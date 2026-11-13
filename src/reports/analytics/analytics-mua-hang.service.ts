import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsPrismaService } from './analytics-prisma.service';
import { AnalyticsReportsService } from '../analytics-reports.service';
import { addDays, todayVn } from './analytics-period';
import {
  MUA_HANG_BLANK,
  MuaHangCodeMergeDto,
  MuaHangCodeMergeUpdateDto,
  MuaHangConfigListQueryDto,
  MuaHangDemandQueryDto,
  MuaHangFilterDto,
  MuaHangPeriodQueryDto,
  MuaHangPurchaseProductDto,
  MuaHangPurchaseProductUpdateDto,
  MuaHangRebateDto,
  MuaHangRebateUpdateDto,
  MuaHangSalesQueryDto,
  MuaHangTrendLevel,
} from './analytics-mua-hang.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › Chuyển Kho + Thu Mua — thay Power BI (dataset_purchasing,
// report "Báo Cáo Chuyển Kho" và report đi kèm dataset cho "Báo Cáo Thu Mua").
// Chép đúng Power Query + DAX:
//   • dim_product = products (+ trade_marks); nhóm hàng theo cột tính DAX
//     visual_product_group / product_group_lv2 / product_group_2026 của dataset này
//     (khác dataset_sale: không có quy tắc "tên chứa Boduo", nhóm 2026 so ngày tạo > 01/12/2025 00:00).
//   • Tồn kho = inventories (onHand / onOrder / hư / cận date / khuyến mãi) của "Kho Sài Gòn",
//     "Kho Hà Nội"; Khách đặt = orders status 1,5 tại chi nhánh 1, 6; Hàng trên đường =
//     transfer_details.sendQuantity của phiếu chuyển status 2, theo kho nhận.
//   • Số bán = invoice_details của hoá đơn status <> 2, mã hàng đã gộp theo bảng
//     analytics_product_code_merges (CASE viết cứng trong Power Query), ngày = purchaseDate + 7h.
//   • Thu Mua: filter report dim_product[is_active] = true và bỏ hoá đơn của nhân viên trong
//     analytics_purchase_excluded_sellers.
// Khác Power BI có chủ đích: dim_date của dataset này KHÔNG nối với bảng nào nên slicer
// Năm/Tháng, "Sản Lượng 90 ngày" và cột Năm/Tháng trong Power BI không lọc gì (luôn ra
// toàn thời gian). Ở đây lọc theo ngày hoá đơn / tháng demand đúng ý nghĩa nhãn.
// ═══════════════════════════════════════════════════════════════════════════

/** Kho của các measure tồn kho (FILTER dim_product_inventory[branch_name] IN {...}). */
export const MUA_HANG_WAREHOUSES = ['Kho Sài Gòn', 'Kho Hà Nội'];
/** reserved_quantity: order_detail[branchId] IN {1,6} && status IN {1,5}. */
const RESERVED_BRANCH_IDS = [1, 6];
const RESERVED_ORDER_STATUSES = [1, 5];
/** fact_transfer[status] = "Đang chuyển" (transfers.status = 2). */
const TRANSFER_IN_TRANSIT = 2;
/** Filter trang Chuyển Kho / Hàng Loại B: NOT product_type IN (null | …). */
const CK_EXCLUDED_TYPES = [
  'Dịch vụ',
  'Dụng cụ pha chế',
  'Hàng khuyến mãi',
  'Hàng OEM',
  'Hàng sản xuất',
  'Mẫu thử',
];
/** Filter trang Nguồn Hàng: origin IN (Nội địa | Nhập khẩu chính ngạch). */
const SOURCE_ORIGINS = ['Nội địa', 'Nhập khẩu chính ngạch'];
/** Biểu đồ "Tình Hình Bán Hàng": filter brand IN (Lermao | Boduo). */
const TREND_BRANDS = ['Lermao', 'Boduo'];
/** sale_per_product_90days: DATESBETWEEN(TODAY()-91, TODAY()-1), chia 90. */
const SALE_WINDOW_START = 91;
const SALE_WINDOW_DAYS = 90;

export const MUA_HANG_VISUAL_GROUPS = [
  '1.Boduo',
  '2.Trong nước',
  '3.Nhập khẩu',
  '4.Lermao',
  '5.Phượng Hoàng',
  '6.Sữa tươi',
  '8.OEM - Khác',
  'Khác',
];

type N = number | null;

/** Phạm vi sản phẩm theo filter trang / report của Power BI. */
interface ProductScope {
  activeOnly?: boolean; // dim_product[is_active] = true (report Thu Mua)
  excludeTypes?: boolean; // Chuyển Kho / Hàng Loại B
  excludeBoduo?: boolean; // Chuyển Kho: NOT brand = Boduo
  origins?: string[]; // Nguồn Hàng
}

interface StockRow {
  code: string;
  name: string;
  visual_group: string;
  product_type: string | null;
  origin: string | null;
  category: string | null;
  branch: string;
  onhand: N;
  onorder: N;
  reserved: N;
  transfer: N;
  sale: N;
  damaged: N;
  near_exp: N;
  promo: N;
}

type StockKey =
  | 'onhand'
  | 'onorder'
  | 'reserved'
  | 'transfer'
  | 'sale'
  | 'damaged'
  | 'near_exp'
  | 'promo';

/** Cộng kiểu DAX SUM: BLANK + BLANK = BLANK, BLANK + x = x. */
const addN = (a: N, b: N): N => (a === null ? b : b === null ? a : a + b);
const num = (v: unknown): N =>
  v === null || v === undefined ? null : Number(v);
/** IF(_item = 0, BLANK(), _item). */
const zeroBlank = (v: N): N => (v === null || Math.abs(v) < 1e-9 ? null : v);
/** Prisma 4 gửi số nguyên JS dạng int → lỗi với tham số float; gửi chuỗi rồi ép kiểu. */
const txt = (v: number | null | undefined) =>
  v === null || v === undefined ? null : String(v);

function sumBy<K extends string>(
  rows: Partial<Record<K, N>>[],
  keys: readonly K[],
): Record<K, N> {
  const out = {} as Record<K, N>;
  for (const k of keys) out[k] = null;
  for (const r of rows)
    for (const k of keys) out[k] = addN(out[k], r[k] ?? null);
  return out;
}

const hasValue = (m: Record<string, N>) =>
  Object.values(m).some((v) => v !== null);

@Injectable()
export class AnalyticsMuaHangService {
  constructor(
    private prisma: AnalyticsPrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Danh sách cho bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  async getFilterOptions() {
    const distinct = (col: 'product_type' | 'brand' | 'category' | 'origin') =>
      this.prisma.$queryRaw<{ v: string | null }[]>`
        WITH ${this.prodCte()}
        SELECT DISTINCT ${Prisma.raw(col)} AS v FROM pp ORDER BY 1 NULLS LAST`;
    const toOpts = (rows: { v: string | null }[]) =>
      rows.map((r) => r.v ?? MUA_HANG_BLANK);

    const [
      branches,
      types,
      brands,
      categories,
      origins,
      groups,
      products,
      years,
      customers,
    ] = await Promise.all([
      this.prisma.$queryRaw<
        { name: string }[]
      >`SELECT name FROM branches ORDER BY id`,
      distinct('product_type'),
      distinct('brand'),
      distinct('category'),
      distinct('origin'),
      this.prisma.$queryRaw<{ name: string }[]>`
          SELECT DISTINCT group_name AS name FROM analytics_product_groups
          UNION SELECT unnest(ARRAY['Nhóm B','Nhóm C','Chưa Phân Loại']) ORDER BY 1`,
      this.prisma.$queryRaw<
        { code: string; name: string; is_active: boolean }[]
      >`
          SELECT code, rtrim(name) AS name, "isActive" AS is_active FROM products ORDER BY name, code`,
      this.prisma.$queryRaw<{ y: number }[]>`
          WITH r AS (
            SELECT min("purchaseDate" + interval '7 hour') AS lo, max("purchaseDate" + interval '7 hour') AS hi FROM invoices
            UNION ALL SELECT min(demand_month), max(demand_month) FROM customer_demand_months
          )
          SELECT generate_series(extract(year FROM min(lo))::int, extract(year FROM max(hi))::int) AS y
          FROM r`,
      this.prisma.$queryRaw<{ id: number; code: string; name: string }[]>`
          SELECT DISTINCT c.id, c.code, c.name FROM customer_demands d
          JOIN customers c ON c.id = d.customer_id ORDER BY c.name`,
    ]);

    return {
      blank: MUA_HANG_BLANK,
      warehouses: MUA_HANG_WAREHOUSES,
      branches: branches.map((b) => b.name),
      productTypes: toOpts(types),
      brands: toOpts(brands),
      categories: toOpts(categories),
      origins: toOpts(origins),
      visualGroups: MUA_HANG_VISUAL_GROUPS,
      groups2026: groups.map((g) => g.name),
      products: products.map((p) => ({
        code: p.code,
        name: p.name,
        isActive: p.is_active,
      })),
      years: years.map((y) => Number(y.y)).filter((y) => y > 2000),
      demandCustomers: customers.map((c) => ({
        id: Number(c.id),
        code: c.code,
        name: c.name,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chuyển Kho › Chuyển Kho
  // ─────────────────────────────────────────────────────────────────────────
  /** Pivot "Dữ Liệu Chuyển Kho 2 Miền": Nhóm hàng › Mã › Tên × Kho. */
  async getChuyenKho(q: MuaHangFilterDto, today: string = todayVn()) {
    const saleFrom = addDays(today, -SALE_WINDOW_START);
    const saleTo = addDays(today, -1);
    const rows = await this.stockRows(
      q,
      { excludeTypes: true, excludeBoduo: true },
      { from: saleFrom, to: saleTo },
    );
    const branches = this.branchCols(q);
    const keys = ['onhand', 'onorder', 'reserved', 'transfer', 'sale'] as const;

    type Cell = Record<(typeof keys)[number], N> & { avgSale: N };
    const withAvg = (m: Record<(typeof keys)[number], N>): Cell => ({
      ...m,
      avgSale: m.sale === null ? null : m.sale / SALE_WINDOW_DAYS,
    });
    const cellsOf = (list: StockRow[]) => {
      const cells: Record<string, Cell> = {};
      for (const b of branches)
        cells[b] = withAvg(
          sumBy(
            list.filter((r) => r.branch === b),
            keys,
          ),
        );
      return { cells, total: withAvg(sumBy(list, keys)) };
    };

    const byProduct = this.groupRows(rows, (r) => r.code);
    const products = [...byProduct.values()]
      .map((list) => ({
        group: list[0].visual_group,
        code: list[0].code,
        name: list[0].name,
        ...cellsOf(list),
      }))
      .filter((p) => hasValue(p.total))
      .sort(
        (a, b) =>
          a.group.localeCompare(b.group, 'vi') || a.code.localeCompare(b.code),
      );
    const groups = [...this.groupRows(rows, (r) => r.visual_group).entries()]
      .map(([group, list]) => ({ group, ...cellsOf(list) }))
      .filter((g) => hasValue(g.total))
      .sort((a, b) => a.group.localeCompare(b.group, 'vi'));

    return {
      asOf: today,
      saleRange: { from: saleFrom, to: saleTo, days: SALE_WINDOW_DAYS },
      branches,
      rows: products,
      groups,
      total: cellsOf(rows),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chuyển Kho › Hàng Loại B
  // ─────────────────────────────────────────────────────────────────────────
  async getHangLoaiB(q: MuaHangFilterDto) {
    const rows = await this.stockRows(q, { excludeTypes: true }, null);
    const branches = this.branchCols(q);
    const cellsOf = (list: StockRow[]) => {
      const pick = (l: StockRow[]) => {
        const s = sumBy(l, ['near_exp', 'damaged', 'promo'] as const);
        return {
          nearExp: zeroBlank(s.near_exp),
          damaged: zeroBlank(s.damaged),
          promo: zeroBlank(s.promo),
        };
      };
      const cells: Record<string, ReturnType<typeof pick>> = {};
      for (const b of branches)
        cells[b] = pick(list.filter((r) => r.branch === b));
      return { cells, total: pick(list) };
    };
    const products = [...this.groupRows(rows, (r) => r.code).values()]
      .map((list) => ({
        code: list[0].code,
        name: list[0].name,
        ...cellsOf(list),
      }))
      .filter((p) => hasValue(p.total))
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      branches,
      rows: products,
      total: cellsOf(rows),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Thu Mua › Tồn Kho (gộp cả trang "Tồn kho" thứ 2: hàng khuyến mãi / cận date)
  // ─────────────────────────────────────────────────────────────────────────
  async getTonKho(q: MuaHangFilterDto) {
    const rows = await this.stockRows(q, { activeOnly: true }, null);
    const branches = this.branchCols(q);
    const keys = ['onhand', 'onorder', 'reserved'] as const;
    const agg = (list: StockRow[]) => sumBy(list, keys);
    const pivot = <T extends Record<string, unknown>>(
      keyOf: (r: StockRow) => string | null,
      extra: (r: StockRow) => T,
    ) =>
      [...this.groupRows(rows, (r) => keyOf(r) ?? MUA_HANG_BLANK).entries()]
        .map(([key, list]) => ({
          key: key === MUA_HANG_BLANK ? null : key,
          ...extra(list[0]),
          ...agg(list),
        }))
        .filter(
          (r) => r.onhand !== null || r.onorder !== null || r.reserved !== null,
        )
        .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '', 'vi'));

    // Bảng chi tiết: dòng = Tên hàng (dim_product[name]), cột = Kho.
    const byName = [...this.groupRows(rows, (r) => r.name).entries()]
      .map(([name, list]) => {
        const cells: Record<string, Record<(typeof keys)[number], N>> = {};
        for (const b of branches)
          cells[b] = agg(list.filter((r) => r.branch === b));
        return { name, cells, total: agg(list) };
      })
      .filter((r) => hasValue(r.total))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    // Trang "Tồn kho" thứ 2: promo_qty / near_exp_qty theo Tên hàng × Kho (BLANK khi = 0).
    const promoCells = (list: StockRow[]) => {
      const s = sumBy(list, ['promo', 'near_exp'] as const);
      return { promo: zeroBlank(s.promo), nearExp: zeroBlank(s.near_exp) };
    };
    const promoByName = [...this.groupRows(rows, (r) => r.name).entries()]
      .map(([name, list]) => {
        const cells: Record<string, ReturnType<typeof promoCells>> = {};
        for (const b of branches)
          cells[b] = promoCells(list.filter((r) => r.branch === b));
        return { name, cells, total: promoCells(list) };
      })
      .filter((r) => hasValue(r.total))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    const totalCells: Record<string, Record<(typeof keys)[number], N>> = {};
    for (const b of branches)
      totalCells[b] = agg(rows.filter((r) => r.branch === b));
    const promoTotal: Record<string, ReturnType<typeof promoCells>> = {};
    for (const b of branches)
      promoTotal[b] = promoCells(rows.filter((r) => r.branch === b));

    return {
      branches,
      detail: { rows: byName, total: { cells: totalCells, total: agg(rows) } },
      byBranch: pivot(
        (r) => r.branch,
        () => ({}),
      ),
      byVisualGroup: pivot(
        (r) => r.visual_group,
        () => ({}),
      ),
      byProductType: pivot(
        (r) => r.product_type,
        () => ({}),
      ),
      byOrigin: pivot(
        (r) =>
          `${r.origin ?? MUA_HANG_BLANK}\u0000${r.category ?? MUA_HANG_BLANK}`,
        (r) => ({ origin: r.origin, category: r.category }),
      ),
      total: agg(rows),
      promo: {
        rows: promoByName,
        total: { cells: promoTotal, total: promoCells(rows) },
      },
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Thu Mua › Nhóm Hàng / Nguồn Hàng
  // ─────────────────────────────────────────────────────────────────────────
  /** Trang Nhóm Hàng: phân theo product_group_lv2. */
  getNhomHang(q: MuaHangSalesQueryDto) {
    return this.salesPage(q, 'group');
  }

  /** Trang Nguồn Hàng: phân theo origin, chỉ Nội địa + Nhập khẩu chính ngạch. */
  getNguonHang(q: MuaHangSalesQueryDto) {
    return this.salesPage(q, 'origin');
  }

  private async salesPage(q: MuaHangSalesQueryDto, by: 'group' | 'origin') {
    const scope: ProductScope = {
      activeOnly: true,
      origins: by === 'origin' ? SOURCE_ORIGINS : undefined,
    };
    const level: MuaHangTrendLevel = q.trendLevel ?? 'month';
    const dim =
      by === 'group' ? Prisma.sql`pf.group_lv2` : Prisma.sql`pf.origin`;
    const ctes = this.salesCtes(q, scope);

    const [lines, trend] = await Promise.all([
      this.prisma.$queryRaw<
        {
          dim: string | null;
          name: string;
          y: number;
          m: number;
          qty: number | null;
          amount: number | null;
        }[]
      >`
        WITH ${ctes},
        a AS (
          SELECT sl.code, date_trunc('month', sl.d) AS mo,
                 SUM(sl.qty)::float8 AS qty, SUM(sl.amount)::float8 AS amount
          FROM sl GROUP BY 1, 2
        )
        -- (mã, tháng) là duy nhất; 2 mã trùng tên được cộng dồn ở bước ghép pivot.
        SELECT ${dim} AS dim, pf.name, extract(year FROM a.mo)::int AS y,
               extract(month FROM a.mo)::int AS m, a.qty, a.amount
        FROM a JOIN pf ON pf.code = a.code`,
      this.prisma.$queryRaw<
        { k: string; series: string | null; qty: number | null }[]
      >`
        WITH ${ctes},
        a AS (
          SELECT sl.code, ${
            level === 'year'
              ? Prisma.sql`extract(year FROM sl.d)::int::text`
              : level === 'month'
                ? Prisma.sql`to_char(sl.d, 'YYYY-MM')`
                : Prisma.sql`to_char(sl.d, 'YYYY-MM-DD')`
          } AS k, SUM(sl.qty)::float8 AS qty
          FROM sl GROUP BY 1, 2
        )
        SELECT a.k, ${by === 'origin' ? Prisma.sql`pf.origin` : Prisma.sql`NULL::text`} AS series,
               SUM(a.qty)::float8 AS qty
        FROM a JOIN pf ON pf.code = a.code
        WHERE lower(pf.brand) = ANY(${TREND_BRANDS.map((b) => b.toLowerCase())}::text[])
        GROUP BY 1, 2 ORDER BY 1`,
    ]);

    // Cột Năm › Tháng của pivot (chỉ các tháng có dữ liệu, như Power BI).
    const periods = [
      ...new Set(lines.map((l) => Number(l.y) * 100 + Number(l.m))),
    ]
      .sort((a, b) => a - b)
      .map((k) => ({
        key: String(k),
        year: Math.floor(k / 100),
        month: k % 100,
      }));

    // Pie: tỷ trọng số lượng bán theo nhóm / nguồn gốc.
    const pieMap = new Map<string | null, N>();
    for (const l of lines)
      pieMap.set(l.dim, addN(pieMap.get(l.dim) ?? null, num(l.qty)));
    const pie = [...pieMap.entries()]
      .map(([key, qty]) => ({ key, qty }))
      .filter((r) => r.qty !== null)
      .sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0));

    // Pivot: nhóm › tên hàng × (năm, tháng): Tổng tiền hàng + Số lượng bán.
    type Cell = { amount: N; qty: N };
    const addCell = (c: Cell | undefined, a: N, qn: N): Cell => ({
      amount: addN(c?.amount ?? null, a),
      qty: addN(c?.qty ?? null, qn),
    });
    const groups = new Map<
      string,
      {
        key: string | null;
        cells: Record<string, Cell>;
        total: Cell;
        items: Map<
          string,
          { name: string; cells: Record<string, Cell>; total: Cell }
        >;
      }
    >();
    const grand: { cells: Record<string, Cell>; total: Cell } = {
      cells: {},
      total: { amount: null, qty: null },
    };
    for (const l of lines) {
      const pk = String(Number(l.y) * 100 + Number(l.m));
      const a = num(l.amount);
      const qn = num(l.qty);
      const gk = l.dim ?? MUA_HANG_BLANK;
      if (!groups.has(gk))
        groups.set(gk, {
          key: l.dim,
          cells: {},
          total: { amount: null, qty: null },
          items: new Map(),
        });
      const g = groups.get(gk)!;
      if (!g.items.has(l.name))
        g.items.set(l.name, {
          name: l.name,
          cells: {},
          total: { amount: null, qty: null },
        });
      const it = g.items.get(l.name)!;
      it.cells[pk] = addCell(it.cells[pk], a, qn);
      it.total = addCell(it.total, a, qn);
      g.cells[pk] = addCell(g.cells[pk], a, qn);
      g.total = addCell(g.total, a, qn);
      grand.cells[pk] = addCell(grand.cells[pk], a, qn);
      grand.total = addCell(grand.total, a, qn);
    }
    const pivot = [...groups.values()]
      .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '', 'vi'))
      .map((g) => ({
        key: g.key,
        cells: g.cells,
        total: g.total,
        items: [...g.items.values()].sort((a, b) =>
          a.name.localeCompare(b.name, 'vi'),
        ),
      }));

    // Area chart: điểm theo cấp trục; Nguồn Hàng có series theo nguồn gốc.
    const seriesKeys = [...new Set(trend.map((t) => t.series))].sort((a, b) =>
      (a ?? '').localeCompare(b ?? '', 'vi'),
    );
    const points = new Map<string, Record<string, N>>();
    for (const t of trend) {
      if (!points.has(t.k)) points.set(t.k, {});
      points.get(t.k)![t.series ?? 'value'] = num(t.qty);
    }

    return {
      by,
      trendLevel: level,
      periods,
      pie,
      pivot,
      total: grand,
      trend: {
        series: seriesKeys.map((s) => s ?? 'value'),
        points: [...points.entries()].map(([k, v]) => ({ key: k, ...v })),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Thu Mua › Đặt Theo Đơn (fact_demand → bảng Demand của POS)
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Power BI lấy fact_demand từ DB sync_kiot_data (bảng "Demand", đồng bộ từ LarkBase).
   * POS có module Demand (customer_demands → months → lines) đồng bộ cùng LarkBase:
   * quantity_base = "Số lượng quy đổi" (converted_quantity), ĐVT = đơn vị cơ bản của hàng.
   * Chỉ tính tháng Demand đã xác nhận (CONFIRMED) như module Demand / planning.
   */
  async getDatTheoDon(q: MuaHangDemandQueryDto) {
    const conds: Prisma.Sql[] = [Prisma.sql`m.status = 'CONFIRMED'`];
    if (q.year)
      conds.push(
        Prisma.sql`extract(year FROM m.demand_month)::int = ${q.year}`,
      );
    if (q.months?.length)
      conds.push(
        Prisma.sql`extract(month FROM m.demand_month)::int = ANY(${q.months}::int[])`,
      );
    if (q.customerIds?.length)
      conds.push(Prisma.sql`cd.customer_id = ANY(${q.customerIds}::int[])`);

    const rows = await this.prisma.$queryRaw<
      {
        code: string;
        name: string;
        unit: string | null;
        y: number;
        m: number;
        qty: number | null;
      }[]
    >`
      WITH ${this.prodCte()}, ${this.pfCte(q, { activeOnly: true })}
      SELECT pf.code, pf.name, pf.unit, extract(year FROM m.demand_month)::int AS y,
             extract(month FROM m.demand_month)::int AS m, SUM(l.quantity_base)::float8 AS qty
      FROM customer_demand_lines l
      JOIN customer_demand_months m ON m.id = l.demand_month_id
      JOIN customer_demands cd ON cd.id = m.demand_id
      JOIN products p ON p.id = l.product_id
      JOIN pf ON pf.code = p.code
      WHERE ${Prisma.join(conds, ' AND ')}
      GROUP BY 1, 2, 3, 4, 5`;

    const periods = [
      ...new Set(rows.map((r) => Number(r.y) * 100 + Number(r.m))),
    ]
      .sort((a, b) => a - b)
      .map((k) => ({
        key: String(k),
        year: Math.floor(k / 100),
        month: k % 100,
      }));
    const items = new Map<
      string,
      {
        code: string;
        name: string;
        unit: string | null;
        cells: Record<string, N>;
        total: N;
      }
    >();
    const total: { cells: Record<string, N>; total: N } = {
      cells: {},
      total: null,
    };
    for (const r of rows) {
      const pk = String(Number(r.y) * 100 + Number(r.m));
      const key = `${r.code}\u0000${r.unit ?? ''}`;
      if (!items.has(key))
        items.set(key, {
          code: r.code,
          name: r.name,
          unit: r.unit,
          cells: {},
          total: null,
        });
      const it = items.get(key)!;
      const v = num(r.qty);
      it.cells[pk] = addN(it.cells[pk] ?? null, v);
      it.total = addN(it.total, v);
      total.cells[pk] = addN(total.cells[pk] ?? null, v);
      total.total = addN(total.total, v);
    }
    return {
      periods,
      rows: [...items.values()].sort((a, b) => a.code.localeCompare(b.code)),
      total,
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SQL
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Power BI (VertiPaq) không phân biệt hoa / thường: "Hàng khuyến mãi" và "Hàng Khuyến Mãi"
   * là 1 giá trị, hiển thị theo cách viết của dòng nạp trước. Gộp tương tự theo id nhỏ nhất.
   */
  private ci(col: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`first_value(${col}) OVER (PARTITION BY lower(${col}) ORDER BY p.id)`;
  }

  /** dim_product của dataset_purchasing (cột tính DAX). */
  prodCte(): Prisma.Sql {
    const t = (s: string) => Prisma.sql`lower(${s})`;
    const type = Prisma.sql`lower(p.parent_name)`;
    const brand = Prisma.sql`lower(tm.name)`;
    const origin = Prisma.sql`lower(p.middle_name)`;
    return Prisma.sql`
      pp AS (
        SELECT p.id, p.code, ${this.ci(Prisma.sql`rtrim(p.name)`)} AS name, p.unit,
          p."isActive" AS is_active,
          ${this.ci(Prisma.sql`p.parent_name`)} AS product_type,
          ${this.ci(Prisma.sql`p.middle_name`)} AS origin,
          ${this.ci(Prisma.sql`p.child_name`)} AS category,
          ${this.ci(Prisma.sql`tm.name`)} AS brand,
          CASE
            WHEN ${type} = ${t('Hàng thương mại')} AND ${brand} = 'boduo' THEN '1.Boduo'
            WHEN ${type} = ${t('Hàng thương hiệu')} AND ${brand} = 'lermao' THEN '4.Lermao'
            WHEN ${type} = ${t('Hàng thương hiệu')} AND ${brand} = ${t('Phượng Hoàng')} THEN '5.Phượng Hoàng'
            WHEN ${type} = ${t('Hàng thương hiệu')} THEN '3.Nhập khẩu'
            WHEN ${type} = ${t('Hàng thương mại')} AND ${brand} = 'western' THEN '6.Sữa tươi'
            WHEN ${type} = ${t('Hàng OEM')} THEN '8.OEM - Khác'
            WHEN ${type} = ${t('Hàng thương mại')}
                 AND ${origin} IN (${t('Nhập khẩu Chính Ngạch')}, ${t('Nhập khẩu khác')}) THEN '3.Nhập khẩu'
            WHEN ${type} = ${t('Hàng thương mại')} AND ${origin} = ${t('Nội địa')} THEN '2.Trong nước'
            ELSE 'Khác'
          END AS visual_group,
          CASE
            WHEN ${type} = ${t('Dụng cụ pha chế')} THEN 'Dụng Cụ Pha Chế'
            WHEN ${type} = ${t('Mẫu thử')} THEN 'Mẫu Thử'
            WHEN ${brand} = ${t('Phượng Hoàng')} THEN 'Trà Phượng Hoàng'
            WHEN ${brand} = 'lermao' THEN 'Lermao'
            WHEN ${brand} = 'amo pastel' THEN 'Amo Pastel'
            WHEN ${brand} = 'bodou' THEN 'Bodou'
            WHEN ${brand} = 'teatrealife' THEN 'TTL'
            WHEN ${brand} = 'te' THEN 'TE'
            WHEN ${brand} = 'sensini' THEN 'Sensini'
            WHEN ${brand} = 'binbaoli' THEN 'Binbaoli'
            WHEN ${type} = ${t('Hàng OEM')} THEN 'OEM Khác'
            WHEN ${origin} = ${t('Nhập khẩu chính ngạch')} THEN 'Nhập Khẩu Chính Ngạch'
            WHEN ${origin} = ${t('Nhập khẩu khác')} THEN 'Nhập Khẩu Khác'
            WHEN ${origin} = ${t('Nội địa')} THEN 'Trong Nước'
            ELSE 'Chưa phân loại'
          END AS group_lv2,
          COALESCE(g.group_name, CASE
            WHEN p."createdAt" + interval '7 hour' > timestamp '2025-12-01'
                 AND ${type} = ${t('Hàng thương hiệu')} THEN 'Nhóm C'
            WHEN p."createdAt" + interval '7 hour' > timestamp '2025-12-01'
                 AND ${type} IN (${t('Hàng thương mại')}, ${t('Hàng OEM')}) THEN 'Nhóm B'
            ELSE 'Chưa Phân Loại' END) AS group2026
        FROM products p
        LEFT JOIN trade_marks tm ON tm.id = p."tradeMarkId"
        LEFT JOIN analytics_product_groups g ON g.product_code = p.code
      )`;
  }

  /** pf: sản phẩm sau filter trang + slicer (alias pr trong điều kiện). */
  pfCte(q: MuaHangFilterDto, scope: ProductScope): Prisma.Sql {
    const conds: Prisma.Sql[] = [];
    if (scope.activeOnly) conds.push(Prisma.sql`pr.is_active`);
    if (scope.excludeTypes)
      conds.push(Prisma.sql`pr.product_type IS NOT NULL
        AND lower(pr.product_type) <> ALL(${CK_EXCLUDED_TYPES.map((s) => s.toLowerCase())}::text[])`);
    if (scope.excludeBoduo)
      conds.push(Prisma.sql`lower(COALESCE(pr.brand, '')) <> 'boduo'`);
    if (scope.origins)
      conds.push(
        Prisma.sql`lower(pr.origin) = ANY(${scope.origins.map((s) => s.toLowerCase())}::text[])`,
      );
    const add = (col: Prisma.Sql, values?: string[]) => {
      const c = this.inList(col, values);
      if (c) conds.push(c);
    };
    add(Prisma.sql`pr.product_type`, q.productTypes);
    add(Prisma.sql`pr.brand`, q.brands);
    add(Prisma.sql`pr.visual_group`, q.visualGroups);
    add(Prisma.sql`pr.group2026`, q.groups2026);
    add(Prisma.sql`pr.category`, q.categories);
    add(Prisma.sql`pr.code`, q.productCodes);
    // MATERIALIZED: tránh planner ước lượng sai số dòng khi lọc theo cột tính (CASE) rồi
    // chọn nested loop trên invoice_details (chậm > 5 giây).
    return Prisma.sql`
      pf AS MATERIALIZED (
        SELECT * FROM pp pr
        ${conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty}
      )`;
  }

  /** col IN (values) — giá trị MUA_HANG_BLANK = ô trống (NULL). */
  private inList(col: Prisma.Sql, values?: string[]): Prisma.Sql | null {
    if (!values?.length) return null;
    const vals = values.filter((v) => v !== MUA_HANG_BLANK);
    const parts: Prisma.Sql[] = [];
    if (vals.length) parts.push(Prisma.sql`${col} = ANY(${vals}::text[])`);
    if (vals.length !== values.length) parts.push(Prisma.sql`${col} IS NULL`);
    return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  }

  /** Cột kho của pivot: 2 kho chính, giao với slicer dim_branch. */
  private branchCols(q: MuaHangFilterDto): string[] {
    return q.branches?.length
      ? MUA_HANG_WAREHOUSES.filter((b) => q.branches!.includes(b))
      : MUA_HANG_WAREHOUSES;
  }

  /**
   * Số tồn kho theo (mã hàng, kho) cho 2 kho chính: tồn / đặt NCC / hư / cận date /
   * khuyến mãi (inventories), khách đặt (orders), hàng trên đường (transfers) và
   * — nếu có sale — số bán trong khoảng ngày (invoice_details, mã đã gộp).
   * Mỗi số NULL khi không có dòng nguồn (BLANK của DAX).
   */
  private async stockRows(
    q: MuaHangFilterDto,
    scope: ProductScope,
    sale: { from: string; to: string } | null,
  ): Promise<StockRow[]> {
    const branches = this.branchCols(q);
    if (!branches.length) return [];
    const saleSql = sale
      ? Prisma.sql`
        UNION ALL
        SELECT COALESCE(cm.to_code, p.code), b.name, NULL, NULL, NULL, NULL,
               d.quantity::float8, NULL, NULL, NULL
        FROM invoice_details d
        JOIN invoices i ON i.id = d."invoiceId"
        LEFT JOIN products p ON p.id = d."productId"
        LEFT JOIN analytics_product_code_merges cm ON cm.from_code = p.code
        JOIN br b ON b.id = i."branchId"
        WHERE i.status <> 2
          AND i."purchaseDate" >= (${sale.from}::date - interval '7 hour')
          AND i."purchaseDate" < (${sale.to}::date + 1 - interval '7 hour')`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<StockRow[]>`
      WITH ${this.prodCte()}, ${this.pfCte(q, scope)},
      br AS (SELECT id, name FROM branches WHERE name = ANY(${branches}::text[])),
      m(code, branch, onhand, onorder, reserved, transfer, sale, damaged, near_exp, promo) AS (
        SELECT p.code, b.name, i."onHand"::float8, i."onOrder"::float8, NULL::float8, NULL::float8,
               NULL::float8, i."damagedQuantity"::float8, i."nearExpiryQuantity"::float8, i."promoQuantity"::float8
        FROM inventories i
        JOIN products p ON p.id = i."productId"
        JOIN br b ON b.id = i."branchId"
        UNION ALL
        SELECT oi."productCode", b.name, NULL, NULL, oi.quantity::float8, NULL, NULL, NULL, NULL, NULL
        FROM orders o
        JOIN order_items oi ON oi."orderId" = o.id
        JOIN br b ON b.id = o."branchId"
        WHERE o.status = ANY(${RESERVED_ORDER_STATUSES}::int[])
          AND o."branchId" = ANY(${RESERVED_BRANCH_IDS}::int[])
        UNION ALL
        SELECT td."productCode", b.name, NULL, NULL, NULL, td."sendQuantity"::float8, NULL, NULL, NULL, NULL
        FROM transfer_details td
        JOIN transfers t ON t.id = td."transferId"
        JOIN br b ON b.id = t."toBranchId"
        WHERE t.status = ${TRANSFER_IN_TRANSIT}
        ${saleSql}
      )
      SELECT pf.code, pf.name, pf.visual_group, pf.product_type, pf.origin, pf.category, m.branch,
             SUM(m.onhand)::float8 AS onhand, SUM(m.onorder)::float8 AS onorder,
             SUM(m.reserved)::float8 AS reserved, SUM(m.transfer)::float8 AS transfer,
             SUM(m.sale)::float8 AS sale, SUM(m.damaged)::float8 AS damaged,
             SUM(m.near_exp)::float8 AS near_exp, SUM(m.promo)::float8 AS promo
      FROM m JOIN pf ON pf.code = m.code
      GROUP BY pf.code, pf.name, pf.visual_group, pf.product_type, pf.origin, pf.category, m.branch`;

    const keys: StockKey[] = [
      'onhand',
      'onorder',
      'reserved',
      'transfer',
      'sale',
      'damaged',
      'near_exp',
      'promo',
    ];
    return rows.map((r) => {
      const out = { ...r };
      for (const k of keys) out[k] = num(r[k]);
      return out;
    });
  }

  /** CTE pp, pf, sl: dòng bán (fact_invoice_item) đã gộp mã + lọc kỳ / kho / nhân viên. */
  private salesCtes(q: MuaHangPeriodQueryDto, scope: ProductScope): Prisma.Sql {
    const conds: Prisma.Sql[] = [
      Prisma.sql`i.status <> 2`,
      Prisma.sql`NOT EXISTS (SELECT 1 FROM analytics_purchase_excluded_sellers e WHERE e.user_id = i."soldById")`,
    ];
    if (q.year) {
      const from = `${q.year}-01-01`;
      const to = `${q.year + 1}-01-01`;
      conds.push(Prisma.sql`i."purchaseDate" >= (${from}::date - interval '7 hour')
        AND i."purchaseDate" < (${to}::date - interval '7 hour')`);
    }
    if (q.months?.length)
      conds.push(
        Prisma.sql`extract(month FROM (i."purchaseDate" + interval '7 hour'))::int = ANY(${q.months}::int[])`,
      );
    const branchJoin = q.branches?.length
      ? Prisma.sql`JOIN branches b ON b.id = i."branchId" AND b.name = ANY(${q.branches}::text[])`
      : Prisma.empty;
    return Prisma.sql`
      ${this.prodCte()}, ${this.pfCte(q, scope)},
      sl AS (
        SELECT COALESCE(cm.to_code, p.code) AS code,
               (i."purchaseDate" + interval '7 hour')::date AS d,
               d.quantity::float8 AS qty,
               (d.quantity * (d.price - d.discount))::float8 AS amount
        FROM invoice_details d
        JOIN invoices i ON i.id = d."invoiceId"
        ${branchJoin}
        LEFT JOIN products p ON p.id = d."productId"
        LEFT JOIN analytics_product_code_merges cm ON cm.from_code = p.code
        WHERE ${Prisma.join(conds, ' AND ')}
      )`;
  }

  private groupRows<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: gộp mã hàng
  // ─────────────────────────────────────────────────────────────────────────
  listCodeMerges(q: MuaHangConfigListQueryDto) {
    const term = q.search?.trim() ? `%${q.search.trim()}%` : null;
    return this.prisma.$queryRaw<
      {
        id: number;
        fromCode: string;
        fromName: string | null;
        toCode: string;
        toName: string | null;
        note: string | null;
      }[]
    >`
      SELECT m.id, m.from_code AS "fromCode", pf.name AS "fromName", m.to_code AS "toCode",
             pt.name AS "toName", m.note
      FROM analytics_product_code_merges m
      LEFT JOIN products pf ON pf.code = m.from_code
      LEFT JOIN products pt ON pt.code = m.to_code
      WHERE ${term}::text IS NULL OR m.from_code ILIKE ${term} OR m.to_code ILIKE ${term}
         OR pf.name ILIKE ${term} OR pt.name ILIKE ${term} OR m.note ILIKE ${term}
      ORDER BY m.from_code`;
  }

  async createCodeMerge(dto: MuaHangCodeMergeDto) {
    const from = dto.fromCode.trim();
    const to = dto.toCode.trim();
    if (from === to) throw new BadRequestException('Mã gộp phải khác mã chính');
    const dup = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM analytics_product_code_merges WHERE from_code = ${from}`;
    if (dup.length)
      throw new BadRequestException(`Mã ${from} đã có trong bảng gộp mã`);
    await this.prisma.$executeRaw`
      INSERT INTO analytics_product_code_merges (from_code, to_code, note)
      VALUES (${from}, ${to}, ${dto.note?.trim() || null})`;
    return { success: true };
  }

  async updateCodeMerge(id: number, dto: MuaHangCodeMergeUpdateDto) {
    await this.ensureRow('analytics_product_code_merges', id);
    const sets: Prisma.Sql[] = [];
    if (dto.toCode !== undefined)
      sets.push(Prisma.sql`to_code = ${dto.toCode.trim()}`);
    if (dto.note !== undefined)
      sets.push(Prisma.sql`note = ${dto.note?.trim() || null}`);
    if (sets.length)
      await this.prisma.$executeRaw`
        UPDATE analytics_product_code_merges SET ${Prisma.join(sets)}, updated_at = now() WHERE id = ${id}`;
    return { success: true };
  }

  async deleteCodeMerge(id: number) {
    await this.ensureRow('analytics_product_code_merges', id);
    await this.prisma
      .$executeRaw`DELETE FROM analytics_product_code_merges WHERE id = ${id}`;
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: nhân viên loại khỏi số bán Thu Mua
  // ─────────────────────────────────────────────────────────────────────────
  async listExcludedSellers() {
    const users = await this.prisma.$queryRaw<
      {
        id: number;
        name: string;
        email: string | null;
        isActive: boolean;
        excluded: boolean;
        rowId: number | null;
      }[]
    >`
      SELECT u.id, u.name, u.email, u."isActive" AS "isActive",
             (e.id IS NOT NULL) AS excluded, e.id AS "rowId"
      FROM users u LEFT JOIN analytics_purchase_excluded_sellers e ON e.user_id = u.id
      ORDER BY (e.id IS NULL), u.name`;
    return users.map((u) => ({
      ...u,
      id: Number(u.id),
      rowId: u.rowId === null ? null : Number(u.rowId),
    }));
  }

  async addExcludedSeller(userId: number) {
    const u = await this.prisma.$queryRaw<
      { id: number }[]
    >`SELECT id FROM users WHERE id = ${userId}`;
    if (!u.length) throw new NotFoundException('Không tìm thấy nhân viên');
    await this.prisma.$executeRaw`
      INSERT INTO analytics_purchase_excluded_sellers (user_id) VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING`;
    return { success: true };
  }

  async removeExcludedSeller(userId: number) {
    await this.prisma.$executeRaw`
      DELETE FROM analytics_purchase_excluded_sellers WHERE user_id = ${userId}`;
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: thông số mua hàng theo mã (dim_manufactory, tồn tối thiểu, quy cách thùng, danh mục R&D)
  // ─────────────────────────────────────────────────────────────────────────
  async listPurchaseProducts(q: MuaHangConfigListQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const term = q.search?.trim() ? `%${q.search.trim()}%` : null;
    const where = Prisma.sql`${term}::text IS NULL OR a.product_code ILIKE ${term} OR p.name ILIKE ${term}
      OR a.manufactory ILIKE ${term} OR a.sub_cate_lv1 ILIKE ${term} OR a.supply_type ILIKE ${term}`;
    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT a.id, a.product_code AS "productCode", p.name AS "productName", a.manufactory, a.spec,
               a.supply_type AS "supplyType", a.min_order_box AS "minOrderBox", a.min_stock_hn AS "minStockHn",
               a.min_stock_sg AS "minStockSg", a.pack_detail AS "packDetail",
               a.convert_quantity AS "convertQuantity", a.sub_cate_lv1 AS "subCateLv1", a.sub_cate_lv2 AS "subCateLv2"
        FROM analytics_purchase_products a
        LEFT JOIN products p ON p.code = a.product_code
        WHERE ${where}
        ORDER BY a.product_code
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM analytics_purchase_products a
        LEFT JOIN products p ON p.code = a.product_code WHERE ${where}`,
    ]);
    return { data: rows, total: Number(count[0]?.n ?? 0), page, limit };
  }

  async createPurchaseProduct(dto: MuaHangPurchaseProductDto) {
    const code = dto.productCode.trim();
    const dup = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM analytics_purchase_products WHERE product_code = ${code}`;
    if (dup.length) throw new BadRequestException(`Mã ${code} đã có`);
    await this.prisma.$executeRaw`
      INSERT INTO analytics_purchase_products (product_code) VALUES (${code})`;
    const id = (
      await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM analytics_purchase_products WHERE product_code = ${code}`
    )[0].id;
    return this.updatePurchaseProduct(Number(id), dto);
  }

  async updatePurchaseProduct(
    id: number,
    dto: MuaHangPurchaseProductUpdateDto,
  ) {
    await this.ensureRow('analytics_purchase_products', id);
    const textCols: [keyof MuaHangPurchaseProductUpdateDto, string][] = [
      ['manufactory', 'manufactory'],
      ['spec', 'spec'],
      ['supplyType', 'supply_type'],
      ['packDetail', 'pack_detail'],
      ['subCateLv1', 'sub_cate_lv1'],
      ['subCateLv2', 'sub_cate_lv2'],
    ];
    const intCols: [keyof MuaHangPurchaseProductUpdateDto, string][] = [
      ['minOrderBox', 'min_order_box'],
      ['minStockHn', 'min_stock_hn'],
      ['minStockSg', 'min_stock_sg'],
      ['convertQuantity', 'convert_quantity'],
    ];
    const sets: Prisma.Sql[] = [];
    for (const [k, col] of textCols) {
      const v = dto[k];
      if (v !== undefined)
        sets.push(
          Prisma.sql`${Prisma.raw(col)} = ${typeof v === 'string' ? v.trim() || null : null}`,
        );
    }
    for (const [k, col] of intCols) {
      const v = dto[k];
      if (v !== undefined)
        sets.push(
          Prisma.sql`${Prisma.raw(col)} = ${txt(v as number | null)}::text::int`,
        );
    }
    if (sets.length)
      await this.prisma.$executeRaw`
        UPDATE analytics_purchase_products SET ${Prisma.join(sets)}, updated_at = now() WHERE id = ${id}`;
    return { success: true };
  }

  async deletePurchaseProduct(id: number) {
    await this.ensureRow('analytics_purchase_products', id);
    await this.prisma
      .$executeRaw`DELETE FROM analytics_purchase_products WHERE id = ${id}`;
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình: rebate nhà máy
  // ─────────────────────────────────────────────────────────────────────────
  listRebates(q: MuaHangConfigListQueryDto) {
    const term = q.search?.trim() ? `%${q.search.trim()}%` : null;
    return this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT id, apply_year AS "applyYear", manufactory, rebate_name AS "rebateName",
             target_cny AS "targetCny", target_vnd AS "targetVnd", rebate_type AS "rebateType",
             main_value AS "mainValue", sub_value AS "subValue"
      FROM analytics_purchase_rebates
      WHERE ${term}::text IS NULL OR manufactory ILIKE ${term} OR rebate_name ILIKE ${term}
      ORDER BY apply_year DESC, manufactory, id`;
  }

  async createRebate(dto: MuaHangRebateDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_purchase_rebates
        (apply_year, manufactory, rebate_name, target_cny, target_vnd, rebate_type, main_value, sub_value)
      VALUES (${dto.applyYear}, ${dto.manufactory.trim()}, ${dto.rebateName.trim()},
              ${txt(dto.targetCny)}::text::float8, ${txt(dto.targetVnd)}::text::float8,
              ${dto.rebateType ?? 'percent'}, ${txt(dto.mainValue)}::text::float8,
              ${txt(dto.subValue)}::text::float8)`;
    return { success: true };
  }

  async updateRebate(id: number, dto: MuaHangRebateUpdateDto) {
    await this.ensureRow('analytics_purchase_rebates', id);
    const sets: Prisma.Sql[] = [];
    if (dto.applyYear !== undefined)
      sets.push(Prisma.sql`apply_year = ${dto.applyYear}`);
    if (dto.manufactory !== undefined)
      sets.push(Prisma.sql`manufactory = ${dto.manufactory.trim()}`);
    if (dto.rebateName !== undefined)
      sets.push(Prisma.sql`rebate_name = ${dto.rebateName.trim()}`);
    if (dto.rebateType !== undefined)
      sets.push(Prisma.sql`rebate_type = ${dto.rebateType}`);
    const floats: [keyof MuaHangRebateUpdateDto, string][] = [
      ['targetCny', 'target_cny'],
      ['targetVnd', 'target_vnd'],
      ['mainValue', 'main_value'],
      ['subValue', 'sub_value'],
    ];
    for (const [k, col] of floats) {
      const v = dto[k];
      if (v !== undefined)
        sets.push(
          Prisma.sql`${Prisma.raw(col)} = ${txt(v as number | null)}::text::float8`,
        );
    }
    if (sets.length)
      await this.prisma.$executeRaw`
        UPDATE analytics_purchase_rebates SET ${Prisma.join(sets)}, updated_at = now() WHERE id = ${id}`;
    return { success: true };
  }

  async deleteRebate(id: number) {
    await this.ensureRow('analytics_purchase_rebates', id);
    await this.prisma
      .$executeRaw`DELETE FROM analytics_purchase_rebates WHERE id = ${id}`;
    return { success: true };
  }

  private async ensureRow(table: string, id: number) {
    const r = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}`;
    if (!r.length) throw new NotFoundException('Không tìm thấy dòng cấu hình');
  }
}
