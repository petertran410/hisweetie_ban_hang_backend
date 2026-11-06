import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalyticsReportsService,
  CardValue,
  LineAgg,
  MetricRow,
  MetricValues,
} from '../analytics-reports.service';
import { AnalyticsBusinessQueryDto } from '../dto';
import {
  CALENDAR_START,
  CurrentPeriod,
  IsoDate,
  addDays,
  compareWindow,
  currentPeriod,
  daxDate,
  diffDays,
  edate,
  isoWeekday,
  listDates,
  parts,
  todayVn,
} from './analytics-period';
import {
  KH_METRICS,
  KhCustomerListItemDto,
  KhListKey,
  KhSalePicDto,
  KhSalePicUpdateDto,
  KhSaleRepRuleDto,
  KhSaleRepRuleUpdateDto,
  KhachHangDemandQueryDto,
  KhachHangQueryDto,
  KhachHangWeeklyQueryDto,
  KhMetric,
} from './analytics-khach-hang.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Phân tích › Khách Hàng (report Power BI "Báo Cáo Khách Hàng", dataset_sale):
// trang Tất Cả, VIP, Key Persale, New / Repeat / Churn Customer, Demand.
// Dựa trên bộ tính chung AnalyticsReportsService.baseCtes (hoá đơn sale, status <> 2,
// ngày VN, gộp hoá đơn cũ) + CTE riêng:
//   kinv  = invx + bộ lọc khách riêng (loại khách, tên khách, nhóm VIP/KEY)
//           + cờ is_l1 (Key PerSale) / is_l2 (VIP lớp 2) / new_cust (khách mới trong tháng)
//   kline = dòng hàng (line_raw) + cùng bộ lọc khách + bộ lọc hàng (nhóm 2026, ngành
//           hàng, thương hiệu, giai đoạn SP mới, sản phẩm)
// Cấu hình thay Excel / DAX viết cứng: analytics_customer_lists, analytics_customer_sale_pics,
// analytics_customer_sale_rep_rules (pbi-extract/seed/khach-hang-tables.sql).
// ═══════════════════════════════════════════════════════════════════════════

const BLANK = '__blank__';
/** dim_customer_group của Power BI bỏ các nhóm này (power_query.m). */
const EXCLUDED_GROUP_IDS = [14, 20, 7, 4, 15, 31, 5, 17, 18, 19, 13, 21, 6];
const CUSTOMER_TYPES = ['Khách buôn', 'Khách chuỗi', 'Khách lẻ'];
/** dim_product[new_product_phase] (theo số ngày từ lần bán đầu tiên tới hôm nay). */
export const PRODUCT_PHASES = [
  'Mới (0-30 ngày)',
  'Giai đoạn 2 (31-60 ngày)',
  'Giai đoạn 3 (61-90 ngày)',
  'Ngoài 90 ngày',
  'Không Bán',
];

interface CteOpts {
  /** Thêm cờ new_cust (invoice[Is New Customer This Month]). */
  firstPurchase?: boolean;
  /** dim_customer_group[name] CONTAINS … (trang VIP / Key Persale). */
  groupContains?: string[];
}

type Row = Record<string, unknown>;

// ── Tuần kiểu Power BI: WEEKNUM(date, 2) — tuần bắt đầu thứ 2, tuần 1 chứa ngày 1/1.
const jan1Dow = (year: number) => isoWeekday(`${year}-01-01`);
/** Số tuần trong năm của ngày (dim_date[Week Number]). */
export function weekNum(d: IsoDate): number {
  const y = parts(d).y;
  const doy = diffDays(`${y}-01-01`, d) + 1;
  return Math.floor((doy - 1 + jan1Dow(y) - 1) / 7) + 1;
}
/** Ngày đầu / cuối của tuần w trong năm (cắt theo năm, như ALL(dim_date) + Year + Week Number). */
function weekRange(year: number, w: number): { from: IsoDate; to: IsoDate } {
  const jan1 = `${year}-01-01`;
  const firstEnd = addDays(jan1, 7 - jan1Dow(year));
  const from = w <= 1 ? jan1 : addDays(firstEnd, 1 + 7 * (w - 2));
  let to = w <= 1 ? firstEnd : addDays(from, 6);
  if (to > `${year}-12-31`) to = `${year}-12-31`;
  return { from, to };
}
/** dim_date[Week Visual]: "Tuần N (dd/MM - dd/MM)" theo thứ 2 – chủ nhật của tuần chứa ngày. */
function weekLabel(d: IsoDate): string {
  const mon = addDays(d, 1 - isoWeekday(d));
  const sun = addDays(mon, 6);
  const dm = (x: IsoDate) => `${x.slice(8, 10)}/${x.slice(5, 7)}`;
  return `Tuần ${weekNum(d)} (${dm(mon)} - ${dm(sun)})`;
}
/** Biểu thức SQL WEEKNUM(x.d, 2). */
const WEEK_SQL = Prisma.sql`((extract(doy FROM x.d)::int + extract(isodow FROM date_trunc('year', x.d))::int - 2) / 7 + 1)`;

type WeekCell = { v: number | null; w: number | null };

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) =>
  v === null || v === undefined ? '' : String(v as string | number);

@Injectable()
export class AnalyticsKhachHangService {
  constructor(
    private prisma: PrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Tất Cả
  // ─────────────────────────────────────────────────────────────────────────
  async getOverview(q: KhachHangQueryDto) {
    const axis = q.axis ?? 'month';
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      todayVn(),
    );
    const productFilter = this.productFilter(q);
    const updatedAt = new Date().toISOString();
    if (!period) {
      return {
        period: null,
        compareLabel: null,
        productFilter,
        axis,
        updatedAt,
        cards: null,
        charts: null,
      };
    }
    const cmp = compareWindow(period);
    const curCond = this.base.periodCond(period);
    const cmpCond = Prisma.sql`x.d BETWEEN ${cmp.from}::date AND ${cmp.to}::date`;
    const ranges = this.base.sameYearRanges(period, q.year, axis);
    const ax = this.base.axisExpr(axis);
    const opts: CteOpts = { firstPurchase: true };
    const lm = this.lineMetrics(productFilter);
    const lmNoBrand = this.lineMetrics(
      this.productFilter({ ...q, brand: undefined }),
    );

    // 3 câu chạy song song: kỳ hiện tại (số theo trục / nhóm), kỳ hiện tại (Top 10 + tỉnh),
    // kỳ so sánh + "năm trước" (1 câu, mỗi câu CTE chỉ tính 1 lần).
    const pr = ranges.length ? this.base.rangeSql(ranges) : null;
    const cmpPrevCond = pr ? Prisma.sql`(${cmpCond} OR ${pr.cond})` : cmpCond;
    const prevJoin = pr
      ? Prisma.sql`JOIN (VALUES ${pr.values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t`
      : Prisma.sql`JOIN (SELECT NULL::int AS k) r ON false`;
    const [curRows, topRows, cmpRows] = await Promise.all([
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, curCond, opts)}
        ${this.jsonSelect({
          inv: Prisma.sql`
            SELECT
              CASE WHEN GROUPING(x.k) = 0 THEN 'period' WHEN GROUPING(x.m) = 0 THEN 'mctype'
                   WHEN GROUPING(x.region) = 0 THEN 'region' ELSE 'total' END AS dim,
              x.k::text AS k, x.m, COALESCE(x.customer_type, x.region) AS key,
              ${this.base.invMetrics()}, ${this.extraMetrics()}
            FROM (SELECT x.*, ${ax} AS k, extract(month FROM x.d)::int AS m FROM kinv x) x
            GROUP BY GROUPING SETS ((), (x.k), (x.m, x.customer_type), (x.region))`,
          // Cấp dòng hàng: đủ 4 chỉ số cho trục sản phẩm (nhóm hàng, danh mục); các trục khác chỉ
          // cần Sản lượng (+ Doanh số) trừ khi đang lọc theo hàng → bỏ COUNT DISTINCT cho nhanh.
          line: Prisma.sql`
            SELECT
              CASE WHEN GROUPING(x.product_type) = 0 THEN 'mptype' ELSE 'category' END AS dim,
              NULL AS k, x.m, COALESCE(x.product_type, x.category) AS key,
              ${this.base.lineMetrics()}
            FROM (SELECT x.*, extract(month FROM x.d)::int AS m FROM kline x) x
            GROUP BY GROUPING SETS ((x.m, x.product_type), (x.category))
            UNION ALL
            SELECT
              CASE WHEN GROUPING(x.k) = 0 THEN 'period' WHEN GROUPING(x.customer_type) = 0 THEN 'mctype'
                   WHEN GROUPING(x.region) = 0 THEN 'region' ELSE 'total' END,
              x.k::text, x.m, COALESCE(x.customer_type, x.region), ${lm}
            FROM (SELECT x.*, ${ax} AS k, extract(month FROM x.d)::int AS m FROM kline x) x
            GROUP BY GROUPING SETS ((), (x.k), (x.m, x.customer_type), (x.region))`,
        })}`),
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, curCond)}
        ${this.jsonSelect({
          // Top 10: xếp theo dim_customers[name], cộng theo khách cha.
          names: Prisma.sql`
            SELECT 'inv' AS src, GROUPING(x.parent_name) AS g, x.cname, x.parent_name,
                   ${this.base.invMetrics()}, 0::float8 AS quantity
            FROM (SELECT x.*, COALESCE(kn.name, ${BLANK}) AS cname FROM kinv x
                  LEFT JOIN kname kn ON kn.code = x.customer_code) x
            GROUP BY GROUPING SETS ((x.cname), (x.cname, x.parent_name))
            UNION ALL
            SELECT 'line', GROUPING(x.parent_name), x.cname, x.parent_name, ${lm}
            FROM (SELECT x.*, COALESCE(kn.name, ${BLANK}) AS cname FROM kline x
                  LEFT JOIN kname kn ON kn.code = x.customer_code) x
            GROUP BY GROUPING SETS ((x.cname), (x.cname, x.parent_name))`,
          // Bản đồ theo tỉnh: switch_dynamics_metrics_all_brand (bỏ lọc thương hiệu).
          prov: Prisma.sql`
            SELECT 'inv' AS src, kn.province AS key, ${this.base.invMetrics()}, 0::float8 AS quantity
            FROM kinv x LEFT JOIN kname kn ON kn.code = x.customer_code GROUP BY kn.province
            UNION ALL
            SELECT 'line', kn.province, ${lmNoBrand}
            FROM kline_all x LEFT JOIN kname kn ON kn.code = x.customer_code GROUP BY kn.province`,
        })}`),
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, cmpPrevCond, opts)}
        ${this.jsonSelect({
          cmp: Prisma.sql`
            SELECT ${this.base.invMetrics()}, ${this.extraMetrics()},
                   (SELECT COALESCE(SUM(l.sub_total) FILTER (WHERE l.ok), 0)::float8 FROM kline l
                    WHERE l.d BETWEEN ${cmp.from}::date AND ${cmp.to}::date) AS line_amount
            FROM kinv x WHERE ${cmpCond}`,
          // "Năm trước" theo từng điểm trục (switch_dynamics_metrics_sameYear).
          prev: Prisma.sql`
            SELECT 'inv' AS src, r.k::text AS key, ${this.base.invMetrics()}, 0::float8 AS quantity
            FROM kinv x ${prevJoin} GROUP BY r.k
            UNION ALL
            SELECT 'line', r.k::text, ${lm}
            FROM kline x ${prevJoin} GROUP BY r.k`,
        })}`),
    ]);
    const res = curRows[0] ?? {};
    const invRows = (res.inv ?? []) as Row[];
    const lineRows = (res.line ?? []) as Row[];
    const nameRows = (topRows[0]?.names ?? []) as Row[];
    const provRows = (topRows[0]?.prov ?? []) as Row[];
    const cmpRow = ((cmpRows[0]?.cmp ?? []) as Row[])[0];
    const prevRows = (cmpRows[0]?.prev ?? []) as Row[];

    // ── Gom số
    const inv = this.dimMap(invRows);
    const line = this.dimMap(lineRows);
    const get = (m: Map<string, Row>, k: string) => m.get(k);
    const invTotal = get(inv, 'total|||');
    const lineTotal = get(line, 'total|||');
    const pick = (i: Row | undefined, l: Row | undefined, useLine: boolean) =>
      this.base.pick(
        i ? this.agg(i) : undefined,
        l ? this.agg(l) : undefined,
        useLine,
        null,
      );

    // ── Thẻ (giá trị cấp hoá đơn; % so kỳ trước theo DAX growth_*_samePeriod)
    const c = cmpRow ?? {};
    const cur = {
      revenue: num(invTotal?.amount),
      orders: num(invTotal?.orders),
      customers: num(invTotal?.customers),
      newCustomers: num(invTotal?.new_customers),
      revNew: num(invTotal?.rev_new),
      revL1: num(invTotal?.rev_l1),
      revL2: num(invTotal?.rev_l2),
      lineAmount: num(lineTotal?.amount),
    };
    const prev = {
      revenue: num(c.amount),
      orders: num(c.orders),
      customers: num(c.customers),
      newCustomers: num(c.new_customers),
      revNew: num(c.rev_new),
      revL1: num(c.rev_l1),
      revL2: num(c.rev_l2),
      lineAmount: num(c.line_amount),
    };
    // growth_revenue_samePeriod dùng switch_revenue (lọc hàng → Revenue Detail),
    // còn thẻ hiển thị [Revenue] cấp hoá đơn.
    const swCur = productFilter ? cur.lineAmount : cur.revenue;
    const swPrev = productFilter ? prev.lineAmount : prev.revenue;
    const cards = {
      revenue: {
        current: cur.revenue,
        previous: swPrev,
        growth: swPrev ? (swCur - swPrev) / swPrev : null,
      } as CardValue,
      newCustomers: this.base.card(cur.newCustomers, prev.newCustomers),
      revenueNew: this.base.card(cur.revNew, prev.revNew),
      keyPerSale: this.base.card(cur.revL1, prev.revL1),
      vip: this.base.card(cur.revL2, prev.revL2),
      activeCustomers: this.base.card(cur.customers, prev.customers),
      aov: this.base.card(
        this.base.div(cur.revenue, cur.orders),
        this.base.div(prev.revenue, prev.orders),
      ),
      arpc: this.base.card(
        this.base.div(cur.revenue, cur.customers),
        this.base.div(prev.revenue, prev.customers),
      ),
    };

    // ── Xu hướng năm nay / năm trước
    const prevInv = new Map<string, Row>();
    const prevLine = new Map<string, Row>();
    for (const r of prevRows)
      (r.src === 'inv' ? prevInv : prevLine).set(String(r.key), r);
    const trend = this.base.axisKeys(period, q.year, axis).map((k) => ({
      key: k,
      label: this.base.axisLabel(axis, Number(k)),
      current: {
        ...pick(
          get(inv, `period|${k}||`),
          get(line, `period|${k}||`),
          productFilter,
        ),
        key: k,
      },
      previous: {
        ...pick(prevInv.get(k), prevLine.get(k), productFilter),
        key: k,
      },
    }));

    // ── Theo tháng × nhóm hàng / loại khách (100% stacked)
    const byMonth = (
      dim: 'mptype' | 'mctype',
      useLine: boolean,
    ): (MetricRow & { m: number })[] => {
      const out: (MetricRow & { m: number })[] = [];
      const keys = new Set<string>();
      for (const k of [...inv.keys(), ...line.keys()])
        if (k.startsWith(`${dim}|`)) keys.add(k);
      for (const k of keys) {
        const [, , m, key] = k.split('|');
        const row = pick(get(inv, k), get(line, k), useLine);
        out.push({ ...row, m: Number(m), key: key === '' ? null : key });
      }
      return out.sort((a, b) => a.m - b.m);
    };

    const list = (dim: string, useLine: boolean): MetricRow[] => {
      const keys = new Set<string>();
      for (const k of [...inv.keys(), ...line.keys()])
        if (k.startsWith(`${dim}|`)) keys.add(k);
      return [...keys].map((k) => {
        const key = k.split('|')[3];
        return {
          ...pick(get(inv, k), get(line, k), useLine),
          key: key || null,
        };
      });
    };

    // ── Top 10: TopN theo dim_customers[name], trục là khách cha
    const topParents = this.topParents(nameRows, productFilter);

    // ── Bản đồ tỉnh (bỏ lọc thương hiệu khi xét ISFILTERED(dim_product))
    const pfNoBrand = this.productFilter({ ...q, brand: undefined });
    const provInv = new Map<string, Row>();
    const provLine = new Map<string, Row>();
    for (const r of provRows)
      (r.src === 'inv' ? provInv : provLine).set(str(r.key), r);
    const byProvince = [...new Set([...provInv.keys(), ...provLine.keys()])]
      .map((k) => ({
        ...pick(provInv.get(k), provLine.get(k), pfNoBrand),
        key: k || null,
      }))
      .filter((r) => r.amount || r.orders || r.quantity);

    return {
      period: this.periodInfo(period, q.year),
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      productFilter,
      axis,
      updatedAt,
      cards,
      charts: {
        trend,
        byMonthProductType: byMonth('mptype', true),
        byMonthCustomerType: byMonth('mctype', productFilter),
        byRegion: list('region', productFilter),
        byCategory: list('category', true),
        byProvince,
        topParents,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang VIP / Key Persale (cùng bố cục): % WoW theo khách cha + bảng theo tuần
  // ─────────────────────────────────────────────────────────────────────────
  async getWeekly(q: KhachHangWeeklyQueryDto, kind: 'vip' | 'key') {
    const metric: KhMetric = q.metric ?? 'amount';
    const today = todayVn();
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      today,
    );
    const productFilter = this.productFilter(q);
    const updatedAt = new Date().toISOString();
    const empty = {
      period: period ? this.periodInfo(period, q.year) : null,
      productFilter,
      metric,
      updatedAt,
      weekOptions: [] as { wk: number; label: string }[],
      weeks: [] as { wk: number; label: string }[],
      currentWeek: null as { wk: number; label: string } | null,
      increase: [] as { name: string; value: number }[],
      decrease: [] as { name: string; value: number }[],
      pivot: null as {
        total: Record<number, WeekCell>;
        parents: {
          name: string;
          cells: Record<number, WeekCell>;
          products: {
            code: string;
            name: string;
            cells: Record<number, WeekCell>;
          }[];
        }[];
      } | null,
    };
    if (!period) return empty;

    // "Chọn Tuần" lấy theo các ngày đang lọc (năm + tháng).
    const allDates = listDates(period, q.year);
    const labelOf = new Map<number, string>();
    for (const d of allDates)
      if (!labelOf.has(weekNum(d))) labelOf.set(weekNum(d), weekLabel(d));
    empty.weekOptions = [...labelOf].map(([wk, label]) => ({ wk, label }));
    const dates = q.week
      ? allDates.filter((d) => weekNum(d) === q.week)
      : allDates;
    if (!dates.length) return empty;
    const weeks = [...new Set(dates.map(weekNum))].sort((a, b) => a - b);
    const maxW = weeks[weeks.length - 1];
    // Revenue WoW %: cả tuần (ALL(dim_date)) của tuần W và W-1 trong cùng năm.
    const from = weekRange(q.year, Math.max(1, weeks[0] - 1)).from;
    let to = weekRange(q.year, maxW).to;
    if (to > today) to = today;
    const wideCond = Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date`;
    const groupContains = kind === 'vip' ? ['VIP'] : ['KEY', 'VIP'];
    const full = metric === 'orders' || metric === 'customers';
    const cnt = (sql: Prisma.Sql) => (full ? sql : Prisma.sql`0`);

    const rows = await this.run(Prisma.sql`
      WITH ${await this.ctes(q, wideCond, { groupContains })},
      pname AS (SELECT DISTINCT ON (code) code, name FROM products ORDER BY code, id)
      ${this.jsonSelect({
        line: Prisma.sql`
          SELECT CASE WHEN GROUPING(x.product_code) = 0 THEN 'pp'
                      WHEN GROUPING(x.parent_name) = 0 THEN 'p' ELSE 't' END AS lvl,
                 x.parent_name, x.product_code, x.wk,
                 COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS rev_full,
                 COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok AND x.inp), 0)::float8 AS amount,
                 ${cnt(Prisma.sql`COUNT(DISTINCT x.code) FILTER (WHERE x.ok AND x.inp)`)}::int AS orders,
                 ${cnt(Prisma.sql`COUNT(DISTINCT COALESCE(x.customer_code, ${BLANK})) FILTER (WHERE x.ok AND x.inp)`)}::int AS customers,
                 COALESCE(SUM(x.quantity) FILTER (WHERE x.inp), 0)::float8 AS quantity,
                 bool_or(x.inp) AS has_inp
          FROM (SELECT x.*, ${WEEK_SQL} AS wk, (x.d = ANY(${dates}::date[])) AS inp FROM kline x) x
          GROUP BY GROUPING SETS ((x.parent_name, x.product_code, x.wk), (x.parent_name, x.wk), (x.wk))`,
        inv: Prisma.sql`
          SELECT CASE WHEN GROUPING(x.parent_name) = 0 THEN 'p' ELSE 't' END AS lvl,
                 x.parent_name, x.wk, ${this.base.invMetrics()}
          FROM (SELECT x.*, ${WEEK_SQL} AS wk FROM kinv x WHERE x.d = ANY(${dates}::date[])) x
          GROUP BY GROUPING SETS ((x.parent_name, x.wk), (x.wk))`,
        pnames: Prisma.sql`
          SELECT code, name FROM pname WHERE code IN (SELECT DISTINCT product_code FROM kline)`,
      })}`);
    const res = rows[0] ?? {};
    const lineRows = (res.line ?? []) as Row[];
    const invRows = (res.inv ?? []) as Row[];
    const pnames = new Map(
      ((res.pnames ?? []) as Row[]).map((r) => [str(r.code), str(r.name)]),
    );

    const key = (lvl: string, parent: unknown, code: unknown, wk: unknown) =>
      `${lvl}|${str(parent)}|${str(code)}|${str(wk)}`;
    const line = new Map<string, Row>();
    for (const r of lineRows)
      line.set(key(str(r.lvl), r.parent_name, r.product_code, r.wk), r);
    const inv = new Map<string, Row>();
    for (const r of invRows)
      inv.set(key(str(r.lvl), r.parent_name, '', r.wk), r);

    const wow = (lvl: string, parent: unknown, code: unknown, wk: number) => {
      const cur = num(line.get(key(lvl, parent, code, wk))?.rev_full);
      const last = num(line.get(key(lvl, parent, code, wk - 1))?.rev_full);
      return last ? (cur - last) / last : null;
    };
    const value = (lvl: string, parent: unknown, code: unknown, wk: number) => {
      const l = line.get(key(lvl, parent, code, wk));
      const lIn = l && l.has_inp ? l : undefined;
      if (lvl === 'pp') return lIn ? this.agg(lIn)[metric] : null;
      // Dòng khách cha / tổng: không lọc hàng → số cấp hoá đơn.
      const i = inv.get(key(lvl, parent, '', wk));
      if (!i && !lIn) return null;
      return this.base.pick(
        i ? this.agg(i) : undefined,
        lIn ? this.agg(lIn) : undefined,
        productFilter,
        null,
      )[metric];
    };
    const cells = (lvl: string, parent: unknown, code: unknown) => {
      const out: Record<number, WeekCell> = {};
      for (const wk of weeks)
        out[wk] = {
          v: value(lvl, parent, code, wk),
          w: wow(lvl, parent, code, wk),
        };
      return out;
    };
    const hasAny = (c: Record<number, WeekCell>) =>
      Object.values(c).some((x) => x.v !== null || x.w !== null);

    // Khách cha / sản phẩm có số trong các tuần đang xem.
    const parents = new Set<string | null>();
    const products = new Map<string | null, Set<string>>();
    for (const r of lineRows) {
      if (r.lvl === 't') continue;
      const p = (r.parent_name as string | null) ?? null;
      parents.add(p);
      if (r.lvl === 'pp') {
        if (!products.has(p)) products.set(p, new Set());
        products.get(p)!.add(str(r.product_code));
      }
    }
    const byName = (a: string, b: string) => a.localeCompare(b, 'vi');
    const pivotParents = [...parents]
      .map((p) => ({
        name: p ?? '',
        cells: cells('p', p, ''),
        products: [...(products.get(p) ?? [])]
          .map((code) => ({
            code,
            name: pnames.get(code) ?? code,
            cells: cells('pp', p, code),
          }))
          .filter((x) => hasAny(x.cells))
          .sort((a, b) => byName(a.name, b.name)),
      }))
      .filter((x) => hasAny(x.cells) || x.products.length)
      .sort((a, b) => byName(a.name, b.name));

    // 10 KH tăng / giảm mua: Revenue WoW % của tuần lớn nhất đang lọc.
    const wows = [...parents]
      .map((p) => ({ name: p ?? '', value: wow('p', p, '', maxW) }))
      .filter((r): r is { name: string; value: number } => r.value !== null);
    // TopN của Power BI giữ cả các khách bằng giá trị thứ 10.
    const topN = (list: { name: string; value: number }[], dir: 1 | -1) => {
      const sorted = list.sort(
        (a, b) =>
          dir * (b.value - a.value) || a.name.localeCompare(b.name, 'vi'),
      );
      const cut = sorted[Math.min(9, sorted.length - 1)]?.value;
      return sorted.filter((r, i) => i < 10 || r.value === cut);
    };
    const increase = topN(
      wows.filter((r) => r.value > 0),
      1,
    );
    const decrease = topN(
      wows.filter((r) => r.value < 0),
      -1,
    );

    return {
      ...empty,
      weeks: weeks.map((wk) => ({
        wk,
        label: labelOf.get(wk) ?? `Tuần ${wk}`,
      })),
      currentWeek: { wk: maxW, label: labelOf.get(maxW) ?? `Tuần ${maxW}` },
      increase,
      decrease,
      pivot: { total: cells('t', '', ''), parents: pivotParents },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Repeat Customer (RC …): cần đúng 1 tháng (SELECTEDVALUE MonthStartDate)
  // ─────────────────────────────────────────────────────────────────────────
  async getRepeat(q: KhachHangQueryDto) {
    const today = todayVn();
    const updatedAt = new Date().toISOString();
    const productFilter = this.productFilter(q);
    const month = q.months?.length === 1 ? q.months[0] : null;
    const M = month ? daxDate(q.year, month, 1) : null;
    if (!month || !M || M > today || M < CALENDAR_START) {
      return { month: null, needMonth: !month, productFilter, updatedAt };
    }
    let mEnd = daxDate(q.year, month + 1, 0);
    if (mEnd > today) mEnd = today;
    const p1 = edate(M, -1); // tháng trước
    const p1End = addDays(M, -1);
    const p2 = edate(M, -2);
    const p3 = edate(M, -3);
    const bucket = Prisma.sql`CASE WHEN x.d >= ${M}::date THEN 2 WHEN x.d >= ${p1}::date THEN 1
      WHEN x.d >= ${p2}::date THEN 0 ELSE -1 END`;

    const [segRows, lineRows] = await Promise.all([
      // Khách cha theo tháng (M, M-1, M-2) × loại khách × team × vùng; mua lần đầu (trong bộ lọc).
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, Prisma.sql`x.d <= ${mEnd}::date`)}
        ${this.jsonSelect({
          seg: Prisma.sql`
            SELECT x.parent_name, x.customer_type, kc.team_name, x.region, ${bucket} AS b
            FROM kinv x LEFT JOIN kcust kc ON kc.code = x.customer_code
            WHERE x.ok AND x.d >= ${p2}::date AND x.parent_name IS NOT NULL
            GROUP BY 1, 2, 3, 4, 5`,
          first: Prisma.sql`
            SELECT x.parent_name, MIN(x.d)::text AS first_d FROM kinv x
            WHERE x.ok AND x.parent_name IS NOT NULL
              AND x.parent_name IN (SELECT parent_name FROM kinv WHERE d >= ${M}::date)
            GROUP BY 1`,
          active: Prisma.sql`
            SELECT COUNT(DISTINCT COALESCE(x.parent_name, ${BLANK})) FILTER (WHERE x.ok)::int AS n
            FROM kinv x WHERE x.d >= ${M}::date`,
        })}`),
      // Dòng hàng 3 tháng trước M: doanh số khách cần chăm sóc + danh sách hành động theo SKU.
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, Prisma.sql`x.d BETWEEN ${p3}::date AND ${p1End}::date`)},
        pname AS (SELECT DISTINCT ON (code) code, name FROM products ORDER BY code, id)
        ${this.jsonSelect({
          sku: Prisma.sql`
            SELECT x.parent_name, kc.sale_rep, x.product_code, MAX(pn.name) AS product_name,
              COALESCE(SUM(x.quantity) FILTER (WHERE x.d >= ${p1}::date), 0)::float8 AS qty_prev,
              COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok AND x.d >= ${p1}::date), 0)::float8 AS rev_prev,
              COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS rev_3m,
              MAX(x.d) FILTER (WHERE x.d >= ${p1}::date)::text AS last_d
            FROM kline x
            LEFT JOIN kcust kc ON kc.code = x.customer_code
            LEFT JOIN pname pn ON pn.code = x.product_code
            WHERE x.parent_name IS NOT NULL
            GROUP BY 1, 2, 3`,
        })}`),
    ]);

    const seg = (segRows[0]?.seg ?? []) as Row[];
    const firstD = new Map(
      ((segRows[0]?.first ?? []) as Row[]).map((r) => [
        str(r.parent_name),
        str(r.first_d),
      ]),
    );
    const active = num(((segRows[0]?.active ?? []) as Row[])[0]?.n);
    const sku = (lineRows[0]?.sku ?? []) as Row[];

    // Tập khách cha theo tháng (b = 2: M, 1: M-1, 0: M-2) cho 1 phân khúc.
    const sets = (pred: (r: Row) => boolean) => {
      const s = [new Set<string>(), new Set<string>(), new Set<string>()];
      for (const r of seg) {
        const b = num(r.b);
        if (b >= 0 && pred(r)) s[b].add(str(r.parent_name));
      }
      return { m2: s[0], m1: s[1], m0: s[2] };
    };
    const inter = (a: Set<string>, b: Set<string>) =>
      [...a].filter((x) => b.has(x)).length;
    const rate = (pred: (r: Row) => boolean) => {
      const s = sets(pred);
      return s.m1.size ? inter(s.m0, s.m1) / s.m1.size : null;
    };

    const all = sets(() => true);
    const repeat = inter(all.m0, all.m1);
    const repeatPrev = inter(all.m1, all.m2);
    const retention = all.m1.size ? repeat / all.m1.size : null;
    const retentionPrev = all.m2.size ? repeatPrev / all.m2.size : null;
    const isNew = (p: string) => (firstD.get(p) ?? '') >= M;
    const reacquired = [...all.m0].filter(
      (p) => !all.m1.has(p) && !isNew(p),
    ).length;
    const care = [...all.m1].filter((p) => !all.m0.has(p));
    const careSet = new Set(care);
    const careRevenue = sku
      .filter((r) => careSet.has(str(r.parent_name)))
      .reduce((s, r) => s + num(r.rev_prev), 0);

    // Retention theo phân khúc (cột + 2 bảng nhiệt).
    const val = (r: Row, k: string) => (r[k] ?? null) as string | null;
    const keysOf = (k: string) => [...new Set(seg.map((r) => val(r, k)))];
    const byType = keysOf('customer_type')
      .map((t) => ({
        key: t,
        rate: rate((r) => val(r, 'customer_type') === t),
      }))
      .filter((x) => x.rate !== null)
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
    const types = byType.map((x) => x.key);
    const heat = (rowKey: string) => {
      const rows = keysOf(rowKey)
        .map((rk) => {
          const inRow = (r: Row) => val(r, rowKey) === rk;
          return {
            key: rk,
            total: rate(inRow),
            cells: Object.fromEntries(
              types.map((t) => [
                t ?? '',
                rate((r) => inRow(r) && val(r, 'customer_type') === t),
              ]),
            ),
          };
        })
        .filter((x) => x.total !== null)
        .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
      return {
        columns: types,
        rows,
        totals: Object.fromEntries(
          types.map((t) => [
            t ?? '',
            rate((r) => val(r, 'customer_type') === t),
          ]),
        ),
        grand: retention,
      };
    };

    // Danh sách hành động: SKU có doanh số tháng trước, khách cha chưa mua tháng này.
    const actions = sku
      .filter((r) => num(r.rev_prev) > 0 && !all.m0.has(str(r.parent_name)))
      .map((r) => ({
        parentName: str(r.parent_name),
        saleRep: str(r.sale_rep),
        productCode: str(r.product_code),
        productName: str(r.product_name) || str(r.product_code),
        qtyPrev: num(r.qty_prev),
        revPrev: num(r.rev_prev),
        rev3m: num(r.rev_3m),
        lastDate: r.last_d ? str(r.last_d) : null,
      }));
    const parentRev = new Map<string, number>();
    for (const a of actions)
      parentRev.set(a.parentName, (parentRev.get(a.parentName) ?? 0) + a.rev3m);
    actions.sort(
      (a, b) =>
        (parentRev.get(b.parentName) ?? 0) -
          (parentRev.get(a.parentName) ?? 0) ||
        a.parentName.localeCompare(b.parentName, 'vi') ||
        b.rev3m - a.rev3m,
    );

    return {
      month: {
        year: q.year,
        month,
        from: M,
        to: mEnd,
        prevFrom: p1,
        prevTo: p1End,
      },
      needMonth: false,
      productFilter,
      updatedAt,
      cards: {
        retention,
        retentionDeltaPp:
          retention !== null && retentionPrev !== null
            ? retention - retentionPrev
            : null,
        repeat,
        previousCustomers: all.m1.size,
        repeatMoM: repeatPrev ? (repeat - repeatPrev) / repeatPrev : null,
        repeatShare: active ? repeat / active : null,
        reacquired,
        care: care.length,
        careRevenue,
      },
      byCustomerType: byType,
      byTeam: heat('team_name'),
      byRegion: heat('region'),
      actions,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang New Customer: trang Power BI chỉ có slicer (chưa có biểu đồ) → dựng từ các
  // measure khách mới của report: New Customer, revenue_new_customer (+ so kỳ trước).
  // ─────────────────────────────────────────────────────────────────────────
  async getNewCustomers(q: KhachHangQueryDto) {
    const today = todayVn();
    const updatedAt = new Date().toISOString();
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      today,
    );
    if (!period)
      return { period: null, updatedAt, cards: null, byMonth: [], list: [] };
    const cmp = compareWindow(period);
    const opts: CteOpts = { firstPurchase: true };
    const cmpCond = Prisma.sql`x.d BETWEEN ${cmp.from}::date AND ${cmp.to}::date`;
    const [curRows, cmpRows] = await Promise.all([
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, this.base.periodCond(period), opts)}
        ${this.jsonSelect({
          months: Prisma.sql`
            SELECT CASE WHEN GROUPING(x.m) = 0 THEN 'month' ELSE 'total' END AS dim, x.m,
                   ${this.base.invMetrics()}, ${this.extraMetrics()}
            FROM (SELECT x.*, extract(month FROM x.d)::int AS m FROM kinv x) x
            GROUP BY GROUPING SETS ((), (x.m))`,
          list: Prisma.sql`
            SELECT x.parent_name, MIN(fp.first_d)::text AS first_d,
                   STRING_AGG(DISTINCT x.customer_type, ', ') AS customer_type,
                   STRING_AGG(DISTINCT x.region, ', ') AS region,
                   COUNT(DISTINCT x.code) FILTER (WHERE x.ok)::int AS orders,
                   COALESCE(SUM(x.total) FILTER (WHERE x.ok), 0)::float8 AS amount
            FROM kinv x LEFT JOIN fp ON fp.pkey = COALESCE(x.parent_name, ${BLANK})
            WHERE x.new_cust
            GROUP BY x.parent_name`,
        })}`),
      this.run(Prisma.sql`
        WITH ${await this.ctes(q, cmpCond, opts)}
        SELECT ${this.extraMetrics()} FROM kinv x`),
    ]);
    const months = (curRows[0]?.months ?? []) as Row[];
    const total = months.find((r) => r.dim === 'total') ?? {};
    const c = cmpRows[0] ?? {};
    return {
      period: this.periodInfo(period, q.year),
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      updatedAt,
      cards: {
        newCustomers: this.base.card(
          num(total.new_customers),
          num(c.new_customers),
        ),
        revenueNew: this.base.card(num(total.rev_new), num(c.rev_new)),
      },
      byMonth: period.months.map((m) => {
        const r = months.find((x) => x.dim === 'month' && num(x.m) === m) ?? {};
        return {
          m,
          newCustomers: num(r.new_customers),
          revenueNew: num(r.rev_new),
          activeCustomers: num(r.customers),
        };
      }),
      list: ((curRows[0]?.list ?? []) as Row[])
        .map((r) => ({
          parentName: (r.parent_name as string | null) ?? null,
          firstDate: r.first_d ? str(r.first_d) : null,
          customerType: (r.customer_type as string | null) ?? null,
          region: (r.region as string | null) ?? null,
          orders: num(r.orders),
          amount: num(r.amount),
        }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Churn Customer: dim_customers[churn_sale_group] = "1.Khách Churn"
  // ─────────────────────────────────────────────────────────────────────────
  async getChurn(q: KhachHangQueryDto) {
    const today = todayVn();
    const updatedAt = new Date().toISOString();
    const productFilter = this.productFilter(q);
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      today,
    );
    const lake = await this.base.dataLakeReady(); // trước custCte (vùng)

    // last_order_time = ngày mua cuối của mã khách trên toàn bảng invoice của Power BI;
    // churn_day = hôm nay - last_order_time; nhóm churn theo loại khách.
    const conds: Prisma.Sql[] = [
      Prisma.sql`(
        (lower(cu.customer_type) = lower('Khách buôn') AND cd.churn_day BETWEEN 10 AND 45)
        OR (lower(cu.customer_type) = lower('Khách chuỗi') AND cd.churn_day BETWEEN 15 AND 45)
        OR (lower(cu.customer_type) = lower('Khách lẻ') AND cd.churn_day BETWEEN 30 AND 60))`,
    ];
    if (q.customerType)
      conds.push(
        Prisma.sql`lower(cu.customer_type) = lower(${q.customerType})`,
      );
    if (q.customerName) conds.push(Prisma.sql`cb.name = ${q.customerName}`);
    if (q.region) conds.push(Prisma.sql`cu.region = ${q.region}`);
    if (q.customerGroupId)
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM customer_group_details g
        WHERE g."customerId" = cu.id AND g."customerGroupId" = ${q.customerGroupId})`);

    const custRows = await this.run(Prisma.sql`
      WITH ${this.fpInvCte(lake)},
      lo AS (
        SELECT customer_code, MAX(d) AS last_d FROM fp_inv
        WHERE customer_code IS NOT NULL GROUP BY 1
      ),
      cand AS (
        SELECT customer_code, last_d, (${today}::date - last_d) AS churn_day FROM lo
        WHERE last_d BETWEEN ${addDays(today, -60)}::date AND ${addDays(today, -10)}::date
      ),
      ${this.base.custCte(Prisma.sql`c.code IN (SELECT customer_code FROM cand)`)},
      ${this.salePicCtes(Prisma.sql`cust`)}
      SELECT cu.code, cb.name, cu.parent_name, cu.customer_type, kc.sale_pic,
             cd.last_d::text AS last_d, cd.churn_day::int AS churn_day
      FROM cust cu
      JOIN cust_base cb ON cb.id = cu.id
      JOIN cand cd ON cd.customer_code = cu.code
      LEFT JOIN kcust kc ON kc.code = cu.code
      WHERE ${Prisma.join(conds, ' AND ')}`);

    // Biểu đồ tròn "Theo người bán": số khách cha (DISTINCTCOUNTNOBLANK) theo sale_pic.
    const pic = new Map<string, Set<string>>();
    for (const r of custRows) {
      if (r.parent_name == null) continue;
      const k = str(r.sale_pic);
      if (!pic.has(k)) pic.set(k, new Set());
      pic.get(k)!.add(str(r.parent_name));
    }
    const bySalePic = [...pic.entries()]
      .map(([key, set]) => ({ key: key || null, value: set.size }))
      .sort((a, b) => b.value - a.value);

    // Bảng: giá trị (switch_dynamics_metrics) trong kỳ của từng khách / sản phẩm.
    const codes = custRows.map((r) => str(r.code));
    let invRows: Row[] = [];
    let lineRows: Row[] = [];
    if (period && codes.length) {
      const res = await this.run(Prisma.sql`
        WITH ${await this.ctes(
          q,
          // Chỉ quét hoá đơn của các khách churn (inv_raw có cột customer_code).
          Prisma.sql`${this.base.periodCond(period)} AND x.customer_code = ANY(${codes}::text[])`,
        )},
        pname AS (SELECT DISTINCT ON (code) code, name FROM products ORDER BY code, id)
        ${this.jsonSelect({
          inv: Prisma.sql`
            SELECT x.customer_code, ${this.base.invMetrics()} FROM kinv x
            WHERE x.customer_code = ANY(${codes}::text[]) GROUP BY 1`,
          line: Prisma.sql`
            SELECT x.customer_code, x.product_code, MAX(pn.name) AS product_name,
                   ${this.base.lineMetrics()}
            FROM kline x LEFT JOIN pname pn ON pn.code = x.product_code
            WHERE x.customer_code = ANY(${codes}::text[]) GROUP BY 1, 2`,
        })}`);
      invRows = (res[0]?.inv ?? []) as Row[];
      lineRows = (res[0]?.line ?? []) as Row[];
    }
    const invBy = new Map(invRows.map((r) => [str(r.customer_code), r]));
    const lineBy = new Map<string, Row[]>();
    for (const r of lineRows) {
      const k = str(r.customer_code);
      if (!lineBy.has(k)) lineBy.set(k, []);
      lineBy.get(k)!.push(r);
    }
    const add = (a: MetricValues, b: MetricValues): MetricValues => ({
      amount: a.amount + b.amount,
      orders: a.orders + b.orders,
      customers: a.customers + b.customers,
      quantity: a.quantity + b.quantity,
    });
    const zero = (): MetricValues => this.base.zero();

    // Dòng theo dim_customers[name] → sản phẩm.
    const byName = new Map<
      string,
      {
        name: string;
        lastOrder: string;
        churnDay: number;
        value: MetricValues;
        products: Map<
          string,
          { code: string; name: string; value: MetricValues }
        >;
      }
    >();
    for (const r of custRows) {
      const code = str(r.code);
      const name = str(r.name);
      const lines = lineBy.get(code) ?? [];
      const lineTotal = lines.reduce((acc, l) => add(acc, this.agg(l)), zero());
      const inv = invBy.get(code);
      const v = this.base.pick(
        inv ? this.agg(inv) : undefined,
        lines.length ? lineTotal : undefined,
        productFilter,
        null,
      );
      const e = byName.get(name) ?? {
        name,
        lastOrder: str(r.last_d),
        churnDay: 0,
        value: zero(),
        products: new Map<
          string,
          { code: string; name: string; value: MetricValues }
        >(),
      };
      if (str(r.last_d) < e.lastOrder) e.lastOrder = str(r.last_d);
      e.churnDay += num(r.churn_day);
      e.value = add(e.value, {
        amount: v.amount,
        orders: v.orders,
        customers: v.customers,
        quantity: v.quantity,
      });
      for (const l of lines) {
        const pc = str(l.product_code);
        const pe = e.products.get(pc) ?? {
          code: pc,
          name: str(l.product_name) || pc,
          value: zero(),
        };
        pe.value = add(pe.value, this.agg(l));
        e.products.set(pc, pe);
      }
      byName.set(name, e);
    }
    const rows = [...byName.values()]
      .map((e) => ({
        ...e,
        products: [...e.products.values()].sort((a, b) =>
          a.name.localeCompare(b.name, 'vi'),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    return {
      period: period ? this.periodInfo(period, q.year) : null,
      today,
      productFilter,
      updatedAt,
      bySalePic,
      totalCustomers: new Set(
        custRows
          .filter((r) => r.parent_name != null)
          .map((r) => str(r.parent_name)),
      ).size,
      rows,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Demand ("Theo Dõi Demand Maycha"). Power BI đọc fact_demand từ DB
  // sync_kiot_data (đồng bộ LarkBase); POS đã có cùng nguồn Lark ở module
  // customer-demand → dùng customer_demand_lines của các tháng CONFIRMED.
  // Khách theo dõi: danh sách demand_maycha (dim_customers[is_customer_maycha]).
  // ─────────────────────────────────────────────────────────────────────────
  async getDemand(q: KhachHangDemandQueryDto) {
    const unit = q.unit ?? 'base';
    const today = todayVn();
    const updatedAt = new Date().toISOString();
    const months = (
      q.months?.length
        ? [...new Set(q.months)]
        : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    ).sort((a, b) => a - b);
    const custFilter = q.customerCode
      ? Prisma.sql`AND c.code = ${q.customerCode}`
      : Prisma.empty;

    const [customers, demandRows] = await Promise.all([
      this.prisma.$queryRaw<{ code: string; name: string | null }[]>`
        SELECT l.customer_code AS code,
               (SELECT c.name FROM customers c WHERE c.code = l.customer_code ORDER BY c.id LIMIT 1) AS name
        FROM analytics_customer_lists l WHERE l.list_key = 'demand_maycha'
        ORDER BY 2`,
      this.prisma.$queryRaw<Row[]>`
        SELECT c.code AS customer_code, p.code AS product_code, MAX(p.name) AS product_name,
               extract(month FROM m.demand_month)::int AS m,
               SUM(l.quantity_base)::float8 AS base_qty,
               SUM(l.quantity_base / NULLIF(COALESCE(p."conversionValue", 1), 0))::float8 AS bulk_qty
        FROM customer_demand_lines l
        JOIN customer_demand_months m ON m.id = l.demand_month_id
        JOIN customer_demands d ON d.id = m.demand_id
        JOIN customers c ON c.id = d.customer_id
        JOIN products p ON p.id = l.product_id
        WHERE m.status = 'CONFIRMED'
          AND extract(year FROM m.demand_month)::int = ${q.year}
          AND extract(month FROM m.demand_month)::int = ANY(${months}::int[])
          AND c.code IN (SELECT customer_code FROM analytics_customer_lists WHERE list_key = 'demand_maycha')
          ${custFilter}
        GROUP BY 1, 2, 4`,
    ]);

    // Thực tế: SL bán (hoá đơn sale) cho các khách có demand, theo mã hàng × tháng.
    const demandCodes = [
      ...new Set(demandRows.map((r) => str(r.customer_code))),
    ];
    let actualRows: Row[] = [];
    const from = daxDate(q.year, months[0], 1);
    let to = daxDate(q.year, months[months.length - 1] + 1, 0);
    if (to > today) to = today;
    if (demandCodes.length && from <= today) {
      const cond = Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date
        AND extract(month FROM x.d)::int = ANY(${months}::int[])
        AND x.customer_code = ANY(${demandCodes}::text[])`;
      actualRows = await this.run(Prisma.sql`
        WITH ${await this.base.baseCtes({ year: q.year } as AnalyticsBusinessQueryDto, cond)}
        SELECT l.customer_code, l.product_code, MAX(p.name) AS product_name,
               extract(month FROM l.d)::int AS m,
               SUM(ROUND(l.quantity))::float8 AS base_qty,
               SUM(ROUND(l.quantity) / NULLIF(COALESCE(p."conversionValue", 1), 0))::float8 AS bulk_qty
        FROM line_raw l
        LEFT JOIN LATERAL (SELECT name, "conversionValue" FROM products WHERE code = l.product_code
                           ORDER BY id LIMIT 1) p ON true
        GROUP BY 1, 2, 4`);
    }

    const qty = (r: Row) => num(unit === 'bulk' ? r.bulk_qty : r.base_qty);
    // Tập khách có demand theo (mã hàng, tháng) — SUMMARIZE(fact_demand, customer_code) trong ô.
    const dKey = (p: string, m: number) => `${p}|${m}`;
    const demandCust = new Map<string, Set<string>>();
    const demandQty = new Map<string, number>();
    const names = new Map<string, string>();
    for (const r of demandRows) {
      const k = dKey(str(r.product_code), num(r.m));
      if (!demandCust.has(k)) demandCust.set(k, new Set());
      demandCust.get(k)!.add(str(r.customer_code));
      demandQty.set(k, (demandQty.get(k) ?? 0) + qty(r));
      names.set(str(r.product_code), str(r.product_name));
    }
    const sumActual = (pred: (r: Row) => boolean) =>
      actualRows.filter(pred).reduce((s, r) => s + qty(r), 0);
    const unionSets = (keys: string[]) => {
      const out = new Set<string>();
      for (const k of keys) for (const c of demandCust.get(k) ?? []) out.add(c);
      return out;
    };
    const cell = (demand: number, actual: number) => ({
      demand,
      actual,
      diff: actual - demand,
    });
    const products = [...names.keys()].sort((a, b) =>
      (names.get(a) ?? a).localeCompare(names.get(b) ?? b, 'vi'),
    );
    const rows = products.map((p) => {
      const cells: Record<number, ReturnType<typeof cell> | null> = {};
      for (const m of months) {
        const k = dKey(p, m);
        const set = demandCust.get(k);
        cells[m] = set
          ? cell(
              demandQty.get(k) ?? 0,
              sumActual(
                (r) =>
                  str(r.product_code) === p &&
                  num(r.m) === m &&
                  set.has(str(r.customer_code)),
              ),
            )
          : null;
      }
      const setP = unionSets(months.map((m) => dKey(p, m)));
      const total = cell(
        months.reduce((s, m) => s + (demandQty.get(dKey(p, m)) ?? 0), 0),
        sumActual(
          (r) => str(r.product_code) === p && setP.has(str(r.customer_code)),
        ),
      );
      return { code: p, name: names.get(p) ?? p, cells, total };
    });
    // Dòng tổng: không lọc hàng → SL mọi mã hàng bán cho khách có demand trong tháng.
    const totalCells: Record<number, ReturnType<typeof cell> | null> = {};
    for (const m of months) {
      const set = unionSets(products.map((p) => dKey(p, m)));
      const demand = products.reduce(
        (s, p) => s + (demandQty.get(dKey(p, m)) ?? 0),
        0,
      );
      totalCells[m] = set.size
        ? cell(
            demand,
            sumActual((r) => num(r.m) === m && set.has(str(r.customer_code))),
          )
        : null;
    }
    const all = new Set(demandRows.map((r) => str(r.customer_code)));
    const grand = cell(
      [...demandQty.values()].reduce((s, v) => s + v, 0),
      sumActual((r) => all.has(str(r.customer_code))),
    );

    return {
      year: q.year,
      months,
      unit,
      subtitle: `Đang tính toán theo ${unit === 'bulk' ? 'Thùng' : 'Gói'}`,
      updatedAt,
      customers: customers.map((c) => ({
        code: c.code,
        name: c.name ?? c.code,
      })),
      rows,
      total: { cells: totalCells, total: grand },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Danh sách cho bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  async getFilterOptions() {
    const lake = await this.base.dataLakeReady();
    const thisYear = parts(todayVn()).y;
    const years: number[] = [];
    for (let y = parts(CALENDAR_START).y; y <= thisYear; y++) years.push(y);

    const [groups, names, regions, productGroups, types, brands, products] =
      await Promise.all([
        this.prisma.$queryRaw<{ id: number; name: string }[]>`
          SELECT id, name FROM customer_groups
          WHERE id <> ALL(${EXCLUDED_GROUP_IDS}::int[]) ORDER BY name`,
        this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT c.name FROM customers c
          WHERE c.id IN (
              SELECT DISTINCT i."customerId" FROM invoices i
              JOIN analytics_sale_team_members m ON m.user_id = i."soldById"
              JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale
              WHERE i.status <> 2 AND i."customerId" IS NOT NULL)
            AND c.name IS NOT NULL
          ORDER BY 1`,
        lake
          ? this.prisma.$queryRaw<{ name: string }[]>`
            SELECT DISTINCT region AS name FROM data_lake.new_province WHERE region IS NOT NULL ORDER BY 1`
          : Promise.resolve([] as { name: string }[]),
        this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT group_name AS name FROM analytics_product_groups
          UNION SELECT unnest(ARRAY['Nhóm B','Nhóm C','Chưa Phân Loại'])
          ORDER BY 1`,
        this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT parent_name AS name FROM products WHERE parent_name IS NOT NULL ORDER BY 1`,
        this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT tm.name FROM products p JOIN trade_marks tm ON tm.id = p."tradeMarkId"
          WHERE tm.name IS NOT NULL ORDER BY 1`,
        this.prisma.$queryRaw<{ code: string; name: string }[]>`
          SELECT DISTINCT ON (p.code) p.code, p.name FROM products p
          WHERE p.id IN (SELECT DISTINCT "productId" FROM invoice_details WHERE "productId" IS NOT NULL)
          ORDER BY p.code, p.id`,
      ]);

    return {
      years,
      customerTypes: CUSTOMER_TYPES,
      customerGroups: groups,
      customerNames: names.map((r) => r.name),
      regions: regions.map((r) => r.name),
      productGroups: productGroups.map((r) => r.name),
      productTypes: types.map((r) => r.name),
      brands: brands.map((r) => r.name),
      productPhases: PRODUCT_PHASES,
      products: products.sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình (bảng thay Excel dim_customer_key / DAX viết cứng)
  // ─────────────────────────────────────────────────────────────────────────
  async listCustomerList(listKey: KhListKey) {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT l.id, l.customer_code, l.customer_name, l.note,
             (SELECT c.name FROM customers c WHERE c.code = l.customer_code ORDER BY c.id LIMIT 1) AS pos_name
      FROM analytics_customer_lists l
      WHERE l.list_key = ${listKey}
      ORDER BY l.customer_code`;
    return rows.map((r) => ({
      id: num(r.id),
      customerCode: str(r.customer_code),
      customerName: (r.pos_name ?? r.customer_name ?? null) as string | null,
      inPos: r.pos_name != null,
      note: (r.note as string | null) ?? null,
    }));
  }

  async addCustomerList(dto: KhCustomerListItemDto) {
    const code = dto.customerCode.trim();
    const exists = await this.prisma.$queryRaw<Row[]>`
      SELECT id FROM analytics_customer_lists WHERE list_key = ${dto.listKey} AND customer_code = ${code}`;
    if (exists.length)
      throw new BadRequestException(`Mã khách "${code}" đã có trong danh sách`);
    const name = await this.prisma.$queryRaw<Row[]>`
      SELECT name FROM customers WHERE code = ${code} ORDER BY id LIMIT 1`;
    await this.prisma.$executeRaw`
      INSERT INTO analytics_customer_lists (list_key, customer_code, customer_name, note)
      VALUES (${dto.listKey}, ${code}, ${(name[0]?.name as string | undefined) ?? null}, ${dto.note ?? null})`;
    return { ok: true };
  }

  async deleteCustomerList(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_customer_lists WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { ok: true };
  }

  async listSalePics() {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, group_name, team_name, sort_order FROM analytics_customer_sale_pics
      ORDER BY sort_order, group_name`;
    return rows.map((r) => ({
      id: num(r.id),
      groupName: str(r.group_name),
      teamName: (r.team_name as string | null) ?? null,
      sortOrder: num(r.sort_order),
    }));
  }

  async createSalePic(dto: KhSalePicDto) {
    const dup = await this.prisma.$queryRaw<Row[]>`
      SELECT id FROM analytics_customer_sale_pics WHERE lower(group_name) = lower(${dto.groupName.trim()})`;
    if (dup.length)
      throw new BadRequestException(`Nhóm "${dto.groupName}" đã có`);
    await this.prisma.$executeRaw`
      INSERT INTO analytics_customer_sale_pics (group_name, team_name, sort_order)
      VALUES (${dto.groupName.trim()}, ${dto.teamName?.trim() || null}, ${dto.sortOrder ?? 0})`;
    return { ok: true };
  }

  async updateSalePic(id: number, dto: KhSalePicUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_customer_sale_pics SET
        group_name = COALESCE(${dto.groupName?.trim() ?? null}, group_name),
        team_name = CASE WHEN ${dto.teamName !== undefined} THEN ${dto.teamName?.trim() || null} ELSE team_name END,
        sort_order = COALESCE(${dto.sortOrder ?? null}::int, sort_order),
        updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { ok: true };
  }

  async deleteSalePic(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_customer_sale_pics WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { ok: true };
  }

  async listSaleRepRules() {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, sale_pic, customer_type, region, sale_rep, priority
      FROM analytics_customer_sale_rep_rules ORDER BY priority, id`;
    return rows.map((r) => ({
      id: num(r.id),
      salePic: str(r.sale_pic),
      customerType: (r.customer_type as string | null) ?? null,
      region: (r.region as string | null) ?? null,
      saleRep: str(r.sale_rep),
      priority: num(r.priority),
    }));
  }

  async createSaleRepRule(dto: KhSaleRepRuleDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_customer_sale_rep_rules (sale_pic, customer_type, region, sale_rep, priority)
      VALUES (${dto.salePic.trim()}, ${dto.customerType?.trim() || null}, ${dto.region?.trim() || null},
              ${dto.saleRep.trim()}, ${dto.priority})`;
    return { ok: true };
  }

  async updateSaleRepRule(id: number, dto: KhSaleRepRuleUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_customer_sale_rep_rules SET
        sale_pic = COALESCE(${dto.salePic?.trim() ?? null}, sale_pic),
        customer_type = CASE WHEN ${dto.customerType !== undefined} THEN ${dto.customerType?.trim() || null} ELSE customer_type END,
        region = CASE WHEN ${dto.region !== undefined} THEN ${dto.region?.trim() || null} ELSE region END,
        sale_rep = COALESCE(${dto.saleRep?.trim() ?? null}, sale_rep),
        priority = COALESCE(${dto.priority ?? null}::int, priority),
        updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { ok: true };
  }

  async deleteSaleRepRule(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_customer_sale_rep_rules WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CTE dùng chung của báo cáo Khách Hàng
  // ─────────────────────────────────────────────────────────────────────────
  /** ISFILTERED(dim_product): có lọc theo hàng → số cấp dòng hàng. */
  productFilter(q: KhachHangQueryDto): boolean {
    return !!(
      q.productGroup ||
      q.productType ||
      q.brand ||
      q.productPhase ||
      q.productCode
    );
  }

  /**
   * WITH-chain: baseCtes (cust, prod, invx, line_raw …) + kgrp, kflag, fp*, ph, kname,
   * kinv, kline_all (mọi lọc hàng trừ thương hiệu), kline. Mọi SELECT dùng alias x.
   */
  async ctes(
    q: KhachHangQueryDto,
    dateCond: Prisma.Sql,
    opts: CteOpts = {},
  ): Promise<Prisma.Sql> {
    const lake = await this.base.dataLakeReady();
    const baseQ = {
      year: q.year,
      months: q.months,
      customerGroupId: q.customerGroupId,
      region: q.region,
    } as AnalyticsBusinessQueryDto;
    const base = await this.base.baseCtes(baseQ, dateCond);

    const custConds = (alias: string): Prisma.Sql => {
      const t = Prisma.raw(alias);
      const c: Prisma.Sql[] = [];
      if (q.customerType)
        c.push(
          Prisma.sql`lower(${t}.customer_type) = lower(${q.customerType})`,
        );
      if (q.customerName)
        c.push(
          Prisma.sql`${t}.customer_code IN (SELECT code FROM cust_base WHERE name = ${q.customerName})`,
        );
      if (opts.groupContains?.length)
        c.push(Prisma.sql`${t}.customer_code IN (SELECT code FROM kgrp)`);
      return c.length ? Prisma.join(c, ' AND ') : Prisma.sql`true`;
    };

    const prodConds: Prisma.Sql[] = [];
    if (q.productGroup)
      prodConds.push(Prisma.sql`pr.group2026 = ${q.productGroup}`);
    if (q.productType)
      prodConds.push(Prisma.sql`pr.product_type = ${q.productType}`);
    if (q.productCode)
      prodConds.push(Prisma.sql`l.product_code = ${q.productCode}`);
    if (q.productPhase)
      prodConds.push(
        Prisma.sql`COALESCE(ph.phase, 'Không Bán') = ${q.productPhase}`,
      );
    const prodWhere = prodConds.length
      ? Prisma.join(prodConds, ' AND ')
      : Prisma.sql`true`;
    const brandWhere = q.brand
      ? Prisma.sql`x.brand = ${q.brand}`
      : Prisma.sql`true`;

    const chain: Prisma.Sql[] = [base];

    if (opts.groupContains?.length) {
      const like = Prisma.join(
        opts.groupContains.map(
          (s) => Prisma.sql`strpos(lower(cg.name), lower(${s})) > 0`,
        ),
        ' OR ',
      );
      chain.push(Prisma.sql`
        kgrp AS (
          SELECT DISTINCT c.code FROM customer_group_details g
          JOIN customer_groups cg ON cg.id = g."customerGroupId"
          JOIN customers c ON c.id = g."customerId"
          WHERE cg.id <> ALL(${EXCLUDED_GROUP_IDS}::int[]) AND (${like})
        )`);
    }

    // is_layer1_persale / is_layer2_vip: mã khách hoặc mã bỏ đuôi ".1…" có trong danh sách.
    chain.push(Prisma.sql`
      kflag AS (
        SELECT cb.code,
          bool_or(kl.list_key = 'key_persale') AS is_l1,
          bool_or(kl.list_key = 'vip_layer2') AS is_l2
        FROM cust_base cb
        JOIN analytics_customer_lists kl ON kl.list_key IN ('key_persale', 'vip_layer2')
          AND kl.customer_code IN (cb.code,
            CASE WHEN strpos(cb.code, '.1') > 0 THEN left(cb.code, strpos(cb.code, '.1') - 1) ELSE cb.code END)
        GROUP BY cb.code
      ),
      kname AS (
        SELECT cb.code, cb.name, COALESCE(na."newCityName", oa."cityName") AS province
        FROM cust_base cb
        LEFT JOIN addr_new na ON na."customerId" = cb.id
        LEFT JOIN addr_old oa ON oa."customerId" = cb.id
      ),
      ${this.salePicCtes(Prisma.sql`cust`)}`);

    if (opts.firstPurchase) {
      // invoice[Is New Customer This Month]: tháng mua đầu tiên của khách cha
      // trên TOÀN BỘ bảng invoice của Power BI (mọi người bán trừ soldById 2).
      chain.push(Prisma.sql`
        ${this.fpInvCte(lake)},
        fp_cb AS (
          SELECT DISTINCT ON (c.code) c.code, c.name, lower(c.code) AS lcode, lower(c.name) AS lname
          FROM customers c WHERE c.code IN (SELECT customer_code FROM fp_inv) ORDER BY c.code, c.id
        ),
        fp_rule AS (
          SELECT DISTINCT ON (cb.code) cb.code, r.parent_name
          FROM fp_cb cb JOIN rules r
            ON (r.match_type = 'code' AND cb.lcode = r.pat)
            OR (r.match_type = 'name_contains' AND strpos(cb.lname, r.pat) > 0)
          ORDER BY cb.code, r.priority, r.id
        ),
        fp_cust AS (
          SELECT cb.code, COALESCE(fr.parent_name, cb.name) AS parent_name
          FROM fp_cb cb LEFT JOIN fp_rule fr ON fr.code = cb.code
        ),
        fp AS (
          SELECT COALESCE(fc.parent_name, ${BLANK}) AS pkey, MIN(f.d) AS first_d
          FROM fp_inv f LEFT JOIN fp_cust fc ON fc.code = f.customer_code
          GROUP BY 1
        )`);
    }

    if (q.productPhase) {
      chain.push(Prisma.sql`
        ph AS (
          SELECT z.product_code,
            CASE WHEN ${todayVn()}::date - MIN(z.d) <= 30 THEN 'Mới (0-30 ngày)'
                 WHEN ${todayVn()}::date - MIN(z.d) <= 60 THEN 'Giai đoạn 2 (31-60 ngày)'
                 WHEN ${todayVn()}::date - MIN(z.d) <= 90 THEN 'Giai đoạn 3 (61-90 ngày)'
                 ELSE 'Ngoài 90 ngày' END AS phase
          FROM (
            SELECT p.code AS product_code, (i."purchaseDate" + interval '7 hour')::date AS d
            FROM invoice_details dd
            JOIN invoices i ON i.id = dd."invoiceId"
            JOIN customers c ON c.id = i."customerId"
            JOIN products p ON p.id = dd."productId"
            WHERE i.status <> 2 AND i."soldById" IS DISTINCT FROM 2
              AND c.code NOT IN (SELECT customer_code FROM analytics_customer_lists WHERE list_key = 'internal_customers')
            ${
              lake
                ? Prisma.sql`
            UNION ALL
            SELECT od."productCode", (o."purchaseDate" + interval '7 hour')::date
            FROM data_lake.invoice_detail od
            JOIN data_lake.invoice o ON o.code = od."invoiceCode"
            JOIN customers c ON c.code = o."customerCode"
            WHERE o.status <> 2
              AND c.code NOT IN (SELECT customer_code FROM analytics_customer_lists WHERE list_key = 'internal_customers')`
                : Prisma.empty
            }
          ) z
          GROUP BY z.product_code
        )`);
    }

    const isNew = opts.firstPurchase
      ? Prisma.sql`(fp.first_d IS NOT NULL AND date_trunc('month', x.d) = date_trunc('month', fp.first_d))`
      : Prisma.sql`false`;
    const fpJoin = opts.firstPurchase
      ? Prisma.sql`LEFT JOIN fp ON fp.pkey = COALESCE(x.parent_name, ${BLANK})`
      : Prisma.empty;
    const phJoin = q.productPhase
      ? Prisma.sql`LEFT JOIN ph ON ph.product_code = l.product_code`
      : Prisma.empty;

    chain.push(Prisma.sql`
      kinv AS (
        SELECT x.*, COALESCE(kf.is_l1, false) AS is_l1, COALESCE(kf.is_l2, false) AS is_l2,
               ${isNew} AS new_cust
        FROM invx x
        LEFT JOIN kflag kf ON kf.code = x.customer_code
        ${fpJoin}
        WHERE ${custConds('x')}
      ),
      kline_all AS (
        SELECT l.code, l.d, l.ok, l.customer_code, l.parent_name, l.customer_type, l.product_code,
               ROUND(l.quantity)::float8 AS quantity, ROUND(l.sub_total)::float8 AS sub_total,
               pr.product_type, pr.brand, pr.category, pr.group2026, cu.region
        FROM line_raw l
        LEFT JOIN prod pr ON pr.code = l.product_code
        LEFT JOIN cust cu ON cu.code = l.customer_code
        ${phJoin}
        WHERE ${custConds('l')} AND ${prodWhere}
      ),
      kline AS (SELECT x.* FROM kline_all x WHERE ${brandWhere})`);

    return Prisma.join(chain, ',');
  }

  /**
   * kpic / kcust: sale phụ trách (dim_customers[sale_pic]), team (group_sale_name) và
   * sale đại diện (sale_rep) theo bảng cấu hình. src: CTE khách có cột id, code,
   * customer_type, region (cust của baseCtes / custCte).
   */
  salePicCtes(src: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      kpic AS (
        SELECT g."customerId" AS cid, STRING_AGG(DISTINCT cg.name, ', ' ORDER BY cg.name) AS sale_pic
        FROM customer_group_details g
        JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE lower(cg.name) IN (SELECT lower(group_name) FROM analytics_customer_sale_pics)
        GROUP BY g."customerId"
      ),
      kcust AS (
        SELECT cu.code, cu.customer_type, cu.region, kp.sale_pic,
          (SELECT sp.team_name FROM analytics_customer_sale_pics sp
           WHERE lower(sp.group_name) = lower(kp.sale_pic) LIMIT 1) AS team_name,
          COALESCE((
            SELECT r.sale_rep FROM analytics_customer_sale_rep_rules r
            WHERE lower(r.sale_pic) = lower(kp.sale_pic)
              AND (r.customer_type IS NULL OR lower(r.customer_type) = lower(cu.customer_type))
              AND (r.region IS NULL OR lower(r.region) = lower(cu.region))
            ORDER BY r.priority, r.id LIMIT 1), 'noname') AS sale_rep
        FROM ${src} cu LEFT JOIN kpic kp ON kp.cid = cu.id
      )`;
  }

  /** Bảng invoice của Power BI (mọi người bán, trừ soldById = 2): ngày + mã khách. */
  fpInvCte(lake: boolean): Prisma.Sql {
    return Prisma.sql`
      fp_inv AS (
        SELECT (i."purchaseDate" + interval '7 hour')::date AS d, c.code AS customer_code
        FROM invoices i LEFT JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2 AND i."soldById" IS DISTINCT FROM 2
        ${
          lake
            ? Prisma.sql`
        UNION ALL
        SELECT (o."purchaseDate" + interval '7 hour')::date, c.code
        FROM data_lake.invoice o LEFT JOIN customers c ON c.code = o."customerCode"
        WHERE o.status <> 2`
            : Prisma.empty
        }
      )`;
  }

  /** Chỉ số cấp dòng; full = false: chỉ Doanh số + Sản lượng (đủ khi không lọc theo hàng). */
  lineMetrics(full: boolean): Prisma.Sql {
    if (full) return this.base.lineMetrics();
    return Prisma.sql`
      COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS amount,
      0 AS orders, 0 AS customers,
      COALESCE(SUM(x.quantity), 0)::float8 AS quantity`;
  }

  extraMetrics(): Prisma.Sql {
    return Prisma.sql`
      COUNT(DISTINCT COALESCE(x.parent_name, ${BLANK})) FILTER (WHERE x.new_cust)::int AS new_customers,
      COALESCE(SUM(x.total) FILTER (WHERE x.ok AND x.new_cust), 0)::float8 AS rev_new,
      COALESCE(SUM(x.total) FILTER (WHERE x.ok AND x.is_l1), 0)::float8 AS rev_l1,
      COALESCE(SUM(x.total) FILTER (WHERE x.ok AND x.is_l2), 0)::float8 AS rev_l2`;
  }

  /** Top 10 khách (theo dim_customers[name]) → cộng theo khách cha, cho từng chỉ số. */
  topParents(rows: Row[], productFilter: boolean) {
    const byName = new Map<string, { inv?: Row; line?: Row }>();
    const pairs = new Map<
      string,
      { name: string; parent: string | null; inv?: Row; line?: Row }
    >();
    for (const r of rows) {
      const src = r.src === 'inv' ? 'inv' : 'line';
      const name = String(r.cname);
      if (Number(r.g) === 1) {
        const e = byName.get(name) ?? {};
        e[src] = r;
        byName.set(name, e);
      } else {
        const parent = (r.parent_name as string | null) ?? null;
        const key = `${name}\u0001${parent ?? ''}`;
        const e = pairs.get(key) ?? { name, parent };
        e[src] = r;
        pairs.set(key, e);
      }
    }
    const val = (e: { inv?: Row; line?: Row }, m: KhMetric) =>
      this.base.pick(
        e.inv ? this.agg(e.inv) : undefined,
        e.line ? this.agg(e.line) : undefined,
        productFilter,
        null,
      )[m];

    const out = {} as Record<KhMetric, { name: string; value: number }[]>;
    for (const m of KH_METRICS) {
      const ranked = [...byName.entries()]
        .map(([name, e]) => ({ name, v: val(e, m) }))
        .filter((r) => r.v)
        .sort((a, b) => b.v - a.v);
      const cutoff = ranked[Math.min(9, ranked.length - 1)]?.v;
      const top = new Set(
        ranked.filter((r, i) => i < 10 || r.v === cutoff).map((r) => r.name),
      );
      const bars = new Map<string, number>();
      for (const p of pairs.values()) {
        if (!top.has(p.name)) continue;
        const label = p.parent ?? '';
        // DISTINCTCOUNT(parent_name) cấp hoá đơn: mỗi khách cha = 1.
        bars.set(
          label,
          m === 'customers' && !productFilter
            ? 1
            : (bars.get(label) ?? 0) + val(p, m),
        );
      }
      out[m] = [...bars.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tiện ích
  // ─────────────────────────────────────────────────────────────────────────
  /** Chạy 1 câu SQL với JIT tắt (SET LOCAL trong transaction): câu CTE dài làm JIT tốn vài giây. */
  run(sql: Prisma.Sql): Promise<Row[]> {
    return this.prisma
      .$transaction([
        this.prisma.$executeRaw`SET LOCAL jit = off`,
        this.prisma.$queryRaw<Row[]>(sql),
      ])
      .then(([, rows]) => rows);
  }

  /** SELECT (json_agg của từng câu con) AS <tên>, … — nhiều kết quả trong 1 câu, CTE tính 1 lần. */
  jsonSelect(parts: Record<string, Prisma.Sql>): Prisma.Sql {
    return Prisma.sql`SELECT ${Prisma.join(
      Object.entries(parts).map(
        ([name, sql]) =>
          Prisma.sql`(SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t) AS ${Prisma.raw(`"${name}"`)}`,
      ),
    )}`;
  }

  periodInfo(p: CurrentPeriod, year: number) {
    return { from: p.min, to: p.max, months: p.months, year };
  }

  /** Map "dim|k|m|key" → dòng (dùng cho kết quả GROUPING SETS). */
  dimMap(rows: Row[]): Map<string, Row> {
    const m = new Map<string, Row>();
    for (const r of rows) {
      m.set(`${str(r.dim)}|${str(r.k)}|${str(r.m)}|${str(r.key)}`, r);
    }
    return m;
  }

  agg(r: Row): LineAgg {
    return {
      amount: num(r.amount),
      orders: num(r.orders),
      customers: num(r.customers),
      quantity: num(r.quantity),
    };
  }
}
