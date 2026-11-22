import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SmaxApiService } from '../smax-api.service';
import {
  periodLabel,
  previousRange,
  type DateRange,
} from '../../leads/lead-reports/lead-reports.calc';
import {
  buildChannelRows,
  buildFunnel,
  buildStaffRows,
  buildThreadStats,
  buildTrend,
  CHAT_ORDER_DAYS,
  csv,
  csvInts,
  kpi,
  rateKpi,
  unavailableThreads,
  vnStartOfDay,
  type ChannelThreadCounts,
  type LinkAgg,
  type SendAgg,
} from './smax-reports.calc';
import { SmaxSummaryQueryDto } from './smax-reports.dto';
import type {
  SmaxDashboardData,
  SmaxFilterOptions,
  SmaxSendError,
  SmaxThreadStats,
} from './smax-reports.types';

/** Người xem báo cáo. */
export interface SmaxReportActor {
  id: number;
  /** Không xem được dữ liệu NV khác → chỉ tin mình gửi, lượt mình gắn, hoá đơn mình tạo. */
  ownOnly: boolean;
  /** Không có leads:update → chỉ lead giao cho mình (cùng luật báo cáo Lead). */
  leadsOwnOnly: boolean;
}

interface Filters {
  range: DateRange | null;
  pagePids: string[];
  userId: number | null;
  branchIds: number[];
}

const CACHE_MS = 10 * 60_000;
const THREAD_CONCURRENCY = 6;
// Doanh thu: loại Đã hủy (2) + Trả hàng (8) — như Dashboard
const REVENUE_EXCLUDE = [2, 8];

/** Ngày giờ VN của cột timestamp (lưu UTC). */
const vnDay = (col: Prisma.Sql) =>
  Prisma.sql`to_char(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

const FAILED = Prisma.sql`(a.metadata ? 'failure' OR COALESCE((a.metadata->>'sentParts')::int, 0) < COALESCE((a.metadata->>'totalParts')::int, 0))`;

/**
 * Báo cáo Smax chat (/bao-cao/smax). Đếm bằng SQL trên audit_logs (SMAX_CHAT_SEND,
 * SMAX_DELIVERY_BOOKING), customer_zalo_contacts, leads, invoices; hội thoại New / Renew đếm
 * bằng API Smax (cache 10 phút). Không bao giờ đọc nội dung tin nhắn (metadata.text).
 */
@Injectable()
export class SmaxReportsService {
  private readonly logger = new Logger(SmaxReportsService.name);
  private pagesCache: {
    at: number;
    pages: Promise<{ pagePid: string; name: string; platform: string }[]>;
  } | null = null;
  private readonly threadCache = new Map<
    string,
    { at: number; value: Promise<ChannelThreadCounts[]> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
  ) {}

  private filters(q: SmaxSummaryQueryDto, actor: SmaxReportActor): Filters {
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    return {
      range: from && to ? { from, to } : null,
      pagePids: csv(q.pagePids),
      userId: actor.ownOnly ? actor.id : (q.userId ?? null),
      branchIds: csvInts(q.branchIds),
    };
  }

  // ───────────────────────── điều kiện chung ─────────────────────────

  private sendWhere(f: Filters, range: DateRange | null): Prisma.Sql {
    return Prisma.sql`a.action_code = 'SMAX_CHAT_SEND'
      ${range ? Prisma.sql`AND a.created_at >= ${range.from} AND a.created_at <= ${range.to}` : Prisma.empty}
      ${f.userId ? Prisma.sql`AND a.user_id = ${f.userId}` : Prisma.empty}
      ${f.pagePids.length ? Prisma.sql`AND a.metadata->>'pagePid' IN (${Prisma.join(f.pagePids)})` : Prisma.empty}`;
  }

  private linkWhere(f: Filters, range: DateRange | null): Prisma.Sql {
    return Prisma.sql`TRUE
      ${range ? Prisma.sql`AND z."createdAt" >= ${range.from} AND z."createdAt" <= ${range.to}` : Prisma.empty}
      ${f.userId ? Prisma.sql`AND z."createdById" = ${f.userId}` : Prisma.empty}
      ${f.pagePids.length ? Prisma.sql`AND z."pagePid" IN (${Prisma.join(f.pagePids)})` : Prisma.empty}`;
  }

  /** Hoá đơn tính doanh thu; ownOnly → hoá đơn mình tạo (như GET /invoices). */
  private invoiceWhere(f: Filters, actor: SmaxReportActor): Prisma.Sql {
    return Prisma.sql`i.status NOT IN (${Prisma.join(REVENUE_EXCLUDE)})
      ${f.branchIds.length ? Prisma.sql`AND i."branchId" IN (${Prisma.join(f.branchIds)})` : Prisma.empty}
      ${actor.ownOnly ? Prisma.sql`AND i."createdBy" = ${actor.id}` : Prisma.empty}`;
  }

  // ───────────────────────── truy vấn ─────────────────────────

  private sendAggs(f: Filters) {
    return this.prisma.$queryRaw<
      (SendAgg & { qr: number; productImages: number; packingSlips: number })[]
    >`
      SELECT a.user_id AS "userId", max(a.user_name) AS "userName",
        COALESCE(a.metadata->>'pagePid', '') AS "pagePid",
        ${vnDay(Prisma.sql`a.created_at`)} AS day,
        count(*)::int AS messages,
        count(*) FILTER (WHERE a.metadata->>'contactKind' = 'group')::int AS "group",
        count(*) FILTER (WHERE ${FAILED})::int AS failures,
        count(*) FILTER (WHERE a.metadata ? 'qrImageUrl')::int AS qr,
        count(*) FILTER (WHERE a.metadata ? 'productImageUrls')::int AS "productImages",
        count(*) FILTER (WHERE a.metadata ? 'packingSlipImageUrls')::int AS "packingSlips"
      FROM audit_logs a
      WHERE ${this.sendWhere(f, f.range)}
      GROUP BY 1, 3, 4`;
  }

  private async sendTotals(f: Filters, range: DateRange) {
    const [r] = await this.prisma.$queryRaw<
      { messages: number; staff: number; failures: number }[]
    >`
      SELECT count(*)::int AS messages, count(DISTINCT a.user_id)::int AS staff,
        count(*) FILTER (WHERE ${FAILED})::int AS failures
      FROM audit_logs a WHERE ${this.sendWhere(f, range)}`;
    return r;
  }

  private linkAggs(f: Filters) {
    return this.prisma.$queryRaw<LinkAgg[]>`
      SELECT z."createdById" AS "userId", z."pagePid" AS "pagePid",
        ${vnDay(Prisma.sql`z."createdAt"`)} AS day, count(*)::int AS n
      FROM customer_zalo_contacts z
      WHERE ${this.linkWhere(f, f.range)}
      GROUP BY 1, 2, 3`;
  }

  private async linkTotal(f: Filters, range: DateRange) {
    const [r] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM customer_zalo_contacts z WHERE ${this.linkWhere(f, range)}`;
    return r.n;
  }

  /** Khách có hoá đơn trong kỳ, bao nhiêu đã có liên hệ Zalo. */
  private async coverage(
    f: Filters,
    actor: SmaxReportActor,
    range: DateRange | null,
  ) {
    const [r] = await this.prisma.$queryRaw<{ num: number; den: number }[]>`
      WITH buyers AS (
        SELECT DISTINCT i."customerId" AS id FROM invoices i
        WHERE i."customerId" IS NOT NULL AND ${this.invoiceWhere(f, actor)}
          ${range ? Prisma.sql`AND i."purchaseDate" >= ${range.from} AND i."purchaseDate" <= ${range.to}` : Prisma.empty}
      )
      SELECT count(*)::int AS den,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM customer_zalo_contacts z WHERE z."customerId" = b.id
        ))::int AS num
      FROM buyers b`;
    return r;
  }

  /**
   * Chat → Đơn: lần gửi đầu tới mỗi khách POS trong kỳ, hoá đơn trong CHAT_ORDER_DAYS ngày sau đó.
   * Tổng: theo khách (lần chat đầu của bất kỳ ai). Theo NV: lần chat đầu của từng NV.
   */
  private async chatOrders(
    f: Filters,
    actor: SmaxReportActor,
    range: DateRange | null,
    perStaff: boolean,
  ) {
    const chats = Prisma.sql`
      SELECT a.user_id, a.entity_id::int AS customer_id, min(a.created_at) AS first_at
      FROM audit_logs a
      WHERE ${this.sendWhere(f, range)}
        AND a.entity_type = 'customers' AND a.entity_id ~ '^[0-9]+$'
      GROUP BY 1, 2`;
    const orders = Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, COALESCE(sum(i."grandTotal"), 0) AS revenue
        FROM invoices i
        WHERE i."customerId" = c.customer_id AND ${this.invoiceWhere(f, actor)}
          AND i."purchaseDate" >= c.first_at
          AND i."purchaseDate" < c.first_at + make_interval(days => ${CHAT_ORDER_DAYS}::int)
      ) o ON TRUE`;
    if (perStaff)
      return this.prisma.$queryRaw<
        {
          userId: number;
          chattedCustomers: number;
          customersWithOrder: number;
          revenue: number;
          invoices: number;
        }[]
      >`
        WITH chats AS (${chats})
        SELECT c.user_id AS "userId", count(*)::int AS "chattedCustomers",
          count(*) FILTER (WHERE o.n > 0)::int AS "customersWithOrder",
          COALESCE(sum(o.revenue), 0)::float AS revenue, COALESCE(sum(o.n), 0)::int AS invoices
        FROM chats c ${orders}
        GROUP BY 1`;
    return this.prisma.$queryRaw<
      {
        userId: number;
        chattedCustomers: number;
        customersWithOrder: number;
        revenue: number;
        invoices: number;
      }[]
    >`
      WITH chats AS (
        SELECT 0 AS user_id, customer_id, min(first_at) AS first_at FROM (${chats}) x GROUP BY 2
      )
      SELECT 0 AS "userId", count(*)::int AS "chattedCustomers",
        count(*) FILTER (WHERE o.n > 0)::int AS "customersWithOrder",
        COALESCE(sum(o.revenue), 0)::float AS revenue, COALESCE(sum(o.n), 0)::int AS invoices
      FROM chats c ${orders}`;
  }

  /** Lead có hội thoại tạo trong kỳ (kênh lọc theo hội thoại), cùng luật phạm vi với báo cáo Lead. */
  private async leadFunnel(
    f: Filters,
    actor: SmaxReportActor,
    range: DateRange | null,
  ) {
    const where: Prisma.LeadWhereInput = {
      conversations: {
        some: f.pagePids.length ? { pagePid: { in: f.pagePids } } : {},
      },
      ...(actor.leadsOwnOnly ? { salePicId: actor.id } : {}),
      ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
    };
    const [leads, handedOver, converted] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.count({
        where: {
          AND: [
            where,
            {
              OR: [
                { status: { in: ['handed_over', 'converted'] } },
                { handovers: { some: {} } },
              ],
            },
          ],
        },
      }),
      this.prisma.lead.count({
        where: { AND: [where, { status: 'converted' }] },
      }),
    ]);
    return { leads, handedOver, converted };
  }

  private async deliveryBookings(f: Filters) {
    const [r] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs a
      WHERE a.action_code = 'SMAX_DELIVERY_BOOKING'
        ${f.range ? Prisma.sql`AND a.created_at >= ${f.range.from} AND a.created_at <= ${f.range.to}` : Prisma.empty}
        ${f.userId ? Prisma.sql`AND a.user_id = ${f.userId}` : Prisma.empty}
        ${f.pagePids.length ? Prisma.sql`AND a.metadata->>'pagePid' IN (${Prisma.join(f.pagePids)})` : Prisma.empty}`;
    return r.n;
  }

  /** 20 lượt gửi lỗi gần nhất — chỉ câu lỗi, không có nội dung tin. */
  private recentErrors(f: Filters) {
    return this.prisma.$queryRaw<
      { at: Date; userName: string; pagePid: string | null; error: string }[]
    >`
      SELECT a.created_at AS at, a.user_name AS "userName", a.metadata->>'pagePid' AS "pagePid",
        COALESCE(a.metadata->>'failure',
          'Gửi thiếu ' || (a.metadata->>'sentParts') || '/' || (a.metadata->>'totalParts') || ' phần') AS error
      FROM audit_logs a
      WHERE ${this.sendWhere(f, f.range)} AND ${FAILED}
      ORDER BY a.created_at DESC
      LIMIT 20`;
  }

  // ───────────────────────── Smax ─────────────────────────

  /** Kênh Smax (cache 10 phút); lỗi → rỗng. */
  private pages() {
    if (!this.pagesCache || Date.now() - this.pagesCache.at > CACHE_MS) {
      const pages = this.smaxApi.listPages().then((rows) =>
        rows
          .filter((p) => p.pid)
          .map((p) => ({
            pagePid: p.pid,
            name: p.name,
            platform: p.platform,
          })),
      );
      this.pagesCache = { at: Date.now(), pages };
      pages.catch(() => (this.pagesCache = null));
    }
    return this.pagesCache.pages.catch(
      () => [] as { pagePid: string; name: string; platform: string }[],
    );
  }

  /** Kênh người xem được thấy: ownOnly → kênh được gán cho mình. */
  private async visibleChannels(actor: SmaxReportActor) {
    const pages = await this.pages();
    if (!actor.ownOnly) return pages;
    const mine = await this.prisma.smaxChannelUser.findMany({
      where: { userId: actor.id },
      select: { pagePid: true },
    });
    const allowed = new Set(mine.map((m) => m.pagePid));
    return pages.filter((p) => allowed.has(p.pagePid));
  }

  private async countChannel(
    pagePid: string,
    range: DateRange,
  ): Promise<ChannelThreadCounts> {
    const base = { from: range.from, to: range.to };
    const [created, createdGroup, active, activeGroup] = await Promise.all([
      this.smaxApi.countThreads([pagePid], { ...base, byCreatedAt: true }),
      this.smaxApi.countThreads([pagePid], {
        ...base,
        byCreatedAt: true,
        groupOnly: true,
      }),
      this.smaxApi.countThreads([pagePid], base),
      this.smaxApi.countThreads([pagePid], { ...base, groupOnly: true }),
    ]);
    return { pagePid, created, createdGroup, active, activeGroup };
  }

  /** Đếm từng kênh (song song có giới hạn), cache 10 phút theo kỳ + kênh. */
  private threadCounts(pagePids: string[], range: DateRange) {
    // "Đến" thường là lúc mở trang (đổi từng ms) → gộp theo khung 10 phút để cache trúng
    const key = `${range.from.toISOString()}|${Math.floor(range.to.getTime() / CACHE_MS)}|${[...pagePids].sort().join(',')}`;
    const hit = this.threadCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = (async () => {
      const out: ChannelThreadCounts[] = [];
      for (let i = 0; i < pagePids.length; i += THREAD_CONCURRENCY) {
        const chunk = pagePids.slice(i, i + THREAD_CONCURRENCY);
        out.push(
          ...(await Promise.all(chunk.map((p) => this.countChannel(p, range)))),
        );
      }
      return out;
    })();
    this.threadCache.set(key, { at: Date.now(), value });
    value.catch(() => this.threadCache.delete(key));
    if (this.threadCache.size > 50) {
      const [oldest] = this.threadCache.keys();
      if (oldest) this.threadCache.delete(oldest);
    }
    return value;
  }

  private async threads(
    f: Filters,
    channels: { pagePid: string }[],
    asOf: Date,
  ): Promise<{
    stats: SmaxThreadStats;
    byChannel: Map<string, { newTotal: number; renewTotal: number }> | null;
  }> {
    if (!f.range)
      return {
        stats: unavailableThreads(
          'Chọn khoảng thời gian để xem hội thoại New / Renew.',
        ),
        byChannel: null,
      };
    const pids = channels
      .map((c) => c.pagePid)
      .filter((p) => !f.pagePids.length || f.pagePids.includes(p));
    if (!pids.length)
      return {
        stats: unavailableThreads('Không có kênh Smax nào để đếm hội thoại.'),
        byChannel: null,
      };
    try {
      const counts = await this.threadCounts(pids, f.range);
      return buildThreadStats(counts, f.range.to < vnStartOfDay(asOf));
    } catch (e) {
      this.logger.warn(`Đếm hội thoại Smax lỗi: ${(e as Error).message}`);
      return {
        stats: unavailableThreads(
          'Không lấy được số liệu hội thoại từ Smax. Thử lại sau.',
        ),
        byChannel: null,
      };
    }
  }

  // ───────────────────────── API ─────────────────────────

  async summary(
    q: SmaxSummaryQueryDto,
    actor: SmaxReportActor,
    asOf = new Date(),
  ): Promise<SmaxDashboardData> {
    const f = this.filters(q, actor);
    const prev = f.range ? previousRange(f.range) : null;
    const channels = await this.visibleChannels(actor);

    const [
      sends,
      links,
      cov,
      orders,
      staffOrders,
      funnel,
      bookings,
      errors,
      threads,
      prevSends,
      prevLinks,
      prevCov,
      prevOrders,
      prevFunnel,
    ] = await Promise.all([
      this.sendAggs(f),
      this.linkAggs(f),
      this.coverage(f, actor, f.range),
      this.chatOrders(f, actor, f.range, false),
      this.chatOrders(f, actor, f.range, true),
      this.leadFunnel(f, actor, f.range),
      this.deliveryBookings(f),
      this.recentErrors(f),
      this.threads(f, channels, asOf),
      prev ? this.sendTotals(f, prev) : null,
      prev ? this.linkTotal(f, prev) : null,
      prev ? this.coverage(f, actor, prev) : null,
      prev ? this.chatOrders(f, actor, prev, false) : null,
      prev ? this.leadFunnel(f, actor, prev) : null,
    ]);

    const sum = (k: keyof (typeof sends)[number]) =>
      sends.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const messages = sum('messages');
    const failures = sum('failures');
    const total = orders[0] ?? {
      customersWithOrder: 0,
      invoices: 0,
      revenue: 0,
    };
    const userIds = [
      ...new Set(
        [
          ...links.map((l) => l.userId),
          ...staffOrders.map((o) => o.userId),
        ].filter((id): id is number => !!id),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const channelName = new Map(channels.map((c) => [c.pagePid, c.name]));
    const allPages = await this.pages();
    for (const p of allPages)
      if (!channelName.has(p.pagePid)) channelName.set(p.pagePid, p.name);

    return {
      period: {
        label: periodLabel(f.range),
        compareLabel: prev ? periodLabel(prev) : null,
      },
      ownOnly: actor.ownOnly,
      kpis: {
        activeStaff: kpi(
          new Set(sends.map((s) => s.userId)).size,
          prevSends?.staff ?? null,
        ),
        messages: kpi(messages, prevSends?.messages ?? null),
        links: kpi(
          links.reduce((s, l) => s + l.n, 0),
          prevLinks,
        ),
        coverage: rateKpi(cov.num, cov.den, prevCov),
        leadConversion: rateKpi(
          funnel.converted,
          funnel.leads,
          prevFunnel
            ? { num: prevFunnel.converted, den: prevFunnel.leads }
            : null,
        ),
        chatRevenue: {
          ...kpi(
            Number(total.revenue),
            prevOrders ? Number(prevOrders[0]?.revenue ?? 0) : null,
          ),
          customers: total.customersWithOrder,
          invoices: total.invoices,
        },
        failureRate: rateKpi(
          failures,
          messages,
          prevSends
            ? { num: prevSends.failures, den: prevSends.messages }
            : null,
        ),
      },
      threads: threads.stats,
      trend: buildTrend(
        Object.values(
          sends.reduce<
            Record<string, { day: string; messages: number; group: number }>
          >((acc, s) => {
            const d = (acc[s.day] ??= { day: s.day, messages: 0, group: 0 });
            d.messages += s.messages;
            d.group += s.group;
            return acc;
          }, {}),
        ),
        links.map((l) => ({ day: l.day, n: l.n })),
        f.range,
        asOf,
      ),
      funnel: buildFunnel(funnel),
      salesSupport: {
        qr: sum('qr'),
        productImages: sum('productImages'),
        packingSlips: sum('packingSlips'),
        deliveryBookings: bookings,
      },
      staff: buildStaffRows(
        sends,
        links,
        staffOrders.map((o) => ({ ...o, revenue: Number(o.revenue) })),
        new Map(users.map((u) => [u.id, u.name])),
      ),
      channels: buildChannelRows(sends, links, channels, threads.byChannel),
      errors: errors.map(
        (e): SmaxSendError => ({
          at: e.at.toISOString(),
          userName: e.userName,
          channelName:
            (e.pagePid && channelName.get(e.pagePid)) || e.pagePid || '',
          error: e.error ?? '',
        }),
      ),
    };
  }

  async filterOptions(actor: SmaxReportActor): Promise<SmaxFilterOptions> {
    const [channels, staffRows, branches] = await Promise.all([
      this.visibleChannels(actor),
      actor.ownOnly
        ? this.prisma.user.findMany({
            where: { id: actor.id },
            select: { id: true, name: true },
          })
        : this.prisma.$queryRaw<{ id: number; name: string }[]>`
            SELECT u.id, u.name FROM users u
            WHERE u.id IN (
              SELECT a.user_id FROM audit_logs a WHERE a.action_code = 'SMAX_CHAT_SEND'
              UNION SELECT z."createdById" FROM customer_zalo_contacts z WHERE z."createdById" IS NOT NULL
              UNION SELECT c."userId" FROM smax_channel_users c
            )
            ORDER BY u.name`,
      this.prisma.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      channels: [...channels].sort((a, b) =>
        a.name.localeCompare(b.name, 'vi'),
      ),
      staff: staffRows,
      branches,
    };
  }
}
