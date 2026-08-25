import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from 'src/audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from 'src/audit-logs/audit-templates';

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(filters?: {
    search?: string;
    isActive?: boolean;
    isPurchasingHub?: boolean;
    page?: number;
    limit?: number;
  }) {
    const {
      search,
      isActive,
      isPurchasingHub,
      page = 1,
      limit = 20,
    } = filters || {};

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { address: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) where.isActive = isActive;
    if (isPurchasingHub !== undefined) where.isPurchasingHub = isPurchasingHub;

    const [data, total] = await Promise.all([
      this.prisma.branch.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.branch.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findByIds(ids: number[]) {
    return this.prisma.branch.findMany({
      where: {
        id: { in: ids },
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findByUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: true,
      },
    });

    if (user?.branchId) {
      return [user.branch];
    }

    return this.findAll();
  }

  async findOne(id: number) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
    });

    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(
    data: {
      name: string;
      code?: string;
      contactNumber?: string;
      subContactNumber?: string;
      email?: string;
      address?: string;
      locationId?: number;
      wardName?: string;
      /// Đánh dấu kho đầu mối nhập khẩu — dùng cho engine dự kiến đặt hàng.
      isPurchasingHub?: boolean;
      transferLeadtimeColdMin?: number | null;
      transferLeadtimeColdMax?: number | null;
      transferLeadtimeNormalMin?: number | null;
      transferLeadtimeNormalMax?: number | null;
    },
    performedByUserId?: number,
  ) {
    if (data.code) {
      const existing = await this.prisma.branch.findUnique({
        where: { code: data.code },
      });
      if (existing) {
        throw new BadRequestException('Branch code already exists');
      }
    }

    const branch = await this.prisma.branch.create({ data });

    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'BRANCH_CREATE',
        entityType: 'branches',
        entityId: branch.id.toString(),
        category: getCategoryFromActionCode('BRANCH_CREATE'),
        severity: getSeverityFromActionCode('BRANCH_CREATE'),
        snapshot: { name: branch.name, code: branch.code },
        message: renderAuditMessage('BRANCH_CREATE', {
          branchName: branch.name,
          branchCode: branch.code || '',
        }),
        messageTemplate: 'BRANCH_CREATE',
        userId: performedByUserId,
        userName: actor?.name || actor?.email || 'System',
      });
    }

    return branch;
  }

  async update(
    id: number,
    data: {
      name?: string;
      code?: string;
      contactNumber?: string;
      subContactNumber?: string;
      email?: string;
      address?: string;
      locationId?: number;
      wardName?: string;
      isActive?: boolean;
      isLock?: boolean;
      /// Đánh dấu kho đầu mối nhập khẩu — dùng cho engine dự kiến đặt hàng.
      isPurchasingHub?: boolean;
      transferLeadtimeColdMin?: number | null;
      transferLeadtimeColdMax?: number | null;
      transferLeadtimeNormalMin?: number | null;
      transferLeadtimeNormalMax?: number | null;
    },
    performedByUserId?: number,
  ) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    if (data.code && data.code !== branch.code) {
      const existing = await this.prisma.branch.findUnique({
        where: { code: data.code },
      });
      if (existing) {
        throw new BadRequestException('Branch code already exists');
      }
    }

    const updated = await this.prisma.branch.update({ where: { id }, data });

    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'BRANCH_UPDATE',
        entityType: 'branches',
        entityId: id.toString(),
        category: getCategoryFromActionCode('BRANCH_UPDATE'),
        severity: getSeverityFromActionCode('BRANCH_UPDATE'),
        snapshot: {
          name: updated.name,
          code: updated.code,
          ...(data.isPurchasingHub !== undefined && {
            isPurchasingHub: updated.isPurchasingHub,
          }),
        },
        message: renderAuditMessage('BRANCH_UPDATE', {
          branchName: updated.name,
        }),
        messageTemplate: 'BRANCH_UPDATE',
        userId: performedByUserId,
        userName: actor?.name || actor?.email || 'System',
      });
    }

    return updated;
  }

  async delete(id: number, performedByUserId?: number) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    await this.prisma.branch.delete({ where: { id } });

    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'BRANCH_DELETE',
        entityType: 'branches',
        entityId: id.toString(),
        category: getCategoryFromActionCode('BRANCH_DELETE'),
        severity: getSeverityFromActionCode('BRANCH_DELETE'),
        snapshot: { name: branch.name, code: branch.code },
        message: renderAuditMessage('BRANCH_DELETE', {
          branchName: branch.name,
        }),
        messageTemplate: 'BRANCH_DELETE',
        userId: performedByUserId,
        userName: actor?.name || actor?.email || 'System',
      });
    }

    return { message: 'Branch deleted successfully' };
  }
}
