import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsPrismaService } from './analytics-prisma.service';
import {
  AnalyticsReportsService,
  rangeDaysJoin,
} from '../analytics-reports.service';
import { AnalyticsAxis, AnalyticsBusinessQueryDto } from '../dto';
import {
  CurrentPeriod,
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
  AnalyticsDlclQueryDto,
  AnalyticsStrategicDistributorDto,
  AnalyticsStrategicDistributorUpdateDto,
  AnalyticsStrategicProgramUpdateDto,
  DlclMetric,
  PRODUCT_PHASES,
} from './analytics-khach-hang-dlcl.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › Khách Hàng — các trang ĐLCL Lermao / Mứt Lermao / Boduo /
// Phượng Hoàng, Biên Thương Mại, Chi Tiết, Xuất Data (thay Power BI, dataset_sale).
// Dùng chung bộ tính toán ở AnalyticsReportsService (baseCtes, invMetrics, lineMetrics…),
// nối thêm CTE riêng:
//   inv : hoá đơn đã lọc (invx) + slicer khách của trang (nhóm khách, chương trình ĐLCL, VIP)
//   ln  : dòng hàng của inv + tên hàng, đơn giá, giảm giá, giá chung (basePrice) + slicer hàng
// switch_dynamics_metrics: có lọc sản phẩm (slicer hàng / bộ lọc của visual / hàng là trục)
// → số cấp dòng (ln), ngược lại → số cấp hoá đơn (inv). Sản lượng luôn cấp dòng.
// Quy tắc viết cứng của DAX (mã khách ĐLCL, nhóm khách chương trình, khách nội bộ) nằm ở
// bảng analytics_strategic_programs / analytics_strategic_distributors (có màn sửa).
// ═══════════════════════════════════════════════════════════════════════════

const BLANK = '__blank__';
const NULL_KEY = '\u0000';
const SEP = '\u0001';
const TOTAL = 'T';
const TOTAL_PREV = 'TP';
/** Filter trang "Biên Thương Mại". */
const BIEN_TM_CUSTOMER_TYPE = 'Khách buôn';
const BIEN_TM_PRODUCT_TYPE = 'Hàng thương hiệu';
const CUSTOMER_TYPES = ['Khách buôn', 'Khách chuỗi', 'Khách lẻ'];
const DETAIL_LIMIT = 3000;
/** Cột của bảng chi tiết (tableEx) — thứ tự phần tử trong mỗi dòng trả về. */
const DETAIL_COLUMNS = [
  'date',
  'invoiceCode',
  'customerName',
  'customerCode',
  'productCode',
  'productName',
  'quantity',
  'price',
  'discount',
  'amount',
  'free',
  'parentName',
] as const;
const INTERNAL_PROGRAM = 'internal';

type MV = {
  amount: number;
  orders: number;
  customers: number;
  quantity: number;
  general: number;
};
type DimName =
  | 'parent'
  | 'product'
  | 'customer'
  | 'category'
  | 'ctype'
  | 'day'
  | 'weekday'
  | 'month';
const DIM_SQL: Record<DimName, Prisma.Sql> = {
  parent: Prisma.sql`x.parent_name`,
  product: Prisma.sql`x.product_name`,
  customer: Prisma.sql`x.customer_name`,
  category: Prisma.sql`x.category`,
  ctype: Prisma.sql`x.customer_type`,
  // Trục auto_period (như axisExpr của AnalyticsReportsService)
  day: Prisma.sql`extract(day FROM x.d)::int`,
  weekday: Prisma.sql`extract(isodow FROM x.d)::int`,
  month: Prisma.sql`extract(month FROM x.d)::int`,
};
const PRODUCT_DIMS = new Set<DimName>(['product', 'category']);

type Bucket = { k: string; from: IsoDate; to: IsoDate };
type CubeMap = Map<string, Map<string, MV>>;
/** Số đếm phân biệt (tốn kém) chỉ tính khi trang cần. */
type Need = { orders?: boolean; customers?: boolean };
/** 1 phép gom trong cubes(): nguồn (ln / inv), ≤ 2 chiều, các khoảng ngày (bucket). */
interface CubeSpec {
  src: 'line' | 'inv';
  dims: (DimName | null)[];
  buckets: Bucket[];
  need: Need;
  where?: Prisma.Sql;
}
const needFor = (metric: DlclMetric, extra: Need = {}): Need => ({
  orders: metric === 'orders' || extra.orders,
  customers: metric === 'customers' || extra.customers,
});
/** Làm tròn tỉ lệ (MoM, biên) 4 chữ số để giảm dung lượng trả về. */
const r4 = (v: number | null) =>
  v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4;

export interface StrategicProgram {
  id: number;
  code: string;
  name: string;
  customerGroupName: string | null;
  productType: string | null;
  brand: string | null;
  sortOrder: number;
}
export interface StrategicDistributor {
  id: number;
  programCode: string;
  name: string;
  customerCodes: string[];
  matchAll: boolean;
  sortOrder: number;
  isActive: boolean;
  note: string | null;
}

interface CteOpts {
  program?: StrategicProgram | null;
  vipOnly?: boolean;
  customerType?: string;
  productType?: string;
}

export type PivotMeasure =
  | 'value'
  | 'mom'
  | 'amount'
  | 'orders'
  | 'quantity'
  | 'general'
  | 'diff'
  | 'margin';
export interface PivotColumn {
  key: string;
  label: string;
  group?: string;
}
export interface PivotNode {
  label: string | null;
  cells: (number | null)[][];
  children?: PivotNode[];
  /** Hàng cấp 1 chưa kèm hàng con: tải khi mở rộng (gọi lại API với expand = label). */
  expandable?: boolean;
}
export interface Pivot {
  columns: PivotColumn[];
  measures: PivotMeasure[];
  rows: PivotNode[];
  total: (number | null)[][];
}

interface MonthGrid {
  display: Bucket[];
  buckets: Bucket[];
  columns: PivotColumn[];
  prevOf: Map<string, string>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ym = (y: number, m: number) => `${y}-${pad(m)}`;
const fmtDm = (d: IsoDate) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

@Injectable()
export class AnalyticsKhachHangDlclService {
  constructor(
    private prisma: AnalyticsPrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Danh sách cho bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  async getOptions() {
    const [shared, parents, productNames, productTypes, brands] =
      await Promise.all([
        this.base.getFilterOptions(),
        // Khách cha theo quy tắc gộp của khách đã có hoá đơn.
        this.base.dataLakeReady().then(
          () =>
            this.prisma.$queryRaw<{ name: string }[]>`
            WITH ${this.base.custCte(Prisma.sql`c.id IN (SELECT DISTINCT "customerId" FROM invoices WHERE status <> 2 AND "customerId" IS NOT NULL)`)}
            SELECT DISTINCT parent_name AS name FROM cust ORDER BY 1`,
        ),
        this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT name FROM products WHERE name IS NOT NULL ORDER BY 1`,
        this.productTypes(),
        this.brands(),
      ]);
    return {
      years: shared.years,
      customerTypes: CUSTOMER_TYPES,
      customerGroups: shared.customerGroups,
      parentNames: parents.map((r) => r.name),
      regions: shared.regions,
      productGroups: shared.productGroups,
      productTypes,
      brands,
      productPhases: [...PRODUCT_PHASES],
      productNames: productNames.map((r) => r.name),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ĐLCL Lermao: sản lượng hàng Lermao theo từng đại lý chiến lược (cột)
  // ─────────────────────────────────────────────────────────────────────────
  async getLermao(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    const program = await this.program('lermao');
    const all = (await this.listDistributorRows('lermao')).filter(
      (d) => d.isActive,
    );
    const selected = q.distributorIds?.length
      ? all.filter((d) => q.distributorIds!.includes(d.id))
      : all;
    const distributors = all.map((d) => ({ id: d.id, name: d.name }));
    const columns = selected.map((d) => ({ id: d.id, name: d.name }));
    if (!p || !columns.length) {
      return {
        ...this.periodInfo(p, q),
        program,
        distributors,
        columns,
        rows: [],
        total: [],
      };
    }

    // Total Quantity theo mã khách × danh mục × hàng; ghép mã khách → đại lý ở đây
    // (CONTAINSSTRING của DAX: mã khách CHỨA chuỗi, không phân biệt hoa thường).
    // Sản lượng cộng dồn được nên cộng theo đại lý không sai số.
    const ctes = await this.ctes(q, this.base.periodCond(p), { program });
    const rows = await this.prisma.$queryRaw<
      {
        code: string;
        category: string | null;
        product: string | null;
        v: number;
      }[]
    >`
      WITH ${ctes}
      SELECT COALESCE(x.customer_code, '') AS code, x.category, x.product_name AS product,
             COALESCE(SUM(x.quantity), 0)::float8 AS v
      FROM ln x
      GROUP BY 1, 2, 3`;

    const matchers = selected.map((d) => {
      const pats = d.customerCodes
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      return (code: string) =>
        d.matchAll || pats.some((pt) => code.toLowerCase().includes(pt));
    });
    const empty = () => columns.map(() => null as number | null);
    const add = (cells: (number | null)[], i: number, v: number) => {
      cells[i] = (cells[i] ?? 0) + v;
    };
    type Node = { label: string | null; cells: (number | null)[] };
    const total = empty();
    const cats = new Map<string, Node & { children: Map<string, Node> }>();
    const codeHits = new Map<string, number[]>();
    for (const r of rows) {
      let hits = codeHits.get(r.code);
      if (!hits) {
        hits = matchers.flatMap((m, i) => (m(r.code) ? [i] : []));
        codeHits.set(r.code, hits);
      }
      if (!hits.length) continue;
      const ck = r.category ?? NULL_KEY;
      if (!cats.has(ck)) {
        cats.set(ck, {
          label: r.category,
          cells: empty(),
          children: new Map(),
        });
      }
      const cat = cats.get(ck)!;
      const pk = r.product ?? NULL_KEY;
      if (!cat.children.has(pk)) {
        cat.children.set(pk, { label: r.product, cells: empty() });
      }
      const prod = cat.children.get(pk)!;
      const v = Number(r.v);
      for (const i of hits) {
        add(total, i, v);
        add(cat.cells, i, v);
        add(prod.cells, i, v);
      }
    }
    const byLabel = (a: Node, b: Node) =>
      (a.label ?? '').localeCompare(b.label ?? '', 'vi');
    return {
      ...this.periodInfo(p, q),
      program,
      distributors,
      columns,
      rows: [...cats.values()].sort(byLabel).map((c) => ({
        label: c.label,
        cells: c.cells,
        children: [...c.children.values()].sort(byLabel),
      })),
      total,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ĐLCL Mứt Lermao: khách nhóm "KH ĐLCL Mứt Lermao", mọi mặt hàng
  // ─────────────────────────────────────────────────────────────────────────
  async getMutLermao(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    const program = await this.program('mut-lermao');
    if (!p) {
      return {
        ...this.periodInfo(p, q),
        program,
        byCustomer: null,
        byProduct: null,
        growth: [],
        detail: null,
      };
    }
    const metric = q.metric ?? 'amount';
    const grid = this.monthGrid(q.year, p);
    const opts: CteOpts = { program };
    const pf = this.productFiltered(q, opts);
    const ctes = await this.ctes(q, this.bucketSql(grid.buckets).cond, opts);
    const need = needFor(metric, { orders: true });
    const [[line, inv], detail] = await Promise.all([
      this.cubes(ctes, [
        {
          src: 'line',
          dims: ['parent', 'product'],
          buckets: grid.buckets,
          need,
        },
        { src: 'inv', dims: ['parent', null], buckets: grid.buckets, need },
      ]),
      this.detail(ctes, p),
    ]);
    const common = {
      columns: grid.columns,
      prevOf: grid.prevOf,
      metric,
      productFiltered: pf,
      line,
      inv,
    };
    return {
      ...this.periodInfo(p, q),
      program,
      productFiltered: pf,
      byCustomer: this.pivot({
        ...common,
        rows: [0, 1],
        measures: ['amount', 'orders', 'quantity', 'mom'],
      }),
      byProduct: this.pivot({
        ...common,
        rows: [1, 0],
        measures: ['amount', 'quantity', 'mom'],
      }),
      growth: this.monthSeries(grid, metric, pf, line, inv),
      detail,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ĐLCL Boduo: khách nhóm "KH ĐL BODUO", hàng thương mại Boduo
  // ─────────────────────────────────────────────────────────────────────────
  async getBoduo(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    const program = await this.program('boduo');
    if (!p) {
      return {
        ...this.periodInfo(p, q),
        program,
        byCustomer: null,
        byCategory: null,
        trend: [],
        pie: [],
        detail: null,
      };
    }
    const metric = q.metric ?? 'amount';
    const grid = this.monthGrid(q.year, p);
    const opts: CteOpts = { program };
    const pf = this.productFiltered(q, opts);
    const need = needFor(metric);
    const [ctes, pieCtes] = await Promise.all([
      this.ctes(q, this.bucketSql(grid.buckets).cond, opts),
      // Biểu đồ tròn: Power BI lọc khách VIP Cty (is_customer_key), không phải nhóm Boduo.
      this.ctes(q, this.base.periodCond(p), {
        program: { ...program, customerGroupName: null },
        vipOnly: true,
      }),
    ]);
    const [[line, inv, cat], [pie], detail] = await Promise.all([
      this.cubes(ctes, [
        { src: 'line', dims: ['customer'], buckets: grid.buckets, need },
        { src: 'inv', dims: ['customer'], buckets: grid.buckets, need },
        // "Danh Mục Hàng Boduo": tháng × danh mục, chỉ Top 5 sản phẩm (TopN của visual).
        {
          src: 'line',
          dims: ['category'],
          buckets: grid.buckets,
          need,
          where: this.topNWhere(p, metric, 5),
        },
      ]),
      this.cubes(pieCtes, [
        {
          src: 'line',
          dims: ['category'],
          buckets: this.periodBuckets(grid),
          need,
        },
      ]),
      this.detail(ctes, p),
    ]);
    const common = {
      columns: grid.columns,
      prevOf: grid.prevOf,
      metric,
      productFiltered: pf,
      line,
      inv,
    };
    return {
      ...this.periodInfo(p, q),
      program,
      byCustomer: this.pivot({
        ...common,
        rows: [0],
        measures: ['value', 'mom'],
      }),
      byCategory: this.monthByDim(grid, metric, cat),
      trend: this.monthSeries(grid, metric, pf, line, inv),
      pie: this.dimList(pie, metric, TOTAL),
      detail,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ĐLCL Phượng Hoàng: khách nhóm "KH ĐL Trà Phượng Hoàng", hàng thương hiệu Phượng Hoàng
  // ─────────────────────────────────────────────────────────────────────────
  async getPhuongHoang(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    const program = await this.program('phuong-hoang');
    const axis: AnalyticsAxis = q.axis ?? 'month';
    if (!p) {
      return {
        ...this.periodInfo(p, q),
        program,
        axis,
        top5: [],
        trend: [],
        byProduct: null,
        byCustomer: null,
        detail: null,
      };
    }
    const metric = q.metric ?? 'amount';
    const grid = this.monthGrid(q.year, p);
    const opts: CteOpts = { program };
    const pf = this.productFiltered(q, opts);
    const ctes = await this.ctes(q, this.bucketSql(grid.buckets).cond, opts);
    const need = needFor(metric);
    const periodB = this.periodBuckets(grid);
    const [[line, inv, prod, trend], detail] = await Promise.all([
      this.cubes(ctes, [
        {
          src: 'line',
          dims: ['parent', 'product'],
          buckets: grid.buckets,
          need,
        },
        { src: 'inv', dims: ['parent', null], buckets: grid.buckets, need },
        { src: 'line', dims: ['product'], buckets: periodB, need },
        {
          src: pf || metric === 'quantity' ? 'line' : 'inv',
          dims: [axis],
          buckets: periodB,
          need,
        },
      ]),
      this.detail(ctes, p),
    ]);
    const common = {
      prevOf: grid.prevOf,
      metric,
      productFiltered: pf,
      line,
      inv,
    };
    return {
      ...this.periodInfo(p, q),
      program,
      axis,
      top5: this.dimList(prod, metric, TOTAL).slice(0, 5),
      trend: this.axisPoints(p, q.year, axis, metric, trend),
      byProduct: this.pivot({
        ...common,
        columns: grid.columns.filter((c) => c.key === TOTAL),
        rows: [1, 0],
        measures: ['quantity'],
      }),
      byCustomer: this.pivot({
        ...common,
        columns: grid.columns,
        rows: [0, 1],
        measures: ['value', 'mom'],
      }),
      detail,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Biên Thương Mại: khách buôn × hàng thương hiệu, giá buôn so với giá lẻ (basePrice)
  // ─────────────────────────────────────────────────────────────────────────
  async getBienThuongMai(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    if (!p) return { ...this.periodInfo(p, q), cards: null, pivot: null };
    const metric = q.metric ?? 'amount';
    const grid = this.monthGrid(q.year, p);
    const buckets = this.periodBuckets(grid);
    const opts: CteOpts = {
      customerType: BIEN_TM_CUSTOMER_TYPE,
      productType: BIEN_TM_PRODUCT_TYPE,
    };
    const ctes = await this.ctes(q, this.base.periodCond(p), opts);
    const [line, inv] = await this.cubes(ctes, [
      { src: 'line', dims: ['customer', 'product'], buckets, need: {} },
      { src: 'inv', dims: [], buckets, need: { customers: true } },
    ]);
    const tot = line.get(this.totalKey(line))?.get(TOTAL);
    const invTot = inv.get(this.totalKey(inv))?.get(TOTAL);
    const amount = tot?.amount ?? 0;
    const general = tot?.general ?? 0;
    return {
      ...this.periodInfo(p, q),
      cards: {
        amount,
        general,
        diff: general - amount,
        margin: amount ? r4((general - amount) / amount) : null,
        activeCustomers: invTot?.customers ?? 0,
      },
      pivot: this.pivot({
        columns: [{ key: TOTAL, label: 'Tổng' }],
        prevOf: new Map(),
        metric,
        productFiltered: true,
        line,
        rows: [0, 1],
        measures: ['amount', 'general', 'diff', 'margin'],
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chi Tiết: bảng theo nhóm khách, xu hướng so cùng kỳ, tổng hợp khách × hàng × tháng/tuần
  // ─────────────────────────────────────────────────────────────────────────
  async getChiTiet(q: AnalyticsDlclQueryDto) {
    const p = this.periodOf(q);
    const axis: AnalyticsAxis = q.axis ?? 'month';
    const mode = q.columns ?? 'month';
    if (!p)
      return {
        ...this.periodInfo(p, q),
        axis,
        mode,
        byType: null,
        trend: [],
        pivot: null,
      };
    const metric = q.metric ?? 'amount';
    const pf = this.productFiltered(q, {});
    const month = this.monthGrid(q.year, p);
    const grid = mode === 'week' ? this.weekGrid(q.year, p) : month;
    const measures: PivotMeasure[] =
      mode === 'week' ? ['value'] : ['value', 'mom'];
    const allBuckets =
      mode === 'week' ? [...grid.buckets, ...month.buckets] : grid.buckets;
    const ctes = await this.ctes(q, this.bucketSql(allBuckets).cond, {});
    const need = needFor(metric);
    // Mở rộng 1 khách cha: chỉ trả các hàng con (sản phẩm) của khách đó.
    if (q.expand !== undefined) {
      return {
        children: await this.expandParent(
          ctes,
          grid,
          metric,
          pf,
          measures,
          q.expand,
        ),
      };
    }
    const sameYear = this.base.sameYearRanges(p, q.year, axis);
    const periodB = this.periodBuckets(month);
    const src = pf || metric === 'quantity' ? 'line' : 'inv';
    const [[line, inv, trend, typeInv, typeLine], newCustomers, prevTrend] =
      await Promise.all([
        this.cubes(ctes, [
          { src: 'line', dims: ['parent', null], buckets: grid.buckets, need },
          { src: 'inv', dims: ['parent', null], buckets: grid.buckets, need },
          { src, dims: [axis], buckets: periodB, need },
          {
            src: 'inv',
            dims: ['ctype'],
            buckets: periodB,
            need: { orders: true, customers: true },
          },
          { src: 'line', dims: ['ctype'], buckets: periodB, need: {} },
        ]),
        this.newCustomersByType(ctes, p),
        // switch_dynamics_metrics_sameYear: mỗi điểm trục có khoảng ngày "năm trước" riêng.
        this.ctes(q, this.base.rangeSql(sameYear).cond, {}).then((c) =>
          this.cubes(c, [
            {
              src,
              dims: [],
              buckets: sameYear.map((r) => ({
                k: String(r.k),
                from: r.from,
                to: r.to,
              })),
              need,
            },
          ]),
        ),
      ]);
    const prevTot = prevTrend[0].get(this.totalKey(prevTrend[0]));
    return {
      ...this.periodInfo(p, q),
      axis,
      mode,
      productFiltered: pf,
      byType: this.customerTypeTable(typeInv, typeLine, newCustomers),
      trend: this.axisPoints(p, q.year, axis, metric, trend).map((t) => {
        const prev = prevTot?.get(t.key);
        return { ...t, previous: prev ? prev[metric] : null };
      }),
      pivot: this.pivot({
        columns: grid.columns,
        prevOf: grid.prevOf,
        metric,
        productFiltered: pf,
        line,
        inv,
        rows: [0, 1],
        measures,
        lazy: true,
      }),
    };
  }

  /** Hàng con (sản phẩm) của 1 khách cha trong bảng khách × hàng (mở rộng matrix). */
  private async expandParent(
    ctes: Prisma.Sql,
    grid: {
      buckets: Bucket[];
      columns: PivotColumn[];
      prevOf: Map<string, string>;
    },
    metric: DlclMetric,
    pf: boolean,
    measures: PivotMeasure[],
    parent: string,
  ): Promise<PivotNode[]> {
    const [line] = await this.cubes(ctes, [
      {
        src: 'line',
        dims: ['parent', 'product'],
        buckets: grid.buckets,
        need: needFor(metric),
        where: Prisma.sql`x.parent_name = ${parent}`,
      },
    ]);
    const pv = this.pivot({
      columns: grid.columns,
      prevOf: grid.prevOf,
      metric,
      productFiltered: pf,
      line,
      rows: [0, 1],
      measures,
    });
    return pv.rows[0]?.children ?? [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Xuất Data (> 12 tháng): khách cha × hàng × năm-tháng
  // ─────────────────────────────────────────────────────────────────────────
  async getXuatData(q: AnalyticsDlclQueryDto) {
    const years = [...new Set(q.years?.length ? q.years : [q.year])].sort(
      (a, b) => a - b,
    );
    const today = todayVn();
    const display: Bucket[] = [];
    const columns: PivotColumn[] = [];
    for (const y of years) {
      const p = currentPeriod({ year: y, months: q.months ?? [] }, today);
      if (!p) continue;
      for (const m of p.months) {
        const to = daxDate(y, m + 1, 0);
        display.push({
          k: ym(y, m),
          from: daxDate(y, m, 1),
          to: to > today ? today : to,
        });
        columns.push({
          key: ym(y, m),
          label: `Tháng ${pad(m)}`,
          group: String(y),
        });
      }
    }
    const metric = q.metric ?? 'amount';
    const updatedAt = new Date().toISOString();
    if (!display.length) return { period: null, updatedAt, pivot: null };
    const period = {
      from: display[0].from,
      to: display[display.length - 1].to,
      months: q.months ?? [],
      year: q.year,
      years,
    };
    columns.push({ key: TOTAL, label: 'Tổng' });
    const grid = {
      buckets: [...display, ...display.map((b) => ({ ...b, k: TOTAL }))],
      columns,
      prevOf: new Map<string, string>(),
    };
    const pf = this.productFiltered(q, {});
    const ctes = await this.ctes(
      q,
      Prisma.sql`x.d BETWEEN ${period.from}::date AND ${period.to}::date`,
      {},
    );
    if (q.expand !== undefined) {
      return {
        children: await this.expandParent(
          ctes,
          grid,
          metric,
          pf,
          ['value'],
          q.expand,
        ),
      };
    }
    const need = needFor(metric);
    // full = xuất toàn bộ khách cha × hàng (tải CSV); mặc định chỉ khách cha (mở rộng khi cần).
    const [line, inv] = await this.cubes(ctes, [
      {
        src: 'line',
        dims: ['parent', q.full ? 'product' : null],
        buckets: grid.buckets,
        need,
      },
      { src: 'inv', dims: ['parent', null], buckets: grid.buckets, need },
    ]);
    return {
      period,
      updatedAt,
      productFiltered: pf,
      pivot: this.pivot({
        columns,
        prevOf: grid.prevOf,
        metric,
        productFiltered: pf,
        line,
        inv,
        rows: [0, 1],
        measures: ['value'],
        lazy: !q.full,
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: chương trình ĐLCL + danh sách đại lý / khách nội bộ
  // ─────────────────────────────────────────────────────────────────────────
  async listPrograms() {
    const [programs, groups, productTypes, brands] = await Promise.all([
      this.prisma.$queryRaw<StrategicProgram[]>`
        SELECT id, code, name, customer_group_name AS "customerGroupName", product_type AS "productType",
               brand, sort_order AS "sortOrder"
        FROM analytics_strategic_programs ORDER BY sort_order, id`,
      this.prisma.$queryRaw<
        { name: string }[]
      >`SELECT DISTINCT name FROM customer_groups ORDER BY 1`,
      this.productTypes(),
      this.brands(),
    ]);
    return {
      programs,
      customerGroups: groups.map((g) => g.name),
      productTypes,
      brands,
    };
  }

  async updateProgram(code: string, dto: AnalyticsStrategicProgramUpdateDto) {
    await this.program(code);
    const sets: Prisma.Sql[] = [];
    const clean = (v: string | null | undefined) =>
      v?.trim() ? v.trim() : null;
    if (dto.name !== undefined)
      sets.push(Prisma.sql`name = ${dto.name.trim()}`);
    if (dto.customerGroupName !== undefined)
      sets.push(
        Prisma.sql`customer_group_name = ${clean(dto.customerGroupName)}`,
      );
    if (dto.productType !== undefined)
      sets.push(Prisma.sql`product_type = ${clean(dto.productType)}`);
    if (dto.brand !== undefined)
      sets.push(Prisma.sql`brand = ${clean(dto.brand)}`);
    if (sets.length) {
      await this.prisma.$executeRaw`
        UPDATE analytics_strategic_programs SET ${Prisma.join(sets)}, updated_at = now() WHERE code = ${code}`;
    }
    return this.program(code);
  }

  async listDistributors(programCode?: string) {
    const rows = await this.listDistributorRows(programCode);
    if (!rows.length) return [];
    // Khách khớp từng đại lý (để kiểm tra mã trước khi dùng). Khách nội bộ: khớp đúng mã.
    const matches = await this.prisma.$queryRaw<
      { id: number; code: string; name: string }[]
    >`
      SELECT d.id, c.code, c.name
      FROM analytics_strategic_distributors d
      CROSS JOIN LATERAL unnest(d.customer_codes) pat
      JOIN customers c ON CASE WHEN d.program_code = ${INTERNAL_PROGRAM} THEN c.code = pat
                               ELSE pat <> '' AND strpos(lower(c.code), lower(pat)) > 0 END
      WHERE d.id = ANY(${rows.map((r) => r.id)}::int[]) AND NOT d.match_all
      ORDER BY d.id, c.code`;
    const byId = new Map<number, { code: string; name: string }[]>();
    for (const m of matches) {
      const list = byId.get(Number(m.id)) ?? [];
      if (list.length < 30) list.push({ code: m.code, name: m.name });
      byId.set(Number(m.id), list);
    }
    return rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? [] }));
  }

  async createDistributor(dto: AnalyticsStrategicDistributorDto) {
    await this.program(dto.programCode);
    const codes = this.cleanCodes(dto.customerCodes);
    if (!codes.length && !dto.matchAll)
      throw new BadRequestException(
        'Cần ít nhất 1 mã khách (hoặc chọn "Tất cả khách")',
      );
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO analytics_strategic_distributors
        (program_code, name, customer_codes, match_all, sort_order, is_active, note, created_at, updated_at)
      VALUES (${dto.programCode}, ${dto.name.trim()}, ${codes}::text[], ${dto.matchAll ?? false},
              ${dto.sortOrder ?? 0}, ${dto.isActive ?? true}, ${dto.note?.trim() || null}, now(), now())
      RETURNING id`;
    return this.distributor(Number(rows[0].id));
  }

  async updateDistributor(
    id: number,
    dto: AnalyticsStrategicDistributorUpdateDto,
  ) {
    const cur = await this.distributor(id);
    const sets: Prisma.Sql[] = [];
    if (dto.name !== undefined)
      sets.push(Prisma.sql`name = ${dto.name.trim()}`);
    if (dto.customerCodes !== undefined) {
      const codes = this.cleanCodes(dto.customerCodes);
      if (!codes.length && !(dto.matchAll ?? cur.matchAll)) {
        throw new BadRequestException(
          'Cần ít nhất 1 mã khách (hoặc chọn "Tất cả khách")',
        );
      }
      sets.push(Prisma.sql`customer_codes = ${codes}::text[]`);
    }
    if (dto.matchAll !== undefined)
      sets.push(Prisma.sql`match_all = ${dto.matchAll}`);
    if (dto.sortOrder !== undefined)
      sets.push(Prisma.sql`sort_order = ${dto.sortOrder}`);
    if (dto.isActive !== undefined)
      sets.push(Prisma.sql`is_active = ${dto.isActive}`);
    if (dto.note !== undefined)
      sets.push(Prisma.sql`note = ${dto.note?.trim() || null}`);
    if (sets.length) {
      await this.prisma.$executeRaw`
        UPDATE analytics_strategic_distributors SET ${Prisma.join(sets)}, updated_at = now() WHERE id = ${id}`;
    }
    return this.distributor(id);
  }

  async deleteDistributor(id: number) {
    await this.distributor(id);
    await this.prisma
      .$executeRaw`DELETE FROM analytics_strategic_distributors WHERE id = ${id}`;
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SQL
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * CTE của trang: baseCtes (cust, prod, seller, invx…) + inv (hoá đơn đã lọc theo slicer khách
   * của trang) + ln (dòng hàng đã lọc theo slicer hàng). dateCond dùng alias x.d.
   */
  private async ctes(
    q: AnalyticsDlclQueryDto,
    dateCond: Prisma.Sql,
    o: CteOpts,
  ): Promise<Prisma.Sql> {
    const baseQ = {
      year: q.year,
      months: q.months,
      customerGroupId: q.customerGroupId,
      parentName: q.parentName,
      region: q.region,
    } as AnalyticsBusinessQueryDto;
    const base = await this.base.baseCtes(baseQ, dateCond);
    const lake = await this.base.dataLakeReady();
    const eq = (col: Prisma.Sql, v: string) =>
      Prisma.sql`lower(COALESCE(${col}, '')) = lower(${v})`;

    const invConds: Prisma.Sql[] = [];
    for (const t of [q.customerType, o.customerType]) {
      if (t) invConds.push(eq(Prisma.sql`x.customer_type`, t));
    }
    const group = o.program?.customerGroupName;
    if (group)
      invConds.push(
        Prisma.sql`x.customer_code IN (SELECT code FROM dl_prog_cust)`,
      );
    if (o.vipOnly) invConds.push(Prisma.sql`x.is_vip`);
    const invAnd = invConds.length
      ? Prisma.sql`AND ${Prisma.join(invConds, ' AND ')}`
      : Prisma.empty;

    const lineConds: Prisma.Sql[] = [];
    for (const v of [q.productType, o.productType, o.program?.productType]) {
      if (v) lineConds.push(eq(Prisma.sql`pr.product_type`, v));
    }
    for (const v of [q.brand, o.program?.brand]) {
      if (v) lineConds.push(eq(Prisma.sql`pr.brand`, v));
    }
    if (q.productGroup)
      lineConds.push(Prisma.sql`pr.group2026 = ${q.productGroup}`);
    if (q.productName) lineConds.push(Prisma.sql`pn.name = ${q.productName}`);
    if (q.productPhase)
      lineConds.push(Prisma.sql`ph.phase = ${q.productPhase}`);
    const lineAnd = lineConds.length
      ? Prisma.sql`AND ${Prisma.join(lineConds, ' AND ')}`
      : Prisma.empty;

    const progCte = group
      ? Prisma.sql`,
      dl_prog_cust AS (
        SELECT DISTINCT c.code
        FROM customer_group_details g
        JOIN customer_groups cg ON cg.id = g."customerGroupId"
        JOIN customers c ON c.id = g."customerId"
        WHERE cg.name = ${group}
      )`
      : Prisma.empty;

    const oldLines = lake
      ? Prisma.sql`
        UNION ALL
        SELECT x.code, x.d, x.ok, x.total, x.customer_code, x.customer_name, x.parent_name, x.customer_type, x.is_vip,
               od."productCode" AS product_code,
               COALESCE(od.quantity, 0)::float8, COALESCE(od.price, 0)::float8, COALESCE(od.discount, 0)::float8,
               (COALESCE(od.quantity, 0) * COALESCE(od.price, 0) - COALESCE(od.quantity, 0) * COALESCE(od.discount, 0))::float8
        FROM data_lake.invoice_detail od
        JOIN inv x ON NOT x.is_new AND x.code = od."invoiceCode"`
      : Prisma.empty;

    return Prisma.sql`
      ${base}${progCte},
      dl_cname AS (
        SELECT DISTINCT ON (c.code) c.code, c.name
        FROM customers c WHERE c.code IN (SELECT customer_code FROM inv_raw WHERE customer_code IS NOT NULL)
        ORDER BY c.code, c.id
      ),
      inv AS (
        SELECT x.*, cn.name AS customer_name
        FROM invx x LEFT JOIN dl_cname cn ON cn.code = x.customer_code
        WHERE true ${invAnd}
      ),
      dl_pname AS (
        -- products.code là UNIQUE → không cần DISTINCT ON; để Postgres tra theo index.
        SELECT p.code, p.name, COALESCE(p."basePrice", 0)::float8 AS base_price
        FROM products p
      )${q.productPhase ? Prisma.sql`, ${this.phaseCtes(lake)}` : Prisma.empty},
      dl_raw AS (
        SELECT x.code, x.d, x.ok, x.total, x.customer_code, x.customer_name, x.parent_name, x.customer_type, x.is_vip,
               p.code AS product_code,
               COALESCE(d.quantity, 0)::float8 AS quantity, COALESCE(d.price, 0)::float8 AS price,
               COALESCE(d.discount, 0)::float8 AS discount,
               (COALESCE(d.quantity, 0) * COALESCE(d.price, 0) - COALESCE(d.quantity, 0) * COALESCE(d.discount, 0))::float8 AS sub_total
        FROM invoice_details d
        JOIN inv x ON x.is_new AND x.id = d."invoiceId"
        LEFT JOIN products p ON p.id = d."productId"
        ${oldLines}
      ),
      ln AS (
        SELECT l.code, l.d, l.ok, l.total AS inv_total, l.customer_code, l.customer_name, l.parent_name,
               l.customer_type, l.is_vip, l.product_code, pn.name AS product_name,
               pr.product_type, pr.brand, pr.category,
               ROUND(l.quantity)::float8 AS quantity, ROUND(l.price)::float8 AS price,
               ROUND(l.discount)::float8 AS discount, ROUND(l.sub_total)::float8 AS sub_total,
               (ROUND(l.quantity) * COALESCE(pn.base_price, 0))::float8 AS general_amount
        FROM dl_raw l
        LEFT JOIN prod pr ON pr.code = l.product_code
        LEFT JOIN dl_pname pn ON pn.code = l.product_code
        ${q.productPhase ? Prisma.sql`LEFT JOIN dl_phase ph ON ph.code = l.product_code` : Prisma.empty}
        WHERE true ${lineAnd}
      )`;
  }

  /**
   * dim_product[new_product_phase]: số ngày từ lần bán đầu tiên (mọi hoá đơn, trừ khách nội bộ)
   * tới hôm nay → Mới / Giai đoạn 2 / 3 / Ngoài 90 ngày / Không Bán.
   */
  private phaseCtes(lake: boolean): Prisma.Sql {
    const old = lake
      ? Prisma.sql`
        UNION ALL
        SELECT od."productCode", (o."purchaseDate" + interval '7 hour')::date
        FROM data_lake.invoice_detail od
        JOIN data_lake.invoice o ON o.code = od."invoiceCode"
        JOIN customers c ON c.code = o."customerCode"
        WHERE o.status <> 2 AND NOT EXISTS (SELECT 1 FROM dl_internal di WHERE di.code = c.code)`
      : Prisma.empty;
    return Prisma.sql`
      dl_internal AS (
        SELECT DISTINCT unnest(customer_codes) AS code FROM analytics_strategic_distributors
        WHERE program_code = ${INTERNAL_PROGRAM} AND is_active
      ),
      dl_first AS (
        SELECT product_code, MIN(d) AS first_d FROM (
          SELECT p.code AS product_code, (i."purchaseDate" + interval '7 hour')::date AS d
          FROM invoice_details dd
          JOIN invoices i ON i.id = dd."invoiceId"
          JOIN products p ON p.id = dd."productId"
          JOIN customers c ON c.id = i."customerId"
          WHERE i.status <> 2 AND i."soldById" IS DISTINCT FROM 2
            AND NOT EXISTS (SELECT 1 FROM dl_internal di WHERE di.code = c.code)
          ${old}
        ) s GROUP BY product_code
      ),
      dl_phase AS (
        SELECT pn.code, CASE
          WHEN f.first_d IS NULL THEN 'Không Bán'
          WHEN ${todayVn()}::date - f.first_d <= 30 THEN 'Mới (0-30 ngày)'
          WHEN ${todayVn()}::date - f.first_d <= 60 THEN 'Giai đoạn 2 (31-60 ngày)'
          WHEN ${todayVn()}::date - f.first_d <= 90 THEN 'Giai đoạn 3 (61-90 ngày)'
          ELSE 'Ngoài 90 ngày' END AS phase
        FROM dl_pname pn LEFT JOIN dl_first f ON f.product_code = pn.code
      )`;
  }

  /**
   * Gom số theo khoảng ngày (bucket) và tối đa 2 chiều, mọi tổ hợp con (GROUPING SETS).
   * Nhiều phép gom chạy chung 1 câu SQL (UNION ALL) để CTE gốc chỉ tính 1 lần.
   * dims[i] = null: chiều i không gom (số cấp hoá đơn khi chiều đó là sản phẩm).
   * Khoá kết quả: key(mask, values).
   */
  private async cubes(ctes: Prisma.Sql, specs: CubeSpec[]): Promise<CubeMap[]> {
    const parts = specs.map((sp, idx) => {
      const used = sp.dims.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
      const inner = used.map(
        (i) =>
          Prisma.sql`(${DIM_SQL[sp.dims[i]!]})::text AS ${Prisma.raw(`d${i}`)}`,
      );
      const sel = [0, 1].map((i) =>
        used.includes(i)
          ? Prisma.raw(`x.d${i} AS d${i}, GROUPING(x.d${i})::int AS g${i}`)
          : Prisma.raw(`NULL::text AS d${i}, 1::int AS g${i}`),
      );
      const subsets: number[][] = [];
      for (let mask = (1 << used.length) - 1; mask >= 0; mask--) {
        subsets.push(used.filter((_, j) => mask & (1 << j)));
      }
      const sets = Prisma.raw(
        subsets
          .map((st) => `(${['b.k', ...st.map((i) => `x.d${i}`)].join(', ')})`)
          .join(', '),
      );
      const { values } = this.bucketSql(sp.buckets);
      return Prisma.sql`(
        SELECT ${idx}::int AS part, b.k AS bucket, ${Prisma.join(sel)}, ${this.metricsSql(sp.src, sp.need)}
        FROM (SELECT x.*${inner.length ? Prisma.sql`, ${Prisma.join(inner)}` : Prisma.empty}
              FROM ${Prisma.raw(sp.src === 'line' ? 'ln' : 'inv')} x) x
        ${rangeDaysJoin(values, Prisma.raw('x.d'), 'b')}
        ${sp.where ? Prisma.sql`WHERE ${sp.where}` : Prisma.empty}
        GROUP BY GROUPING SETS (${sets}))`;
    });
    const rows = await this.base.q<Record<string, unknown>[]>(Prisma.sql`
      WITH ${ctes}
      ${Prisma.join(parts, ' UNION ALL ')}`);

    const out = specs.map((sp) => {
      const m: CubeMap = new Map();
      this.cubeDims.set(m, sp.dims);
      return m;
    });
    for (const r of rows) {
      const idx = Number(r.part);
      const dims = specs[idx].dims;
      const bits = dims.map((d, i) => !!d && Number(r[`g${i}`]) === 0);
      const vals = dims.map((_, i) =>
        bits[i] ? ((r[`d${i}`] as string | null) ?? null) : null,
      );
      const k = this.key(bits, vals);
      const m = out[idx];
      if (!m.has(k)) m.set(k, new Map());
      m.get(k)!.set(String(r.bucket), {
        amount: Number(r.amount ?? 0),
        orders: Number(r.orders ?? 0),
        customers: Number(r.customers ?? 0),
        quantity: Number(r.quantity ?? 0),
        general: Number(r.general ?? 0),
      });
    }
    return out;
  }

  /**
   * Công thức như invMetrics() / lineMetrics() của AnalyticsReportsService (Revenue / Revenue Detail,
   * Total Orders (in Detail), Active Customer / active_customer_in_detail, Total Quantity) + doanh số
   * theo giá chung; COUNT(DISTINCT) chỉ tính khi cần (rất tốn khi gom nhiều tổ hợp).
   */
  private metricsSql(src: 'line' | 'inv', need: Need): Prisma.Sql {
    const cnt = (on: boolean | undefined, expr: Prisma.Sql) =>
      on
        ? Prisma.sql`COUNT(DISTINCT (${expr}) COLLATE "C") FILTER (WHERE x.ok)::int`
        : Prisma.sql`0::int`;
    if (src === 'inv') {
      return Prisma.sql`
        COALESCE(SUM(x.total) FILTER (WHERE x.ok), 0)::float8 AS amount,
        ${cnt(need.orders, Prisma.sql`x.code`)} AS orders,
        ${cnt(need.customers, Prisma.sql`COALESCE(x.parent_name, ${BLANK})`)} AS customers,
        0::float8 AS quantity, 0::float8 AS general`;
    }
    return Prisma.sql`
      COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS amount,
      ${cnt(need.orders, Prisma.sql`x.code`)} AS orders,
      ${cnt(need.customers, Prisma.sql`COALESCE(x.customer_code, ${BLANK})`)} AS customers,
      COALESCE(SUM(x.quantity), 0)::float8 AS quantity,
      COALESCE(SUM(x.general_amount) FILTER (WHERE x.ok), 0)::float8 AS general`;
  }

  /** Khoá của 1 ô trong cube: mask chiều đang gom + giá trị từng chiều. */
  private key(bits: boolean[], vals: (string | null)[]): string {
    return [
      bits.map((b) => (b ? '1' : '0')).join(''),
      ...vals.map((v, i) => (bits[i] ? (v ?? NULL_KEY) : '')),
    ].join(SEP);
  }

  /**
   * Dựng bảng pivot (matrix Power BI) từ cube: hàng theo rows (chỉ số chiều của cube, 1–2 cấp),
   * cột theo bucket, mỗi cột nhiều measure. Số switch_dynamics_metrics: cấp dòng nếu có lọc
   * sản phẩm hoặc hàng đang ở chiều sản phẩm, ngược lại cấp hoá đơn.
   */
  private pivot(o: {
    columns: PivotColumn[];
    prevOf: Map<string, string>;
    metric: DlclMetric;
    productFiltered: boolean;
    line: CubeMap;
    inv?: CubeMap;
    rows: number[];
    measures: PivotMeasure[];
    /** true: chỉ trả hàng cấp 1 (hàng con tải khi mở rộng). */
    lazy?: boolean;
  }): Pivot {
    const dims = this.cubeDims.get(o.line) ?? [];
    const dimCount = dims.length;
    const bitsFor = (idx: number[]) =>
      Array.from({ length: dimCount }, (_, i) => idx.includes(i));
    const valsFor = (idx: number[], v: (string | null)[]) =>
      Array.from({ length: dimCount }, (_, i) => {
        const j = idx.indexOf(i);
        return j >= 0 ? v[j] : null;
      });
    const hasProductDim = (idx: number[]) =>
      idx.some((i) => {
        const d = dims[i];
        return !!d && PRODUCT_DIMS.has(d);
      });

    const cellsOf = (idx: number[], v: (string | null)[]) => {
      const k = this.key(bitsFor(idx), valsFor(idx, v));
      const lineRow = o.line.get(k);
      const invRow = o.inv?.get(k);
      const useLine = o.productFiltered || hasProductDim(idx) || !invRow;
      const sw = (bucket: string | undefined): number | null => {
        if (!bucket) return null;
        const l = lineRow?.get(bucket);
        if (o.metric === 'quantity') return l ? l.quantity : null;
        const src = useLine ? l : invRow?.get(bucket);
        return src ? src[o.metric] : null;
      };
      return o.columns.map((c) =>
        o.measures.map((m) => {
          const l = lineRow?.get(c.key);
          switch (m) {
            case 'value':
              return sw(c.key);
            case 'mom': {
              const prevKey = o.prevOf.get(c.key);
              if (!prevKey) return null;
              const cur = sw(c.key);
              const prev = sw(prevKey);
              return prev ? r4(((cur ?? 0) - prev) / prev) : null;
            }
            case 'amount':
              return l ? l.amount : null;
            case 'orders':
              return l ? l.orders : null;
            case 'quantity':
              return l ? l.quantity : null;
            case 'general':
              return l ? l.general : null;
            case 'diff':
              return l ? l.general - l.amount : null;
            case 'margin':
              return l && l.amount
                ? r4((l.general - l.amount) / l.amount)
                : null;
          }
          return null;
        }),
      );
    };
    const displayKeys = new Set(o.columns.map((c) => c.key));
    const hasData = (k: string) =>
      [...(o.line.get(k)?.keys() ?? []), ...(o.inv?.get(k)?.keys() ?? [])].some(
        (b) => displayKeys.has(b),
      );
    const sortVal = (cells: (number | null)[][]) =>
      cells[cells.length - 1]?.[0] ?? -Infinity;

    // Liệt kê giá trị của chiều hàng cấp 1 / cấp 2 từ khoá cube.
    const parse = (k: string) => {
      const [mask, ...vals] = k.split(SEP);
      return { mask, vals: vals.map((v) => (v === NULL_KEY ? null : v)) };
    };
    const maskOf = (idx: number[]) =>
      bitsFor(idx)
        .map((b) => (b ? '1' : '0'))
        .join('');
    const r0 = o.rows[0];
    const r1 = o.rows[1];
    const lvl1 = new Map<string, string | null>();
    const lvl2 = new Map<string, Map<string, string | null>>();
    for (const k of new Set([...o.line.keys(), ...(o.inv?.keys() ?? [])])) {
      if (!hasData(k)) continue;
      const { mask, vals } = parse(k);
      if (mask === maskOf([r0])) lvl1.set(vals[r0] ?? NULL_KEY, vals[r0]);
      if (r1 !== undefined && mask === maskOf([r0, r1])) {
        const a = vals[r0] ?? NULL_KEY;
        if (!lvl2.has(a)) lvl2.set(a, new Map());
        lvl2.get(a)!.set(vals[r1] ?? NULL_KEY, vals[r1]);
      }
    }
    const rows: PivotNode[] = [...lvl1.entries()].map(([a, va]) => {
      const node: PivotNode = { label: va, cells: cellsOf([r0], [va]) };
      if (r1 !== undefined && o.lazy) {
        node.expandable = va !== null;
      } else if (r1 !== undefined) {
        node.children = [...(lvl2.get(a)?.values() ?? [])]
          .map((vb) => ({ label: vb, cells: cellsOf([r0, r1], [va, vb]) }))
          .sort((x, y) => sortVal(y.cells) - sortVal(x.cells));
      }
      return node;
    });
    rows.sort((x, y) => sortVal(y.cells) - sortVal(x.cells));
    return {
      columns: o.columns,
      measures: o.measures,
      rows,
      total: cellsOf([], []),
    };
  }

  /** Tên các chiều của từng cube (để biết chiều nào là sản phẩm / số chiều của khoá). */
  private cubeDims = new WeakMap<CubeMap, (DimName | null)[]>();

  /** Khoá ô tổng (không gom chiều nào) của cube. */
  private totalKey(cube: CubeMap): string {
    const n = this.cubeDims.get(cube)?.length ?? 0;
    return this.key(
      Array<boolean>(n).fill(false),
      Array<string | null>(n).fill(null),
    );
  }

  /** Chuỗi theo tháng (dim_date) + MoM so với tháng liền trước. */
  private monthSeries(
    grid: MonthGrid,
    metric: DlclMetric,
    pf: boolean,
    line: CubeMap,
    inv: CubeMap,
  ) {
    const k = this.totalKey(line);
    const ki = this.totalKey(inv);
    const val = (b: string) => {
      const l = line.get(k)?.get(b);
      if (metric === 'quantity') return l ? l.quantity : null;
      const src = pf ? l : (inv.get(ki)?.get(b) ?? l);
      return src ? src[metric] : null;
    };
    return grid.display.map((b) => {
      const prevKey = grid.prevOf.get(b.k);
      const cur = val(b.k);
      const prev = prevKey ? val(prevKey) : null;
      return {
        key: b.k,
        label: `Tháng ${Number(b.k.slice(5, 7))}`,
        value: cur,
        mom: prev ? r4(((cur ?? 0) - prev) / prev) : null,
      };
    });
  }

  /** "Danh Mục Hàng Boduo": hàng = tháng (dim_date), cột = danh mục, giá trị + MoM. */
  private monthByDim(grid: MonthGrid, metric: DlclMetric, cube: CubeMap) {
    const cats = new Map<string, string | null>();
    for (const k of cube.keys()) {
      const [mask, v] = k.split(SEP);
      if (mask === '1') cats.set(v, v === NULL_KEY ? null : v);
    }
    const catKeys = [...cats.keys()].sort((a, b) => a.localeCompare(b, 'vi'));
    const keys = [
      ...catKeys.map((c) => ['1', c].join(SEP)),
      ['0', ''].join(SEP),
    ];
    const val = (k: string, b: string | undefined) => {
      const m = b ? cube.get(k)?.get(b) : undefined;
      return m ? m[metric] : null;
    };
    const cell = (k: string, b: Bucket) => {
      const cur = val(k, b.k);
      const prev = val(k, grid.prevOf.get(b.k));
      return [cur, prev ? r4(((cur ?? 0) - prev) / prev) : null];
    };
    return {
      columns: [
        ...catKeys.map((c) => ({ key: c, label: cats.get(c) ?? null })),
        { key: TOTAL, label: 'Tổng' },
      ],
      rows: grid.display.map((b) => ({
        key: b.k,
        label: `Tháng ${Number(b.k.slice(5, 7))}`,
        cells: keys.map((k) => cell(k, b)),
      })),
      total: keys.map((k) => [val(k, TOTAL), null]),
    };
  }

  /** Danh sách theo 1 chiều tại 1 bucket (biểu đồ tròn). */
  private dimList(cube: CubeMap, metric: DlclMetric, bucket: string) {
    const out: { name: string | null; value: number }[] = [];
    for (const [k, m] of cube) {
      const [mask, v] = k.split(SEP);
      const mv = m.get(bucket);
      if (mask === '1' && mv)
        out.push({ name: v === NULL_KEY ? null : v, value: mv[metric] });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  /** Khoảng ngày của kỳ đang lọc (các tháng chọn, cắt tới hôm nay) gộp thành 1 bucket T. */
  private periodBuckets(grid: MonthGrid): Bucket[] {
    return grid.display.map((b) => ({ ...b, k: TOTAL }));
  }

  /** TopN của visual: chỉ giữ N sản phẩm (theo tên) có switch metric cao nhất trong kỳ. */
  private topNWhere(
    p: CurrentPeriod,
    metric: DlclMetric,
    n: number,
  ): Prisma.Sql {
    const order: Record<DlclMetric, Prisma.Sql> = {
      amount: Prisma.sql`COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)`,
      quantity: Prisma.sql`COALESCE(SUM(x.quantity), 0)`,
      orders: Prisma.sql`COUNT(DISTINCT (x.code) COLLATE "C") FILTER (WHERE x.ok)`,
      customers: Prisma.sql`COUNT(DISTINCT (COALESCE(x.customer_code, ${BLANK})) COLLATE "C") FILTER (WHERE x.ok)`,
    };
    return Prisma.sql`x.product_name IN (
      SELECT x.product_name FROM ln x
      WHERE ${this.base.periodCond(p)} AND x.product_name IS NOT NULL
      GROUP BY x.product_name ORDER BY ${order[metric]} DESC LIMIT ${n})`;
  }

  /** Điểm của biểu đồ theo trục Ngày / Thứ / Tháng (cube 1 chiều trục, bucket T). */
  private axisPoints(
    p: CurrentPeriod,
    year: number,
    axis: AnalyticsAxis,
    metric: DlclMetric,
    cube: CubeMap,
  ) {
    const vals = new Map<string, number>();
    for (const [k, m] of cube) {
      const [mask, v] = k.split(SEP);
      const mv = m.get(TOTAL);
      if (mask === '1' && mv) vals.set(v, mv[metric]);
    }
    return this.base.axisKeys(p, year, axis).map((k) => ({
      key: k,
      label: this.base.axisLabel(axis, Number(k)),
      value: vals.get(k) ?? null,
    }));
  }

  /** Số khách mới theo nhóm khách (invoice[Is New Customer This Month], New Customer). */
  private async newCustomersByType(
    ctes: Prisma.Sql,
    p: CurrentPeriod,
  ): Promise<Map<string, number>> {
    const lake = await this.base.dataLakeReady();
    const oldAll = lake
      ? Prisma.sql`
        UNION ALL
        SELECT c.code, (o."purchaseDate" + interval '7 hour')::date
        FROM data_lake.invoice o LEFT JOIN customers c ON c.code = o."customerCode"
        WHERE o.status <> 2`
      : Prisma.empty;
    const rows = await this.base.q<
      { key: string | null; g: number; n: number }[]
    >(Prisma.sql`
      WITH ${ctes},
      -- Tháng mua đầu tiên của khách cha trên MỌI hoá đơn (bảng invoice của Power BI: mọi người bán, trừ user 2)
      nc_all AS (
        SELECT c.code AS customer_code, (i."purchaseDate" + interval '7 hour')::date AS d
        FROM invoices i LEFT JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2 AND i."soldById" IS DISTINCT FROM 2
        ${oldAll}
      ),
      nc_cust AS (
        SELECT DISTINCT ON (c.code) c.code,
          COALESCE((
            SELECT r.parent_name FROM rules r
            WHERE (r.match_type = 'code' AND lower(c.code) = r.pat)
               OR (r.match_type = 'name_contains' AND strpos(lower(c.name), r.pat) > 0)
            ORDER BY r.priority, r.id LIMIT 1
          ), c.name) AS parent_name
        FROM customers c WHERE c.code IN (SELECT customer_code FROM nc_all WHERE customer_code IS NOT NULL)
        ORDER BY c.code, c.id
      ),
      nc_first AS (
        SELECT COALESCE(nc.parent_name, ${BLANK}) AS parent_key, MIN(a.d) AS first_d
        FROM nc_all a LEFT JOIN nc_cust nc ON nc.code = a.customer_code
        GROUP BY 1
      )
      SELECT x.customer_type AS key, GROUPING(x.customer_type)::int AS g,
        COUNT(DISTINCT (COALESCE(x.parent_name, ${BLANK})) COLLATE "C")
          FILTER (WHERE date_trunc('month', x.d) = date_trunc('month', f.first_d))::int AS n
      FROM inv x LEFT JOIN nc_first f ON f.parent_key = COALESCE(x.parent_name, ${BLANK})
      WHERE ${this.base.periodCond(p)}
      GROUP BY GROUPING SETS ((x.customer_type), ())`);
    return new Map(
      rows.map((r) => [`${r.g}${SEP}${r.key ?? NULL_KEY}`, Number(r.n)]),
    );
  }

  /** "Tình hình kinh doanh theo nhóm khách" (trang Chi Tiết). */
  private customerTypeTable(
    inv: CubeMap,
    line: CubeMap,
    newCustomers: Map<string, number>,
  ) {
    const toRow = (k: string, type: string | null, g: number) => {
      const i = inv.get(k)?.get(TOTAL);
      const l = line.get(k)?.get(TOTAL);
      const amount = i?.amount ?? 0;
      const orders = i?.orders ?? 0;
      const customers = i?.customers ?? 0;
      return {
        customerType: type,
        quantity: l ? l.quantity : null,
        orders,
        amount,
        aov: orders ? amount / orders : null,
        aoc: customers ? orders / customers : null,
        arpc: customers ? amount / customers : null,
        newCustomers: newCustomers.get(`${g}${SEP}${type ?? NULL_KEY}`) ?? 0,
      };
    };
    const rows = [...inv.keys()]
      .map((k) => k.split(SEP))
      .filter(([mask]) => mask === '1')
      .map(([mask, v]) =>
        toRow([mask, v].join(SEP), v === NULL_KEY ? null : v, 0),
      )
      .sort((a, b) =>
        (a.customerType ?? '￿').localeCompare(b.customerType ?? '￿', 'vi'),
      );
    return { rows, total: toRow(this.totalKey(inv), null, 1) };
  }

  /** Bảng chi tiết (tableEx): từng dòng hàng của hoá đơn trong kỳ. */
  private async detail(ctes: Prisma.Sql, p: CurrentPeriod) {
    const rows = await this.base.q<Record<string, unknown>[]>(Prisma.sql`
      WITH ${ctes}
      SELECT x.d::text AS d, x.code, x.customer_name, x.customer_code, x.product_code, x.product_name,
             x.price, x.discount, (x.inv_total = 0) AS free, x.parent_name,
             COALESCE(SUM(x.quantity), 0)::float8 AS quantity,
             SUM(x.sub_total) FILTER (WHERE x.ok)::float8 AS amount,
             COUNT(*) OVER ()::int AS n
      FROM ln x
      WHERE ${this.base.periodCond(p)}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      ORDER BY 1 DESC, 2 DESC, 6
      LIMIT ${DETAIL_LIMIT}`);
    const count = rows.length ? Number(rows[0].n) : 0;
    // Dòng dạng mảng (gọn): xem DETAIL_COLUMNS.
    return {
      count,
      truncated: count > rows.length,
      columns: DETAIL_COLUMNS,
      rows: rows.map((r) => [
        String(r.d),
        r.code as string,
        (r.customer_name as string | null) ?? null,
        (r.customer_code as string | null) ?? null,
        (r.product_code as string | null) ?? null,
        (r.product_name as string | null) ?? null,
        Number(r.quantity),
        Number(r.price),
        Number(r.discount),
        r.amount === null ? null : Number(r.amount),
        !!r.free,
        (r.parent_name as string | null) ?? null,
      ]),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Kỳ & cột thời gian
  // ─────────────────────────────────────────────────────────────────────────
  private periodOf(q: AnalyticsDlclQueryDto): CurrentPeriod | null {
    return currentPeriod({ year: q.year, months: q.months ?? [] }, todayVn());
  }

  private periodInfo(p: CurrentPeriod | null, q: AnalyticsDlclQueryDto) {
    return {
      period: p
        ? { from: p.min, to: p.max, months: p.months, year: q.year }
        : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Cột theo tháng (dim_month[Vie Month]) + tháng liền trước của từng tháng (để tính MoM) +
   * cột Tổng (T) và kỳ Tổng lùi 1 tháng (TP, như DATEADD(-1, MONTH)).
   */
  private monthGrid(year: number, p: CurrentPeriod): MonthGrid {
    const today = todayVn();
    const display: Bucket[] = p.months.map((m) => {
      const to = daxDate(year, m + 1, 0);
      return {
        k: ym(year, m),
        from: daxDate(year, m, 1),
        to: to > today ? today : to,
      };
    });
    const prevOf = new Map<string, string>();
    const prev: Bucket[] = [];
    for (const m of p.months) {
      const first = daxDate(year, m - 1, 1);
      const { y, m: pm } = parts(first);
      const k = ym(y, pm);
      prevOf.set(ym(year, m), k);
      if (!display.some((b) => b.k === k) && !prev.some((b) => b.k === k)) {
        prev.push({ k, from: first, to: daxDate(y, pm + 1, 0) });
      }
    }
    prevOf.set(TOTAL, TOTAL_PREV);
    const total = display.map((b) => ({ k: TOTAL, from: b.from, to: b.to }));
    const totalPrev = display.map((b) => ({
      k: TOTAL_PREV,
      ...this.shiftMonth(b.from, b.to),
    }));
    return {
      display,
      buckets: [...display, ...prev, ...total, ...totalPrev],
      columns: [
        ...display.map((b) => ({
          key: b.k,
          label: `Tháng ${b.k.slice(5, 7)}`,
        })),
        { key: TOTAL, label: 'Tổng' },
      ],
      prevOf,
    };
  }

  /** Cột theo tuần trong từng tháng (dim_month › dim_date[Week Visual]). */
  private weekGrid(year: number, p: CurrentPeriod): MonthGrid {
    const today = todayVn();
    const display: Bucket[] = [];
    const columns: PivotColumn[] = [];
    for (const m of p.months) {
      let cur = daxDate(year, m, 1);
      const end = daxDate(year, m + 1, 0);
      while (cur <= end && cur <= today) {
        const wk = this.weekNum(cur);
        let last = cur;
        while (
          addDays(last, 1) <= end &&
          addDays(last, 1) <= today &&
          this.weekNum(addDays(last, 1)) === wk
        ) {
          last = addDays(last, 1);
        }
        const monday = addDays(cur, -(isoWeekday(cur) - 1));
        const sunday = addDays(monday, 6);
        const k = `${ym(year, m)}|${wk}`;
        display.push({ k, from: cur, to: last });
        columns.push({
          key: k,
          label: `Tuần ${wk} (${fmtDm(monday)} - ${fmtDm(sunday)})`,
          group: `Tháng ${pad(m)}`,
        });
        cur = addDays(last, 1);
      }
    }
    columns.push({ key: TOTAL, label: 'Tổng' });
    const total = display.map((b) => ({ ...b, k: TOTAL }));
    return {
      display,
      buckets: [...display, ...total],
      columns,
      prevOf: new Map(),
    };
  }

  /** WEEKNUM(date, 2): tuần bắt đầu thứ Hai, tuần 1 chứa ngày 1/1. */
  private weekNum(date: IsoDate): number {
    const { y } = parts(date);
    const jan1 = daxDate(y, 1, 1);
    const doy = Math.round((Date.parse(date) - Date.parse(jan1)) / 86400000);
    return Math.floor((doy + isoWeekday(jan1) - 1) / 7) + 1;
  }

  /** DATEADD(…, -1, MONTH) cho 1 khoảng ngày: ngày cuối tháng → cuối tháng trước. */
  private shiftMonth(from: IsoDate, to: IsoDate) {
    const { y, m } = parts(to);
    const isMonthEnd = daxDate(y, m + 1, 0) === to;
    return {
      from: edate(from, -1),
      to: isMonthEnd ? daxDate(y, m, 0) : edate(to, -1),
    };
  }

  private bucketSql(buckets: Bucket[]) {
    const from = buckets.reduce(
      (a, b) => (b.from < a ? b.from : a),
      buckets[0].from,
    );
    const to = buckets.reduce((a, b) => (b.to > a ? b.to : a), buckets[0].to);
    return {
      values: Prisma.join(
        buckets.map(
          (b) => Prisma.sql`(${b.k}::text, ${b.from}::date, ${b.to}::date)`,
        ),
      ),
      cond: Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date`,
    };
  }

  /** ISFILTERED(dim_product): có slicer hàng hoặc bộ lọc sản phẩm của visual / chương trình. */
  private productFiltered(q: AnalyticsDlclQueryDto, o: CteOpts): boolean {
    return !!(
      q.productGroup ||
      q.productType ||
      q.brand ||
      q.productPhase ||
      q.productName ||
      o.productType ||
      o.program?.productType ||
      o.program?.brand
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Đọc cấu hình
  // ─────────────────────────────────────────────────────────────────────────
  private async program(code: string): Promise<StrategicProgram> {
    const rows = await this.prisma.$queryRaw<StrategicProgram[]>`
      SELECT id, code, name, customer_group_name AS "customerGroupName", product_type AS "productType",
             brand, sort_order AS "sortOrder"
      FROM analytics_strategic_programs WHERE code = ${code}`;
    if (!rows.length)
      throw new NotFoundException(
        `Chưa cấu hình chương trình "${code}" (analytics_strategic_programs)`,
      );
    return rows[0];
  }

  private listDistributorRows(programCode?: string) {
    return this.prisma.$queryRaw<StrategicDistributor[]>`
      SELECT id, program_code AS "programCode", name, customer_codes AS "customerCodes", match_all AS "matchAll",
             sort_order AS "sortOrder", is_active AS "isActive", note
      FROM analytics_strategic_distributors
      WHERE ${programCode ?? null}::text IS NULL OR program_code = ${programCode ?? null}
      ORDER BY program_code, sort_order, id`;
  }

  private async distributor(id: number): Promise<StrategicDistributor> {
    const rows = await this.prisma.$queryRaw<StrategicDistributor[]>`
      SELECT id, program_code AS "programCode", name, customer_codes AS "customerCodes", match_all AS "matchAll",
             sort_order AS "sortOrder", is_active AS "isActive", note
      FROM analytics_strategic_distributors WHERE id = ${id}`;
    if (!rows.length) throw new NotFoundException('Không tìm thấy đại lý');
    return rows[0];
  }

  private cleanCodes(codes: string[]): string[] {
    return [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  }

  private async productTypes(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT parent_name AS name FROM products WHERE parent_name IS NOT NULL ORDER BY 1`;
    return rows.map((r) => r.name);
  }

  private async brands(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT tm.name FROM products p JOIN trade_marks tm ON tm.id = p."tradeMarkId"
      WHERE tm.name IS NOT NULL ORDER BY 1`;
    return rows.map((r) => r.name);
  }
}
