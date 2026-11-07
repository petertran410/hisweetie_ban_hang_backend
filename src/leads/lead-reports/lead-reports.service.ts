import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  and,
  avgBy,
  avgHours,
  buildCskhRows,
  buildFunnel,
  buildKpis,
  buildLeadWhere,
  buildSaleRows,
  buildSourceRows,
  buildTrend,
  countMap,
  DateRange,
  failedHandoverStep,
  LeadReportActor,
  LeadReportFilters,
  PeriodStats,
  periodLabel,
  previousRange,
  REACHED,
  round1,
  StatusCounts,
} from './lead-reports.calc';
import { LeadSummaryQueryDto } from './lead-reports.dto';
import type {
  LeadAttention,
  LeadDashboardData,
  LeadFilterOptions,
} from './lead-reports.types';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Lead Mới quá ngưỡng này chưa chăm sóc → "Cần xử lý". */
const STALE_NEW_HOURS = 24;
/** Đã chuyển Sale quá ngưỡng này chưa có đơn → "Cần xử lý". */
const STALE_HANDED_DAYS = 14;
/** Số mục tối đa trả về cho mỗi danh sách "Cần xử lý" (total vẫn là số đầy đủ). */
const ATTENTION_LIMIT = 20;

const csv = (v?: string) =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/**
 * Dashboard Lead (/bao-cao/lead). Đếm bằng Prisma count / groupBy ở DB; chỉ đọc vài cột ngày
 * (createdAt, convertedAt, lần chuyển giao đầu) khi cần tính thời gian trung bình và xu hướng.
 */
@Injectable()
export class LeadReportsService {
  constructor(private readonly prisma: PrismaService) {}

  parseFilters(q: LeadSummaryQueryDto): LeadReportFilters {
    return {
      from: q.from ? new Date(q.from) : null,
      to: q.to ? new Date(q.to) : null,
      sources: csv(q.sources),
      categories: csv(q.categories),
      cskhUserId: q.cskhUserId ?? null,
      salePicId: q.salePicId ?? null,
    };
  }

  async summary(
    q: LeadSummaryQueryDto,
    actor: LeadReportActor,
    now = new Date(),
  ): Promise<LeadDashboardData> {
    const f = this.parseFilters(q);
    const range: DateRange | null = f.from
      ? { from: f.from, to: f.to ?? now }
      : null;
    const prev = range ? previousRange(range) : null;

    const where = buildLeadWhere(f, actor);
    const backlog = buildLeadWhere(f, actor, false);
    const prevWhere = prev
      ? buildLeadWhere({ ...f, from: prev.from, to: prev.to }, actor)
      : null;

    const [cur, prevStats, funnelCounts, sources, cskh, sale, rows, attention] =
      await Promise.all([
        this.periodStats(where),
        prevWhere ? this.periodStats(prevWhere) : Promise.resolve(null),
        this.funnelCounts(where),
        this.sourceCounts(where, prevWhere),
        this.cskhCounts(where, backlog, now),
        this.saleCounts(where, backlog, now),
        this.prisma.lead.findMany({
          where,
          select: { id: true, createdAt: true, status: true, cskhUserId: true },
        }),
        this.attention(backlog, now),
      ]);

    const firstResponse = await this.firstResponseMinutes(
      rows,
      cur.firstHandover,
    );

    const userIds = [
      ...cskh.received.keys(),
      ...cskh.overdueNew.keys(),
      ...sale.received.keys(),
      ...sale.overdueNoOrder.keys(),
    ].filter((id): id is number => !!id);
    const names = await this.userNames(userIds);

    return {
      period: {
        from: range ? range.from.toISOString() : null,
        to: range ? range.to.toISOString() : null,
        label: periodLabel(range),
        compareLabel: prev ? periodLabel(prev) : null,
      },
      asOf: now.toISOString(),
      kpis: buildKpis(cur.stats, prevStats?.stats ?? null),
      funnel: buildFunnel({ lead: totalOf(cur.stats.status), ...funnelCounts }),
      bySource: buildSourceRows(sources),
      cskh: buildCskhRows({
        ...cskh,
        firstResponseMinutes: firstResponse,
        names,
      }),
      salePic: buildSaleRows({
        ...sale,
        avgDaysToFirstOrder: avgBy(
          cur.converted
            .filter((l) => l.salePicId && l.convertedAt)
            .map((l) => [
              l.salePicId,
              ((l.convertedAt as Date).getTime() -
                (l.handovers[0]?.createdAt ?? l.createdAt).getTime()) /
                DAY_MS,
            ]),
        ),
        names,
      }),
      trend: buildTrend(rows, range, now),
      attention,
    };
  }

  /** Người lọc được ở bộ lọc CSKH / Sale PIC: người đang có lead (Sale chỉ thấy chính mình). */
  async filterOptions(actor: LeadReportActor): Promise<LeadFilterOptions> {
    const base = buildLeadWhere({}, actor, false);
    const [c, s] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['cskhUserId'],
        where: and(base, { cskhUserId: { not: null } }),
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['salePicId'],
        where: and(base, { salePicId: { not: null } }),
        _count: { _all: true },
      }),
    ]);
    const cIds = c.map((r) => r.cskhUserId as number);
    const sIds = s.map((r) => r.salePicId as number);
    const names = await this.userNames([...cIds, ...sIds]);
    const list = (ids: number[]) =>
      ids
        .map((id) => ({ id, name: names.get(id) ?? `#${id}` }))
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return { cskh: list(cIds), salePics: list(sIds) };
  }

  // ───────────────────────── từng khối ─────────────────────────

  /** Đếm theo trạng thái + thời gian TB tới chuyển Sale / đơn đầu của lead tạo trong kỳ. */
  private async periodStats(where: Prisma.LeadWhereInput) {
    const [byStatus, handovers, converted] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.leadHandover.groupBy({
        by: ['leadId'],
        where: { lead: where },
        _min: { createdAt: true },
      }),
      this.prisma.lead.findMany({
        where: and(where, { convertedAt: { not: null } }),
        select: {
          createdAt: true,
          convertedAt: true,
          salePicId: true,
          handovers: {
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      }),
    ]);

    const firstHandover = new Map<number, Date>();
    for (const h of handovers) {
      if (h._min.createdAt) firstHandover.set(h.leadId, h._min.createdAt);
    }
    const handedLeads = firstHandover.size
      ? await this.prisma.lead.findMany({
          where: { id: { in: [...firstHandover.keys()] } },
          select: { id: true, createdAt: true },
        })
      : [];

    const status = Object.fromEntries(
      byStatus.map((r) => [r.status, r._count._all]),
    ) as StatusCounts;
    const stats: PeriodStats = {
      status,
      avgHoursToHandover: avgHours(
        handedLeads.map((l) => [l.createdAt, firstHandover.get(l.id) as Date]),
      ),
      avgHoursToFirstOrder: avgHours(
        converted.map((l) => [l.createdAt, l.convertedAt as Date]),
      ),
    };
    return { stats, firstHandover, converted };
  }

  private async funnelCounts(where: Prisma.LeadWhereInput) {
    const [caring, handed_over, has_customer, ordered] = await Promise.all(
      (['caring', 'handed_over', 'has_customer', 'ordered'] as const).map((k) =>
        this.prisma.lead.count({ where: and(where, REACHED[k]) }),
      ),
    );
    return { caring, handed_over, has_customer, ordered };
  }

  private async sourceCounts(
    where: Prisma.LeadWhereInput,
    prevWhere: Prisma.LeadWhereInput | null,
  ) {
    const by = (w: Prisma.LeadWhereInput) =>
      this.prisma.lead
        .groupBy({ by: ['source'], where: w, _count: { _all: true } })
        .then((r) => countMap<string>(r, 'source'));
    const [leads, converted, cancelled, previous] = await Promise.all([
      by(where),
      by(and(where, { status: 'converted' })),
      by(and(where, { status: 'cancelled' })),
      prevWhere ? by(prevWhere) : Promise.resolve(null),
    ]);
    return { leads, converted, cancelled, previous };
  }

  private async cskhCounts(
    where: Prisma.LeadWhereInput,
    backlog: Prisma.LeadWhereInput,
    now: Date,
  ) {
    const by = (w: Prisma.LeadWhereInput) =>
      this.prisma.lead
        .groupBy({ by: ['cskhUserId'], where: w, _count: { _all: true } })
        .then((r) => countMap<number | null>(r, 'cskhUserId'));
    const [received, cared, handedOver, converted, cancelled, overdueNew] =
      await Promise.all([
        by(where),
        by(and(where, REACHED.caring)),
        by(and(where, REACHED.handed_over)),
        by(and(where, { status: 'converted' })),
        by(and(where, { status: 'cancelled' })),
        by(and(backlog, this.staleNewWhere(now))),
      ]);
    return { received, cared, handedOver, converted, cancelled, overdueNew };
  }

  private async saleCounts(
    where: Prisma.LeadWhereInput,
    backlog: Prisma.LeadWhereInput,
    now: Date,
  ) {
    const by = (w: Prisma.LeadWhereInput) =>
      this.prisma.lead
        .groupBy({
          by: ['salePicId'],
          where: and(w, { salePicId: { not: null } }),
          _count: { _all: true },
        })
        .then((r) => countMap<number | null>(r, 'salePicId'));
    const [received, withCustomer, ordered, cancelled, overdueNoOrder] =
      await Promise.all([
        by(where),
        by(and(where, REACHED.has_customer)),
        by(and(where, REACHED.ordered)),
        by(and(where, { status: 'cancelled' })),
        by(and(backlog, this.staleHandedWhere(now))),
      ]);
    return { received, withCustomer, ordered, cancelled, overdueNoOrder };
  }

  private staleNewWhere(now: Date): Prisma.LeadWhereInput {
    return {
      status: 'new',
      createdAt: { lt: new Date(now.getTime() - STALE_NEW_HOURS * HOUR_MS) },
    };
  }

  private staleHandedWhere(now: Date): Prisma.LeadWhereInput {
    return {
      status: { notIn: ['converted', 'cancelled'] },
      convertedAt: null,
      handovers: {
        some: {
          createdAt: {
            lte: new Date(now.getTime() - STALE_HANDED_DAYS * DAY_MS),
          },
        },
      },
    };
  }

  /**
   * Phản hồi đầu của CSKH (phút): từ lúc tạo lead tới mốc sớm nhất trong
   *  - lần sửa lead đầu tiên đổi trạng thái khỏi "Mới" (audit log LEAD_UPDATE),
   *  - lần chuyển giao đầu tiên.
   * Lead tạo sẵn ở trạng thái khác "Mới" (không có mốc) không được tính.
   */
  private async firstResponseMinutes(
    rows: {
      id: number;
      createdAt: Date;
      status: string;
      cskhUserId: number | null;
    }[],
    firstHandover: Map<number, Date>,
  ): Promise<Map<number | null, number>> {
    const touched = rows.filter((r) => r.status !== 'new');
    if (!touched.length) return new Map();
    const audits = await this.prisma.auditLog.groupBy({
      by: ['entityId'],
      where: {
        entityType: 'leads',
        actionCode: 'LEAD_UPDATE',
        entityId: { in: touched.map((r) => String(r.id)) },
        metadata: { path: ['before', 'status'], equals: 'new' },
        NOT: { metadata: { path: ['after', 'status'], equals: 'new' } },
      },
      _min: { createdAt: true },
    });
    const firstEdit = new Map<number, Date>();
    for (const a of audits) {
      if (a.entityId && a._min.createdAt)
        firstEdit.set(Number(a.entityId), a._min.createdAt);
    }
    const pairs: [number | null, number][] = [];
    for (const r of touched) {
      const marks = [firstEdit.get(r.id), firstHandover.get(r.id)].filter(
        (d): d is Date => !!d,
      );
      if (!marks.length) continue;
      const first = Math.min(...marks.map((d) => d.getTime()));
      pairs.push([r.cskhUserId, (first - r.createdAt.getTime()) / 60_000]);
    }
    const avg = avgBy(pairs);
    return new Map([...avg].map(([k, v]) => [k, Math.round(v)]));
  }

  /** Khối "Cần xử lý": tồn đọng HIỆN TẠI theo bộ lọc (không giới hạn theo ngày tạo). */
  private async attention(
    backlog: Prisma.LeadWhereInput,
    now: Date,
  ): Promise<LeadAttention> {
    const staleNewW = and(backlog, this.staleNewWhere(now));
    const staleHandedW = and(backlog, this.staleHandedWhere(now));
    const [staleNewTotal, staleNew, staleHandedTotal, staleHanded, partial] =
      await Promise.all([
        this.prisma.lead.count({ where: staleNewW }),
        this.prisma.lead.findMany({
          where: staleNewW,
          orderBy: { createdAt: 'asc' },
          take: ATTENTION_LIMIT,
          select: {
            id: true,
            name: true,
            source: true,
            createdAt: true,
            cskhUser: { select: { name: true } },
          },
        }),
        this.prisma.lead.count({ where: staleHandedW }),
        this.prisma.lead.findMany({
          where: staleHandedW,
          orderBy: { createdAt: 'asc' },
          take: ATTENTION_LIMIT,
          select: {
            id: true,
            name: true,
            source: true,
            customerId: true,
            salePic: { select: { name: true } },
            handovers: {
              select: { createdAt: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        }),
        // Chuyển giao "partial" của lead còn mở và chưa có lần chuyển giao nào hoàn tất.
        this.prisma.leadHandover.findMany({
          where: {
            status: 'partial',
            lead: and(backlog, {
              status: { notIn: ['converted', 'cancelled'] },
              handovers: { none: { status: 'done' } },
            }),
          },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            leadId: true,
            salePicId: true,
            createdById: true,
            steps: true,
            updatedAt: true,
            lead: { select: { name: true, source: true } },
          },
        }),
      ]);

    const failed = partial
      .map((h) => ({ h, fail: failedHandoverStep(h.steps) }))
      .filter((x) => x.fail);
    const shown = failed.slice(0, ATTENTION_LIMIT);
    const names = await this.userNames(
      shown.flatMap(({ h }) => [h.salePicId, h.createdById]),
    );

    return {
      staleNew: {
        total: staleNewTotal,
        items: staleNew.map((l) => ({
          leadId: l.id,
          name: l.name,
          source: l.source,
          createdAt: l.createdAt.toISOString(),
          hoursOpen: round1((now.getTime() - l.createdAt.getTime()) / HOUR_MS),
          cskhName: l.cskhUser?.name ?? null,
        })),
      },
      handoverErrors: {
        total: failed.length,
        items: shown.map(({ h, fail }) => ({
          leadId: h.leadId,
          name: h.lead.name,
          source: h.lead.source,
          handoverId: h.id,
          failedStep: fail!.step,
          error: fail!.error,
          at: h.updatedAt.toISOString(),
          salePicName: names.get(h.salePicId) ?? null,
          createdByName: names.get(h.createdById) ?? null,
        })),
      },
      staleHanded: {
        total: staleHandedTotal,
        items: staleHanded.map((l) => {
          const handedAt = l.handovers[0]?.createdAt ?? now;
          return {
            leadId: l.id,
            name: l.name,
            source: l.source,
            handedAt: handedAt.toISOString(),
            daysSinceHandover: Math.floor(
              (now.getTime() - handedAt.getTime()) / DAY_MS,
            ),
            hasCustomer: l.customerId !== null,
            salePicName: l.salePic?.name ?? null,
          };
        }),
      },
    };
  }

  private async userNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

const totalOf = (s: StatusCounts) =>
  Object.values(s).reduce((a, n) => a + (n ?? 0), 0);
