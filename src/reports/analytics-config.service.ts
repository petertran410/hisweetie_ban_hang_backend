import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsPrismaService } from './analytics/analytics-prisma.service';
import {
  AnalyticsConfigListQueryDto,
  AnalyticsParentRuleDto,
  AnalyticsParentRuleUpdateDto,
  AnalyticsProductGroupDto,
  AnalyticsProductGroupUpdateDto,
  AnalyticsSaleTeamDto,
  AnalyticsSaleTeamUpdateDto,
} from './dto';

// Cấu hình cho báo cáo Phân tích: quy tắc khách cha, team sale, thành viên
// team, nhóm hàng 2026. Thay cho các quy tắc viết cứng trong Power BI.
@Injectable()
export class AnalyticsConfigService {
  constructor(private prisma: AnalyticsPrismaService) {}

  // ── Quy tắc khách cha ───────────────────────────────────────────────────
  listParentRules(q: AnalyticsConfigListQueryDto) {
    const where: Prisma.AnalyticsCustomerParentRuleWhereInput = q.search
      ? {
          OR: [
            { pattern: { contains: q.search, mode: 'insensitive' } },
            { parentName: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {};
    return this.prisma.analyticsCustomerParentRule.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  }

  createParentRule(dto: AnalyticsParentRuleDto) {
    return this.prisma.analyticsCustomerParentRule.create({
      data: {
        ...dto,
        pattern: dto.pattern.trim(),
        parentName: dto.parentName.trim(),
      },
    });
  }

  async updateParentRule(id: number, dto: AnalyticsParentRuleUpdateDto) {
    await this.ensure(
      this.prisma.analyticsCustomerParentRule.findUnique({ where: { id } }),
    );
    return this.prisma.analyticsCustomerParentRule.update({
      where: { id },
      data: {
        ...dto,
        pattern: dto.pattern?.trim(),
        parentName: dto.parentName?.trim(),
      },
    });
  }

  async deleteParentRule(id: number) {
    await this.ensure(
      this.prisma.analyticsCustomerParentRule.findUnique({ where: { id } }),
    );
    await this.prisma.analyticsCustomerParentRule.delete({ where: { id } });
    return { success: true };
  }

  /** Thử quy tắc: khách nào sẽ được gộp vào khách cha nào (để kiểm tra trước khi lưu). */
  async previewParent(search: string) {
    const term = `%${search.trim()}%`;
    return this.prisma.$queryRaw<
      { code: string; name: string; parent_name: string }[]
    >`
      WITH rules AS (
        SELECT id, match_type, lower(pattern) AS pat, parent_name, priority
        FROM analytics_customer_parent_rules WHERE is_active
      )
      SELECT c.code, c.name,
        COALESCE((
          SELECT r.parent_name FROM rules r
          WHERE (r.match_type = 'code' AND lower(c.code) = r.pat)
             OR (r.match_type = 'name_contains' AND strpos(lower(c.name), r.pat) > 0)
          ORDER BY r.priority, r.id LIMIT 1
        ), c.name) AS parent_name
      FROM customers c
      WHERE c.code ILIKE ${term} OR c.name ILIKE ${term}
      ORDER BY c.name
      LIMIT 50`;
  }

  // ── Team sale ───────────────────────────────────────────────────────────
  listTeams() {
    return this.prisma.analyticsSaleTeam.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { members: true } } },
    });
  }

  async createTeam(dto: AnalyticsSaleTeamDto) {
    const code = dto.code.trim();
    if (await this.prisma.analyticsSaleTeam.findUnique({ where: { code } })) {
      throw new BadRequestException(`Mã team "${code}" đã tồn tại`);
    }
    return this.prisma.analyticsSaleTeam.create({
      data: {
        code,
        name: dto.name.trim(),
        isSale: dto.isSale ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateTeam(id: number, dto: AnalyticsSaleTeamUpdateDto) {
    await this.ensure(
      this.prisma.analyticsSaleTeam.findUnique({ where: { id } }),
    );
    return this.prisma.analyticsSaleTeam.update({
      where: { id },
      data: { ...dto, name: dto.name?.trim() },
    });
  }

  async deleteTeam(id: number) {
    await this.ensure(
      this.prisma.analyticsSaleTeam.findUnique({ where: { id } }),
    );
    await this.prisma.analyticsSaleTeam.delete({ where: { id } }); // thành viên xoá theo (cascade)
    return { success: true };
  }

  // ── Thành viên team: liệt kê mọi nhân viên kèm team (nếu có) ─────────────
  async listMembers(q: AnalyticsConfigListQueryDto) {
    const term = q.search ? `%${q.search.trim()}%` : null;
    return this.prisma.$queryRaw<
      {
        userId: number;
        name: string;
        email: string;
        isActive: boolean;
        teamId: number | null;
      }[]
    >`
      SELECT u.id AS "userId", u.name, u.email, u."isActive" AS "isActive", m.team_id AS "teamId"
      FROM users u
      LEFT JOIN analytics_sale_team_members m ON m.user_id = u.id
      WHERE ${term ? Prisma.sql`(u.name ILIKE ${term} OR u.email ILIKE ${term})` : Prisma.sql`true`}
      ORDER BY (m.team_id IS NULL), u."isActive" DESC, u.name`;
  }

  /** Gán nhân viên vào team; teamId = null để bỏ khỏi team. */
  async setMember(userId: number, teamId: number | null) {
    await this.ensure(
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }),
    );
    if (teamId === null) {
      await this.prisma.analyticsSaleTeamMember.deleteMany({
        where: { userId },
      });
      return { userId, teamId: null };
    }
    await this.ensure(
      this.prisma.analyticsSaleTeam.findUnique({ where: { id: teamId } }),
    );
    await this.prisma.analyticsSaleTeamMember.upsert({
      where: { userId },
      update: { teamId },
      create: { userId, teamId },
    });
    return { userId, teamId };
  }

  // ── Nhóm hàng 2026 ──────────────────────────────────────────────────────
  async listProductGroups(q: AnalyticsConfigListQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const term = q.search ? `%${q.search.trim()}%` : null;
    const where = term
      ? Prisma.sql`(g.product_code ILIKE ${term} OR p.name ILIKE ${term} OR g.group_name ILIKE ${term})`
      : Prisma.sql`true`;
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<
        {
          id: number;
          productCode: string;
          productName: string | null;
          groupName: string;
        }[]
      >`
        SELECT g.id, g.product_code AS "productCode", p.name AS "productName", g.group_name AS "groupName"
        FROM analytics_product_groups g
        LEFT JOIN LATERAL (SELECT name FROM products WHERE code = g.product_code LIMIT 1) p ON true
        WHERE ${where}
        ORDER BY g.group_name, g.product_code
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM analytics_product_groups g
        LEFT JOIN LATERAL (SELECT name FROM products WHERE code = g.product_code LIMIT 1) p ON true
        WHERE ${where}`,
    ]);
    return { data: rows, total: total[0]?.n ?? 0, page, limit };
  }

  async createProductGroup(dto: AnalyticsProductGroupDto) {
    const productCode = dto.productCode.trim();
    if (
      await this.prisma.analyticsProductGroup.findUnique({
        where: { productCode },
      })
    ) {
      throw new BadRequestException(`Mã hàng "${productCode}" đã có nhóm`);
    }
    return this.prisma.analyticsProductGroup.create({
      data: { productCode, groupName: dto.groupName.trim() },
    });
  }

  async updateProductGroup(id: number, dto: AnalyticsProductGroupUpdateDto) {
    await this.ensure(
      this.prisma.analyticsProductGroup.findUnique({ where: { id } }),
    );
    return this.prisma.analyticsProductGroup.update({
      where: { id },
      data: { groupName: dto.groupName.trim() },
    });
  }

  async deleteProductGroup(id: number) {
    await this.ensure(
      this.prisma.analyticsProductGroup.findUnique({ where: { id } }),
    );
    await this.prisma.analyticsProductGroup.delete({ where: { id } });
    return { success: true };
  }

  private async ensure<T>(p: Promise<T | null>): Promise<T> {
    const row = await p;
    if (!row) throw new NotFoundException('Không tìm thấy');
    return row;
  }
}
