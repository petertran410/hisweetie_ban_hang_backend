import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsReportsService } from '../analytics-reports.service';
import {
  CALENDAR_START,
  CurrentPeriod,
  IsoDate,
  compareWindow,
  currentPeriod,
  daxDate,
  edate,
  parts,
  todayVn,
} from './analytics-period';
import {
  QtExclusionDto,
  QtExclusionUpdateDto,
  QtMetric,
  QtProfitQueryDto,
  QtQueryDto,
} from './analytics-quan-tri.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › Quản Trị — thay report Power BI "Báo Cáo Quản Trị"
// (dataset_sale, layout cũ). Cách tính chép Power BI:
//   • Filter toàn report: ngành hàng ∈ (Hàng OEM, Hàng thương hiệu, Hàng thương mại);
//     khách không thuộc danh sách loại trừ (is_include_from_report = 1, hoá đơn
//     không có khách cũng bị loại); người bán có trong bảng nhân viên (MỌI nhân
//     viên, không chỉ team sale); kênh bán có trong danh sách kênh.
//   • Vì filter ngành hàng nằm trên dim_product nên ISFILTERED(dim_product) luôn
//     đúng → mọi switch_* dùng số cấp DÒNG HÀNG (Revenue Detail, net_detail_profit,
//     product_margin). Số cấp hoá đơn chỉ còn ở AOV / ARPC / AOC / Revenue / khách.
//   • Giá vốn = số lượng × dim_product[cost_price] = MAX(inventories.cost) của mã
//     hàng (giá vốn HIỆN TẠI, không theo ngày bán). Cột invoice_detail[cost_price]
//     mà measure cost_amount gọi không còn trong model Power BI (measure đang lỗi).
//   • Trả hàng (net_profit, _margin, P&L): Power BI cộng TOÀN BỘ phiếu trả (bảng
//     return không nối ngày / khách / nhân viên) và giá vốn trả hàng lỗi. Ở đây
//     tính phiếu trả trong kỳ (ngày tạo phiếu), gắn nhân viên / khách theo hoá đơn
//     gốc (không có hoá đơn → người tạo phiếu, khách trên phiếu).
//   • Gộp hoá đơn hệ thống cũ (data_lake) như Kinh Doanh (quyết định 3).
// ═══════════════════════════════════════════════════════════════════════════

export const QT_PRODUCT_TYPES = [
  'Hàng OEM',
  'Hàng thương hiệu',
  'Hàng thương mại',
];
/** Top 10 Bán Chạy (trang Sản Phẩm) chỉ lấy 2 ngành này. */
const TOP10_PRODUCT_TYPES = ['Hàng thương hiệu', 'Hàng thương mại'];
/** dim_customer_type */
export const QT_CUSTOMER_TYPES = ['Khách buôn', 'Khách lẻ', 'Khách chuỗi'];
const OTHER_TEAM_NAME = '6.Khác';
const BUON = 'Khách buôn';
/** return_detail[cost_price]: bỏ tồn kho chi nhánh có mã KiotViet 631163 (Văn phòng Hà Nội). */
const RETURN_COST_EXCLUDED_BRANCH_KIOT_ID = '631163';
export const CUSTOMER_STATUSES = [
  'New Customer',
  'Repeat Customer',
  'Reacquired Customer',
] as const;
/** Số khách của "Top 20 Khách Đem Lại Lợi Nhuận Cao Nhất" / "Mua Nhiều Nhưng Biên Mỏng". */
const TOP_CUSTOMERS = 20;
const VIP_LABEL = 'Chiến Lược';
const NORMAL_LABEL = 'Bình Thường';

// ─── Bộ tổng hợp chung ─────────────────────────────────────────────────────
type Src = 'line' | 'inv' | 'ret' | 'retl';
interface Spec {
  dim: string;
  src: Src;
  /** Khoá nhóm (tối đa 6) — trả về dạng text. */
  keys?: Prisma.Sql[];
  where?: Prisma.Sql;
  /** JOIN thêm sau "FROM <src> x" (vd khoảng ngày năm trước). */
  join?: Prisma.Sql;
  /** Tính thêm các cột *_all (bỏ mọi lọc sản phẩm — ALL(dim_product)). */
  all?: boolean;
  /** Đếm số đơn / số khách cấp dòng (COUNT DISTINCT — chậm, chỉ bật khi cần). */
  counts?: boolean;
}
const MAX_KEYS = 6;
const COLS = [
  'amount', // Revenue Detail
  'orders', // Total Orders in Detail
  'customers', // active_customer_in_detail
  'quantity', // Total Quantity
  'cost', // cost_amount
  'disc', // discount_product
  'before_disc', // revenue_detail_before_discount
  'amount_all',
  'cost_all',
  'orders_all',
  'customers_all',
  'quantity_all',
  'revenue', // Revenue (cấp hoá đơn)
  'inv_orders', // Total Orders
  'inv_customers', // Active Customer
  'inv_discount', // discount_invoice
  'new_customers', // New Customer
  'new_revenue', // revenue_new_customer
  'ret_amount', // return_amount
  'ret_cost', // cost_return_detail_amount
  'ret_detail', // return_detail_amount
] as const;
type Col = (typeof COLS)[number];
export type QtAgg = Record<Col, number>;

interface AggOut {
  dim: string;
  keys: (string | null)[];
  v: QtAgg;
}

const zeroAgg = (): QtAgg =>
  Object.fromEntries(COLS.map((c) => [c, 0])) as QtAgg;

class AggResult {
  private map = new Map<string, AggOut>();
  constructor(rows: Record<string, unknown>[]) {
    for (const r of rows) {
      const keys: (string | null)[] = [];
      for (let i = 1; i <= MAX_KEYS; i++) {
        // Khoá luôn được SELECT dạng ::text.
        const k = r[`k${i}`] as string | null | undefined;
        keys.push(k ?? null);
      }
      while (keys.length && keys[keys.length - 1] === null) keys.pop();
      const dim = String(r.dim);
      const id = this.id(dim, keys);
      let out = this.map.get(id);
      if (!out) {
        out = { dim, keys, v: zeroAgg() };
        this.map.set(id, out);
      }
      for (const c of COLS) out.v[c] += Number(r[c] ?? 0);
    }
  }
  private id(dim: string, keys: (string | null)[]) {
    return JSON.stringify([dim, ...keys]);
  }
  /** Số của 1 nhóm (0 nếu không có). Khoá null ở cuối có thể bỏ. */
  get(dim: string, ...keys: (string | null)[]): QtAgg {
    const k = [...keys];
    while (k.length && k[k.length - 1] === null) k.pop();
    return this.map.get(this.id(dim, k))?.v ?? zeroAgg();
  }
  list(dim: string): AggOut[] {
    return [...this.map.values()].filter((o) => o.dim === dim);
  }
}

// ─── Kiểu dữ liệu trả về ───────────────────────────────────────────────────
export interface QtMetricValues {
  amount: number; // Doanh số (Revenue Detail)
  orders: number;
  customers: number;
  quantity: number;
  profit: number; // net_detail_profit = Revenue Detail - cost_amount
  margin: number | null; // product_margin
}
export interface QtRow extends QtMetricValues {
  key: string | null;
}
export interface QtCard {
  current: number | null;
  previous: number | null;
  growth: number | null;
}

interface QtFilter {
  saleTeamId?: number;
  customerType?: string;
  parentName?: string;
  groupSource?: string;
  productGroup?: string;
  productType?: string;
  category?: string;
  origin?: string;
  brand?: string;
  productCode?: string;
}

interface CteOpts {
  returns?: boolean;
  /** Cột trạng thái khách (Is New Customer This Month, Customer_Status). */
  status?: boolean;
  /** Tỉnh/thành của khách. */
  province?: boolean;
}

@Injectable()
export class AnalyticsQuanTriService {
  constructor(
    private prisma: PrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ═════════════════════════════════════════════════════════════════════════
  // Trang Tổng Quan
  // ═════════════════════════════════════════════════════════════════════════
  async getOverview(q: QtQueryDto) {
    const axis = q.axis ?? 'month';
    const updatedAt = new Date().toISOString();
    const period = this.period(q);
    if (!period) {
      return {
        period: null,
        compareLabel: null,
        compareRange: null,
        axis,
        updatedAt,
        cards: null,
        charts: null,
      };
    }
    const cmp = compareWindow(period);
    const cur = this.base.periodCond(period);
    const cmpCond = this.between(cmp.from, cmp.to);
    const sy = this.yearRanges(this.base.sameYearRanges(period, q.year, axis));
    const axisExpr = this.base.axisExpr(axis);
    const metric: QtMetric = q.metric ?? 'amount';
    const counts = this.needCounts(metric);

    const r = await this.run(
      this.filter(q),
      this.anyOf([cur, cmpCond, sy?.cond]),
      [
        ...this.at(this.totalSpecs('total'), cur),
        ...this.at(this.totalSpecs('cmp'), cmpCond),
        ...this.at(
          [
            {
              dim: 'year',
              src: 'line',
              counts,
              keys: [Prisma.sql`extract(year FROM x.d)::int`],
            },
            { dim: 'period', src: 'line', counts, keys: [axisExpr] },
            {
              dim: 'vip',
              src: 'line',
              counts,
              keys: [Prisma.sql`x.parent_name`],
              where: Prisma.sql`x.is_vip AND lower(COALESCE(x.customer_type, '')) = lower(${BUON})`,
            },
            {
              dim: 'ctype',
              src: 'line',
              counts,
              keys: [Prisma.sql`x.customer_type`],
            },
            {
              dim: 'ptype',
              src: 'line',
              counts,
              keys: [Prisma.sql`x.product_type`],
            },
            { dim: 'brand', src: 'line', counts, keys: [Prisma.sql`x.brand`] },
            {
              dim: 'category',
              src: 'line',
              counts,
              keys: [Prisma.sql`x.category`],
            },
          ],
          cur,
        ),
        ...(sy
          ? [
              {
                dim: 'sy',
                src: 'line' as const,
                counts,
                keys: [sy.key],
                join: sy.join,
              },
            ]
          : []),
      ],
    );

    const rows = (dim: string) =>
      r.list(dim).map((o) => this.row(o.keys[0] ?? null, o.v));
    return {
      ...this.head(q, period),
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      axis,
      metric,
      updatedAt,
      cards: this.growthCards(r.get('total'), r.get('cmp')),
      charts: {
        byYear: rows('year').sort((a, b) => Number(a.key) - Number(b.key)),
        byPeriod: this.base.axisKeys(period, q.year, axis).map((k) => ({
          key: k,
          label: this.base.axisLabel(axis, Number(k)),
          current: this.row(k, r.get('period', k)),
          previous: this.row(k, r.get('sy', k)),
        })),
        byVipWholesale: rows('vip').filter((x) => x.key !== null),
        byCustomerType: rows('ctype'),
        byProductType: rows('ptype'),
        byBrand: rows('brand'),
        byCategory: rows('category'),
      },
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Trang Lợi Nhuận (các bookmark của Power BI)
  // ═════════════════════════════════════════════════════════════════════════
  async getProfit(q: QtProfitQueryDto) {
    const view = q.view ?? 'team';
    const updatedAt = new Date().toISOString();
    const period = this.period(q);
    if (!period) return { view, period: null, updatedAt };
    const f = this.filter(q);
    const date = this.base.periodCond(period);
    const head = { view, ...this.head(q, period), updatedAt };

    if (view === 'team') {
      // Bookmark "Nhóm Bán": Báo cáo kết quả kinh doanh (pl_value) theo nhóm bán.
      const team = Prisma.sql`x.team_name`;
      const r = await this.run(f, date, [
        ...this.totalSpecs('total'),
        ...this.totalSpecs('team').map((s) => ({ ...s, keys: [team] })),
      ]);
      const teams = r
        .list('team')
        .map((o) => o.keys[0])
        .filter((k): k is string => k !== null)
        .sort((a, b) => a.localeCompare(b, 'vi'));
      return {
        ...head,
        teams: teams.map((name) => this.plColumn(name, r.get('team', name))),
        total: this.plColumn(null, r.get('total')),
      };
    }

    if (view === 'customer') {
      // Bookmark "Khách Hàng Key".
      const parent = Prisma.sql`x.parent_name`;
      const vipKey = Prisma.sql`CASE WHEN x.is_vip THEN ${VIP_LABEL} ELSE ${NORMAL_LABEL} END`;
      const inTop = Prisma.sql`x.parent_name IN (SELECT parent_name FROM qtop)`;
      const r = await this.run(
        f,
        date,
        [
          ...this.totalSpecs('parent')
            .filter((s) => s.src !== 'inv')
            .map((s) => ({ ...s, keys: [parent] })),
          {
            dim: 'parentVip',
            src: 'inv',
            keys: [parent],
            where: Prisma.sql`x.is_vip`,
          },
          ...this.totalSpecs('vip')
            .filter((s) => s.src !== 'inv')
            .map((s) => ({ ...s, keys: [vipKey] })),
          {
            dim: 'cat',
            src: 'line',
            keys: [parent, Prisma.sql`x.category`],
            where: inTop,
          },
          {
            dim: 'prod',
            src: 'line',
            keys: [parent, Prisma.sql`x.product_name`],
            where: inTop,
          },
        ],
        {
          // Top 20 khách cha theo net_profit (lọc cho 2 biểu đồ "Họ thường mua …").
          extra: Prisma.sql`,
          qtop AS (
            SELECT parent_name FROM (
              SELECT u.parent_name, SUM(u.v) AS v FROM (
                SELECT x.parent_name, CASE WHEN x.ok THEN x.sub_total - x.cost ELSE 0 END AS v
                FROM line x WHERE x.inp
                UNION ALL SELECT x.parent_name, -x.amount FROM retx x
                UNION ALL SELECT x.parent_name, x.cost FROM retl x WHERE x.inp
              ) u WHERE u.parent_name IS NOT NULL GROUP BY u.parent_name
            ) t ORDER BY t.v DESC, t.parent_name LIMIT ${TOP_CUSTOMERS}
          )`,
        },
      );
      const vipParents = new Set(r.list('parentVip').map((o) => o.keys[0]));
      const parents = r
        .list('parent')
        .filter((o) => o.keys[0] !== null)
        .map((o) => ({
          name: o.keys[0] as string,
          isVip: vipParents.has(o.keys[0]),
          amount: o.v.amount,
          netProfit: this.netProfit(o.v),
          margin: this.netMargin(o.v),
        }));
      const byName = (a: { name: string }, b: { name: string }) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      const topProfit = [...parents]
        .sort((a, b) => b.netProfit - a.netProfit || byName(a, b))
        .slice(0, TOP_CUSTOMERS);
      // "Khách Mua Nhiều Nhưng Biên Lợi Nhuận Mỏng": top 20 theo doanh số, biên tăng dần.
      const thinMargin = [...parents]
        .sort((a, b) => b.amount - a.amount || byName(a, b))
        .slice(0, TOP_CUSTOMERS)
        .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0));
      const pairs = (dim: string) =>
        r
          .list(dim)
          .filter((o) => o.v.quantity !== 0)
          .map((o) => ({
            parent: o.keys[0] ?? '',
            name: o.keys[1] ?? null,
            quantity: o.v.quantity,
          }));
      return {
        ...head,
        byVip: [VIP_LABEL, NORMAL_LABEL].map((k) => ({
          key: k,
          netProfit: this.netProfit(r.get('vip', k)),
        })),
        topProfit,
        thinMargin,
        categoryMix: pairs('cat'),
        productMix: pairs('prod'),
      };
    }

    if (view === 'product') {
      // Bookmark "Hàng Hóa" + cây lợi nhuận + "BC Chi Tiết Hàng Hóa".
      const r = await this.run(f, date, [
        { dim: 'total', src: 'line', all: true },
        {
          dim: 'prod',
          src: 'line',
          keys: [
            Prisma.sql`x.product_code`,
            Prisma.sql`x.product_name`,
            Prisma.sql`x.product_type`,
            Prisma.sql`x.origin`,
            Prisma.sql`x.category`,
            Prisma.sql`x.group2026`,
          ],
        },
        {
          dim: 'prodType',
          src: 'line',
          keys: [Prisma.sql`x.product_code`, Prisma.sql`x.customer_type`],
        },
      ]);
      const total = r.get('total');
      const byType = new Map<
        string,
        Record<string, { amount: number; profit: number }>
      >();
      for (const o of r.list('prodType')) {
        const t = o.keys[1];
        if (!t) continue;
        const code = o.keys[0] ?? '';
        const m = byType.get(code) ?? {};
        m[t] = { amount: o.v.amount, profit: o.v.amount - o.v.cost };
        byType.set(code, m);
      }
      return {
        ...head,
        /** Lợi nhuận mọi mặt hàng (ALL(dim_product)) — mẫu số contribute_profit_by_product. */
        allProductsProfit: total.amount_all - total.cost_all,
        total: this.detailValues(total),
        products: r
          .list('prod')
          .map((o) => ({
            code: o.keys[0],
            name: o.keys[1],
            productType: o.keys[2],
            origin: o.keys[3],
            category: o.keys[4],
            productGroup: o.keys[5],
            ...this.detailValues(o.v),
            byCustomerType: byType.get(o.keys[0] ?? '') ?? {},
          }))
          .sort((a, b) => b.profit - a.profit),
      };
    }

    // "BC Chi Tiết Khách Hàng": Chiến Lược (is_customer_key = 1) › loại khách › khách cha.
    const r = await this.run(f, date, [
      {
        dim: 'cust',
        src: 'line',
        keys: [Prisma.sql`x.customer_type`, Prisma.sql`x.parent_name`],
        where: Prisma.sql`x.is_vip`,
        all: true,
      },
    ]);
    return {
      ...head,
      rows: r
        .list('cust')
        .map((o) => ({
          customerType: o.keys[0],
          parentName: o.keys[1],
          ...this.detailValues(o.v),
          allProductsProfit: o.v.amount_all - o.v.cost_all,
        }))
        .filter((x) => x.amount !== 0 || x.quantity !== 0)
        .sort((a, b) => b.amount - a.amount),
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Trang Khách Hàng
  // ═════════════════════════════════════════════════════════════════════════
  async getCustomers(q: QtQueryDto) {
    const metric: QtMetric = q.metric ?? 'amount';
    const updatedAt = new Date().toISOString();
    const period = this.period(q);
    if (!period) return { period: null, metric, updatedAt };
    const cur = this.base.periodCond(period);
    const pivot = this.monthPivot(period);
    const month = Prisma.sql`extract(month FROM x.d)::int`;
    const ctype = Prisma.sql`x.customer_type`;
    // Visual Power BI lọc NOT dim_customers[customer_group] IN (null) (= loại khách).
    const typed = Prisma.sql`x.customer_type IS NOT NULL`;
    const curTyped = Prisma.sql`${cur} AND ${typed}`;
    const counts = this.needCounts(metric);

    const r = await this.run(
      this.filter(q),
      this.anyOf([cur, pivot.cond]),
      [
        { dim: 'total', src: 'inv', where: cur },
        ...this.at(this.totalSpecs('typedTotal'), curTyped),
        ...this.at(
          this.totalSpecs('type').map((s) => ({ ...s, keys: [ctype] })),
          curTyped,
        ),
        { dim: 'monthType', src: 'inv', keys: [month, ctype], where: curTyped },
        {
          dim: 'monthStatus',
          src: 'inv',
          keys: [month, Prisma.sql`x.cstatus`],
          where: curTyped,
        },
        {
          dim: 'typeRegion',
          src: 'line',
          counts,
          keys: [ctype, Prisma.sql`x.region`],
          where: curTyped,
        },
        {
          dim: 'region',
          src: 'line',
          counts,
          keys: [Prisma.sql`x.region`],
          where: cur,
        },
        {
          dim: 'province',
          src: 'inv',
          keys: [Prisma.sql`x.province`],
          where: Prisma.sql`${cur} AND x.province IS NOT NULL`,
        },
        {
          dim: 'cell',
          src: 'line',
          keys: [
            ctype,
            Prisma.sql`x.customer_code`,
            Prisma.sql`x.customer_name`,
            pivot.key,
          ],
          where: typed,
          join: pivot.join,
          counts,
        },
        {
          dim: 'typeMonth',
          src: 'line',
          counts,
          keys: [ctype, pivot.key],
          where: typed,
          join: pivot.join,
        },
        {
          dim: 'month',
          src: 'line',
          counts,
          keys: [pivot.key],
          where: typed,
          join: pivot.join,
        },
      ],
      { status: true, province: true },
    );

    const t = r.get('total');
    const pick = (v: QtAgg) => this.metricOf(v, metric);
    return {
      ...this.head(q, period),
      metric,
      updatedAt,
      cards: {
        activeCustomers: t.inv_customers,
        newCustomers: t.new_customers,
        newCustomerRevenue: t.new_revenue,
        aov: this.div(t.revenue, t.inv_orders),
        arpc: this.div(t.revenue, t.inv_customers),
      },
      byMonthType: r.list('monthType').map((o) => ({
        month: Number(o.keys[0]),
        key: o.keys[1],
        value: o.v.inv_customers,
      })),
      byMonthStatus: r.list('monthStatus').map((o) => ({
        month: Number(o.keys[0]),
        key: o.keys[1],
        value: o.v.inv_customers,
      })),
      byType: QT_CUSTOMER_TYPES.map((k) => ({
        key: k,
        ...this.customerTypeValues(r.get('type', k)),
      })),
      byTypeTotal: this.customerTypeValues(r.get('typedTotal')),
      byTypeRegion: r.list('typeRegion').map((o) => ({
        customerType: o.keys[0],
        region: o.keys[1],
        value: pick(o.v),
      })),
      byRegion: r.list('region').map((o) => ({
        key: o.keys[0],
        value: pick(o.v),
      })),
      byProvince: r
        .list('province')
        .map((o) => ({ key: o.keys[0], value: o.v.revenue }))
        .sort((a, b) => b.value - a.value),
      pivot: {
        months: pivot.months,
        cells: r.list('cell').map((o) => ({
          customerType: o.keys[0],
          code: o.keys[1],
          name: o.keys[2],
          k: o.keys[3],
          value: pick(o.v),
        })),
        typeMonths: r.list('typeMonth').map((o) => ({
          customerType: o.keys[0],
          k: o.keys[1],
          value: pick(o.v),
        })),
        monthTotals: r.list('month').map((o) => ({
          k: o.keys[0],
          value: pick(o.v),
        })),
      },
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Trang Sản Phẩm
  // ═════════════════════════════════════════════════════════════════════════
  async getProducts(q: QtQueryDto) {
    const metric: QtMetric = q.metric ?? 'amount';
    const axis = q.axis ?? 'day';
    const updatedAt = new Date().toISOString();
    const period = this.period(q);
    if (!period) return { period: null, metric, axis, updatedAt };
    const cmp = compareWindow(period);
    const cur = this.base.periodCond(period);
    const cmpCond = this.between(cmp.from, cmp.to);
    const pivot = this.monthPivot(period);
    const cat = Prisma.sql`x.category`;
    const counts = this.needCounts(metric);

    const [r, plan] = await Promise.all([
      this.run(this.filter(q), this.anyOf([cur, cmpCond, pivot.cond]), [
        ...this.at(this.totalSpecs('total'), cur),
        ...this.at(this.totalSpecs('cmp'), cmpCond),
        {
          dim: 'period',
          src: 'line',
          counts,
          keys: [this.base.axisExpr(axis)],
          where: cur,
        },
        {
          dim: 'top',
          src: 'line',
          counts,
          keys: [Prisma.sql`x.product_code`, Prisma.sql`x.product_name`],
          where: Prisma.sql`${cur} AND lower(COALESCE(x.product_type, '')) IN (${Prisma.join(
            TOP10_PRODUCT_TYPES.map((t) => t.toLowerCase()),
          )})`,
        },
        {
          dim: 'cell',
          src: 'line',
          keys: [
            cat,
            Prisma.sql`x.product_code`,
            Prisma.sql`x.product_name`,
            pivot.key,
          ],
          join: pivot.join,
          counts,
        },
        {
          dim: 'catMonth',
          src: 'line',
          counts,
          keys: [cat, pivot.key],
          join: pivot.join,
        },
        {
          dim: 'month',
          src: 'line',
          counts,
          keys: [pivot.key],
          all: true,
          join: pivot.join,
        },
        {
          dim: 'rowTotal',
          src: 'line',
          counts,
          keys: [cat, Prisma.sql`x.product_code`],
          where: cur,
        },
        { dim: 'catTotal', src: 'line', counts, keys: [cat], where: cur },
        { dim: 'grand', src: 'line', counts, where: cur, all: true },
      ]),
      this.cumulativeTarget(period),
    ]);
    const c = r.get('total');
    const pick = (v: QtAgg) => this.metricOf(v, metric);
    const pickAll = (v: QtAgg) => this.metricOfAll(v, metric);

    return {
      ...this.head(q, period),
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      metric,
      axis,
      updatedAt,
      cards: {
        ...this.growthCards(c, r.get('cmp')),
        /** Thẻ "Doanh Thu Thuần" = switch_dynamics_metrics theo chỉ số đang chọn. */
        metricValue: pick(c),
        /** Thẻ "Biên Lợi Nhuận" trang này dùng _margin (có trừ trả hàng). */
        netMargin: this.netMargin(c),
        /** subtitle_revenue_actual_target: Revenue / chỉ tiêu luỹ kế tới tháng cuối kỳ. */
        target: {
          revenue: c.revenue,
          plan,
          rate: plan ? c.revenue / plan : null,
        },
      },
      trend: this.base.axisKeys(period, q.year, axis).map((k) => ({
        key: k,
        label: this.base.axisLabel(axis, Number(k)),
        ...this.metrics(r.get('period', k)),
      })),
      products: r.list('top').map((o) => ({
        code: o.keys[0],
        name: o.keys[1],
        ...this.metrics(o.v),
      })),
      pivot: {
        months: pivot.months,
        cells: r.list('cell').map((o) => ({
          category: o.keys[0],
          code: o.keys[1],
          name: o.keys[2],
          k: o.keys[3],
          value: pick(o.v),
        })),
        categoryMonths: r.list('catMonth').map((o) => ({
          category: o.keys[0],
          k: o.keys[1],
          value: pick(o.v),
        })),
        monthTotals: r.list('month').map((o) => ({
          k: o.keys[0],
          value: pick(o.v),
          all: pickAll(o.v),
        })),
        rowTotals: r.list('rowTotal').map((o) => ({
          category: o.keys[0],
          code: o.keys[1],
          value: pick(o.v),
        })),
        categoryTotals: r.list('catTotal').map((o) => ({
          category: o.keys[0],
          value: pick(o.v),
        })),
        grandTotal: {
          value: pick(r.get('grand')),
          all: pickAll(r.get('grand')),
        },
      },
    };
  }
  // ═════════════════════════════════════════════════════════════════════════
  // Danh sách cho bộ lọc
  // ═════════════════════════════════════════════════════════════════════════
  async getFilterOptions() {
    const lake = await this.base.dataLakeReady();
    const thisYear = parts(todayVn()).y;
    const years: number[] = [];
    for (let y = parts(CALENDAR_START).y; y <= thisYear; y++) years.push(y);
    const typesLower = QT_PRODUCT_TYPES.map((t) => t.toLowerCase());
    const since = daxDate(thisYear - 1, 1, 1);
    const oldCustomers = lake
      ? Prisma.sql`UNION SELECT o."customerCode" FROM data_lake.invoice o
                   WHERE (o."purchaseDate" + interval '7 hour')::date >= ${since}::date`
      : Prisma.empty;

    const [teams, products, parents, channels] = await Promise.all([
      this.prisma.$queryRaw<{ id: number; name: string }[]>`
        SELECT id, name FROM analytics_sale_teams ORDER BY name`,
      this.prisma.$queryRaw<
        {
          code: string;
          name: string;
          product_type: string;
          origin: string | null;
          category: string | null;
          brand: string | null;
          group2026: string;
        }[]
      >`
        WITH ${this.base.prodCte()}
        SELECT DISTINCT ON (p.code) p.code, p.name, pr.product_type, p.middle_name AS origin,
               pr.category, pr.brand, pr.group2026
        FROM products p JOIN prod pr ON pr.code = p.code
        WHERE lower(pr.product_type) IN (${Prisma.join(typesLower)})
        ORDER BY p.code, p.id`,
      this.prisma.$queryRaw<
        { parent_name: string; customer_type: string | null; is_vip: boolean }[]
      >`
        WITH ${this.base.custCte(Prisma.sql`c.code IN (
          SELECT c2.code FROM invoices i JOIN customers c2 ON c2.id = i."customerId"
          WHERE i.status <> 2 AND (i."purchaseDate" + interval '7 hour')::date >= ${since}::date
          ${oldCustomers})`)}
        SELECT DISTINCT parent_name, customer_type, is_vip FROM cust WHERE parent_name IS NOT NULL`,
      this.prisma.$queryRaw<{ group_source: string }[]>`
        WITH ${this.chanCte()} SELECT DISTINCT group_source FROM chan ORDER BY 1`,
    ]);

    const uniq = (list: (string | null | undefined)[]) =>
      [...new Set(list.filter((v): v is string => !!v))].sort((a, b) =>
        a.localeCompare(b, 'vi'),
      );
    const vipParents = (types: string[]) =>
      uniq(
        parents
          .filter(
            (p) =>
              p.is_vip && types.includes((p.customer_type ?? '').toLowerCase()),
          )
          .map((p) => p.parent_name),
      );

    return {
      years,
      saleTeams: [
        ...teams.map((t) => ({ id: t.id, name: t.name })),
        { id: 0, name: OTHER_TEAM_NAME },
      ],
      customerTypes: QT_CUSTOMER_TYPES,
      groupSources: channels.map((c) => c.group_source),
      /** Tổng Quan: khách buôn VIP. */
      vipWholesaleParents: vipParents([BUON.toLowerCase()]),
      /** Khách Hàng: khách buôn + chuỗi VIP. */
      vipParents: vipParents(['khách buôn', 'khách chuỗi']),
      /** Lợi Nhuận: mọi khách cha có mua từ năm trước. */
      parents: uniq(parents.map((p) => p.parent_name)),
      productTypes: QT_PRODUCT_TYPES,
      productGroups: uniq(products.map((p) => p.group2026)),
      categories: uniq(products.map((p) => p.category)),
      origins: uniq(products.map((p) => p.origin)),
      brands: uniq(products.map((p) => p.brand)),
      products: products
        .map((p) => ({
          code: p.code,
          name: p.name,
          category: p.category,
          brand: p.brand,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Cấu hình: khách / nhân viên không tính vào báo cáo
  // ═════════════════════════════════════════════════════════════════════════
  listExclusions() {
    return this.prisma.$queryRaw<
      {
        id: number;
        kind: string;
        code: string;
        note: string | null;
        isActive: boolean;
        label: string | null;
      }[]
    >`
      SELECT e.id, e.kind, e.code, e.note, e.is_active AS "isActive",
             CASE WHEN e.kind = 'customer' THEN c.name ELSE COALESCE(u.name, u.email) END AS label
      FROM analytics_management_exclusions e
      LEFT JOIN customers c ON e.kind = 'customer' AND c.code = e.code
      LEFT JOIN users u ON e.kind = 'seller' AND u.id::text = e.code
      ORDER BY e.kind, e.code`;
  }

  async createExclusion(dto: QtExclusionDto) {
    const code = dto.code.trim();
    if (dto.kind === 'seller' && !/^\d+$/.test(code)) {
      throw new BadRequestException('Mã nhân viên phải là id (số)');
    }
    const dup = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM analytics_management_exclusions WHERE kind = ${dto.kind} AND code = ${code}`;
    if (dup.length) throw new BadRequestException('Đã có trong danh sách');
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO analytics_management_exclusions (kind, code, note, is_active, created_at, updated_at)
      VALUES (${dto.kind}, ${code}, ${dto.note?.trim() || null}, ${dto.isActive ?? true}, now(), now())
      RETURNING id`;
    return { id: rows[0]?.id };
  }

  async updateExclusion(id: number, dto: QtExclusionUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_management_exclusions
      SET note = CASE WHEN ${dto.note !== undefined} THEN ${dto.note?.trim() || null} ELSE note END,
          is_active = COALESCE(${dto.isActive ?? null}::boolean, is_active),
          updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy');
    return { id };
  }

  async deleteExclusion(id: number) {
    const n = await this.prisma
      .$executeRaw`DELETE FROM analytics_management_exclusions WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy');
    return { id };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SQL
  // ═════════════════════════════════════════════════════════════════════════
  private filter(q: QtQueryDto): QtFilter {
    return {
      saleTeamId: q.saleTeamId,
      customerType: q.customerType,
      parentName: q.parentName,
      groupSource: q.groupSource,
      productGroup: q.productGroup,
      productType: q.productType,
      category: q.category,
      origin: q.origin,
      brand: q.brand,
      productCode: q.productCode,
    };
  }

  /** dim_sale_channel: kênh bán POS + nhóm nguồn (Power BI suy từ icon, ở đây theo tên kênh). */
  private chanCte(): Prisma.Sql {
    return Prisma.sql`
      chan AS (
        SELECT sc.id,
          CASE
            WHEN sc.id = 1 OR lower(sc.name) = lower('Bán trực tiếp') THEN 'Direct Selling'
            WHEN lower(sc.name) ~ '(shopee|tiktok|facebook|lazada|instagram|website)' THEN 'Online'
            ELSE 'Other'
          END AS group_source
        FROM sale_channels sc
      )`;
  }

  /**
   * CTE: hoá đơn (invx), dòng hàng (line), phiếu trả (retx, retl) đã áp mọi
   * filter của report + slicer. dateCond dùng alias x.d (ngày VN).
   * line.inp = dòng thuộc phạm vi sản phẩm (filter ngành hàng của report + slicer sản phẩm).
   */
  private async ctes(
    f: QtFilter,
    dateCond: Prisma.Sql,
    o: CteOpts,
  ): Promise<Prisma.Sql> {
    const lake = await this.base.dataLakeReady();
    const today = todayVn();

    // Lọc hoá đơn / phiếu trả theo khách, nhân viên, kênh.
    const invConds: Prisma.Sql[] = [
      Prisma.sql`x.customer_code NOT IN (SELECT code FROM qexcl WHERE kind = 'customer')`,
    ];
    if (f.saleTeamId !== undefined && f.saleTeamId !== null)
      invConds.push(Prisma.sql`x.team_id = ${f.saleTeamId}`);
    if (f.customerType)
      invConds.push(
        Prisma.sql`lower(COALESCE(x.customer_type, '')) = lower(${f.customerType})`,
      );
    if (f.parentName)
      invConds.push(Prisma.sql`x.parent_name = ${f.parentName}`);
    if (f.groupSource)
      invConds.push(Prisma.sql`x.group_source = ${f.groupSource}`);
    const invWhere = Prisma.join(invConds, ' AND ');

    // Phạm vi sản phẩm (inp).
    const prodConds: Prisma.Sql[] = [
      Prisma.sql`lower(COALESCE(pr.product_type, '')) IN (${Prisma.join(
        QT_PRODUCT_TYPES.map((t) => t.toLowerCase()),
      )})`,
    ];
    if (f.productType)
      prodConds.push(
        Prisma.sql`lower(pr.product_type) = lower(${f.productType})`,
      );
    if (f.category) prodConds.push(Prisma.sql`pr.category = ${f.category}`);
    if (f.origin) prodConds.push(Prisma.sql`pi.origin = ${f.origin}`);
    if (f.brand) prodConds.push(Prisma.sql`pr.brand = ${f.brand}`);
    if (f.productGroup)
      prodConds.push(Prisma.sql`pr.group2026 = ${f.productGroup}`);
    if (f.productCode) prodConds.push(Prisma.sql`pr.code = ${f.productCode}`);
    const inp = Prisma.sql`COALESCE(${Prisma.join(prodConds, ' AND ')}, false)`;

    const ok = (col: Prisma.Sql) =>
      Prisma.sql`(lower(COALESCE(${col}, '')) <> lower('Đã hủy'))`;

    const oldInvoices = lake
      ? Prisma.sql`
        UNION ALL
        SELECT NULL::int AS id, o.code, (o."purchaseDate" + interval '7 hour')::date AS d,
               ROUND(COALESCE(o.total, 0))::float8 AS total, COALESCE(o.discount, 0)::float8 AS discount,
               ${ok(Prisma.sql`o."statusValue"`)} AS ok,
               c.code AS customer_code, false AS is_new, s.team_id, ch.group_source
        FROM data_lake.invoice o
        JOIN seller s ON s.kiot_viet_id::text = o."soldById"
        JOIN customers c ON c.code = o."customerCode"
        JOIN chan ch ON ch.id = COALESCE(o."saleChannelId", 1)
        WHERE o.status <> 2`
      : Prisma.empty;

    // Dòng hàng chỉ giữ các cột cần dùng để CTE (vật chất hoá) nằm gọn trong bộ nhớ.
    const lineCols = Prisma.sql`x.code, x.d, x.ok, x.customer_code, x.team_id${
      o.status ? Prisma.sql`, x.cstatus` : Prisma.empty
    }`;
    const oldLines = lake
      ? Prisma.sql`
        UNION ALL
        SELECT ${lineCols}, od."productCode" AS product_code,
               COALESCE(od.quantity, 0)::float8 AS quantity, COALESCE(od.price, 0)::float8 AS price,
               COALESCE(od.discount, 0)::float8 AS discount
        FROM data_lake.invoice_detail od
        JOIN invx x ON NOT x.is_new AND x.code = od."invoiceCode"`
      : Prisma.empty;

    // Lịch sử mua (cho Is New Customer This Month / Customer_Status): mọi hoá đơn
    // của bảng invoice Power BI (status <> 2, bỏ nhân viên loại trừ, gồm hoá đơn cũ).
    const hist = o.status
      ? Prisma.sql`
      hist_inv AS (
        SELECT c.code AS customer_code, (i."purchaseDate" + interval '7 hour')::date AS d
        FROM invoices i JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2
          AND COALESCE(i."soldById"::text, '') NOT IN (SELECT code FROM qexcl WHERE kind = 'seller')
        ${
          lake
            ? Prisma.sql`UNION ALL
        SELECT o."customerCode", (o."purchaseDate" + interval '7 hour')::date
        FROM data_lake.invoice o WHERE o.status <> 2`
            : Prisma.empty
        }
      ),`
      : Prisma.empty;
    // Khách cần tra khách cha: khách của hoá đơn trong kỳ (+ lịch sử mua, + phiếu trả).
    const scopeSrc = [
      o.status
        ? Prisma.sql`SELECT customer_code FROM hist_inv`
        : Prisma.sql`SELECT customer_code FROM inv_raw`,
      ...(o.returns ? [Prisma.sql`SELECT customer_code FROM ret_raw`] : []),
    ];
    const custScope = Prisma.sql`c.code IN (${Prisma.join(scopeSrc, ' UNION ')})`;
    const histAgg = o.status
      ? Prisma.sql`,
      hist_pm AS (
        SELECT DISTINCT cu.parent_name, date_trunc('month', h.d)::date AS m
        FROM hist_inv h JOIN qcust cu ON cu.code = h.customer_code
      ),
      hist_first AS (
        SELECT parent_name, MIN(m) AS first_m FROM hist_pm GROUP BY parent_name
      )`
      : Prisma.empty;
    const statusCols = o.status
      ? Prisma.sql`,
          (date_trunc('month', x.d)::date = hf.first_m) AS is_new_cust,
          CASE
            WHEN date_trunc('month', x.d)::date = hf.first_m THEN 'New Customer'
            WHEN pp.m IS NOT NULL THEN 'Repeat Customer'
            ELSE 'Reacquired Customer'
          END AS cstatus`
      : Prisma.sql`, false AS is_new_cust`;
    const statusJoin = o.status
      ? Prisma.sql`LEFT JOIN hist_first hf ON hf.parent_name = cu.parent_name
        LEFT JOIN hist_pm pp ON pp.parent_name = cu.parent_name
          AND pp.m = (date_trunc('month', x.d) - interval '1 month')::date`
      : Prisma.empty;
    const provCte = o.province
      ? Prisma.sql`,
      qaddr_new AS (
        SELECT DISTINCT ON ("customerId") "customerId", "newCityName"
        FROM customer_addresses WHERE "newCityCode" IS NOT NULL
        ORDER BY "customerId", "updatedAt" DESC
      ),
      qaddr_old AS (
        SELECT DISTINCT ON ("customerId") "customerId", "cityName"
        FROM customer_addresses ORDER BY "customerId", "updatedAt" DESC
      ),
      qprov AS (
        SELECT c.code, COALESCE(na."newCityName", oa."cityName") AS province
        FROM customers c
        LEFT JOIN qaddr_new na ON na."customerId" = c.id
        LEFT JOIN qaddr_old oa ON oa."customerId" = c.id
        WHERE c.code IN (SELECT customer_code FROM inv_raw)
      )`
      : Prisma.empty;
    const provCol = o.province
      ? Prisma.sql`, qp.province`
      : Prisma.sql`, NULL::text AS province`;
    const provJoin = o.province
      ? Prisma.sql`LEFT JOIN qprov qp ON qp.code = x.customer_code`
      : Prisma.empty;

    const returns = o.returns
      ? Prisma.sql`
      ret_raw AS (
        SELECT r.id, r.code, (r."createdAt" + interval '7 hour')::date AS d,
               COALESCE(r."totalReturnAmount", 0)::float8 AS amount,
               c.code AS customer_code, s.team_id, s.team_name, ch.group_source
        FROM return_orders r
        LEFT JOIN invoices i ON i.id = r."invoiceId"
        JOIN seller s ON s.user_id = COALESCE(i."soldById", r."createdBy")
        JOIN customers c ON c.id = COALESCE(i."customerId", r."customerId")
        JOIN chan ch ON ch.id = COALESCE(i."saleChannelId", 1)
        WHERE r.status <> 5
          AND (r."createdAt" + interval '7 hour')::date BETWEEN ${CALENDAR_START}::date AND ${today}::date
      ),
      ret_in AS (SELECT * FROM ret_raw x WHERE ${dateCond}),`
      : Prisma.empty;
    const retTail = o.returns
      ? Prisma.sql`,
      retx AS (
        SELECT x.*, cu.parent_name, cu.customer_type, cu.is_vip, cu.region
        FROM ret_in x JOIN qcust cu ON cu.code = x.customer_code
        WHERE ${invWhere}
      ),
      retl AS (
        SELECT x.*, pr.product_type, pr.category, pr.brand, pr.group2026,
               pi.name AS product_name, pi.origin,
               COALESCE(rd."totalAmount", 0)::float8 AS sub_total,
               COALESCE(rd."requestQuantity", rd."confirmedQuantity", 0)::float8
                 * COALESCE(pc.return_cost_price, 0) AS cost,
               ${inp} AS inp
        FROM return_order_details rd
        JOIN retx x ON x.id = rd."returnOrderId"
        LEFT JOIN prod pr ON pr.code = rd."productCode"
        LEFT JOIN pinfo pi ON pi.code = rd."productCode"
        LEFT JOIN pcost pc ON pc.code = rd."productCode"
      )`
      : Prisma.empty;

    return Prisma.sql`
      ${this.base.prodCte()},
      pinfo AS (
        SELECT DISTINCT ON (p.code) p.code, p.name, p.middle_name AS origin,
               COALESCE(p."basePrice", 0)::float8 AS base_price
        FROM products p ORDER BY p.code, p.id
      ),
      pcost AS (
        SELECT p.code, MAX(iv.cost)::float8 AS cost_price,
               MAX(iv.cost) FILTER (
                 WHERE COALESCE(b.kiot_viet_id::text, '') <> ${RETURN_COST_EXCLUDED_BRANCH_KIOT_ID}
               )::float8 AS return_cost_price
        FROM inventories iv
        JOIN products p ON p.id = iv."productId"
        LEFT JOIN branches b ON b.id = iv."branchId"
        GROUP BY p.code
      ),
      qexcl AS (
        SELECT kind, code FROM analytics_management_exclusions WHERE is_active
      ),
      seller AS (
        SELECT u.id AS user_id, u.kiot_viet_id,
               COALESCE(t.id, 0) AS team_id, COALESCE(t.name, ${OTHER_TEAM_NAME}) AS team_name
        FROM users u
        LEFT JOIN analytics_sale_team_members m ON m.user_id = u.id
        LEFT JOIN analytics_sale_teams t ON t.id = m.team_id
        WHERE u.id::text NOT IN (SELECT code FROM qexcl WHERE kind = 'seller')
      ),
      ${this.chanCte()},
      inv_all AS (
        SELECT i.id, i.code, (i."purchaseDate" + interval '7 hour')::date AS d,
               ROUND(COALESCE(i."totalAmount", 0))::float8 AS total,
               COALESCE(i.discount, 0)::float8 AS discount,
               ${ok(Prisma.sql`i."statusValue"`)} AS ok,
               c.code AS customer_code, true AS is_new, s.team_id, ch.group_source
        FROM invoices i
        JOIN seller s ON s.user_id = i."soldById"
        JOIN customers c ON c.id = i."customerId"
        JOIN chan ch ON ch.id = COALESCE(i."saleChannelId", 1)
        WHERE i.status <> 2
        ${oldInvoices}
      ),
      inv_raw AS (
        SELECT * FROM inv_all x
        WHERE x.d >= ${CALENDAR_START}::date AND x.d <= ${today}::date AND ${dateCond}
      ),
      ${returns}
      ${hist}
      ${this.base.custCte(custScope)},
      -- MATERIALIZED: tra quy tắc khách cha 1 lần / khách (không lặp theo từng hoá đơn)
      qcust AS MATERIALIZED (
        SELECT cu.*, c.name AS customer_name FROM cust cu JOIN customers c ON c.id = cu.id
      ),
      qteam AS (SELECT DISTINCT team_id, team_name FROM seller)
      ${histAgg}
      ${provCte},
      invx AS (
        SELECT x.*, cu.parent_name, cu.customer_type, cu.is_vip, cu.region, tm.team_name
               ${statusCols} ${provCol}
        FROM inv_raw x
        JOIN qcust cu ON cu.code = x.customer_code
        LEFT JOIN qteam tm ON tm.team_id = x.team_id
        ${statusJoin}
        ${provJoin}
        WHERE ${invWhere}
      ),
      line_raw AS (
        SELECT ${lineCols}, p.code AS product_code,
               COALESCE(d.quantity, 0)::float8 AS quantity, COALESCE(d.price, 0)::float8 AS price,
               COALESCE(d.discount, 0)::float8 AS discount
        FROM invoice_details d
        JOIN invx x ON x.is_new AND x.id = d."invoiceId"
        LEFT JOIN products p ON p.id = d."productId"
        ${oldLines}
      ),
      line AS (
        SELECT l.code, l.d, l.ok, l.customer_code, l.team_id, l.product_code,
               ${o.status ? Prisma.sql`l.cstatus,` : Prisma.empty}
               q.qty AS quantity_r,
               ROUND(l.quantity * l.price - l.quantity * l.discount)::float8 AS sub_total,
               q.qty * COALESCE(pc.cost_price, 0) AS cost,
               ROUND(l.discount) * q.qty AS disc,
               q.qty * (CASE WHEN ROUND(l.price) = 0
                              AND lower(COALESCE(pr.product_type, '')) IN (lower('Hàng thương hiệu'), lower('Hàng thương mại'))
                             THEN COALESCE(pi.base_price, 0) ELSE ROUND(l.price) END) AS before_disc,
               ${inp} AS inp,
               cu.parent_name, cu.customer_type, cu.is_vip, cu.region, cu.customer_name,
               tm.team_name, pr.product_type, pr.category, pr.brand, pr.group2026,
               pi.name AS product_name, pi.origin
        FROM line_raw l
        LEFT JOIN qcust cu ON cu.code = l.customer_code
        LEFT JOIN qteam tm ON tm.team_id = l.team_id
        CROSS JOIN LATERAL (SELECT ROUND(l.quantity)::float8 AS qty) q
        LEFT JOIN prod pr ON pr.code = l.product_code
        LEFT JOIN pinfo pi ON pi.code = l.product_code
        LEFT JOIN pcost pc ON pc.code = l.product_code
      )
      ${retTail}`;
  }

  /** Các cột số của một spec (cột không thuộc nguồn = 0). */
  private specCols(s: Spec): Prisma.Sql {
    const z = Prisma.sql`0::float8`;
    const m: Record<Col, Prisma.Sql> = Object.fromEntries(
      COLS.map((c) => [c, z]),
    ) as Record<Col, Prisma.Sql>;
    const sum = (expr: string, cond?: string) =>
      Prisma.raw(
        `COALESCE(SUM(${expr})${cond ? ` FILTER (WHERE ${cond})` : ''}, 0)::float8`,
      );
    const cnt = (expr: string, cond: string) =>
      Prisma.raw(`COUNT(DISTINCT ${expr}) FILTER (WHERE ${cond})::float8`);
    if (s.src === 'line') {
      m.amount = sum('x.sub_total', 'x.inp AND x.ok');
      if (s.counts) {
        m.orders = cnt('x.code', 'x.inp AND x.ok');
        m.customers = cnt('x.customer_code', 'x.inp AND x.ok');
      }
      m.quantity = sum('x.quantity_r', 'x.inp');
      m.cost = sum('x.cost', 'x.inp AND x.ok');
      m.disc = sum('x.disc', 'x.inp');
      m.before_disc = sum('x.before_disc', 'x.inp');
      if (s.all) {
        m.amount_all = sum('x.sub_total', 'x.ok');
        m.cost_all = sum('x.cost', 'x.ok');
        if (s.counts) {
          m.orders_all = cnt('x.code', 'x.ok');
          m.customers_all = cnt('x.customer_code', 'x.ok');
        }
        m.quantity_all = sum('x.quantity_r');
      }
    } else if (s.src === 'inv') {
      m.revenue = sum('x.total', 'x.ok');
      m.inv_orders = cnt('x.code', 'x.ok');
      m.inv_customers = cnt('x.parent_name', 'x.ok');
      m.inv_discount = sum('x.discount');
      m.new_customers = cnt('x.parent_name', 'x.is_new_cust');
      m.new_revenue = sum('x.total', 'x.ok AND x.is_new_cust');
    } else if (s.src === 'ret') {
      m.ret_amount = sum('x.amount');
    } else {
      m.ret_cost = sum('x.cost', 'x.inp');
      m.ret_detail = sum('x.sub_total', 'x.inp');
    }
    return Prisma.join(
      COLS.map((c) => Prisma.sql`${m[c]} AS ${Prisma.raw(c)}`),
      ', ',
    );
  }

  /** FROM … WHERE … chung của một spec. */
  private specFrom(s: Spec): Prisma.Sql {
    const from = {
      line: Prisma.sql`line x`,
      inv: Prisma.sql`invx x`,
      ret: Prisma.sql`retx x`,
      retl: Prisma.sql`retl x`,
    }[s.src];
    const conds: Prisma.Sql[] = [];
    if (s.src === 'line' && !s.all) conds.push(Prisma.sql`x.inp`);
    if (s.where) conds.push(Prisma.sql`(${s.where})`);
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`
      : Prisma.empty;
    return Prisma.sql`${from} ${s.join ?? Prisma.empty} ${where}`;
  }

  private specSql(s: Spec): Prisma.Sql {
    const keys = s.keys ?? [];
    if (keys.length > MAX_KEYS) throw new Error('too many keys');
    const kcols = Array.from({ length: MAX_KEYS }, (_, i) =>
      keys[i]
        ? Prisma.sql`(${keys[i]})::text AS ${Prisma.raw(`k${i + 1}`)}`
        : Prisma.sql`NULL::text AS ${Prisma.raw(`k${i + 1}`)}`,
    );
    const groupBy = keys.length
      ? Prisma.sql`GROUP BY ${Prisma.raw(keys.map((_, i) => String(i + 2)).join(', '))}`
      : Prisma.empty;
    return Prisma.sql`(SELECT ${s.dim}::text AS dim, ${Prisma.join(kcols, ', ')}, ${this.specCols(s)}
      FROM ${this.specFrom(s)} ${groupBy})`;
  }

  /**
   * Nhiều spec cùng nguồn + cùng điều kiện, không đếm phân biệt → 1 lần quét với
   * GROUPING SETS (mỗi spec có cột khoá riêng; nhận diện spec bằng GROUPING()).
   */
  private groupSql(group: Spec[]): Prisma.Sql {
    const names = group.map((s, i) =>
      (s.keys ?? []).map((_, j) => `g${i}_${j}`),
    );
    const all = names.flat();
    const keyCols = group.flatMap((s, i) =>
      (s.keys ?? []).map(
        (k, j) => Prisma.sql`(${k})::text AS ${Prisma.raw(names[i][j])}`,
      ),
    );
    // GROUPING(c1..cn): bit = 1 khi cột không thuộc nhóm (cột đầu là bit cao nhất).
    const mask = (i: number) =>
      all.reduce(
        (m, c, idx) =>
          names[i].includes(c) ? m : m | (1 << (all.length - 1 - idx)),
        0,
      );
    const g = Prisma.raw(`GROUPING(${all.join(', ')})`);
    const dim = Prisma.sql`CASE ${g} ${Prisma.join(
      group.map((s, i) => Prisma.sql`WHEN ${mask(i)} THEN ${s.dim}::text`),
      ' ',
    )} END`;
    const kcols = Array.from({ length: MAX_KEYS }, (_, j) => {
      const whens = group
        .map((_, i) =>
          names[i][j]
            ? Prisma.sql`WHEN ${mask(i)} THEN ${Prisma.raw(names[i][j])}`
            : null,
        )
        .filter((w): w is Prisma.Sql => w !== null);
      return whens.length
        ? Prisma.sql`CASE ${g} ${Prisma.join(whens, ' ')} END AS ${Prisma.raw(`k${j + 1}`)}`
        : Prisma.sql`NULL::text AS ${Prisma.raw(`k${j + 1}`)}`;
    });
    const sets = Prisma.raw(names.map((n) => `(${n.join(', ')})`).join(', '));
    return Prisma.sql`(SELECT ${dim} AS dim, ${Prisma.join(kcols, ', ')}, ${this.specCols(group[0])}
      FROM (SELECT x.*, ${Prisma.join(keyCols, ', ')} FROM ${this.specFrom(group[0])}) x
      GROUP BY GROUPING SETS (${sets}))`;
  }

  /** Gom spec gộp được (cùng nguồn / điều kiện / JOIN, không COUNT DISTINCT). */
  private plan(specs: Spec[]): Prisma.Sql[] {
    const sig = (s: Spec) =>
      JSON.stringify([
        s.src,
        !!s.all,
        s.where?.sql ?? null,
        s.where?.values ?? null,
        s.join?.sql ?? null,
        s.join?.values ?? null,
      ]);
    const groups = new Map<string, Spec[]>();
    const out: Prisma.Sql[] = [];
    for (const s of specs) {
      // inv luôn có COUNT DISTINCT; spec đếm số đơn / khách cũng không gộp.
      if (s.src === 'inv' || s.counts) {
        out.push(this.specSql(s));
        continue;
      }
      const k = sig(s);
      const list = groups.get(k) ?? [];
      // Mỗi nhóm chỉ 1 spec không khoá (GROUPING SETS chỉ có 1 tập rỗng).
      if (!(s.keys ?? []).length && list.some((x) => !(x.keys ?? []).length)) {
        out.push(this.specSql(s));
        continue;
      }
      list.push(s);
      groups.set(k, list);
    }
    for (const list of groups.values()) {
      const cols = list.reduce((n, s) => n + (s.keys ?? []).length, 0);
      if (list.length > 1 && cols > 0 && cols <= 30)
        out.push(this.groupSql(list));
      else out.push(...list.map((s) => this.specSql(s)));
    }
    return out;
  }

  /** Chạy nhiều spec trong 1 câu SQL (CTE tính 1 lần cho mọi spec). */
  private async run(
    f: QtFilter,
    dateCond: Prisma.Sql,
    specs: Spec[],
    o: CteOpts & { extra?: Prisma.Sql } = {},
  ): Promise<AggResult> {
    const returns =
      o.extra !== undefined ||
      specs.some((s) => s.src === 'ret' || s.src === 'retl');
    const ctes = await this.ctes(f, dateCond, { ...o, returns });
    const query = this.prisma.$queryRaw<Record<string, unknown>[]>`
      WITH ${ctes} ${o.extra ?? Prisma.empty}
      ${Prisma.join(this.plan(specs), ' UNION ALL ')}`;
    // Ước lượng số dòng của CTE rất lệch → planner chọn nested loop và để CTE
    // tràn ra đĩa. Chỉ trong giao dịch này: tăng work_mem, tắt nested loop
    // (và JIT — chi phí ước lượng khổng lồ khiến JIT biên dịch mất vài giây).
    // set_config(…, true) = SET LOCAL, gộp 1 lượt gọi.
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw`
        SELECT set_config('work_mem', '128MB', true),
               set_config('enable_nestloop', 'off', true),
               set_config('enable_mergejoin', 'off', true),
               set_config('jit', 'off', true)`,
      query,
    ]);
    return new AggResult(rows);
  }

  /** Chỉ số Hóa Đơn / Khách Hàng cần COUNT DISTINCT cấp dòng. */
  private needCounts(metric: QtMetric): boolean {
    return metric === 'orders' || metric === 'customers';
  }

  private period(q: QtQueryDto): CurrentPeriod | null {
    return currentPeriod({ year: q.year, months: q.months ?? [] }, todayVn());
  }

  private head(q: QtQueryDto, p: CurrentPeriod) {
    return {
      period: { from: p.min, to: p.max, months: p.months, year: q.year },
    };
  }

  private between(from: IsoDate, to: IsoDate): Prisma.Sql {
    return Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date`;
  }

  /** Điều kiện ngày chung của câu SQL = hợp các kỳ (mỗi spec tự lọc kỳ của nó). */
  private anyOf(conds: (Prisma.Sql | undefined)[]): Prisma.Sql {
    const list = conds.filter((c): c is Prisma.Sql => !!c);
    return Prisma.sql`(${Prisma.join(
      list.map((c) => Prisma.sql`(${c})`),
      ' OR ',
    )})`;
  }

  /** Gắn thêm điều kiện (thường là kỳ) cho từng spec. */
  private at(specs: Spec[], where: Prisma.Sql): Spec[] {
    return specs.map((s) => ({
      ...s,
      where: s.where ? Prisma.sql`(${where}) AND (${s.where})` : where,
    }));
  }

  /** Đủ 4 nguồn (dòng hàng, hoá đơn, phiếu trả, dòng trả) cho net_profit / AOV. */
  private totalSpecs(dim: string): Spec[] {
    return [
      { dim, src: 'line' },
      { dim, src: 'inv' },
      { dim, src: 'ret' },
      { dim, src: 'retl' },
    ];
  }

  /** "Năm trước" theo từng điểm trục (switch_dynamics_metrics_sameYear). */
  private yearRanges(ranges: { k: number; from: IsoDate; to: IsoDate }[]) {
    if (!ranges.length) return null;
    const { values, cond } = this.base.rangeSql(ranges);
    return {
      key: Prisma.sql`r.k`,
      join: Prisma.sql`JOIN (VALUES ${values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t`,
      cond,
    };
  }
  /**
   * Khoảng ngày cho bảng tháng có MoM Growth: mỗi tháng đang chọn ("cur:YYYY-MM")
   * và tháng liền trước của nó ("prev:YYYY-MM") — DATEADD(dim_date, -1, MONTH):
   * tháng đủ → cả tháng trước; tháng đang dở (tới hôm nay) → cùng số ngày tháng trước.
   */
  private monthPivot(p: CurrentPeriod) {
    const year = parts(p.min).y;
    const ranges: { k: string; from: IsoDate; to: IsoDate }[] = [];
    const months: string[] = [];
    for (const m of p.months) {
      const from = daxDate(year, m, 1);
      const end = daxDate(year, m + 1, 0);
      const to = end > p.max ? p.max : end;
      const ym = from.slice(0, 7);
      months.push(ym);
      ranges.push({ k: `cur:${ym}`, from, to });
      ranges.push({
        k: `prev:${ym}`,
        from: daxDate(year, m - 1, 1),
        to: to === end ? daxDate(year, m, 0) : edate(to, -1),
      });
    }
    const min = ranges.reduce(
      (a, r) => (r.from < a ? r.from : a),
      ranges[0].from,
    );
    const max = ranges.reduce((a, r) => (r.to > a ? r.to : a), ranges[0].to);
    const values = Prisma.join(
      ranges.map(
        (r) => Prisma.sql`(${r.k}::text, ${r.from}::date, ${r.to}::date)`,
      ),
    );
    return {
      months,
      cond: Prisma.sql`x.d BETWEEN ${min}::date AND ${max}::date`,
      join: Prisma.sql`JOIN (VALUES ${values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t`,
      key: Prisma.sql`r.k`,
    };
  }

  /** cumulative_plan_revenue: tổng chỉ tiêu (KPI Sale) các tháng <= tháng cuối kỳ. */
  private async cumulativeTarget(p: CurrentPeriod): Promise<number | null> {
    const { y, m } = parts(p.max);
    const rows = await this.prisma.$queryRaw<{ v: number | null }[]>`
      SELECT SUM(kpi_value)::float8 AS v FROM analytics_kpi_revenue_targets
      WHERE year * 100 + month <= ${y * 100 + m}`;
    const v = rows[0]?.v;
    return v === null || v === undefined ? null : Number(v);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Công thức
  // ═════════════════════════════════════════════════════════════════════════
  private div(a: number, b: number): number | null {
    return b ? a / b : null;
  }

  /** DIVIDE(hiện tại - kỳ trước, kỳ trước): null khi kỳ trước = 0 / trống. */
  private card(cur: number | null, prev: number | null): QtCard {
    const growth = prev ? ((cur ?? 0) - prev) / prev : null;
    return { current: cur, previous: prev, growth };
  }

  /** net_profit = gross_profit - (return_amount - cost_return_detail_amount). */
  private netProfit(v: QtAgg): number {
    return v.amount - v.cost - (v.ret_amount - v.ret_cost);
  }

  /** _margin = net_profit / switch_revenue (Revenue Detail). */
  private netMargin(v: QtAgg): number | null {
    return this.div(this.netProfit(v), v.amount);
  }

  private metrics(v: QtAgg): QtMetricValues {
    const profit = v.amount - v.cost;
    return {
      amount: v.amount,
      orders: v.orders,
      customers: v.customers,
      quantity: v.quantity,
      profit,
      margin: this.div(profit, v.amount),
    };
  }

  private row(key: string | null, v: QtAgg): QtRow {
    return { key, ...this.metrics(v) };
  }

  /** switch_dynamics_metrics theo chỉ số đang chọn. */
  private metricOf(v: QtAgg, metric: QtMetric): number | null {
    const m = this.metrics(v);
    return m[metric];
  }

  private metricOfAll(v: QtAgg, metric: QtMetric): number | null {
    const profit = v.amount_all - v.cost_all;
    switch (metric) {
      case 'amount':
        return v.amount_all;
      case 'orders':
        return v.orders_all;
      case 'customers':
        return v.customers_all;
      case 'quantity':
        return v.quantity_all;
      case 'profit':
        return profit;
      default:
        return this.div(profit, v.amount_all);
    }
  }

  /** 6 thẻ + % so kỳ trước (growth_*_samePeriod). */
  private growthCards(c: QtAgg, p: QtAgg) {
    const profitC = c.amount - c.cost;
    const profitP = p.amount - p.cost;
    const nmC = this.netMargin(c);
    const nmP = this.netMargin(p);
    return {
      revenue: this.card(c.amount, p.amount),
      quantity: this.card(c.quantity, p.quantity),
      aov: this.card(
        this.div(c.revenue, c.inv_orders),
        this.div(p.revenue, p.inv_orders),
      ),
      arpc: this.card(
        this.div(c.revenue, c.inv_customers),
        this.div(p.revenue, p.inv_customers),
      ),
      /** gross_profit; % = growth_netProfit_samePeriod (net_detail_profit). */
      grossProfit: this.card(profitC, profitP),
      /** switch_margin (product_margin); % = growth_margin_samePeriod (_margin, có trừ trả hàng). */
      margin: {
        current: this.div(profitC, c.amount),
        previous: nmP,
        growth: this.card(nmC, nmP).growth,
      },
    };
  }

  /** Cột của "Báo cáo kết quả kinh doanh" (pl_value, nhánh không lọc product_group_lv2). */
  private plColumn(team: string | null, v: QtAgg) {
    const discount = v.disc + v.inv_discount;
    return {
      team,
      grossRevenue: v.before_disc,
      discount,
      discountRate: this.div(discount, v.before_disc),
      returns: v.ret_amount,
      netRevenue: v.revenue - v.ret_amount,
      cost: v.cost,
      grossProfit: this.netProfit(v),
      margin: this.netMargin(v),
    };
  }

  /** Các giá trị của bảng "Báo cáo kết quả kinh doanh theo khách / hàng hoá". */
  private detailValues(v: QtAgg) {
    const profit = v.amount - v.cost;
    return {
      amount: v.amount,
      cost: v.cost,
      profit,
      margin: this.div(profit, v.amount),
      quantity: v.quantity,
      discount: v.disc,
    };
  }

  /** Bảng theo loại khách (trang Khách Hàng). */
  private customerTypeValues(v: QtAgg) {
    return {
      aov: this.div(v.revenue, v.inv_orders),
      aoc: this.div(v.inv_orders, v.inv_customers),
      arpc: this.div(v.revenue, v.inv_customers),
      newCustomers: v.new_customers,
      quantity: v.quantity,
      orders: v.inv_orders,
      revenue: v.revenue,
      cost: v.cost,
      margin: this.netMargin(v),
    };
  }
}
