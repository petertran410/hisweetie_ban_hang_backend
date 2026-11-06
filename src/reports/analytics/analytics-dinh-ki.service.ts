import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalyticsReportsService,
  VISUAL_PRODUCT_GROUPS,
} from '../analytics-reports.service';
import { AnalyticsBusinessQueryDto } from '../dto';
import {
  CALENDAR_START,
  IsoDate,
  addDays,
  currentPeriod,
  daxDate,
  edate,
  isoWeekday,
  parts,
  todayVn,
} from './analytics-period';
import {
  DinhKiBrandQueryDto,
  DinhKiDateQueryDto,
  DinhKiDetailQueryDto,
  DkGroupTargetDto,
  DkGroupTargetListQueryDto,
  DkGroupTargetUpdateDto,
  DkJamFlavorDto,
  DkJamFlavorListQueryDto,
  DkJamFlavorUpdateDto,
  DkWeeklySellerDto,
  HangTuanQueryDto,
} from './analytics-dinh-ki.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › Định Kì (dataset_sale) + Hằng Tuần (dataset_sale - version 2)
// — thay Power BI. Các trang "HTML Content" của Power BI (measure html_weekly,
// html_last_week, html_monthly, html_region, html_brand_compare, card_* …) được
// tính lại bằng SQL ở đây, frontend dựng lại giao diện.
//
// Quy ước chép từ DAX (dataset_sale):
//   • Doanh thu dòng hàng (Revenue Detail) = Σ sub_total đã làm tròn, bỏ hoá đơn
//     "Đã hủy"; Sản lượng (Total Quantity) KHÔNG lọc trạng thái.
//   • TODAY() của Power BI = "ngày mốc" (tham số date, mặc định hôm nay) để xem
//     lại tuần / tháng cũ.
//   • "Tuần này" kiểu WEEKNUM(…,2)+YEAR (revenue_detail_thisweek, *_by_sale_thisweek,
//     total_order_thisweek) = các ngày của tuần nằm trong năm của ngày mốc; kiểu
//     week_offset = 0 / Orders_ThisWeek / KH mới = cả tuần thứ 2 → CN.
//   • Khách mới = khách có hoá đơn đầu tiên (mọi thời gian, của nhân viên sale /
//     của team khi tính theo team) nằm trong kỳ.
//   • Chỉ tiêu theo sale: analytics_kpi_revenue_targets (sale_code = phần trước @
//     của email nhân viên). Chỉ tiêu theo nhóm hàng: analytics_dk_group_targets.
// Mỗi trang gom mọi số liệu dòng hàng / hoá đơn / khách mới vào 1 câu SQL (collect)
// để chỉ tính baseCtes một lần.
// ═══════════════════════════════════════════════════════════════════════════

type Range = { from: IsoDate; to: IsoDate };
type Ranges = Record<string, Range>;

/** Cột được phép gom nhóm (khớp cột của CTE dk_line / dk_inv). */
type DimCol =
  | 'group2026'
  | 'visual_group'
  | 'team_id'
  | 'user_id'
  | 'region'
  | 'customer_type'
  | 'product_type'
  | 'product_name'
  | 'product_code'
  | 'category';
type Dims = Record<string, DimCol[]>;

interface Agg {
  amount: number; // Doanh thu (bỏ hoá đơn hủy)
  central: number; // Doanh thu khách Miền Trung
  quantity: number; // Sản lượng (dòng hàng, mọi trạng thái)
  orders: number; // Số hoá đơn (bỏ hủy)
  customers: number; // Số khách (bỏ hủy, khách trống tính 1)
  ordersAll: number; // Số hoá đơn (mọi trạng thái)
  customersAll: number; // Số khách (mọi trạng thái)
}
/** range → dim → key → Agg. Dim "total" có key "". */
type AggMap = Map<string, Map<string, Map<string, Agg>>>;

interface DkFilters {
  saleTeamId?: number;
  parentName?: string;
  productGroup?: string;
}

const CENTRAL = 'Miền Trung';
const LERMAO = '4.Lermao';
const PHUONG_HOANG = '5.Phượng Hoàng';
const BODUO = '1.Boduo';
const CUSTOMER_TYPES = ['Khách lẻ', 'Khách buôn', 'Khách chuỗi'] as const;
const PT_BRAND = 'Hàng thương hiệu';
const PT_TRADE = 'Hàng thương mại';
// dataset_sale - version 2 › Revenue: bỏ mã STTTW01 từ 01/07/2026.
const V2_EXCLUDED_PRODUCT = 'STTTW01';
const V2_EXCLUDE_FROM = '2026-07-01';
const BLANK = '__blank__';

const ZERO: Agg = {
  amount: 0,
  central: 0,
  quantity: 0,
  orders: 0,
  customers: 0,
  ordersAll: 0,
  customersAll: 0,
};

const minD = (...d: IsoDate[]) => d.reduce((a, b) => (b < a ? b : a));
const maxD = (...d: IsoDate[]) => d.reduce((a, b) => (b > a ? b : a));
const monday = (d: IsoDate) => addDays(d, 1 - isoWeekday(d));
const monthStart = (d: IsoDate) => daxDate(parts(d).y, parts(d).m, 1);
const monthEnd = (d: IsoDate) => daxDate(parts(d).y, parts(d).m + 1, 0);
const ym = (d: IsoDate) => d.slice(0, 7);
const div = (a: number, b: number | null | undefined) => (b ? a / b : null);
const viSort = (a: string, b: string) => a.localeCompare(b, 'vi');
const ddmm = (d: IsoDate) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** WEEKNUM(date, 2) của DAX: tuần bắt đầu thứ 2, tuần 1 chứa ngày 1/1. */
function weekNum(d: IsoDate): number {
  const { y, m, d: day } = parts(d);
  const doy = Math.round((Date.UTC(y, m - 1, day) - Date.UTC(y, 0, 1)) / 864e5);
  return Math.floor((doy + isoWeekday(daxDate(y, 1, 1)) - 1) / 7) + 1;
}

@Injectable()
export class AnalyticsDinhKiService {
  constructor(
    private prisma: PrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Tổng Quan (giống Kinh Doanh › Tổng Quan) + bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  getOverview(q: AnalyticsBusinessQueryDto) {
    return this.base.getBusinessOverview(q);
  }

  getFilterOptions() {
    return this.base.getFilterOptions();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tuần Này (html_weekly) / Tuần Trước (html_last_week)
  // ─────────────────────────────────────────────────────────────────────────
  async getWeekly(q: DinhKiDateQueryDto, mode: 'this' | 'last') {
    const today = todayVn();
    const anchor = this.anchor(q.date, today);
    const mon = monday(anchor);
    const { y, m } = parts(anchor);
    const lastWeek: Range = { from: addDays(mon, -7), to: addDays(mon, -1) };
    const ranges: Ranges =
      mode === 'this'
        ? {
            // WEEKNUM + YEAR (revenue_detail_thisweek, *_by_sale_thisweek)
            cur: {
              from: maxD(mon, daxDate(y, 1, 1)),
              to: minD(addDays(mon, 6), daxDate(y, 12, 31), today),
            },
            // week_offset = 0 / Orders_ThisWeek / New_Customers_ThisWeek
            cur0: { from: mon, to: minD(addDays(mon, 6), today) },
            prev: lastWeek,
          }
        : {
            cur: lastWeek,
            cur0: lastWeek,
            prev: { from: addDays(mon, -14), to: addDays(mon, -8) },
          };

    const lineDims: Dims = {
      group: ['group2026'],
      visual: ['visual_group'],
      team: ['team_id'],
    };
    if (mode === 'this') lineDims.product = ['visual_group', 'product_name'];
    const [data, kpi, targets, debt, teams] = await Promise.all([
      this.collect(ranges, {
        line: lineDims,
        inv: { team: ['team_id'] },
        newCustomers: ['cur0', 'prev'],
      }),
      this.saleKpi(y, m),
      this.groupTargets([{ y, m }]),
      this.debt(today),
      this.saleTeams(),
    ]);
    const { line, inv, nc } = data;
    const get = this.getter(line);
    const getInv = this.getter(inv);
    const revCur = get('cur', 'total', '').amount;
    const kpiTarget = kpi.total / 4;

    const teamRows = teams
      .map((t) => {
        const key = String(t.id);
        const ds = getInv('cur', 'team', key).amount;
        const target = (kpi.byTeam.get(t.id) ?? 0) / 4;
        // Tuần này: % KPI = doanh thu dòng hàng / KPI; tuần trước: doanh số hoá đơn / KPI.
        const kpiBase = mode === 'this' ? get('cur', 'team', key).amount : ds;
        return {
          id: t.id,
          name: t.name,
          revenue: ds,
          orders: getInv('cur', 'team', key).orders,
          newCustomers:
            mode === 'this' ? (nc.byTeam.get(`cur0|${key}`) ?? 0) : null,
          kpiTarget: target,
          kpiPct: div(kpiBase, target),
        };
      })
      .filter((t) => t.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    return {
      mode,
      anchor,
      today,
      ranges,
      kpiMonth: { year: y, month: m },
      updatedAt: new Date().toISOString(),
      finance: {
        revenue: { current: revCur, previous: get('prev', 'total', '').amount },
        orders: {
          current: getInv('cur0', 'total', '').orders,
          previous: getInv('prev', 'total', '').orders,
        },
        kpi: { target: kpiTarget, pct: div(revCur, kpiTarget) },
        central: {
          current: get('cur0', 'total', '').central,
          previous: get('prev', 'total', '').central,
        },
      },
      groups: this.groupRows(line, targets, y, m, 4),
      visualGroups: this.visualRows(line),
      debt,
      customers: {
        newCurrent: nc.count.get('cur0') ?? 0,
        newPrevious: nc.count.get('prev') ?? 0,
        revenueNewCurrent: nc.revenue.get('cur0') ?? 0,
        revenueNewPrevious: nc.revenue.get('prev') ?? 0,
      },
      teams: teamRows,
      topProducts: mode === 'this' ? this.topProducts(line, 'cur0') : null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tháng (html_monthly)
  // ─────────────────────────────────────────────────────────────────────────
  async getMonthly(q: DinhKiDateQueryDto) {
    const today = todayVn();
    const anchor = this.anchor(q.date, today);
    const { y, m } = parts(anchor);
    const ranges = this.monthRanges(anchor, today);

    const [data, kpi, targets, debt, teams] = await Promise.all([
      this.collect(ranges, {
        line: {
          group: ['group2026'],
          visual: ['visual_group'],
          product: ['visual_group', 'product_name'],
        },
        inv: { team: ['team_id'] },
        newCustomers: ['cur', 'prev'],
      }),
      this.saleKpi(y, m),
      this.groupTargets([{ y, m }]),
      this.debt(today),
      this.saleTeams(),
    ]);
    const { line, inv, nc } = data;
    const get = this.getter(line);
    const getInv = this.getter(inv);
    const revCur = get('cur', 'total', '').amount;

    const teamRows = teams
      .map((t) => {
        const key = String(t.id);
        const ds = getInv('cur', 'team', key).amount;
        const target = kpi.byTeam.get(t.id) ?? 0;
        return {
          id: t.id,
          name: t.name,
          revenue: ds,
          orders: getInv('cur', 'team', key).orders,
          newCustomers: nc.byTeam.get(`cur|${key}`) ?? 0,
          kpiTarget: target,
          kpiPct: div(ds, target),
        };
      })
      .filter((t) => t.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    return {
      anchor,
      today,
      ranges,
      kpiMonth: { year: y, month: m },
      updatedAt: new Date().toISOString(),
      finance: {
        revenue: { current: revCur, previous: get('prev', 'total', '').amount },
        orders: {
          current: getInv('cur', 'total', '').orders,
          previous: getInv('prev', 'total', '').orders,
        },
        kpi: {
          actual: revCur,
          target: kpi.total,
          pct: div(revCur, kpi.total),
        },
        // Power BI dùng nhầm New_Customers_LastMonth (= tháng này); ở đây tính đúng tháng trước.
        newCustomers: {
          current: nc.count.get('cur') ?? 0,
          previous: nc.count.get('prev') ?? 0,
        },
      },
      groups: this.groupRows(line, targets, y, m, 1),
      visualGroups: this.visualRows(line),
      debt,
      customers: {
        revenueNewCurrent: nc.revenue.get('cur') ?? 0,
        revenueNewPrevious: nc.revenue.get('prev') ?? 0,
      },
      teams: teamRows,
      topProducts: this.topProducts(line, 'cur'),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Vùng (html_region)
  // ─────────────────────────────────────────────────────────────────────────
  async getRegion(q: DinhKiDateQueryDto) {
    const today = todayVn();
    const anchor = this.anchor(q.date, today);
    const ranges = this.monthRanges(anchor, today);
    const lake = await this.base.dataLakeReady();
    const [data, regionList] = await Promise.all([
      this.collect(ranges, {
        line: {
          region: ['region'],
          regionType: ['region', 'customer_type'],
          regionProduct: ['region', 'product_type', 'product_name'],
        },
        inv: { region: ['region'] },
        newCustomers: ['cur'],
      }),
      lake
        ? this.prisma.$queryRaw<{ region: string }[]>`
            SELECT DISTINCT region FROM data_lake.new_province WHERE region IS NOT NULL`
        : Promise.resolve([] as { region: string }[]),
    ]);
    const { line, inv, nc } = data;
    const get = this.getter(line);
    const getInv = this.getter(inv);
    // Tỷ trọng so với toàn công ty (kể cả khách chưa có vùng).
    const totalThis = get('cur', 'total', '').amount;

    const names = new Set<string>(regionList.map((r) => r.region));
    for (const k of this.keysWith(line, 'cur', 'region', () => true))
      names.add(k);

    const products = (region: string, type: string) =>
      this.keysWith(line, 'cur', 'regionProduct', (a, key) => {
        const [r, t, name] = key.split('|');
        return (
          a.amount > 0 &&
          r === region &&
          t.toLowerCase() === type.toLowerCase() &&
          !!name
        );
      })
        .map((key) => ({
          name: key.split('|').slice(2).join('|'),
          revenue: get('cur', 'regionProduct', key).amount,
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

    const rows = [...names]
      .map((region) => {
        const revThis = get('cur', 'region', region).amount;
        const revLast = get('prev', 'region', region).amount;
        const orders = getInv('cur', 'region', region).orders;
        const type = (t: string) =>
          get('cur', 'regionType', `${region}|${t}`).amount;
        return {
          region,
          revenue: revThis,
          previous: revLast,
          share: div(revThis, totalThis),
          mom: div(revThis - revLast, revLast),
          activeCustomers: getInv('cur', 'region', region).customersAll,
          newCustomers: nc.byRegion.get(`cur|${region}`) ?? 0,
          orders,
          aov: div(revThis, orders),
          customerTypes: {
            le: type(CUSTOMER_TYPES[0]),
            buon: type(CUSTOMER_TYPES[1]),
            chuoi: type(CUSTOMER_TYPES[2]),
          },
          brandProducts: products(region, PT_BRAND),
          tradeProducts: products(region, PT_TRADE),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const byGrowth = rows
      .filter((r) => r.previous > 0)
      .sort((a, b) => (b.mom ?? 0) - (a.mom ?? 0));
    const pick = (r?: (typeof rows)[number]) =>
      r
        ? { region: r.region, revenue: r.revenue, mom: r.mom, share: r.share }
        : null;

    return {
      anchor,
      today,
      ranges,
      updatedAt: new Date().toISOString(),
      totalRevenue: totalThis,
      insights: {
        topShare: pick(rows[0]),
        bestGrowth: pick(byGrowth[0]),
        worstGrowth: pick(byGrowth[byGrowth.length - 1]),
      },
      regions: rows,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Đối Thủ (html_brand_compare): Mứt Lermao vs Mứt Boduo theo Năm / Tháng
  // ─────────────────────────────────────────────────────────────────────────
  async getBrandCompare(q: DinhKiBrandQueryDto) {
    const today = todayVn();
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      today,
    );
    const updatedAt = new Date().toISOString();
    if (!period) return { period: null, updatedAt, brands: null };

    const ranges: Ranges = { cur: { from: period.min, to: period.max } };
    const [data, jam] = await Promise.all([
      this.collect(
        ranges,
        {
          line: {
            brand: ['visual_group'],
            product: ['visual_group', 'product_name', 'category'],
            code: ['product_code'],
          },
          lineWhere: Prisma.sql`(x.visual_group IN (${LERMAO}, ${BODUO})
            OR x.product_code IN (SELECT product_code FROM analytics_dk_jam_flavors))`,
        },
        {},
        this.base.periodCond(period),
      ),
      this.prisma.$queryRaw<{ code: string; flavor: string; brand: string }[]>`
        SELECT product_code AS code, jam_flavor AS flavor, brand
        FROM analytics_dk_jam_flavors
        WHERE NULLIF(trim(jam_flavor), '') IS NOT NULL`,
    ]);
    const get = this.getter(data.line);

    const brand = (g: string) => {
      const a = get('cur', 'brand', g);
      return {
        revenue: a.amount,
        quantity: a.quantity,
        orders: a.ordersAll, // total_order_detail: DISTINCTCOUNT(invoice_detail[invoice_code])
        customers: a.customersAll,
      };
    };

    // Vị mứt: sản lượng theo mã hàng trong bảng vị (lọc theo hãng của bảng vị).
    const flavorMap = new Map<string, { lermao: number; boduo: number }>();
    for (const j of jam) {
      const cur = flavorMap.get(j.flavor) ?? { lermao: 0, boduo: 0 };
      const q2 = get('cur', 'code', j.code).quantity;
      if (j.brand === 'Lermao') cur.lermao += q2;
      else if (j.brand === 'Boduo') cur.boduo += q2;
      flavorMap.set(j.flavor, cur);
    }
    const flavors = [...flavorMap]
      .map(([flavor, v]) => ({ flavor, ...v, total: v.lermao + v.boduo }))
      .sort((a, b) => b.total - a.total || viSort(a.flavor, b.flavor));

    // Top 10 sản phẩm: chỉ tên có doanh thu ở danh mục Mứt/Siro (Lermao) | Mứt/Siro/Sốt (Boduo).
    const eligibleCats: Record<string, string[]> = {
      [LERMAO]: ['mứt', 'siro'],
      [BODUO]: ['mứt', 'siro', 'sốt'],
    };
    const byProduct = new Map<
      string,
      {
        g: string;
        name: string;
        revenue: number;
        quantity: number;
        ok: boolean;
      }
    >();
    const byName = new Map<string, number>();
    for (const key of this.keysWith(data.line, 'cur', 'product', () => true)) {
      const [g, name, cat] = key.split('|');
      if (!name || !(g in eligibleCats)) continue;
      const a = get('cur', 'product', key);
      const k = `${g}|${name}`;
      const cur = byProduct.get(k) ?? {
        g,
        name,
        revenue: 0,
        quantity: 0,
        ok: false,
      };
      cur.revenue += a.amount;
      cur.quantity += a.quantity;
      if (a.amount > 0 && eligibleCats[g].includes(cat.toLowerCase()))
        cur.ok = true;
      byProduct.set(k, cur);
      byName.set(name, (byName.get(name) ?? 0) + a.amount);
    }
    const top = (g: string) =>
      [...byProduct.values()]
        .filter((p) => p.g === g && p.ok)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10)
        .map(({ name, revenue, quantity }) => ({ name, revenue, quantity }));

    return {
      period: {
        from: period.min,
        to: period.max,
        months: period.months,
        year: q.year,
      },
      updatedAt,
      brands: { lermao: brand(LERMAO), boduo: brand(BODUO) },
      flavors,
      topLermao: top(LERMAO),
      topBoduo: top(BODUO),
      maxProductRevenue: Math.max(0, ...byName.values()),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chi Tiết: bảng pivot theo tuần (Nhóm hàng 2026, Nhóm hàng hoá, Nhân sự, Miền Trung)
  // ─────────────────────────────────────────────────────────────────────────
  async getDetail(q: DinhKiDetailQueryDto) {
    const today = todayVn();
    const anchor = this.anchor(q.date, today);
    const mon = monday(anchor);
    const { y, m } = parts(anchor);
    const pm = parts(edate(monthStart(anchor), -1));
    const ranges: Ranges = {
      cur: {
        from: maxD(mon, daxDate(y, 1, 1)),
        to: minD(addDays(mon, 6), daxDate(y, 12, 31), today),
      },
      cur0: { from: mon, to: minD(addDays(mon, 6), today) },
      prev: { from: addDays(mon, -7), to: addDays(mon, -1) },
    };
    const f: DkFilters = {
      saleTeamId: q.saleTeamId,
      productGroup: q.productGroup,
      parentName: q.parentName,
    };
    const [data, targets] = await Promise.all([
      this.collect(
        ranges,
        {
          line: {
            group: ['group2026'],
            visual: ['visual_group'],
            user: ['user_id'],
          },
        },
        f,
      ),
      this.groupTargets([
        { y, m },
        { y: pm.y, m: pm.m },
      ]),
    ]);
    const line = data.line;
    const get = this.getter(line);
    const weekTarget = (kind: string, name: string, yy: number, mm: number) => {
      const t = targets.get(`${kind}|${name}|${yy}|${mm}`);
      return t === undefined ? null : t / 4;
    };
    const keysCurPrev = (dim: string) =>
      new Set([
        ...this.keysWith(line, 'cur', dim, () => true),
        ...this.keysWith(line, 'prev', dim, () => true),
      ]);
    const targetNames = (kind: string) =>
      [...targets.keys()]
        .map((k) => k.split('|'))
        .filter(([k2, , yy, mm]) => k2 === kind && +yy === y && +mm === m)
        .map(([, name]) => name);

    // O1 — Nhóm hàng 2026 (Kế hoạch tuần = KPI tháng / 4)
    const g2026 = keysCurPrev('group');
    if (f.productGroup) {
      for (const k of [...g2026]) if (k !== f.productGroup) g2026.delete(k);
      if (weekTarget('group2026', f.productGroup, y, m) !== null)
        g2026.add(f.productGroup);
    } else for (const n of targetNames('group2026')) g2026.add(n);
    const groupRows = [...g2026].sort(viSort).map((name) => {
      const t = weekTarget('group2026', name, y, m);
      const cur = get('cur', 'group', name).amount;
      const prev = get('prev', 'group', name).amount;
      return {
        name,
        target: t,
        current: cur,
        pctCurrent: div(cur, t),
        previous: prev,
        pctPrevious: div(prev, t),
      };
    });
    const totalCur = get('cur', 'total', '').amount;
    const totalPrev = get('prev', 'total', '').amount;
    // Dòng tổng: SELECTEDVALUE(nhóm) chỉ có giá trị khi đang lọc đúng 1 nhóm.
    const oneTarget = f.productGroup
      ? weekTarget('group2026', f.productGroup, y, m)
      : null;

    // O2 — Nhóm hàng hoá (KPI theo visual_product_group; % tuần trước so KPI tháng trước)
    const visual = keysCurPrev('visual');
    if (!f.productGroup)
      for (const n of targetNames('visual'))
        if (VISUAL_PRODUCT_GROUPS.includes(n)) visual.add(n);
    const visualRows = [...visual].sort(viSort).map((name) => {
      const tCur = weekTarget('visual', name, y, m);
      const tPrev = weekTarget('visual', name, pm.y, pm.m);
      const cur = get('cur', 'visual', name).amount;
      const prev = get('prev', 'visual', name).amount;
      return {
        name,
        target: tCur,
        current: cur,
        pctCurrent: div(cur, tCur),
        previous: prev,
        pctPrevious: div(prev, tPrev),
      };
    });

    // Hiệu quả nhân sự — doanh thu dòng hàng theo nhân viên
    const userIds = [...keysCurPrev('user')].map(Number).filter(Boolean);
    const users = userIds.length
      ? await this.prisma.$queryRaw<{ id: number; name: string }[]>`
          SELECT id, name FROM users WHERE id = ANY(${userIds}::int[])`
      : [];
    const staff = users
      .map((u) => ({
        name: u.name,
        previous: get('prev', 'user', String(u.id)).amount,
        current: get('cur', 'user', String(u.id)).amount,
      }))
      .filter((u) => u.previous || u.current)
      .sort((a, b) => viSort(a.name, b.name));

    // O3 — Doanh số khu vực trọng điểm: chỉ dòng Miền Trung có số (như Power BI)
    const centralCur = get('cur0', 'total', '').central;
    const centralPrev = get('prev', 'total', '').central;

    return {
      anchor,
      today,
      ranges,
      kpiMonth: { year: y, month: m },
      updatedAt: new Date().toISOString(),
      groups: {
        rows: groupRows,
        total: {
          target: oneTarget,
          current: totalCur,
          pctCurrent: div(totalCur, oneTarget),
          previous: totalPrev,
          pctPrevious: div(totalPrev, oneTarget),
        },
      },
      visualGroups: {
        rows: visualRows,
        total: {
          target: null,
          current: totalCur,
          pctCurrent: null,
          previous: totalPrev,
          pctPrevious: null,
        },
      },
      staff,
      regions:
        centralCur || centralPrev
          ? [{ region: CENTRAL, current: centralCur, previous: centralPrev }]
          : [],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hằng Tuần › Kết Quả Hàng Tuần (dataset_sale - version 2)
  // ─────────────────────────────────────────────────────────────────────────
  async getHangTuan(q: HangTuanQueryDto) {
    const today = todayVn();
    const Y = q.year;
    const months = q.months?.length ? new Set(q.months) : null;
    const weekSet = q.weeks?.length ? new Set(q.weeks) : null;

    // Tập ngày đang lọc (dim_date ∩ Năm ∩ Tháng ∩ Tuần, tới hôm nay).
    const inMonths: IsoDate[] = [];
    for (
      let d = maxD(daxDate(Y, 1, 1), CALENDAR_START);
      d <= minD(daxDate(Y, 12, 31), today);
      d = addDays(d, 1)
    ) {
      if (!months || months.has(parts(d).m)) inMonths.push(d);
    }
    const weekOptions = [...new Set(inMonths.map(monday))]
      .sort()
      .reverse()
      .map((start) => {
        const inYear = inMonths.find((d) => monday(d) === start)!;
        return {
          start,
          label: `Tuần ${weekNum(inYear)} (${ddmm(start)} - ${ddmm(addDays(start, 6))})`,
        };
      });
    const dates = weekSet
      ? inMonths.filter((d) => weekSet.has(monday(d)))
      : inMonths;

    const sellers = await this.prisma.$queryRaw<
      {
        user_id: number;
        seller_group: string;
        name: string;
        sc: string | null;
        team_id: number | null;
        team_name: string | null;
        team_sort: number | null;
      }[]
    >`
      SELECT s.user_id, s.seller_group, u.name,
             lower(split_part(u.email, '@', 1)) AS sc,
             t.id AS team_id, t.name AS team_name, t.sort_order AS team_sort
      FROM analytics_dk_weekly_sellers s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN analytics_sale_team_members m ON m.user_id = s.user_id
      LEFT JOIN analytics_sale_teams t ON t.id = m.team_id
      ORDER BY s.sort_order, s.seller_group, u.name`;

    const teamOptions = [
      ...new Map(
        sellers
          .filter((s) => s.team_id !== null)
          .sort((a, b) => (a.team_sort ?? 0) - (b.team_sort ?? 0))
          .map((s) => [s.team_id!, { id: s.team_id!, name: s.team_name! }]),
      ).values(),
    ];
    const options = {
      weeks: weekOptions,
      teams: teamOptions,
      sellerGroups: [...new Set(sellers.map((s) => s.seller_group))],
    };
    const updatedAt = new Date().toISOString();
    if (!dates.length) return { empty: true as const, options, updatedAt };

    const r = dates[dates.length - 1];
    const teamIds = q.saleTeamIds?.length ? new Set(q.saleTeamIds) : null;
    const groupNames = q.sellerGroups?.length ? new Set(q.sellerGroups) : null;
    const userFiltered = !!(teamIds || groupNames);
    const selected = sellers.filter(
      (s) =>
        (!teamIds || (s.team_id !== null && teamIds.has(s.team_id))) &&
        (!groupNames || groupNames.has(s.seller_group)),
    );
    const allIds = sellers.map((s) => s.user_id);

    // Các khoảng ngày cần doanh thu theo ngày.
    const pmDate = edate(r, -1);
    const prevMtd: Range = {
      from: monthStart(pmDate),
      to: daxDate(
        parts(pmDate).y,
        parts(pmDate).m,
        Math.min(parts(r).d, parts(monthEnd(pmDate)).d),
      ),
    };
    const weekR: Range = { from: monday(r), to: r };
    const lastWeekR: Range = {
      from: addDays(monday(r), -7),
      to: addDays(monday(r), -1),
    };
    const curWeek: Range = { from: monday(today), to: today };
    const lo = minD(
      monthStart(dates[0]),
      prevMtd.from,
      lastWeekR.from,
      curWeek.from,
    );
    const hi = maxD(r, today);

    const [daily, kpiRows] = await Promise.all([
      this.v2Daily(lo, hi),
      this.prisma.$queryRaw<
        { year: number; month: number; sc: string; v: number }[]
      >`
        SELECT year, month, lower(sale_code) AS sc, SUM(kpi_value)::float8 AS v
        FROM analytics_kpi_revenue_targets
        WHERE year BETWEEN ${parts(lo).y} AND ${parts(hi).y}
        GROUP BY year, month, lower(sale_code)`,
    ]);

    // Doanh thu theo user × ngày (amount) + phần của khách mới trong tháng (isNew).
    const dayRev = new Map<string, { amount: number; isNew: number }>();
    for (const row of daily)
      dayRev.set(`${row.user_id}|${this.iso(row.d)}`, {
        amount: Number(row.amount),
        isNew: Number(row.new_amount),
      });
    const sumDays = (ids: number[], list: IsoDate[], newOnly = false) => {
      let s = 0;
      for (const d of list)
        for (const id of ids) {
          const v = dayRev.get(`${id}|${d}`);
          s += (newOnly ? v?.isNew : v?.amount) ?? 0;
        }
      return s;
    };
    const span = (from: IsoDate, to: IsoDate) => {
      const out: IsoDate[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
      return out;
    };
    const rev = (ids: number[], from: IsoDate, to: IsoDate) =>
      sumDays(ids, span(from, to));

    // KPI tháng theo sale_code; không lọc người bán → mọi dòng KPI của tháng.
    const kpiOf = (sc: (string | null)[] | null, yy: number, mm: number) => {
      const set = sc ? new Set(sc.filter((x): x is string => !!x)) : null;
      return kpiRows
        .filter(
          (k) => k.year === yy && k.month === mm && (!set || set.has(k.sc)),
        )
        .reduce((s, k) => s + Number(k.v), 0);
    };

    const ry = parts(r).y;
    const rm = parts(r).m;
    const selIds = selected.map((s) => s.user_id);
    const selSc = userFiltered ? selected.map((s) => s.sc) : null;
    const weekStarts = new Set(dates.map(monday));
    // DS_selected_week: đúng 1 tuần đang lọc → doanh số tuần đó, ngược lại tuần hiện tại.
    const selectedWeek = (ids: number[]) =>
      weekStarts.size === 1
        ? sumDays(ids, dates)
        : rev(ids, curWeek.from, curWeek.to);

    const metrics = (ids: number[], sc: (string | null)[] | null) => {
      const kpi = kpiOf(sc, ry, rm);
      const ds = rev(ids, monthStart(r), r);
      const dsPrev = rev(ids, prevMtd.from, prevMtd.to);
      const wk = rev(ids, weekR.from, weekR.to);
      const lw = rev(ids, lastWeekR.from, lastWeekR.to);
      return {
        kpi,
        revenue: ds,
        kpiPct: div(ds, kpi),
        previousMtd: dsPrev,
        mom: div(ds - dsPrev, dsPrev),
        thisWeek: wk,
        lastWeek: lw,
        wow: div(wk - lw, lw),
      };
    };
    const nonEmpty = (x: ReturnType<typeof metrics>) =>
      !!(x.kpi || x.revenue || x.previousMtd || x.thisWeek || x.lastWeek);

    const self = metrics(selIds, selSc);
    const deptKpi = kpiOf(null, ry, rm);
    const deptRevenue = rev(allIds, monthStart(r), r);
    const selWeek = selectedWeek(selIds);
    const deptWeek = selectedWeek(allIds);

    // Pivot "Hiệu suất nhân viên sale": Người Bán → Cá Nhân.
    const pivot = [...new Set(selected.map((s) => s.seller_group))]
      .map((g) => {
        const members = selected.filter((s) => s.seller_group === g);
        return {
          name: g,
          ...metrics(
            members.map((s) => s.user_id),
            members.map((s) => s.sc),
          ),
          users: members
            .map((s) => ({ name: s.name, ...metrics([s.user_id], [s.sc]) }))
            .filter(nonEmpty),
        };
      })
      .filter(nonEmpty);
    // KPI của sale_code không thuộc người bán nào (Power BI hiện dòng trống).
    if (!userFiltered) {
      const known = new Set(sellers.map((s) => s.sc));
      const orphan = kpiRows
        .filter((k) => k.year === ry && k.month === rm && !known.has(k.sc))
        .reduce((s, k) => s + Number(k.v), 0);
      if (orphan)
        pivot.push({
          name: '(Trống)',
          ...metrics([], []),
          kpi: orphan,
          users: [],
        });
    }

    // Cột "Doanh số" theo Năm-Tháng của tập ngày đang lọc.
    const byMonth = new Map<string, number>();
    for (const d of dates)
      byMonth.set(ym(d), (byMonth.get(ym(d)) ?? 0) + sumDays(selIds, [d]));

    // "Doanh số lũy kế theo ngày": DS MTD tới từng ngày + KPI lũy kế (KPI/số ngày × ngày).
    const kpiByMonth = new Map<string, number>();
    const cumulative = dates.map((d) => {
      if (!kpiByMonth.has(ym(d)))
        kpiByMonth.set(ym(d), kpiOf(selSc, parts(d).y, parts(d).m));
      return {
        date: d,
        label: ddmm(d),
        revenue: rev(selIds, monthStart(d), d),
        kpi: (kpiByMonth.get(ym(d))! / parts(monthEnd(d)).d) * parts(d).d,
      };
    });

    return {
      empty: false as const,
      options,
      updatedAt,
      refDate: r,
      selection: { from: dates[0], to: r, weeks: weekStarts.size },
      cards: {
        revenueMtd: self.revenue,
        previousMtd: self.previousMtd,
        mom: self.mom,
        kpi: self.kpi,
        remaining: self.kpi - self.revenue,
        achieved: self.kpiPct,
        revenueNew: sumDays(selIds, dates, true),
        deptKpi,
        deptRemaining: deptKpi - deptRevenue,
        selectedWeek: selWeek,
        selectedWeekRemaining: self.kpi / 4 - selWeek,
        deptSelectedWeek: deptWeek,
        deptSelectedWeekRemaining: deptKpi / 4 - deptWeek,
      },
      byMonth: [...byMonth].map(([key, revenue]) => ({ key, revenue })),
      pivot,
      total: self,
      cumulative,
    };
  }

  /**
   * Doanh thu theo nhân viên × ngày của báo cáo Hằng Tuần (Revenue của version 2:
   * Σ sub_total không làm tròn, bỏ STTTW01 từ 01/07/2026, chỉ nhân viên trong
   * analytics_dk_weekly_sellers) + phần doanh thu của "khách mới trong tháng"
   * (tháng của hoá đơn = tháng mua đầu tiên của khách cha).
   */
  private async v2Daily(lo: IsoDate, hi: IsoDate) {
    const lake = await this.base.dataLakeReady();
    const oldInv = lake
      ? Prisma.sql`
        UNION ALL
        SELECT (o."purchaseDate" + interval '7 hour')::date AS d, c.code AS customer_code
        FROM data_lake.invoice o
        JOIN users ou ON ou.kiot_viet_id::text = o."soldById"
        JOIN analytics_dk_weekly_sellers s ON s.user_id = ou.id
        LEFT JOIN customers c ON c.code = o."customerCode"
        WHERE o.status <> 2`
      : Prisma.empty;
    return this.prisma.$queryRaw<
      { user_id: number; d: Date; amount: number; new_amount: number }[]
    >`
      WITH hist AS (
        SELECT (i."purchaseDate" + interval '7 hour')::date AS d, c.code AS customer_code
        FROM invoices i
        JOIN analytics_dk_weekly_sellers s ON s.user_id = i."soldById"
        LEFT JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2
        ${oldInv}
      ),
      ${this.base.custCte(Prisma.sql`c.code IN (SELECT customer_code FROM hist WHERE customer_code IS NOT NULL)`)},
      first_p AS (
        SELECT COALESCE(cu.parent_name, ${BLANK}) AS p, MIN(h.d) AS fd
        FROM hist h LEFT JOIN cust cu ON cu.code = h.customer_code
        GROUP BY 1
      ),
      inv AS (
        SELECT i.id, i."soldById" AS user_id, (i."purchaseDate" + interval '7 hour')::date AS d,
               c.code AS customer_code
        FROM invoices i
        JOIN analytics_dk_weekly_sellers s ON s.user_id = i."soldById"
        LEFT JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2
          AND (i."purchaseDate" + interval '7 hour')::date BETWEEN ${lo}::date AND ${hi}::date
      )
      SELECT x.user_id, x.d,
        COALESCE(SUM(v.sub_total), 0)::float8 AS amount,
        COALESCE(SUM(v.sub_total) FILTER (
          WHERE date_trunc('month', fp.fd) = date_trunc('month', x.d)), 0)::float8 AS new_amount
      FROM inv x
      JOIN invoice_details dd ON dd."invoiceId" = x.id
      LEFT JOIN products p ON p.id = dd."productId"
      CROSS JOIN LATERAL (
        SELECT (COALESCE(dd.quantity, 0) * COALESCE(dd.price, 0)
                - COALESCE(dd.quantity, 0) * COALESCE(dd.discount, 0))::float8 AS sub_total
      ) v
      LEFT JOIN cust cu ON cu.code = x.customer_code
      LEFT JOIN first_p fp ON fp.p = COALESCE(cu.parent_name, ${BLANK})
      WHERE x.d < ${V2_EXCLUDE_FROM}::date OR COALESCE(p.code, '') <> ${V2_EXCLUDED_PRODUCT}
      GROUP BY x.user_id, x.d`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: chỉ tiêu nhóm hàng, vị mứt, người bán Hằng Tuần
  // ─────────────────────────────────────────────────────────────────────────
  listGroupTargets(q: DkGroupTargetListQueryDto) {
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (q.kind) conds.push(Prisma.sql`kind = ${q.kind}`);
    if (q.year) conds.push(Prisma.sql`year = ${q.year}`);
    return this.prisma.$queryRaw<
      {
        id: number;
        kind: string;
        groupName: string;
        year: number;
        month: number;
        kpiValue: number;
      }[]
    >`
      SELECT id, kind, group_name AS "groupName", year, month, kpi_value AS "kpiValue"
      FROM analytics_dk_group_targets
      WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY kind, year, month, group_name`;
  }

  async upsertGroupTarget(dto: DkGroupTargetDto) {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO analytics_dk_group_targets (kind, group_name, year, month, kpi_value)
      VALUES (${dto.kind}, ${dto.groupName.trim()}, ${dto.year}, ${dto.month}, ${dto.kpiValue})
      ON CONFLICT (kind, group_name, year, month)
      DO UPDATE SET kpi_value = EXCLUDED.kpi_value, updated_at = CURRENT_TIMESTAMP
      RETURNING id`;
    return { id: rows[0]?.id };
  }

  async updateGroupTarget(id: number, dto: DkGroupTargetUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_dk_group_targets
      SET kpi_value = ${dto.kpiValue}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy chỉ tiêu');
    return { success: true };
  }

  async deleteGroupTarget(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_dk_group_targets WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy chỉ tiêu');
    return { success: true };
  }

  listJamFlavors(q: DkJamFlavorListQueryDto) {
    const term = q.search?.trim() ? `%${q.search.trim()}%` : null;
    return this.prisma.$queryRaw<
      {
        id: number;
        productCode: string;
        productName: string | null;
        jamFlavor: string;
        brand: string;
      }[]
    >`
      SELECT j.id, j.product_code AS "productCode", p.name AS "productName",
             j.jam_flavor AS "jamFlavor", j.brand
      FROM analytics_dk_jam_flavors j
      LEFT JOIN LATERAL (
        SELECT name FROM products WHERE code = j.product_code ORDER BY id LIMIT 1
      ) p ON true
      WHERE ${term}::text IS NULL
         OR j.product_code ILIKE ${term} OR j.jam_flavor ILIKE ${term} OR p.name ILIKE ${term}
      ORDER BY j.brand, j.jam_flavor, j.product_code`;
  }

  async createJamFlavor(dto: DkJamFlavorDto) {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO analytics_dk_jam_flavors (product_code, jam_flavor, brand)
      VALUES (${dto.productCode.trim()}, ${dto.jamFlavor.trim()}, ${dto.brand})
      ON CONFLICT (product_code)
      DO UPDATE SET jam_flavor = EXCLUDED.jam_flavor, brand = EXCLUDED.brand,
                    updated_at = CURRENT_TIMESTAMP
      RETURNING id`;
    return { id: rows[0]?.id };
  }

  async updateJamFlavor(id: number, dto: DkJamFlavorUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_dk_jam_flavors
      SET jam_flavor = COALESCE(${dto.jamFlavor?.trim() ?? null}, jam_flavor),
          brand = COALESCE(${dto.brand ?? null}, brand),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy mã hàng');
    return { success: true };
  }

  async deleteJamFlavor(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_dk_jam_flavors WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy mã hàng');
    return { success: true };
  }

  /** Nhân viên thuộc team sale + nhóm "Người Bán" trong báo cáo Hằng Tuần (null = không tính). */
  listWeeklySellers() {
    return this.prisma.$queryRaw<
      {
        userId: number;
        name: string;
        email: string;
        teamName: string | null;
        sellerGroup: string | null;
        sortOrder: number | null;
      }[]
    >`
      SELECT u.id AS "userId", u.name, u.email, t.name AS "teamName",
             s.seller_group AS "sellerGroup", s.sort_order AS "sortOrder"
      FROM users u
      LEFT JOIN analytics_sale_team_members m ON m.user_id = u.id
      LEFT JOIN analytics_sale_teams t ON t.id = m.team_id
      LEFT JOIN analytics_dk_weekly_sellers s ON s.user_id = u.id
      WHERE s.user_id IS NOT NULL OR m.user_id IS NOT NULL
      ORDER BY (s.user_id IS NULL), s.sort_order, s.seller_group, u.name`;
  }

  async setWeeklySeller(userId: number, dto: DkWeeklySellerDto) {
    const u = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM users WHERE id = ${userId}`;
    if (!u.length) throw new NotFoundException('Không tìm thấy nhân viên');
    await this.prisma.$executeRaw`
      INSERT INTO analytics_dk_weekly_sellers (user_id, seller_group, sort_order)
      VALUES (${userId}, ${dto.sellerGroup.trim()}, ${dto.sortOrder ?? 0})
      ON CONFLICT (user_id)
      DO UPDATE SET seller_group = EXCLUDED.seller_group, sort_order = EXCLUDED.sort_order,
                    updated_at = CURRENT_TIMESTAMP`;
    return { success: true };
  }

  async removeWeeklySeller(userId: number) {
    await this.prisma
      .$executeRaw`DELETE FROM analytics_dk_weekly_sellers WHERE user_id = ${userId}`;
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dựng các dòng dùng chung
  // ─────────────────────────────────────────────────────────────────────────
  /** O1 — nhóm hàng 2026 có doanh thu kỳ này; Kế hoạch = KPI tháng / perMonth. */
  private groupRows(
    line: AggMap,
    targets: Map<string, number>,
    y: number,
    m: number,
    perMonth: number,
  ) {
    const get = this.getter(line);
    return this.keysWith(line, 'cur', 'group', (a) => a.amount > 0)
      .sort(viSort)
      .map((name) => {
        const r = get('cur', 'group', name).amount;
        const t = targets.get(`group2026|${name}|${y}|${m}`);
        const target = t === undefined ? null : t / perMonth;
        return {
          name,
          revenue: r,
          previous: get('prev', 'group', name).amount,
          target,
          pct: div(r, target),
        };
      });
  }

  /** O2 — nhóm hàng hiển thị có doanh thu kỳ này, tỷ trọng trên tổng doanh thu kỳ. */
  private visualRows(line: AggMap) {
    const get = this.getter(line);
    const total = get('cur', 'total', '').amount;
    return this.keysWith(line, 'cur', 'visual', (a) => a.amount > 0)
      .sort(viSort)
      .map((name) => {
        const r = get('cur', 'visual', name).amount;
        return {
          name,
          revenue: r,
          previous: get('prev', 'visual', name).amount,
          share: div(r, total),
        };
      });
  }

  /** Top 5 sản phẩm (theo tên) Lermao / Phượng Hoàng theo sản lượng trong kỳ. */
  private topProducts(line: AggMap, range: string) {
    const get = this.getter(line);
    const top = (g: string) =>
      this.keysWith(
        line,
        range,
        'product',
        (a, key) => a.quantity > 0 && key.startsWith(`${g}|`),
      )
        .map((key) => {
          const a = get(range, 'product', key);
          return {
            name: key.slice(g.length + 1),
            quantity: a.quantity,
            revenue: a.amount,
          };
        })
        .filter((p) => p.name)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5);
    return { lermao: top(LERMAO), phuongHoang: top(PHUONG_HOANG) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SQL dùng chung
  // ─────────────────────────────────────────────────────────────────────────
  private anchor(date: string | undefined, today: IsoDate): IsoDate {
    if (!date) return today;
    if (date > today) return today;
    if (date < CALENDAR_START) return CALENDAR_START;
    return date;
  }

  /** Tháng của ngày mốc (tới hôm nay) + cả tháng trước. */
  private monthRanges(anchor: IsoDate, today: IsoDate): Ranges {
    const prevMonth = edate(monthStart(anchor), -1);
    return {
      cur: { from: monthStart(anchor), to: minD(monthEnd(anchor), today) },
      prev: { from: prevMonth, to: monthEnd(prevMonth) },
    };
  }

  private iso(d: Date | string): IsoDate {
    return typeof d === 'string'
      ? d.slice(0, 10)
      : d.toISOString().slice(0, 10);
  }

  /**
   * baseCtes (cust, prod, seller, invx …) + CTE riêng:
   *   dk_inv  — hoá đơn đã lọc + nhân viên bán + team (MATERIALIZED để Postgres
   *             không trộn lại với các CTE ước lượng sai số dòng)
   *   dk_line — dòng hàng (đã làm tròn như Power BI) + vùng, loại khách, team,
   *             nhân viên, mã / tên hàng, ngành hàng, danh mục, nhóm 2026, nhóm hiển thị.
   */
  private async ctes(dateCond: Prisma.Sql, f: DkFilters = {}) {
    const lake = await this.base.dataLakeReady();
    const q = {
      year: parts(todayVn()).y,
      saleTeamId: f.saleTeamId,
      parentName: f.parentName,
    } as AnalyticsBusinessQueryDto;
    const base = await this.base.baseCtes(q, dateCond);
    // Người bán của hoá đơn cũ (mã KiotViet → users.kiot_viet_id): truy vấn con
    // theo từng hoá đơn cũ (khoá chính code) — tránh nested loop trên CTE.
    const oldUser = lake
      ? Prisma.sql`(SELECT ou.id FROM data_lake.invoice o
           JOIN users ou ON ou.kiot_viet_id::text = o."soldById"
           WHERE o.code = x.code LIMIT 1)`
      : Prisma.sql`NULL::int`;
    // Dòng hàng hoá đơn cũ (giống line_raw của baseCtes).
    const oldLines = lake
      ? Prisma.sql`
        UNION ALL
        SELECT x.code, x.d, x.ok, x.customer_code, x.region, x.customer_type, x.team_id, x.user_id,
               od."productCode",
               COALESCE(od.quantity, 0)::float8,
               (COALESCE(od.quantity, 0) * COALESCE(od.price, 0)
                - COALESCE(od.quantity, 0) * COALESCE(od.discount, 0))::float8
        FROM dk_inv x
        JOIN data_lake.invoice_detail od ON NOT x.is_new AND od."invoiceCode" = x.code`
      : Prisma.empty;
    const prodWhere = f.productGroup
      ? Prisma.sql`WHERE pr.group2026 = ${f.productGroup}`
      : Prisma.empty;
    return Prisma.sql`${base},
      dk_inv0 AS MATERIALIZED (
        SELECT x.id, x.is_new, x.code, x.d, x.ok, x.total, x.customer_code, x.parent_name,
               x.customer_type, x.region, i."soldById" AS user_id
        FROM invx x JOIN invoices i ON i.id = x.id
        WHERE x.is_new
        UNION ALL
        SELECT x.id, x.is_new, x.code, x.d, x.ok, x.total, x.customer_code, x.parent_name,
               x.customer_type, x.region, ${oldUser} AS user_id
        FROM invx x
        WHERE NOT x.is_new
      ),
      dk_inv AS MATERIALIZED (
        SELECT x.*, m.team_id
        FROM dk_inv0 x
        LEFT JOIN analytics_sale_team_members m ON m.user_id = x.user_id
      ),
      dk_pname AS (
        SELECT DISTINCT ON (code) code, name FROM products ORDER BY code, id
      ),
      dk_line0 AS (
        SELECT x.code, x.d, x.ok, x.customer_code, x.region, x.customer_type, x.team_id, x.user_id,
               p.code AS product_code,
               COALESCE(d.quantity, 0)::float8 AS quantity,
               (COALESCE(d.quantity, 0) * COALESCE(d.price, 0)
                - COALESCE(d.quantity, 0) * COALESCE(d.discount, 0))::float8 AS sub_total
        FROM dk_inv x
        JOIN invoice_details d ON x.is_new AND d."invoiceId" = x.id
        LEFT JOIN products p ON p.id = d."productId"
        ${oldLines}
      ),
      dk_line AS (
        SELECT l.code, l.d, l.ok, l.customer_code, l.region, l.customer_type, l.team_id, l.user_id,
               ROUND(l.quantity)::float8 AS quantity, ROUND(l.sub_total)::float8 AS sub_total,
               l.product_code, pn.name AS product_name,
               pr.product_type, pr.category, pr.group2026, pr.visual_group
        FROM dk_line0 l
        LEFT JOIN prod pr ON pr.code = l.product_code
        LEFT JOIN dk_pname pn ON pn.code = l.product_code
        ${prodWhere}
      )`;
  }

  /**
   * Một câu SQL cho cả trang: tổng hợp dòng hàng (line) và hoá đơn (inv) theo
   * từng kỳ (ranges) × nhiều cách gom nhóm (GROUPING SETS), cộng khách mới theo
   * kỳ (toàn bộ / theo team / theo vùng của khách).
   * dateCond (tuỳ chọn) thay cho điều kiện "từ ngày nhỏ nhất tới lớn nhất của ranges".
   */
  private async collect(
    ranges: Ranges,
    spec: {
      line?: Dims;
      inv?: Dims;
      newCustomers?: string[];
      /** Điều kiện thêm trên dòng hàng (alias x của dk_line) để giảm khối lượng. */
      lineWhere?: Prisma.Sql;
    },
    f: DkFilters = {},
    dateCond?: Prisma.Sql,
  ) {
    const all = Object.values(ranges);
    const span = Prisma.sql`x.d BETWEEN ${minD(...all.map((r) => r.from))}::date AND ${maxD(...all.map((r) => r.to))}::date`;
    const ctes = await this.ctes(dateCond ?? span, f);
    const lake = await this.base.dataLakeReady();

    const selects: Prisma.Sql[] = [];
    if (spec.line)
      selects.push(this.groupedSql('line', spec.line, spec.lineWhere));
    if (spec.inv) selects.push(this.groupedSql('inv', spec.inv));

    let ncCtes = Prisma.empty;
    const ncKeys = spec.newCustomers ?? [];
    if (ncKeys.length) {
      const oldHist = lake
        ? Prisma.sql`
          UNION ALL
          SELECT c.code, m.team_id, (o."purchaseDate" + interval '7 hour')::date
          FROM data_lake.invoice o
          JOIN seller s ON s.kiot_viet_id::text = o."soldById"
          JOIN customers c ON c.code = o."customerCode"
          JOIN dk_cand cd ON cd.customer_code = c.code
          LEFT JOIN analytics_sale_team_members m ON m.user_id = s.user_id
          WHERE o.status <> 2`
        : Prisma.empty;
      // Lịch sử hoá đơn (mọi thời gian) của các khách có hoá đơn trong kỳ.
      ncCtes = Prisma.sql`,
        dk_cand AS (SELECT DISTINCT customer_code FROM dk_inv WHERE customer_code IS NOT NULL),
        dk_hist AS (
          SELECT c.code AS customer_code, m.team_id, (i."purchaseDate" + interval '7 hour')::date AS d
          FROM invoices i
          JOIN seller s ON s.user_id = i."soldById"
          JOIN customers c ON c.id = i."customerId"
          JOIN dk_cand cd ON cd.customer_code = c.code
          LEFT JOIN analytics_sale_team_members m ON m.user_id = i."soldById"
          WHERE i.status <> 2
          ${oldHist}
        ),
        dk_fa AS (
          SELECT customer_code, MIN(d) AS fd FROM dk_hist
          WHERE d >= ${CALENDAR_START}::date GROUP BY customer_code
        ),
        dk_ft AS (
          SELECT team_id, customer_code, MIN(d) AS fd FROM dk_hist
          WHERE team_id IS NOT NULL AND d >= ${CALENDAR_START}::date
          GROUP BY team_id, customer_code
        ),
        dk_reg AS (
          SELECT customer_code, MIN(region) AS region FROM dk_inv
          WHERE customer_code IS NOT NULL GROUP BY customer_code
        )`;
      const inKeys = Prisma.sql`r.k IN (${Prisma.join(ncKeys)})`;
      selects.push(Prisma.sql`
        SELECT 'new'::text AS src, r.k::text AS k, 'all'::text AS dim, ''::text AS key,
          COALESCE((SELECT SUM(x.total) FROM dk_inv x
                    JOIN dk_fa f2 ON f2.customer_code = x.customer_code
                    WHERE f2.fd BETWEEN r.f AND r.t AND x.d BETWEEN r.f AND r.t), 0)::float8 AS amount,
          0::float8 AS central, 0::float8 AS quantity, 0::int AS orders,
          COUNT(fa.customer_code)::int AS customers, 0::int AS orders_all, 0::int AS customers_all
        FROM dk_r r LEFT JOIN dk_fa fa ON fa.fd BETWEEN r.f AND r.t
        WHERE ${inKeys}
        GROUP BY r.k, r.f, r.t`);
      selects.push(Prisma.sql`
        SELECT 'new', r.k::text, 'region', rg.region, 0::float8, 0::float8, 0::float8, 0,
          COUNT(*)::int, 0, 0
        FROM dk_r r
        JOIN dk_fa fa ON fa.fd BETWEEN r.f AND r.t
        JOIN dk_reg rg ON rg.customer_code = fa.customer_code
        WHERE ${inKeys} AND rg.region IS NOT NULL
        GROUP BY r.k, rg.region`);
      selects.push(Prisma.sql`
        SELECT 'new', r.k::text, 'team', ft.team_id::text, 0::float8, 0::float8, 0::float8, 0,
          COUNT(*)::int, 0, 0
        FROM dk_r r JOIN dk_ft ft ON ft.fd BETWEEN r.f AND r.t
        WHERE ${inKeys}
        GROUP BY r.k, ft.team_id`);
    }

    const rows = await this.prisma.$queryRaw<
      {
        src: string;
        k: string;
        dim: string;
        key: string | null;
        amount: number;
        central: number;
        quantity: number;
        orders: number;
        customers: number;
        orders_all: number;
        customers_all: number;
      }[]
    >`
      WITH ${ctes},
      dk_r(k, f, t) AS (VALUES ${Prisma.join(
        Object.entries(ranges).map(
          ([k, r]) => Prisma.sql`(${k}::text, ${r.from}::date, ${r.to}::date)`,
        ),
      )})
      ${ncCtes}
      ${Prisma.join(
        selects.map((s) => Prisma.sql`(${s})`),
        ' UNION ALL ',
      )}`;

    const line: AggMap = new Map();
    const inv: AggMap = new Map();
    const nc = {
      count: new Map<string, number>(),
      revenue: new Map<string, number>(),
      byTeam: new Map<string, number>(),
      byRegion: new Map<string, number>(),
    };
    for (const row of rows) {
      if (row.src === 'new') {
        const n = Number(row.customers);
        if (row.dim === 'all') {
          nc.count.set(row.k, n);
          nc.revenue.set(row.k, Number(row.amount));
        } else if (row.dim === 'team') nc.byTeam.set(`${row.k}|${row.key}`, n);
        else nc.byRegion.set(`${row.k}|${row.key}`, n);
        continue;
      }
      const map = row.src === 'line' ? line : inv;
      if (!map.has(row.k)) map.set(row.k, new Map());
      const byDim = map.get(row.k)!;
      if (!byDim.has(row.dim)) byDim.set(row.dim, new Map());
      byDim.get(row.dim)!.set(row.key ?? '', {
        amount: Number(row.amount),
        central: Number(row.central),
        quantity: Number(row.quantity),
        orders: Number(row.orders),
        customers: Number(row.customers),
        ordersAll: Number(row.orders_all),
        customersAll: Number(row.customers_all),
      });
    }
    return { line, inv, nc };
  }

  /**
   * SELECT … GROUP BY GROUPING SETS cho 1 nguồn. Nhận dạng tập gom nhóm của mỗi
   * dòng bằng GROUPING(c0..cn-1) (bit = 1 nếu cột không nằm trong tập; c0 là bit cao).
   */
  private groupedSql(
    source: 'line' | 'inv',
    dims: Dims,
    where?: Prisma.Sql,
  ): Prisma.Sql {
    const cols = [...new Set(Object.values(dims).flat())];
    const n = cols.length;
    const col = (c: DimCol) => Prisma.raw(`s.${c}`);
    const bit = (c: DimCol) => 1 << (n - 1 - cols.indexOf(c));
    const full = (1 << n) - 1;
    const grouping = n
      ? Prisma.sql`GROUPING(${Prisma.join(cols.map(col))})`
      : Prisma.sql`0`;
    const entries = Object.entries(dims).map(([name, dc]) => ({
      name,
      mask: full - dc.reduce((s, c) => s + bit(c), 0),
      key: Prisma.sql`concat_ws('|', ${Prisma.join(
        dc.map((c) => Prisma.sql`COALESCE(${col(c)}::text, '')`),
      )})`,
    }));
    const when = (pick: (e: (typeof entries)[number]) => Prisma.Sql) =>
      Prisma.join(
        entries.map(
          (e) => Prisma.sql`WHEN ${Prisma.raw(String(e.mask))} THEN ${pick(e)}`,
        ),
        ' ',
      );
    const dimSql = entries.length
      ? Prisma.sql`CASE ${grouping} ${when((e) => Prisma.sql`${e.name}::text`)} ELSE 'total' END`
      : Prisma.sql`'total'`;
    const keySql = entries.length
      ? Prisma.sql`CASE ${grouping} ${when((e) => e.key)} ELSE '' END`
      : Prisma.sql`''`;
    const sets = [
      Prisma.sql`(s.k)`,
      ...Object.values(dims).map(
        (dc) => Prisma.sql`(s.k, ${Prisma.join(dc.map(col))})`,
      ),
    ];
    const val =
      source === 'line' ? Prisma.sql`s.sub_total` : Prisma.sql`s.total`;
    const qty =
      source === 'line'
        ? Prisma.sql`COALESCE(SUM(s.quantity), 0)::float8`
        : Prisma.sql`0::float8`;
    const table = source === 'line' ? Prisma.sql`dk_line` : Prisma.sql`dk_inv`;
    return Prisma.sql`
      SELECT ${source}::text AS src, s.k::text AS k, ${dimSql}::text AS dim, ${keySql}::text AS key,
        COALESCE(SUM(${val}) FILTER (WHERE s.ok), 0)::float8 AS amount,
        COALESCE(SUM(${val}) FILTER (WHERE s.ok AND s.region = ${CENTRAL}), 0)::float8 AS central,
        ${qty} AS quantity,
        COUNT(DISTINCT s.code) FILTER (WHERE s.ok)::int AS orders,
        COUNT(DISTINCT COALESCE(s.customer_code, ${BLANK})) FILTER (WHERE s.ok)::int AS customers,
        COUNT(DISTINCT s.code)::int AS orders_all,
        COUNT(DISTINCT COALESCE(s.customer_code, ${BLANK}))::int AS customers_all
      FROM (
        SELECT r.k, x.* FROM ${table} x JOIN dk_r r ON x.d BETWEEN r.f AND r.t
        ${where ? Prisma.sql`WHERE ${where}` : Prisma.empty}
      ) s
      GROUP BY GROUPING SETS (${Prisma.join(sets)})`;
  }

  private getter(map: AggMap) {
    return (range: string, dim: string, key: string): Agg =>
      map.get(range)?.get(dim)?.get(key) ?? ZERO;
  }

  private keysWith(
    map: AggMap,
    range: string,
    dim: string,
    pred: (a: Agg, key: string) => boolean,
  ): string[] {
    const m = map.get(range)?.get(dim);
    if (!m) return [];
    return [...m].filter(([k, a]) => k !== '' && pred(a, k)).map(([k]) => k);
  }

  /**
   * Chỉ tiêu doanh số tháng theo sale (KPI_target_sale_thismonth): dòng KPI của
   * nhân viên thuộc team sale (sale_code = phần trước @ của email).
   */
  private async saleKpi(year: number, month: number) {
    const rows = await this.prisma.$queryRaw<
      { sc: string; team_id: number; v: number }[]
    >`
      WITH km AS (
        SELECT lower(sale_code) AS sc, SUM(kpi_value) AS v
        FROM analytics_kpi_revenue_targets
        WHERE year = ${year} AND month = ${month}
        GROUP BY lower(sale_code)
      ),
      su AS (
        SELECT DISTINCT lower(split_part(u.email, '@', 1)) AS sc, m.team_id
        FROM analytics_sale_team_members m
        JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale
        JOIN users u ON u.id = m.user_id
      )
      SELECT km.sc, su.team_id, km.v::float8 AS v FROM km JOIN su ON su.sc = km.sc`;
    const byTeam = new Map<number, number>();
    const bySc = new Map<string, number>();
    for (const r of rows) {
      byTeam.set(r.team_id, (byTeam.get(r.team_id) ?? 0) + Number(r.v));
      bySc.set(r.sc, Number(r.v));
    }
    const total = [...bySc.values()].reduce((s, v) => s + v, 0);
    return { total, byTeam };
  }

  /** Chỉ tiêu nhóm hàng: key "kind|group|year|month" → KPI tháng. */
  private async groupTargets(months: { y: number; m: number }[]) {
    const rows = await this.prisma.$queryRaw<
      { kind: string; g: string; year: number; month: number; v: number }[]
    >`
      SELECT kind, group_name AS g, year, month, kpi_value::float8 AS v
      FROM analytics_dk_group_targets
      WHERE (year, month) IN (${Prisma.join(months.map((x) => Prisma.sql`(${x.y}::int, ${x.m}::int)`))})`;
    return new Map(
      rows.map((r) => [`${r.kind}|${r.g}|${r.year}|${r.month}`, Number(r.v)]),
    );
  }

  private saleTeams() {
    return this.prisma.$queryRaw<{ id: number; name: string }[]>`
      SELECT id, name FROM analytics_sale_teams WHERE is_sale ORDER BY sort_order, name`;
  }

  /**
   * Công nợ khách hàng (cuối kỳ) + số khách nợ quá 30 ngày từ lần mua cuối
   * (ending_kiot_debt, dim_customers[last_order_time]: mọi hoá đơn, bỏ người bán id 2).
   */
  private async debt(today: IsoDate) {
    const lake = await this.base.dataLakeReady();
    const old = lake
      ? Prisma.sql`
        UNION ALL
        SELECT o."customerCode" AS code, MAX((o."purchaseDate" + interval '7 hour')::date) AS d
        FROM data_lake.invoice o WHERE o.status <> 2 GROUP BY o."customerCode"`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { total: number; over30: number }[]
    >`
      WITH cb AS (
        SELECT DISTINCT ON (c.code) c.code, COALESCE(c."totalDebt", 0)::float8 AS debt
        FROM customers c ORDER BY c.code, c.id
      ),
      lo AS (
        SELECT c.code, MAX((i."purchaseDate" + interval '7 hour')::date) AS d
        FROM invoices i JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2 AND i."soldById" IS DISTINCT FROM 2
        GROUP BY c.code
        ${old}
      ),
      last AS (SELECT code, MAX(d) AS d FROM lo GROUP BY code)
      SELECT COALESCE(SUM(cb.debt), 0)::float8 AS total,
        COUNT(DISTINCT cb.code) FILTER (
          WHERE cb.debt > 0 AND (l.d IS NULL OR ${today}::date - l.d > 30))::int AS over30
      FROM cb LEFT JOIN last l ON l.code = cb.code`;
    return {
      total: Number(rows[0]?.total ?? 0),
      over30: Number(rows[0]?.over30 ?? 0),
    };
  }
}
