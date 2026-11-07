// Phần tính thuần của dashboard Lead (không gọi DB) — để test bằng jest.
// Service đếm bằng Prisma count/groupBy rồi đưa kết quả vào đây để ráp response.

import { Prisma } from '@prisma/client';
import { HANDOVER_STEPS, HandoverStep, LEAD_SOURCES } from '../leads.constants';
import type {
  LeadCskhRow,
  LeadDurationKpi,
  LeadFunnelStage,
  LeadKpi,
  LeadKpis,
  LeadSalePicRow,
  LeadSourceRow,
  LeadTrend,
  LeadTrendPoint,
} from './lead-reports.types';

// ───────────────────────── số học ─────────────────────────

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** % thay đổi so với kỳ trước; null khi kỳ trước = 0 hoặc thiếu số. */
export function changePct(
  value: number | null,
  previous: number | null,
): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return round1(((value - previous) / previous) * 100);
}

/** num / den * 100 (1 chữ số thập phân); 0 khi mẫu số = 0. */
export const ratePct = (num: number, den: number) =>
  den > 0 ? round1((num / den) * 100) : 0;

/** Trung bình số giờ (2 chữ số thập phân, để vài phút không thành 0) giữa các cặp (bắt đầu, kết thúc); bỏ cặp âm; null khi rỗng. */
export function avgHours(pairs: [Date, Date][]): number | null {
  const hours = pairs
    .map(([a, b]) => (b.getTime() - a.getTime()) / 3_600_000)
    .filter((h) => h >= 0);
  if (!hours.length) return null;
  return (
    Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 100) / 100
  );
}

// ───────────────────────── bộ lọc → Prisma where ─────────────────────────

export interface LeadReportFilters {
  from?: Date | null;
  to?: Date | null;
  sources?: string[];
  categories?: string[];
  cskhUserId?: number | null;
  salePicId?: number | null;
}

export interface LeadReportActor {
  id: number;
  /** Chỉ có leads:view (Sale) → chỉ lead có salePicId = mình (cùng quy tắc GET /leads). */
  ownOnly: boolean;
}

/**
 * Điều kiện lọc lead dùng chung cho mọi số liệu — cùng quy tắc với LeadsService.list
 * (để số KPI khớp số đếm ở /khach-hang/lead với cùng bộ lọc).
 * withPeriod=false: bỏ điều kiện ngày tạo (dùng cho khối "Cần xử lý" là tồn đọng hiện tại).
 */
export function buildLeadWhere(
  f: LeadReportFilters,
  actor: LeadReportActor,
  withPeriod = true,
): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  if (actor.ownOnly) and.push({ salePicId: actor.id });
  if (f.sources?.length) and.push({ source: { in: f.sources } });
  if (f.categories?.length) and.push({ category: { in: f.categories } });
  if (f.cskhUserId) and.push({ cskhUserId: f.cskhUserId });
  if (f.salePicId) and.push({ salePicId: f.salePicId });
  if (withPeriod && f.from) and.push({ createdAt: { gte: f.from } });
  if (withPeriod && f.to) and.push({ createdAt: { lte: f.to } });
  return and.length ? { AND: and } : {};
}

// Điều kiện riêng của từng tầng; tầng nào cũng gộp điều kiện của các tầng sau
// (vd lead còn "Mới" nhưng đã có chuyển giao vẫn tính là đã chăm sóc) nên phễu luôn giảm dần.
const ORDERED: Prisma.LeadWhereInput[] = [{ status: 'converted' }];
const HAS_CUSTOMER = [...ORDERED, { customerId: { not: null } }];
const HANDED_OVER = [
  ...HAS_CUSTOMER,
  { status: 'handed_over' },
  { handovers: { some: {} } },
];
// Không có lịch sử trạng thái: mọi lead đã rời "Mới" (kể cả Huỷ) coi như đã được chăm sóc.
const CARING = [...HANDED_OVER, { status: { not: 'new' } }];

/** Lead đã đi tới (ít nhất) từng tầng phễu. */
export const REACHED: Record<
  'caring' | 'handed_over' | 'has_customer' | 'ordered',
  Prisma.LeadWhereInput
> = {
  ordered: { OR: ORDERED },
  has_customer: { OR: HAS_CUSTOMER },
  handed_over: { OR: HANDED_OVER },
  caring: { OR: CARING },
};

export const and = (
  ...parts: Prisma.LeadWhereInput[]
): Prisma.LeadWhereInput => ({ AND: parts });

// ───────────────────────── thời gian (giờ Việt Nam, UTC+7) ─────────────────────────

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** Date → Date dịch +7 giờ để đọc bằng getUTC* như giờ VN. */
const vn = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS);
/** Mốc giờ VN → Date (UTC thật). */
const fromVn = (y: number, m: number, d = 1) =>
  new Date(Date.UTC(y, m, d) - VN_OFFSET_MS);

const pad2 = (n: number) => String(n).padStart(2, '0');
const dmy = (d: Date) => {
  const x = vn(d);
  return `${pad2(x.getUTCDate())}/${pad2(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`;
};

export interface DateRange {
  from: Date;
  to: Date;
}

const isMonthStart = (d: Date) => {
  const x = vn(d);
  return (
    x.getUTCDate() === 1 &&
    x.getUTCHours() === 0 &&
    x.getUTCMinutes() === 0 &&
    x.getUTCSeconds() === 0
  );
};
/** to = 23:59:59(.999) ngày cuối tháng. */
const isMonthEnd = (d: Date) => {
  const x = vn(new Date(d.getTime() + 1000));
  return (
    x.getUTCDate() === 1 && x.getUTCHours() === 0 && x.getUTCMinutes() === 0
  );
};
const sameMonth = (a: Date, b: Date) => {
  const x = vn(a);
  const y = vn(b);
  return (
    x.getUTCFullYear() === y.getUTCFullYear() &&
    x.getUTCMonth() === y.getUTCMonth()
  );
};

/** Nhãn kỳ: "Tháng 10/2026" nếu trọn 1 tháng, ngược lại "01/10/2026 – 15/10/2026". */
export function periodLabel(r: DateRange | null): string {
  if (!r) return 'Toàn thời gian';
  if (isMonthStart(r.from) && isMonthEnd(r.to) && sameMonth(r.from, r.to)) {
    const x = vn(r.from);
    return `Tháng ${x.getUTCMonth() + 1}/${x.getUTCFullYear()}`;
  }
  const a = dmy(r.from);
  const b = dmy(r.to);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * Kỳ trước để so sánh:
 *  - kỳ bắt đầu ngày 1: cùng khoảng ngày của tháng trước (trọn tháng → trọn tháng trước);
 *  - còn lại: khoảng cùng độ dài ngay trước kỳ.
 */
export function previousRange(r: DateRange): DateRange {
  if (isMonthStart(r.from)) {
    const x = vn(r.from);
    const y = x.getUTCFullYear();
    const m = x.getUTCMonth();
    const pFrom = fromVn(y, m - 1, 1);
    if (isMonthEnd(r.to) && sameMonth(r.from, r.to)) {
      return { from: pFrom, to: new Date(r.from.getTime() - 1) };
    }
    const span = r.to.getTime() - r.from.getTime();
    return {
      from: pFrom,
      to: new Date(Math.min(pFrom.getTime() + span, r.from.getTime() - 1)),
    };
  }
  const span = r.to.getTime() - r.from.getTime();
  return {
    from: new Date(r.from.getTime() - span - 1),
    to: new Date(r.from.getTime() - 1),
  };
}

// ───────────────────────── xu hướng ─────────────────────────

const dayKey = (x: Date) =>
  `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;

/** Tuần ISO (thứ Hai đầu tuần) của một ngày giờ-VN đã dịch. */
function isoWeek(x: Date): { key: string; monday: Date } {
  const dow = (x.getUTCDay() + 6) % 7; // 0 = thứ Hai
  const monday = new Date(
    Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() - dow),
  );
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / (7 * DAY_MS)) + 1;
  return { key: `${thursday.getUTCFullYear()}-W${pad2(week)}`, monday };
}

/**
 * Lead mới / lead chuyển đổi theo ngày-tuần-tháng (giờ VN). Lead chuyển đổi được tính
 * theo ngày TẠO lead (cùng quy ước kỳ của toàn dashboard).
 * Các mốc trống trong kỳ vẫn có điểm = 0 để đường không bị đứt.
 */
export function buildTrend(
  rows: { createdAt: Date; status: string }[],
  range: DateRange | null,
  asOf: Date,
): LeadTrend {
  if (!rows.length && !range) return { day: [], week: [], month: [] };
  const start =
    range?.from ??
    rows.reduce(
      (m, r) => (r.createdAt < m ? r.createdAt : m),
      rows[0].createdAt,
    );
  const endRaw = range?.to ?? asOf;
  const end = endRaw > asOf ? asOf : endRaw;

  const counts = new Map<string, { n: number; c: number }>();
  for (const r of rows) {
    const k = dayKey(vn(r.createdAt));
    const cur = counts.get(k) ?? { n: 0, c: 0 };
    cur.n += 1;
    if (r.status === 'converted') cur.c += 1;
    counts.set(k, cur);
  }

  const s = vn(start);
  const e = vn(end < start ? start : end);
  const first = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const last = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());

  const day: LeadTrendPoint[] = [];
  const week = new Map<string, LeadTrendPoint & { from: Date; to: Date }>();
  const month = new Map<string, LeadTrendPoint>();

  for (let t = first; t <= last; t += DAY_MS) {
    const x = new Date(t);
    const k = dayKey(x);
    const v = counts.get(k) ?? { n: 0, c: 0 };
    const dd = `${pad2(x.getUTCDate())}/${pad2(x.getUTCMonth() + 1)}`;
    day.push({ key: k, label: dd, newLeads: v.n, converted: v.c });

    const w = isoWeek(x);
    const wk = week.get(w.key) ?? {
      key: w.key,
      label: '',
      newLeads: 0,
      converted: 0,
      from: x,
      to: x,
    };
    wk.newLeads += v.n;
    wk.converted += v.c;
    wk.to = x;
    week.set(w.key, wk);

    const mk = `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}`;
    const mo = month.get(mk) ?? {
      key: mk,
      label: `T${x.getUTCMonth() + 1}/${x.getUTCFullYear()}`,
      newLeads: 0,
      converted: 0,
    };
    mo.newLeads += v.n;
    mo.converted += v.c;
    month.set(mk, mo);
  }

  const short = (d: Date) =>
    `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
  return {
    day,
    week: [...week.values()].map(({ from, to, ...p }) => ({
      ...p,
      label:
        from.getTime() === to.getTime()
          ? short(from)
          : from.getUTCMonth() === to.getUTCMonth()
            ? `${pad2(from.getUTCDate())}–${short(to)}`
            : `${short(from)}–${short(to)}`,
    })),
    month: [...month.values()],
  };
}

// ───────────────────────── KPI / phễu / nguồn / nhân sự ─────────────────────────

export type StatusCounts = Partial<
  Record<'new' | 'caring' | 'handed_over' | 'converted' | 'cancelled', number>
>;

export interface PeriodStats {
  status: StatusCounts;
  avgHoursToHandover: number | null;
  avgHoursToFirstOrder: number | null;
}

const totalOf = (s: StatusCounts) =>
  Object.values(s).reduce((a, n) => a + (n ?? 0), 0);

const kpi = (value: number, previous: number | null): LeadKpi => ({
  value,
  previous: previous ?? 0,
  changePct: changePct(value, previous),
});

const durationKpi = (
  value: number | null,
  previous: number | null,
): LeadDurationKpi => ({
  value,
  previous,
  changePct: changePct(value, previous),
});

/** Tỷ lệ chuyển đổi = đã chuyển đổi / (tổng lead − huỷ). */
export function conversionRate(s: StatusCounts): number {
  return ratePct(s.converted ?? 0, totalOf(s) - (s.cancelled ?? 0));
}

/** prev = null: không có kỳ trước (Toàn thời gian) → previous 0, changePct null. */
export function buildKpis(
  cur: PeriodStats,
  prev: PeriodStats | null,
): LeadKpis {
  const c = cur.status;
  const p = prev?.status;
  const pick = (s: StatusCounts | undefined, k: keyof StatusCounts) =>
    s ? (s[k] ?? 0) : null;
  const total = totalOf(c);
  return {
    total: kpi(total, p ? totalOf(p) : null),
    newLeads: kpi(c.new ?? 0, pick(p, 'new')),
    caring: kpi(c.caring ?? 0, pick(p, 'caring')),
    handedOver: kpi(c.handed_over ?? 0, pick(p, 'handed_over')),
    converted: kpi(c.converted ?? 0, pick(p, 'converted')),
    conversionRate: {
      ...kpi(conversionRate(c), p ? conversionRate(p) : null),
      rateOfAllLeads: ratePct(c.converted ?? 0, total),
    },
    avgHoursToHandover: durationKpi(
      cur.avgHoursToHandover,
      prev ? prev.avgHoursToHandover : null,
    ),
    avgHoursToFirstOrder: durationKpi(
      cur.avgHoursToFirstOrder,
      prev ? prev.avgHoursToFirstOrder : null,
    ),
  };
}

const FUNNEL_LABEL: Record<LeadFunnelStage['key'], string> = {
  lead: 'Lead',
  caring: 'Chăm sóc',
  handed_over: 'Chuyển Sale',
  has_customer: 'Có mã KH',
  ordered: 'Đặt hàng',
};

export function buildFunnel(
  counts: Record<LeadFunnelStage['key'], number>,
): LeadFunnelStage[] {
  const keys: LeadFunnelStage['key'][] = [
    'lead',
    'caring',
    'handed_over',
    'has_customer',
    'ordered',
  ];
  const top = counts.lead;
  return keys.map((key, i) => {
    const count = counts[key];
    const prev = i === 0 ? null : counts[keys[i - 1]];
    return {
      key,
      label: FUNNEL_LABEL[key],
      count,
      pctOfTop: ratePct(count, top),
      dropCount: prev === null ? null : prev - count,
      dropPct: prev === null ? null : ratePct(prev - count, prev),
    };
  });
}

/** Map<key, count> từ kết quả groupBy dạng { [by]: key, _count: { _all } }. */
export function countMap<K extends string | number | null>(
  rows: { _count: { _all: number } }[],
  by: string,
): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) {
    m.set((r as unknown as Record<string, K>)[by], r._count._all);
  }
  return m;
}

export function buildSourceRows(input: {
  leads: Map<string, number>;
  converted: Map<string, number>;
  cancelled: Map<string, number>;
  previous: Map<string, number> | null;
}): LeadSourceRow[] {
  const total = [...input.leads.values()].reduce((s, n) => s + n, 0);
  const known = LEAD_SOURCES as readonly string[];
  const extra = [...input.leads.keys()].filter((s) => !known.includes(s));
  return [...known, ...extra]
    .map((source) => {
      const leads = input.leads.get(source) ?? 0;
      const converted = input.converted.get(source) ?? 0;
      const cancelled = input.cancelled.get(source) ?? 0;
      const previousLeads = input.previous?.get(source) ?? 0;
      return {
        source,
        leads,
        converted,
        conversionRate: ratePct(converted, leads - cancelled),
        sharePct: ratePct(leads, total),
        previousLeads,
        leadsChangePct: input.previous ? changePct(leads, previousLeads) : null,
      };
    })
    .filter((r) => r.leads > 0 || r.previousLeads > 0);
}

/** Tên hiển thị cho id người dùng; 0/null = chưa gán. */
const nameOf = (names: Map<number, string>, id: number, unassigned: string) =>
  id === 0 ? unassigned : (names.get(id) ?? `#${id}`);

export function buildCskhRows(input: {
  received: Map<number | null, number>;
  cared: Map<number | null, number>;
  handedOver: Map<number | null, number>;
  converted: Map<number | null, number>;
  cancelled: Map<number | null, number>;
  overdueNew: Map<number | null, number>;
  firstResponseMinutes: Map<number | null, number>;
  names: Map<number, string>;
}): LeadCskhRow[] {
  const ids = new Set<number | null>([
    ...input.received.keys(),
    ...input.overdueNew.keys(),
  ]);
  return [...ids]
    .map((key) => {
      const g = (m: Map<number | null, number>) => m.get(key) ?? 0;
      const userId = key ?? 0;
      return {
        userId,
        name: nameOf(input.names, userId, 'Chưa gán CSKH'),
        received: g(input.received),
        cared: g(input.cared),
        handedOver: g(input.handedOver),
        converted: g(input.converted),
        conversionRate: ratePct(
          g(input.converted),
          g(input.received) - g(input.cancelled),
        ),
        avgFirstResponseMinutes: input.firstResponseMinutes.get(key) ?? null,
        overdueNew: g(input.overdueNew),
      };
    })
    .sort((a, b) => b.received - a.received || b.overdueNew - a.overdueNew);
}

export function buildSaleRows(input: {
  received: Map<number | null, number>;
  withCustomer: Map<number | null, number>;
  ordered: Map<number | null, number>;
  cancelled: Map<number | null, number>;
  overdueNoOrder: Map<number | null, number>;
  avgDaysToFirstOrder: Map<number | null, number>;
  names: Map<number, string>;
}): LeadSalePicRow[] {
  const ids = new Set<number | null>([
    ...input.received.keys(),
    ...input.overdueNoOrder.keys(),
  ]);
  ids.delete(null); // lead chưa có Sale PIC không thuộc bảng Sale
  return [...ids]
    .map((key) => {
      const g = (m: Map<number | null, number>) => m.get(key) ?? 0;
      const userId = key as number;
      return {
        userId,
        name: nameOf(input.names, userId, 'Chưa gán Sale'),
        received: g(input.received),
        withCustomer: g(input.withCustomer),
        ordered: g(input.ordered),
        conversionRate: ratePct(
          g(input.ordered),
          g(input.received) - g(input.cancelled),
        ),
        avgDaysToFirstOrder: input.avgDaysToFirstOrder.get(key) ?? null,
        overdueNoOrder: g(input.overdueNoOrder),
      };
    })
    .sort((a, b) => b.received - a.received);
}

/** Trung bình theo nhóm: [nhóm, giá trị][] → Map<nhóm, TB (1 chữ số)>. */
export function avgBy<K>(pairs: [K, number][]): Map<K, number> {
  const acc = new Map<K, { s: number; n: number }>();
  for (const [k, v] of pairs) {
    if (!(v >= 0)) continue;
    const cur = acc.get(k) ?? { s: 0, n: 0 };
    cur.s += v;
    cur.n += 1;
    acc.set(k, cur);
  }
  return new Map([...acc].map(([k, { s, n }]) => [k, round1(s / n)]));
}

// ───────────────────────── chuyển giao lỗi ─────────────────────────

/** Bước đầu tiên đang "failed" của một lần chuyển giao (steps JSON); null nếu không có. */
export function failedHandoverStep(
  steps: unknown,
): { step: HandoverStep; error: string } | null {
  if (!steps || typeof steps !== 'object') return null;
  const s = steps as Record<string, { status?: string; error?: string }>;
  for (const step of HANDOVER_STEPS) {
    if (s[step]?.status === 'failed') {
      return { step, error: s[step].error?.trim() || 'Không rõ lỗi' };
    }
  }
  return null;
}
