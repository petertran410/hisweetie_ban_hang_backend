import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsAxis, AnalyticsBusinessQueryDto } from './dto';
import {
  CALENDAR_START,
  CurrentPeriod,
  IsoDate,
  compareWindow,
  currentPeriod,
  daxDate,
  isoWeekday,
  listDates,
  parts,
  sameYearRange,
  shiftYear,
  todayVn,
} from './analytics/analytics-period';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo "Phân tích" — thay Power BI (dataset_sale, report "Báo Cáo Kinh
// Doanh" › Tổng Quan). Cách tính chép đúng Power BI:
//   • Hoá đơn status <> 2 (giữ cả status 8 "đã trả"), KHÔNG trừ đơn trả hàng.
//   • Ngày = (purchaseDate + 7 giờ)::date, chỉ tính tới hôm nay (dim_date).
//   • Chỉ tính hoá đơn của nhân viên thuộc team sale (analytics_sale_teams.is_sale).
//   • Gộp hoá đơn cũ data_lake.invoice / invoice_detail (người bán cũ ghi bằng
//     mã KiotViet → nối users.kiot_viet_id).
//   • Doanh số / số đơn / số khách cấp hoá đơn; khi lọc theo sản phẩm hoặc
//     biểu đồ có trục sản phẩm → dùng số cấp dòng hàng (switch_dynamics_metrics).
// ═══════════════════════════════════════════════════════════════════════════

/** Nhóm khách Power BI loại khỏi bộ lọc "Nhóm khách" (dim_customer_group). */
const EXCLUDED_CUSTOMER_GROUP_IDS = [
  14, 20, 7, 4, 15, 31, 5, 17, 18, 19, 13, 21, 6,
];
const VIP_GROUP_NAME = 'Khách VIP Cty';
const CUSTOMER_TYPE_GROUPS = ['Khách chuỗi', 'Khách lẻ', 'Khách buôn'];
/** Giá trị đại diện cho "trống" khi đếm khách (DISTINCTCOUNT của DAX tính BLANK là 1 giá trị). */
const BLANK_KEY = '__blank__';

export const VISUAL_PRODUCT_GROUPS = [
  '1.Boduo',
  '2.Trong nước',
  '3.Nhập khẩu',
  '4.Lermao',
  '5.Phượng Hoàng',
  '6.Sữa tươi',
  '8.OEM - Khác',
  'Khác',
];

export interface MetricValues {
  amount: number; // Doanh số
  orders: number; // Số hoá đơn
  customers: number; // Số khách
  quantity: number; // Sản lượng
}
export interface MetricRow extends MetricValues {
  key: string | null;
}

export type Dim =
  | 'total'
  | 'year'
  | 'period'
  | 'vip'
  | 'ctype'
  | 'ptype'
  | 'brand'
  | 'category';
export type InvAgg = { amount: number; orders: number; customers: number };
export type LineAgg = InvAgg & { quantity: number };

export interface CardValue {
  current: number | null;
  previous: number | null;
  growth: number | null; // (hiện tại - kỳ trước) / kỳ trước; null nếu kỳ trước = 0
}

/**
 * Service Phân tích › Kinh Doanh › Tổng Quan, đồng thời là BỘ TÍNH TOÁN DÙNG CHUNG
 * cho các báo cáo Phân tích khác (inject AnalyticsReportsService rồi gọi):
 *   - baseCtes(q, dateCond): CTE cust, prod, seller, invx (hoá đơn đã lọc), line (dòng hàng đã lọc)
 *   - custCte(scope) / prodCte(): bảng khách (khách cha, loại khách, VIP, vùng) / sản phẩm
 *   - invMetrics() / lineMetrics(): công thức Revenue / Orders / Active Customer / Quantity của Power BI
 *   - periodCond / axisExpr / sameYearRanges / rangeSql: kỳ hiện tại, trục thời gian, kỳ so sánh
 * KHÔNG đổi chữ ký các hàm này khi làm báo cáo khác — viết CTE riêng nối thêm nếu cần.
 */
@Injectable()
export class AnalyticsReportsService {
  private hasDataLake?: boolean;

  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Kinh Doanh › Tổng Quan
  // ─────────────────────────────────────────────────────────────────────────
  async getBusinessOverview(q: AnalyticsBusinessQueryDto) {
    const axis: AnalyticsAxis = q.axis ?? 'month';
    const today = todayVn();
    const period = currentPeriod(
      { year: q.year, months: q.months ?? [] },
      today,
    );
    const productFilter = !!(q.productGroup || q.visualProductGroup);
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
    const curDate = this.periodCond(period);
    const cmpDate = Prisma.sql`x.d BETWEEN ${cmp.from}::date AND ${cmp.to}::date`;
    const sameYear = this.sameYearRanges(period, q.year, axis);

    const axisExpr = this.axisExpr(axis);
    const [invCur, lineCur, invCmp, lineCmp, invSy, lineSy] = await Promise.all(
      [
        this.invoiceAgg(q, curDate, axisExpr),
        this.lineAgg(q, curDate, axisExpr),
        this.invoiceTotal(q, cmpDate),
        this.lineTotal(q, cmpDate),
        this.invoiceByRanges(q, sameYear),
        this.lineByRanges(q, sameYear),
      ],
    );

    // Ghép số cấp hoá đơn + cấp dòng cho từng biểu đồ.
    const merged = (dim: Dim): MetricRow[] => {
      const inv = invCur.get(dim) ?? new Map<string | null, InvAgg>();
      const line = lineCur.get(dim) ?? new Map<string | null, LineAgg>();
      const keys = new Set<string | null>([...inv.keys(), ...line.keys()]);
      const productDim =
        dim === 'ptype' || dim === 'brand' || dim === 'category';
      return [...keys].map((key) =>
        this.pick(
          inv.get(key),
          line.get(key),
          productFilter || productDim,
          key,
        ),
      );
    };
    const total =
      merged('total')[0] ??
      this.pick(undefined, undefined, productFilter, null);

    // Thẻ: Doanh số theo switch_revenue; AOV/ARPC luôn cấp hoá đơn.
    const invTotalCur = invCur.get('total')?.get(null);
    const lineTotalCur = lineCur.get('total')?.get(null);
    const revCur = productFilter
      ? (lineTotalCur?.amount ?? 0)
      : (invTotalCur?.amount ?? 0);
    const revCmp = productFilter ? lineCmp.amount : invCmp.amount;
    const cards = {
      revenue: this.card(revCur, revCmp),
      quantity: this.card(lineTotalCur?.quantity ?? 0, lineCmp.quantity),
      aov: this.card(
        this.div(invTotalCur?.amount ?? 0, invTotalCur?.orders ?? 0),
        this.div(invCmp.amount, invCmp.orders),
      ),
      arpc: this.card(
        this.div(invTotalCur?.amount ?? 0, invTotalCur?.customers ?? 0),
        this.div(invCmp.amount, invCmp.customers),
      ),
    };

    // Biểu đồ theo kỳ + "năm trước" theo từng điểm trục.
    const periodRows = merged('period');
    const prevByKey = new Map<string, MetricRow>();
    for (const key of new Set([...invSy.keys(), ...lineSy.keys()])) {
      prevByKey.set(
        key,
        this.pick(invSy.get(key), lineSy.get(key), productFilter, key),
      );
    }
    const axisKeys = this.axisKeys(period, q.year, axis);
    const byPeriod = axisKeys.map((k) => {
      const cur = periodRows.find((r) => r.key === k);
      return {
        key: k,
        label: this.axisLabel(axis, Number(k)),
        current: cur ?? { ...this.zero(), key: k },
        previous: prevByKey.get(k) ?? { ...this.zero(), key: k },
      };
    });

    return {
      period: {
        from: period.min,
        to: period.max,
        months: period.months,
        year: q.year,
      },
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      productFilter,
      axis,
      updatedAt,
      cards,
      charts: {
        total,
        byYear: merged('year').sort((a, b) => Number(a.key) - Number(b.key)),
        byPeriod,
        byVipCustomer: merged('vip').filter((r) => r.key !== null),
        byCustomerType: merged('ctype'),
        byProductType: merged('ptype'),
        byBrand: merged('brand'),
        byCategory: merged('category'),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Danh sách cho bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  async getFilterOptions() {
    const lake = await this.dataLakeReady(); // phải chạy trước custCte()
    const thisYear = parts(todayVn()).y;
    const years: number[] = [];
    for (let y = parts(CALENDAR_START).y; y <= thisYear; y++) years.push(y);

    const [teams, groups, productGroups, vipParents, regions] =
      await Promise.all([
        this.prisma.analyticsSaleTeam.findMany({
          where: { isSale: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true },
        }),
        this.prisma.$queryRaw<{ id: number; name: string }[]>`
        SELECT id, name FROM customer_groups
        WHERE id <> ALL(${EXCLUDED_CUSTOMER_GROUP_IDS}::int[])
        ORDER BY name`,
        this.prisma.$queryRaw<{ name: string }[]>`
        SELECT DISTINCT group_name AS name FROM analytics_product_groups
        UNION SELECT unnest(ARRAY['Nhóm B','Nhóm C','Chưa Phân Loại'])
        ORDER BY 1`,
        this.prisma.$queryRaw<{ name: string }[]>`
        WITH ${this.custCte(Prisma.sql`c.id IN (SELECT "customerId" FROM vip)`)}
        SELECT DISTINCT parent_name AS name FROM cust WHERE parent_name IS NOT NULL ORDER BY 1`,
        lake
          ? this.prisma.$queryRaw<{ name: string }[]>`
            SELECT DISTINCT region AS name FROM data_lake.new_province WHERE region IS NOT NULL ORDER BY 1`
          : Promise.resolve([] as { name: string }[]),
      ]);

    return {
      years,
      saleTeams: teams,
      customerGroups: groups,
      productGroups: productGroups.map((r) => r.name),
      visualProductGroups: VISUAL_PRODUCT_GROUPS,
      vipParents: vipParents.map((r) => r.name),
      regions: regions.map((r) => r.name),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SQL
  // ─────────────────────────────────────────────────────────────────────────
  async dataLakeReady(): Promise<boolean> {
    if (this.hasDataLake === undefined) {
      const r = await this.prisma.$queryRaw<{ ok: boolean }[]>`
        SELECT to_regclass('data_lake.invoice') IS NOT NULL
           AND to_regclass('data_lake.invoice_detail') IS NOT NULL
           AND to_regclass('data_lake.new_province') IS NOT NULL AS ok`;
      this.hasDataLake = !!r[0]?.ok;
    }
    return this.hasDataLake;
  }

  /**
   * Khách: khách cha (quy tắc), loại khách, VIP, vùng — tương đương dim_customers.
   * scope: điều kiện trên customers c để chỉ tính những khách cần (bảng địa chỉ
   * không có index theo khách nên lấy địa chỉ mới nhất của mọi khách một lần).
   */
  custCte(scope: Prisma.Sql): Prisma.Sql {
    const region = this.hasDataLake
      ? Prisma.sql`(SELECT p.region FROM data_lake.new_province p
                    WHERE lower(p.name) = lower(COALESCE(na."newCityName", oa."cityName")) LIMIT 1)`
      : Prisma.sql`NULL::text`;
    return Prisma.sql`
      rules AS (
        SELECT id, match_type, lower(pattern) AS pat, parent_name, priority
        FROM analytics_customer_parent_rules WHERE is_active
      ),
      addr_new AS (
        SELECT DISTINCT ON ("customerId") "customerId", "newCityName"
        FROM customer_addresses WHERE "newCityCode" IS NOT NULL
        ORDER BY "customerId", "updatedAt" DESC, id DESC
      ),
      addr_old AS (
        SELECT DISTINCT ON ("customerId") "customerId", "cityName"
        FROM customer_addresses
        ORDER BY "customerId", "updatedAt" DESC, id DESC
      ),
      ctype AS (
        SELECT DISTINCT ON (g."customerId") g."customerId", cg.name
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (${Prisma.join(CUSTOMER_TYPE_GROUPS)})
        ORDER BY g."customerId", cg.name
      ),
      vip AS (
        SELECT DISTINCT g."customerId"
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name = ${VIP_GROUP_NAME}
      ),
      cust_base AS (
        SELECT DISTINCT ON (c.code) c.id, c.code, c.name
        FROM customers c WHERE ${scope}
        ORDER BY c.code, c.id
      ),
      cust AS (
        SELECT cb.id, cb.code,
          COALESCE((
            SELECT r.parent_name FROM rules r
            WHERE (r.match_type = 'code' AND lower(cb.code) = r.pat)
               OR (r.match_type = 'name_contains' AND strpos(lower(cb.name), r.pat) > 0)
            ORDER BY r.priority, r.id LIMIT 1
          ), cb.name) AS parent_name,
          ct.name AS customer_type,
          (v."customerId" IS NOT NULL) AS is_vip,
          ${region} AS region
        FROM cust_base cb
        LEFT JOIN addr_new na ON na."customerId" = cb.id
        LEFT JOIN addr_old oa ON oa."customerId" = cb.id
        LEFT JOIN ctype ct ON ct."customerId" = cb.id
        LEFT JOIN vip v ON v."customerId" = cb.id
      )`;
  }

  /** Sản phẩm: ngành hàng, thương hiệu, danh mục, nhóm hiển thị, nhóm 2026 — dim_product. */
  prodCte(): Prisma.Sql {
    return Prisma.sql`
      prod AS (
        SELECT DISTINCT ON (p.code)
          p.code,
          p.parent_name AS product_type,
          p.child_name AS category,
          tm.name AS brand,
          COALESCE(g.group_name, CASE
            WHEN (p."createdAt" + interval '7 hour')::date > date '2025-12-01'
                 AND lower(p.parent_name) = lower('Hàng thương hiệu') THEN 'Nhóm C'
            WHEN (p."createdAt" + interval '7 hour')::date > date '2025-12-01'
                 AND lower(p.parent_name) IN (lower('Hàng thương mại'), lower('Hàng OEM')) THEN 'Nhóm B'
            ELSE 'Chưa Phân Loại' END) AS group2026,
          CASE
            WHEN lower(p.parent_name) = lower('Hàng thương mại') AND lower(tm.name) = 'boduo' THEN '1.Boduo'
            WHEN strpos(lower(p.name), 'boduo') > 0 THEN '1.Boduo'
            WHEN lower(p.parent_name) = lower('Hàng thương hiệu') AND lower(tm.name) = 'lermao' THEN '4.Lermao'
            WHEN lower(p.parent_name) = lower('Hàng thương hiệu') AND lower(tm.name) = lower('Phượng Hoàng') THEN '5.Phượng Hoàng'
            WHEN lower(p.parent_name) = lower('Hàng thương hiệu') THEN '3.Nhập khẩu'
            WHEN lower(p.parent_name) = lower('Hàng thương mại') AND lower(tm.name) = 'western' THEN '6.Sữa tươi'
            WHEN lower(p.parent_name) = lower('Hàng OEM') THEN '8.OEM - Khác'
            WHEN lower(p.parent_name) = lower('Hàng thương mại')
                 AND lower(p.middle_name) IN (lower('Nhập khẩu Chính Ngạch'), lower('Nhập khẩu khác')) THEN '3.Nhập khẩu'
            WHEN lower(p.parent_name) = lower('Hàng thương mại') AND lower(p.middle_name) = lower('Nội địa') THEN '2.Trong nước'
            ELSE 'Khác'
          END AS visual_group
        FROM products p
        LEFT JOIN trade_marks tm ON tm.id = p."tradeMarkId"
        LEFT JOIN analytics_product_groups g ON g.product_code = p.code
        ORDER BY p.code, p.id
      )`;
  }

  /**
   * CTE chung: cust, prod, seller, invx (hoá đơn đã lọc) và line (dòng hàng đã lọc).
   * dateCond dùng alias x.d (ngày VN của hoá đơn).
   */
  async baseCtes(
    q: AnalyticsBusinessQueryDto,
    dateCond: Prisma.Sql,
  ): Promise<Prisma.Sql> {
    const lake = await this.dataLakeReady();
    const teamCond = q.saleTeamId
      ? Prisma.sql`AND t.id = ${q.saleTeamId}`
      : Prisma.empty;

    const custConds: Prisma.Sql[] = [];
    if (q.parentName)
      custConds.push(Prisma.sql`cu.parent_name = ${q.parentName}`);
    if (q.region) custConds.push(Prisma.sql`cu.region = ${q.region}`);
    if (q.customerGroupId) {
      custConds.push(Prisma.sql`EXISTS (SELECT 1 FROM customer_group_details g
        WHERE g."customerId" = cu.id AND g."customerGroupId" = ${q.customerGroupId})`);
    }
    const custAnd = custConds.length
      ? Prisma.sql`AND ${Prisma.join(custConds, ' AND ')}`
      : Prisma.empty;

    const prodConds: Prisma.Sql[] = [];
    if (q.productGroup)
      prodConds.push(Prisma.sql`pr.group2026 = ${q.productGroup}`);
    if (q.visualProductGroup)
      prodConds.push(Prisma.sql`pr.visual_group = ${q.visualProductGroup}`);
    const prodWhere = prodConds.length
      ? Prisma.sql`WHERE ${Prisma.join(prodConds, ' AND ')}`
      : Prisma.empty;

    const okExpr = (col: Prisma.Sql) =>
      Prisma.sql`(lower(COALESCE(${col}, '')) <> lower('Đã hủy'))`;

    const oldInvoices = lake
      ? Prisma.sql`
        UNION ALL
        SELECT NULL::int AS id, o.code, (o."purchaseDate" + interval '7 hour')::date AS d,
               ROUND(COALESCE(o.total, 0))::float8 AS total, ${okExpr(Prisma.sql`o."statusValue"`)} AS ok,
               c.code AS customer_code, false AS is_new
        FROM data_lake.invoice o
        JOIN seller s ON s.kiot_viet_id::text = o."soldById"
        LEFT JOIN customers c ON c.code = o."customerCode"
        WHERE o.status <> 2`
      : Prisma.empty;

    const lineCols = Prisma.sql`x.code, x.d, x.ok, x.customer_code, x.parent_name, x.customer_type, x.is_vip`;
    const oldLines = lake
      ? Prisma.sql`
        UNION ALL
        SELECT ${lineCols}, od."productCode" AS product_code,
               COALESCE(od.quantity, 0)::float8 AS quantity,
               (COALESCE(od.quantity, 0) * COALESCE(od.price, 0) - COALESCE(od.quantity, 0) * COALESCE(od.discount, 0))::float8 AS sub_total
        FROM data_lake.invoice_detail od
        JOIN invx x ON NOT x.is_new AND x.code = od."invoiceCode"`
      : Prisma.empty;

    return Prisma.sql`
      ${this.prodCte()},
      seller AS (
        SELECT u.id AS user_id, u.kiot_viet_id
        FROM analytics_sale_team_members m
        JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale ${teamCond}
        JOIN users u ON u.id = m.user_id
      ),
      inv_all AS (
        SELECT i.id, i.code, (i."purchaseDate" + interval '7 hour')::date AS d,
               ROUND(COALESCE(i."totalAmount", 0))::float8 AS total, ${okExpr(Prisma.sql`i."statusValue"`)} AS ok,
               c.code AS customer_code, true AS is_new
        FROM invoices i
        JOIN seller s ON s.user_id = i."soldById"
        LEFT JOIN customers c ON c.id = i."customerId"
        WHERE i.status <> 2
        ${oldInvoices}
      ),
      inv_raw AS (
        SELECT * FROM inv_all x
        WHERE x.d >= ${CALENDAR_START}::date AND x.d <= ${todayVn()}::date AND ${dateCond}
      ),
      ${this.custCte(Prisma.sql`c.code IN (SELECT customer_code FROM inv_raw WHERE customer_code IS NOT NULL)`)},
      invx AS (
        SELECT x.*, cu.parent_name, cu.customer_type, cu.is_vip, cu.region
        FROM inv_raw x
        LEFT JOIN cust cu ON cu.code = x.customer_code
        WHERE true ${custAnd}
      ),
      line_raw AS (
        SELECT ${lineCols}, p.code AS product_code,
               COALESCE(d.quantity, 0)::float8 AS quantity,
               (COALESCE(d.quantity, 0) * COALESCE(d.price, 0) - COALESCE(d.quantity, 0) * COALESCE(d.discount, 0))::float8 AS sub_total
        FROM invoice_details d
        JOIN invx x ON x.is_new AND x.id = d."invoiceId"
        LEFT JOIN products p ON p.id = d."productId"
        ${oldLines}
      ),
      line AS (
        SELECT l.code, l.d, l.ok, l.customer_code, l.parent_name, l.customer_type, l.is_vip,
               ROUND(l.quantity)::float8 AS quantity, ROUND(l.sub_total)::float8 AS sub_total,
               pr.product_type, pr.brand, pr.category, pr.group2026, pr.visual_group
        FROM line_raw l
        LEFT JOIN prod pr ON pr.code = l.product_code
        ${prodWhere}
      )`;
  }

  invMetrics(): Prisma.Sql {
    return Prisma.sql`
      COALESCE(SUM(x.total) FILTER (WHERE x.ok), 0)::float8 AS amount,
      COUNT(DISTINCT x.code) FILTER (WHERE x.ok)::int AS orders,
      COUNT(DISTINCT COALESCE(x.parent_name, ${BLANK_KEY})) FILTER (WHERE x.ok)::int AS customers`;
  }

  lineMetrics(): Prisma.Sql {
    return Prisma.sql`
      COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS amount,
      COUNT(DISTINCT x.code) FILTER (WHERE x.ok)::int AS orders,
      COUNT(DISTINCT COALESCE(x.customer_code, ${BLANK_KEY})) FILTER (WHERE x.ok)::int AS customers,
      COALESCE(SUM(x.quantity), 0)::float8 AS quantity`;
  }

  /** Số cấp hoá đơn, gom theo: tổng, năm, kỳ (trục), khách VIP, loại khách. */
  async invoiceAgg(
    q: AnalyticsBusinessQueryDto,
    dateCond: Prisma.Sql,
    axisExpr: Prisma.Sql,
  ) {
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, dateCond)}
      SELECT
        CASE WHEN GROUPING(x.y) = 0 THEN 'year' WHEN GROUPING(x.k) = 0 THEN 'period'
             WHEN GROUPING(x.vip_parent) = 0 THEN 'vip' WHEN GROUPING(x.customer_type) = 0 THEN 'ctype'
             ELSE 'total' END AS dim,
        COALESCE(x.y::text, x.k::text, x.vip_parent, x.customer_type) AS key,
        ${this.invMetrics()}
      FROM (
        SELECT x.*, extract(year FROM x.d)::int AS y, ${axisExpr} AS k,
               CASE WHEN x.is_vip THEN x.parent_name END AS vip_parent
        FROM invx x
      ) x
      GROUP BY GROUPING SETS ((), (x.y), (x.k), (x.vip_parent), (x.customer_type))`;
    return this.toDimMap<InvAgg>(rows);
  }

  /** Số cấp dòng hàng, gom theo các trục hoá đơn + trục sản phẩm. */
  async lineAgg(
    q: AnalyticsBusinessQueryDto,
    dateCond: Prisma.Sql,
    axisExpr: Prisma.Sql,
  ) {
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, dateCond)}
      SELECT
        CASE WHEN GROUPING(x.y) = 0 THEN 'year' WHEN GROUPING(x.k) = 0 THEN 'period'
             WHEN GROUPING(x.vip_parent) = 0 THEN 'vip' WHEN GROUPING(x.customer_type) = 0 THEN 'ctype'
             WHEN GROUPING(x.product_type) = 0 THEN 'ptype' WHEN GROUPING(x.brand) = 0 THEN 'brand'
             WHEN GROUPING(x.category) = 0 THEN 'category' ELSE 'total' END AS dim,
        COALESCE(x.y::text, x.k::text, x.vip_parent, x.customer_type, x.product_type, x.brand, x.category) AS key,
        ${this.lineMetrics()}
      FROM (
        SELECT x.*, extract(year FROM x.d)::int AS y, ${axisExpr} AS k,
               CASE WHEN x.is_vip THEN x.parent_name END AS vip_parent
        FROM line x
      ) x
      GROUP BY GROUPING SETS ((), (x.y), (x.k), (x.vip_parent), (x.customer_type),
                              (x.product_type), (x.brand), (x.category))`;
    return this.toDimMap<LineAgg>(rows);
  }

  async invoiceTotal(
    q: AnalyticsBusinessQueryDto,
    dateCond: Prisma.Sql,
  ): Promise<InvAgg> {
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, dateCond)}
      SELECT ${this.invMetrics()} FROM invx x`;
    return this.num(rows[0]) as InvAgg;
  }

  async lineTotal(
    q: AnalyticsBusinessQueryDto,
    dateCond: Prisma.Sql,
  ): Promise<LineAgg> {
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, dateCond)}
      SELECT ${this.lineMetrics()} FROM line x`;
    return this.num(rows[0]) as LineAgg;
  }

  /** "Năm trước" theo từng điểm trục: mỗi điểm có (các) khoảng ngày riêng. */
  async invoiceByRanges(q: AnalyticsBusinessQueryDto, ranges: Range[]) {
    if (!ranges.length) return new Map<string, InvAgg>();
    const { values, cond } = this.rangeSql(ranges);
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, cond)}
      SELECT r.k::text AS key, ${this.invMetrics()}
      FROM invx x JOIN (VALUES ${values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t
      GROUP BY r.k`;
    return new Map(rows.map((r) => [String(r.key), this.num(r) as InvAgg]));
  }

  async lineByRanges(q: AnalyticsBusinessQueryDto, ranges: Range[]) {
    if (!ranges.length) return new Map<string, LineAgg>();
    const { values, cond } = this.rangeSql(ranges);
    const rows = await this.prisma.$queryRaw<AggRow[]>`
      WITH ${await this.baseCtes(q, cond)}
      SELECT r.k::text AS key, ${this.lineMetrics()}
      FROM line x JOIN (VALUES ${values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t
      GROUP BY r.k`;
    return new Map(rows.map((r) => [String(r.key), this.num(r) as LineAgg]));
  }

  rangeSql(ranges: Range[]) {
    const from = ranges.reduce(
      (a, r) => (r.from < a ? r.from : a),
      ranges[0].from,
    );
    const to = ranges.reduce((a, r) => (r.to > a ? r.to : a), ranges[0].to);
    return {
      values: Prisma.join(
        ranges.map(
          (r) => Prisma.sql`(${r.k}::int, ${r.from}::date, ${r.to}::date)`,
        ),
      ),
      cond: Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Kỳ & trục thời gian
  // ─────────────────────────────────────────────────────────────────────────
  periodCond(p: CurrentPeriod): Prisma.Sql {
    return Prisma.sql`x.d BETWEEN ${p.min}::date AND ${p.max}::date
      AND extract(month FROM x.d)::int = ANY(${p.months}::int[])`;
  }

  axisExpr(axis: AnalyticsAxis): Prisma.Sql {
    if (axis === 'day') return Prisma.sql`extract(day FROM x.d)::int`;
    if (axis === 'weekday') return Prisma.sql`extract(isodow FROM x.d)::int`;
    return Prisma.sql`extract(month FROM x.d)::int`;
  }

  axisKeys(p: CurrentPeriod, year: number, axis: AnalyticsAxis): string[] {
    if (axis === 'month') return p.months.map(String);
    const set = new Set<number>();
    for (const d of listDates(p, year))
      set.add(axis === 'day' ? parts(d).d : isoWeekday(d));
    return [...set].sort((a, b) => a - b).map(String);
  }

  axisLabel(axis: AnalyticsAxis, k: number): string {
    if (axis === 'month') return `Tháng ${k}`;
    if (axis === 'weekday') return k === 7 ? 'Chủ Nhật' : `Thứ ${k + 1}`;
    return String(k);
  }

  /**
   * Khoảng ngày "năm trước" cho từng điểm trục.
   * - Trục Tháng: đúng DAX switch_dynamics_metrics_sameYear (min..max của tháng, lùi 1 năm).
   * - Trục Ngày / Thứ: lùi từng ngày đúng 1 năm. (DAX gốc lấy cả khoảng min..max nên
   *   cho số sai ở 2 trục này; ở đây tính đúng ngày tương ứng.)
   */
  sameYearRanges(p: CurrentPeriod, year: number, axis: AnalyticsAxis): Range[] {
    if (axis === 'month') {
      return p.months.map((m) => {
        let from = daxDate(year, m, 1);
        let to = daxDate(year, m + 1, 0);
        if (from < p.min) from = p.min;
        if (to > p.max) to = p.max;
        return { k: m, ...sameYearRange(from, to) };
      });
    }
    return listDates(p, year).map((d) => {
      const prev = shiftYear(d);
      return {
        k: axis === 'day' ? parts(d).d : isoWeekday(d),
        from: prev,
        to: prev,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tiện ích
  // ─────────────────────────────────────────────────────────────────────────
  toDimMap<T>(rows: AggRow[]): Map<Dim, Map<string | null, T>> {
    const out = new Map<Dim, Map<string | null, T>>();
    for (const r of rows) {
      const dim = r.dim as Dim;
      if (!out.has(dim)) out.set(dim, new Map());
      out
        .get(dim)!
        .set(
          dim === 'total' || r.key == null ? null : String(r.key),
          this.num(r) as T,
        );
    }
    return out;
  }

  num(r: AggRow | undefined) {
    return {
      amount: Number(r?.amount ?? 0),
      orders: Number(r?.orders ?? 0),
      customers: Number(r?.customers ?? 0),
      quantity: Number(r?.quantity ?? 0),
    };
  }

  zero(): MetricValues {
    return { amount: 0, orders: 0, customers: 0, quantity: 0 };
  }

  /** Chọn số cấp hoá đơn hay cấp dòng (switch_dynamics_metrics). Sản lượng luôn cấp dòng. */
  pick(
    inv: InvAgg | undefined,
    line: LineAgg | undefined,
    useLine: boolean,
    key: string | null,
  ): MetricRow {
    const src = useLine ? line : inv;
    return {
      key,
      amount: src?.amount ?? 0,
      orders: src?.orders ?? 0,
      customers: src?.customers ?? 0,
      quantity: line?.quantity ?? 0,
    };
  }

  div(a: number, b: number): number | null {
    return b ? a / b : null;
  }

  card(current: number | null, previous: number | null): CardValue {
    const growth = previous ? ((current ?? 0) - previous) / previous : null;
    return { current, previous, growth };
  }
}

export type Range = { k: number; from: IsoDate; to: IsoDate };

/** Dòng trả về từ các câu SQL tổng hợp. */
export type AggRow = {
  dim?: string;
  key?: string | number | null;
  amount?: number | null;
  orders?: number | null;
  customers?: number | null;
  quantity?: number | null;
};
