import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsReportsService } from '../analytics-reports.service';
import {
  IsoDate,
  addDays,
  daxDate,
  diffDays,
  isoWeekday,
  parts,
  todayVn,
} from './analytics-period';
import {
  KpiIncomeRuleDto,
  KpiIncomeRuleUpdateDto,
  KpiProductMapDto,
  KpiProductMapUpdateDto,
  KpiProductTargetDto,
  KpiProductTargetUpdateDto,
  KpiRepRuleDto,
  KpiRepRuleUpdateDto,
  KpiRevenueTargetDto,
  KpiRevenueTargetUpdateDto,
  KpiSaleDailyQueryDto,
  KpiSaleOrderQueryDto,
  KpiSaleQueryDto,
} from './analytics-kpi-sale.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › KPI Sale — thay dataset + report "KPI Sale" của Power BI.
// Logic chép theo model KPI Sale (KHÁC dataset_sale của trang Kinh Doanh):
//   • Hoá đơn status <> 2 của MỌI người bán (không lọc team sale), chỉ hệ thống
//     mới (dataset KPI không có data_lake); ngày = (purchaseDate + 7h)::date.
//   • Dòng hàng: sub_total = SL×giá − SL×giảm giá; mã hàng gộp theo bảng
//     analytics_kpi_product_code_maps trước khi lấy loại hàng / nhóm hàng 2026.
//   • revenue_detail = SUM(sub_total) bỏ STTTW01 từ 01/07/2026.
//   • Người đại diện (dim_customers[sale_rep]) theo analytics_kpi_sale_rep_rules
//     (có hiệu lực theo ngày mua → xử lý bàn giao tranglt → trangtt từ 09/2026).
//   • "Tính thu nhập" (check_logic) theo analytics_kpi_income_rules.
//   • Chỉ tiêu: analytics_kpi_revenue_targets / analytics_kpi_product_targets.
//   • Phân quyền theo dòng (RLS của Power BI): Super Admin hoặc user có
//     canViewOtherStaffData xem tất cả; người khác chỉ thấy khách có người đại
//     diện = mã của mình hoặc "noname", và chỉ tiêu của chính mình.
// ═══════════════════════════════════════════════════════════════════════════

const SUPER_ADMIN_ROLE = 'Super Admin';
const NONAME = 'noname';
const NO_SALE_PIC = '__none__';
const CUSTOMER_TYPE_GROUPS = ['Khách chuỗi', 'Khách lẻ', 'Khách buôn'];
/** filter_product_group_2026 (các giá trị nhóm hàng 2026). */
export const KPI_PRODUCT_GROUPS = [
  'Chưa Phân Loại',
  'Nhóm A',
  'Nhóm B',
  'Nhóm C',
  'Nhóm D',
];
/** measure revenue_detail: không tính mã này từ ngày này (viết cứng trong DAX). */
export const KPI_REVENUE_EXCLUDE = {
  productCode: 'STTTW01',
  from: '2026-07-01',
};
/** Bảng cấu hình theo tên trên URL (config/<table>/:id). */
export const KPI_CONFIG_TABLES = {
  'revenue-targets': 'analytics_kpi_revenue_targets',
  'product-targets': 'analytics_kpi_product_targets',
  'rep-rules': 'analytics_kpi_sale_rep_rules',
  'income-rules': 'analytics_kpi_income_rules',
  'product-maps': 'analytics_kpi_product_code_maps',
} as const;
export type KpiConfigTable = keyof typeof KPI_CONFIG_TABLES;
/** Năm đầu của dim_month (CALENDAR từ 01/01/2024). */
const KPI_FIRST_YEAR = 2024;

/** Người xem (req.user) — dùng để áp RLS. */
export interface KpiViewer {
  id?: number;
  email?: string;
  roles?: string[];
  canViewOtherStaffData?: boolean;
}

interface Scope {
  restricted: boolean;
  code: string | null;
}

interface FactOptions {
  from: IsoDate;
  to: IsoDate;
  months?: number[];
  scope: Scope;
  users?: string[];
  /** Filter trang NOT(dim_user[given_name] IN {null}): người đại diện phải là user có thật. */
  pageFilter?: boolean;
  salePics?: string[];
  sellers?: number[];
  invoiceCode?: string;
}

type Num = number | string | null;

type OrderSellerRow = {
  seller_id: number | null;
  seller_name: string | null;
  rep: string | null;
  rev: number | null;
  invoices: number;
};

type OrderCustomerRow = {
  customer_code: string | null;
  customer_name: string | null;
  sale_pic: string | null;
  rep: string | null;
  rev: number | null;
  total: number;
  total_rev: number | null;
};

type DailyAgg = {
  rep: string | null;
  grp: string | null;
  income: boolean;
  rev: number | null;
  sub: number | null;
};

type DailyDetail = {
  rep: string | null;
  seller_name: string | null;
  code: string;
  d: string;
  customer_code: string | null;
  customer_name: string | null;
  customer_type: string | null;
  product_name: string | null;
  grp: string | null;
  income: boolean;
  product_type: string | null;
  rev: number | null;
  total: number;
  total_rev: number | null;
};


/** % Hiệu Quả của Bảng Thu Nhập, cùng KPI tháng dùng cho cột Còn Lại. */
export function incomeEfficiency(
  kpi: number | null,
  revenue: number | null,
): number | null {
  return kpi ? (revenue ?? 0) / kpi : null;
}

@Injectable()
export class AnalyticsKpiSaleService {
  constructor(
    private prisma: PrismaService,
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Phạm vi xem & kỳ
  // ─────────────────────────────────────────────────────────────────────────
  scopeOf(user?: KpiViewer): Scope {
    if (user?.roles?.includes(SUPER_ADMIN_ROLE) || user?.canViewOtherStaffData)
      return { restricted: false, code: null };
    const code = (user?.email ?? '').split('@')[0].trim();
    return { restricted: true, code: code || null };
  }

  private period(q: KpiSaleQueryDto) {
    const months = (
      q.months?.length
        ? [...new Set(q.months)]
        : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    ).sort((a, b) => a - b);
    return {
      year: q.year,
      months,
      from: daxDate(q.year, months[0], 1),
      to: daxDate(q.year, months[months.length - 1] + 1, 0),
    };
  }

  /** Tuần hiện tại theo WEEKNUM(TODAY(), 2) của DAX, cắt trong năm hiện tại. */
  currentWeek(today: IsoDate = todayVn()) {
    const { y } = parts(today);
    const jan1 = `${y}-01-01`;
    const dec31 = `${y}-12-31`;
    const doy = diffDays(jan1, today) + 1;
    const week = Math.floor((doy - 1 + isoWeekday(jan1) - 1) / 7) + 1;
    let from = addDays(today, -(isoWeekday(today) - 1));
    let to = addDays(today, 7 - isoWeekday(today));
    if (from < jan1) from = jan1;
    if (to > dec31) to = dec31;
    return { year: y, week, from, to };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CTE dữ liệu (tương đương invoice / invoice_detail / dim_customers / dim_product)
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * CTE: du (dim_user), rr / ir (quy tắc), kc (dim_customers), invr (hoá đơn đã
   * lọc + người đại diện), lnx (dòng hàng + nhóm hàng + check_logic + cờ loại trừ).
   */
  private async factCtes(o: FactOptions): Promise<Prisma.Sql> {
    const lake = await this.base.dataLakeReady();
    const prov = lake
      ? Prisma.sql`SELECT lower(name) AS lname, replace(region, 'Miền ', '') AS region FROM data_lake.new_province`
      : Prisma.sql`SELECT NULL::text AS lname, NULL::text AS region WHERE false`;

    const invConds: Prisma.Sql[] = [];
    if (o.months?.length && o.months.length < 12)
      invConds.push(
        Prisma.sql`extract(month FROM x.d)::int = ANY(${o.months}::int[])`,
      );
    if (o.sellers?.length) {
      const ids = o.sellers.filter((s) => s > 0);
      const none = o.sellers.some((s) => s <= 0);
      invConds.push(
        Prisma.sql`(x.seller_id = ANY(${ids}::int[]) ${none ? Prisma.sql`OR x.seller_id IS NULL` : Prisma.empty})`,
      );
    }
    if (o.invoiceCode?.trim())
      invConds.push(Prisma.sql`x.code ILIKE ${`%${o.invoiceCode.trim()}%`}`);

    const repConds: Prisma.Sql[] = [];
    if (o.scope.restricted)
      repConds.push(
        Prisma.sql`x.rep = ANY(${[o.scope.code ?? NONAME, NONAME]}::text[])`,
      );
    if (o.users?.length)
      repConds.push(Prisma.sql`x.rep = ANY(${o.users}::text[])`);
    if (o.pageFilter)
      repConds.push(Prisma.sql`x.rep IN (SELECT user_key FROM du)`);
    if (o.salePics?.length) {
      const names = o.salePics.filter((s) => s !== NO_SALE_PIC);
      const none = o.salePics.includes(NO_SALE_PIC);
      repConds.push(
        Prisma.sql`(x.sale_pic = ANY(${names}::text[]) ${none ? Prisma.sql`OR x.sale_pic IS NULL` : Prisma.empty})`,
      );
    }
    const and = (c: Prisma.Sql[]) =>
      c.length ? Prisma.sql`AND ${Prisma.join(c, ' AND ')}` : Prisma.empty;

    return Prisma.sql`
      du AS (
        SELECT DISTINCT ON (split_part(email, '@', 1)) split_part(email, '@', 1) AS user_key, name
        FROM users ORDER BY split_part(email, '@', 1), id
      ),
      rr AS MATERIALIZED (
        SELECT id, priority, sale_pic, lower(customer_type) AS ctype, lower(region) AS region,
               sale_code, valid_from, valid_to
        FROM analytics_kpi_sale_rep_rules WHERE is_active
      ),
      ir AS MATERIALIZED (
        SELECT sale_code,
          (SELECT array_agg(lower(v)) FROM unnest(customer_types) v) AS ctypes,
          (SELECT array_agg(lower(v)) FROM unnest(product_types) v) AS ptypes,
          (SELECT array_agg(lower(v)) FROM unnest(product_groups) v) AS pgroups
        FROM analytics_kpi_income_rules WHERE is_active
      ),
      inv AS MATERIALIZED (
        SELECT i.id, i.code, (i."purchaseDate" + interval '7 hour')::date AS d,
               i."customerId" AS customer_id, i."soldById" AS seller_id
        FROM invoices i
        WHERE i.status <> 2
          AND i."purchaseDate" >= (${o.from}::date - interval '7 hour')
          AND i."purchaseDate" < (${o.to}::date + 1 - interval '7 hour')
      ),
      sp AS (
        SELECT DISTINCT ON (g."customerId") g."customerId", cg.name
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (SELECT sale_pic FROM rr)
        ORDER BY g."customerId", cg.name DESC
      ),
      ct AS (
        SELECT DISTINCT ON (g."customerId") g."customerId", cg.name
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (${Prisma.join(CUSTOMER_TYPE_GROUPS)})
        ORDER BY g."customerId", cg.name
      ),
      addr AS (
        SELECT DISTINCT ON ("customerId") "customerId", "newCityName"
        FROM customer_addresses WHERE "newCityCode" IS NOT NULL
        ORDER BY "customerId", "updatedAt" DESC
      ),
      prov AS (${prov}),
      kc AS MATERIALIZED (
        SELECT c.id, c.code, c.name, sp.name AS sale_pic, ct.name AS customer_type,
               COALESCE(pv.region, 'Chưa Phân Loại') AS region
        FROM customers c
        LEFT JOIN sp ON sp."customerId" = c.id
        LEFT JOIN ct ON ct."customerId" = c.id
        LEFT JOIN addr a ON a."customerId" = c.id
        LEFT JOIN prov pv ON pv.lname = lower(a."newCityName")
        WHERE c.id IN (SELECT customer_id FROM inv)
      ),
      invr AS MATERIALIZED (
        SELECT * FROM (
          SELECT x.id, x.code, x.d, x.seller_id, su.name AS seller_name,
                 kc.id AS customer_id, kc.code AS customer_code, kc.name AS customer_name,
                 kc.sale_pic, kc.customer_type, kc.region,
                 CASE WHEN kc.id IS NULL THEN NULL
                      WHEN kc.sale_pic IS NULL THEN ${NONAME}
                      ELSE COALESCE((
                   SELECT r.sale_code FROM rr r
                   WHERE r.sale_pic = kc.sale_pic
                     AND (r.ctype IS NULL OR r.ctype = lower(kc.customer_type))
                     AND (r.region IS NULL OR r.region = lower(kc.region))
                     AND (r.valid_from IS NULL OR r.valid_from <= x.d)
                     AND (r.valid_to IS NULL OR r.valid_to >= x.d)
                   ORDER BY r.priority, r.id LIMIT 1
                 ), kc.sale_pic) END AS rep
          FROM inv x
          LEFT JOIN kc ON kc.id = x.customer_id
          LEFT JOIN users su ON su.id = x.seller_id
        ) x
        WHERE true ${and(invConds)} ${and(repConds)}
      ),
      ${this.base.prodCte()},
      ln AS (
        SELECT x.id AS invoice_id, x.code, x.d, x.rep, x.seller_id, x.seller_name,
               x.customer_id, x.customer_code, x.customer_name, x.customer_type, x.sale_pic,
               COALESCE(m.to_code, p.code) AS product_code, p.name AS product_name,
               pr.product_type, pr.group2026 AS grp,
               (COALESCE(dd.quantity, 0) * COALESCE(dd.price, 0)
                 - COALESCE(dd.quantity, 0) * COALESCE(dd.discount, 0))::float8 AS sub_total
        FROM invoice_details dd
        JOIN invr x ON x.id = dd."invoiceId"
        LEFT JOIN products p ON p.id = dd."productId"
        LEFT JOIN analytics_kpi_product_code_maps m ON m.from_code = p.code
        LEFT JOIN prod pr ON pr.code = COALESCE(m.to_code, p.code)
      ),
      lnx AS (
        SELECT l.*,
          (l.d >= ${KPI_REVENUE_EXCLUDE.from}::date AND l.product_code = ${KPI_REVENUE_EXCLUDE.productCode}) AS excluded,
          EXISTS (
            SELECT 1 FROM ir
            WHERE ir.sale_code = l.rep
              AND lower(l.customer_type) = ANY(ir.ctypes)
              AND lower(l.product_type) = ANY(ir.ptypes)
              AND lower(l.grp) = ANY(ir.pgroups)
          ) AS income
        FROM ln l
      )`;
  }

  /**
   * Chạy câu SQL dữ liệu nặng với JIT tắt: Postgres ước lượng chi phí cao (subquery
   * theo từng hoá đơn) nên bật JIT và mất ~0,7 s chỉ để biên dịch.
   */
  private async fact<T>(
    strings: TemplateStringsArray,
    ...values: Prisma.Sql[] | unknown[]
  ): Promise<T> {
    const sql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$queryRaw<T>(sql),
    ]);
    return rows;
  }

  /** Điều kiện chỉ tiêu theo kỳ / nhân viên / RLS / filter trang. */
  private targetWhere(
    p: { year: number; months: number[] },
    scope: Scope,
    users?: string[],
    pageFilter = true,
  ): Prisma.Sql {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.year = ${p.year}`,
      Prisma.sql`t.month = ANY(${p.months}::int[])`,
    ];
    if (scope.restricted)
      conds.push(Prisma.sql`t.sale_code = ${scope.code ?? ''}`);
    if (users?.length)
      conds.push(Prisma.sql`t.sale_code = ANY(${users}::text[])`);
    if (pageFilter)
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM users u WHERE split_part(u.email, '@', 1) = t.sale_code)`,
      );
    return Prisma.join(conds, ' AND ');
  }

  private async userNames(codes: string[]): Promise<Map<string, string>> {
    if (!codes.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ code: string; name: string }[]>`
      SELECT DISTINCT ON (split_part(email, '@', 1)) split_part(email, '@', 1) AS code, name
      FROM users WHERE split_part(email, '@', 1) = ANY(${codes}::text[])
      ORDER BY split_part(email, '@', 1), id`;
    return new Map(rows.map((r) => [r.code, r.name]));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bộ lọc
  // ─────────────────────────────────────────────────────────────────────────
  async getOptions(user?: KpiViewer) {
    const scope = this.scopeOf(user);
    const today = todayVn();
    const years: number[] = [];
    for (let y = KPI_FIRST_YEAR; y <= parts(today).y; y++) years.push(y);

    const [codes, salePics] = await Promise.all([
      this.prisma.$queryRaw<{ code: string }[]>`
        SELECT sale_code AS code FROM analytics_kpi_sale_rep_rules WHERE is_active
        UNION SELECT sale_pic FROM analytics_kpi_sale_rep_rules WHERE is_active
        UNION SELECT sale_code FROM analytics_kpi_revenue_targets
        UNION SELECT sale_code FROM analytics_kpi_product_targets`,
      this.prisma.$queryRaw<{ name: string }[]>`
        SELECT DISTINCT sale_pic AS name FROM analytics_kpi_sale_rep_rules WHERE is_active ORDER BY 1`,
    ]);
    let list = codes.map((c) => c.code);
    if (scope.restricted) list = scope.code ? [scope.code] : [];
    const names = await this.userNames(list);
    const users = list
      .filter((c) => names.has(c))
      .map((c) => ({ code: c, name: names.get(c)! }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    return {
      years,
      restricted: scope.restricted,
      viewerCode: scope.code,
      users,
      productGroups: KPI_PRODUCT_GROUPS,
      salePics: salePics.map((r) => r.name),
      week: this.currentWeek(today),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Sale Income (dùng cả cho TPKD)
  // ─────────────────────────────────────────────────────────────────────────
  async getSaleIncome(q: KpiSaleQueryDto, user?: KpiViewer) {
    const scope = this.scopeOf(user);
    const p = this.period(q);
    const week = this.currentWeek();
    const ctes = await this.factCtes({
      from: p.from,
      to: p.to,
      months: p.months,
      scope,
      users: q.users,
      pageFilter: true,
    });

    const [lines, kpiRows, productRows] = await Promise.all([
      this.fact<
        { rep: string; ym: string; grp: string | null; rev: Num; week: Num }[]
      >`
        WITH ${ctes},
        steam AS (
          SELECT DISTINCT split_part(u.email, '@', 1) AS code
          FROM analytics_sale_team_members m
          JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale
          JOIN users u ON u.id = m.user_id
        )
        SELECT l.rep, to_char(l.d, 'YYYY-MM') AS ym, l.grp,
          SUM(l.sub_total) FILTER (WHERE NOT l.excluded)::float8 AS rev,
          SUM(l.sub_total) FILTER (
            WHERE NOT l.excluded AND l.d BETWEEN ${week.from}::date AND ${week.to}::date
              AND l.rep IN (SELECT code FROM steam)
          )::float8 AS week
        FROM lnx l
        GROUP BY 1, 2, 3`,
      this.prisma.$queryRaw<
        { code: string; month: number; kpi: Num; salary: Num }[]
      >`
        SELECT t.sale_code AS code, t.month, SUM(t.kpi_value)::float8 AS kpi,
               MAX(t.basic_salary)::float8 AS salary
        FROM analytics_kpi_revenue_targets t
        WHERE ${this.targetWhere(p, scope, q.users)}
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<
        { code: string; month: number; grp: string; kpi: Num }[]
      >`
        SELECT t.sale_code AS code, t.month, t.product_group AS grp, SUM(t.kpi_value)::float8 AS kpi
        FROM analytics_kpi_product_targets t
        WHERE ${this.targetWhere(p, scope, q.users)}
        GROUP BY 1, 2, 3`,
    ]);

    const ym = (m: number) => `${p.year}-${String(m).padStart(2, '0')}`;
    // Ô (nhân viên, tháng, nhóm hàng) → KPI nhóm hàng / thực tế.
    type Cell = { kpi: number | null; revenue: number | null };
    const mix = new Map<
      string,
      Cell & { code: string; ym: string; group: string | null }
    >();
    const mixCell = (code: string, m: string, group: string | null) => {
      const k = `${code}|${m}|${group ?? ''}`;
      let c = mix.get(k);
      if (!c) {
        c = { code, ym: m, group, kpi: null, revenue: null };
        mix.set(k, c);
      }
      return c;
    };
    const add = (a: number | null, b: Num) =>
      b === null || b === undefined ? a : (a ?? 0) + Number(b);

    let weekRevenue: number | null = null;
    for (const r of lines) {
      const c = mixCell(r.rep, r.ym, r.grp);
      c.revenue = add(c.revenue, r.rev);
      weekRevenue = add(weekRevenue, r.week);
    }
    for (const r of productRows) {
      const c = mixCell(r.code, ym(r.month), r.grp);
      c.kpi = add(c.kpi, r.kpi);
    }

    // Bảng Thu Nhập: (nhân viên, tháng).
    type IncomeRow = {
      code: string;
      ym: string;
      kpi: number | null;
      revenue: number | null;
      kpiProduct: number | null;
    };
    const income = new Map<string, IncomeRow>();
    const incomeRow = (code: string, m: string) => {
      const k = `${code}|${m}`;
      let r = income.get(k);
      if (!r) {
        r = { code, ym: m, kpi: null, revenue: null, kpiProduct: null };
        income.set(k, r);
      }
      return r;
    };
    for (const c of mix.values()) {
      const r = incomeRow(c.code, c.ym);
      r.revenue = add(r.revenue, c.revenue);
      r.kpiProduct = add(r.kpiProduct, c.kpi);
    }
    for (const k of kpiRows) {
      const r = incomeRow(k.code, ym(k.month));
      r.kpi = add(r.kpi, k.kpi);
    }

    const codes = [...new Set([...income.values()].map((r) => r.code))];
    const names = await this.userNames(codes);
    const nameOf = (c: string) => names.get(c) ?? c;

    const finish = (r: Omit<IncomeRow, 'code' | 'ym'>) => ({
      ...r,
      // Cùng mẫu số với Còn Lại: KPI tháng của team, không phải tổng KPI nhóm hàng.
      pct: incomeEfficiency(r.kpi, r.revenue),
      remain:
        r.kpi === null && r.revenue === null
          ? null
          : (r.kpi ?? 0) - (r.revenue ?? 0),
    });
    const incomeRows = [...income.values()]
      .map((r) => ({ ...r, name: nameOf(r.code), ...finish(r) }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'vi') || a.ym.localeCompare(b.ym),
      );
    const sum = (key: 'kpi' | 'revenue' | 'kpiProduct') =>
      incomeRows.reduce<number | null>((s, r) => add(s, r[key]), null);
    const totals = finish({
      kpi: sum('kpi'),
      revenue: sum('revenue'),
      kpiProduct: sum('kpiProduct'),
    });

    return {
      period: p,
      restricted: scope.restricted,
      week,
      users: codes
        .map((c) => ({ code: c, name: nameOf(c) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
      cards: {
        kpi: totals.kpi,
        revenue: totals.revenue,
        weekRevenue,
        remain: totals.remain,
      },
      income: { rows: incomeRows, totals },
      productMix: [...mix.values()]
        .filter((c) => c.kpi !== null || c.revenue !== null)
        .map((c) => ({ ...c, name: nameOf(c.code) })),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Theo Ngày
  // ─────────────────────────────────────────────────────────────────────────
  async getDaily(q: KpiSaleDailyQueryDto, user?: KpiViewer) {
    const scope = this.scopeOf(user);
    const p = this.period(q);
    let from = q.from && q.from > p.from ? q.from : p.from;
    let to = q.to && q.to < p.to ? q.to : p.to;
    if (from > to) [from, to] = [to, from];
    const ctes = await this.factCtes({
      from,
      to,
      months: p.months,
      scope,
      users: q.users,
      sellers: q.sellers,
      invoiceCode: q.invoiceCode,
    });
    const groupCond = q.groups?.length
      ? Prisma.sql`AND COALESCE(l.grp, '') = ANY(${q.groups}::text[])`
      : Prisma.empty;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 100;

    // 1 câu SQL trả cả số tổng hợp lẫn 1 trang bảng chi tiết (tính dữ liệu 1 lần).
    const [[one], sellers] = await Promise.all([
      this.fact<{ agg: DailyAgg[]; detail: DailyDetail[] }[]>`
        WITH ${ctes},
        lx AS (SELECT l.* FROM lnx l WHERE true ${groupCond}),
        agg AS (
          SELECT rep, grp, income,
            SUM(sub_total) FILTER (WHERE NOT excluded)::float8 AS rev,
            SUM(sub_total)::float8 AS sub
          FROM lx GROUP BY 1, 2, 3
        ),
        -- tableEx gom theo các cột hiển thị; cột cấp hoá đơn phụ thuộc invoice_id
        -- nên gom theo (hoá đơn, cột hàng) rồi mới nối thông tin hoá đơn cho 1 trang.
        g AS (
          SELECT invoice_id, d, code, product_name, grp, income, product_type,
                 SUM(sub_total)::float8 AS rev
          FROM lx WHERE NOT excluded
          GROUP BY 1, 2, 3, 4, 5, 6, 7
        ),
        pg AS (
          SELECT g.*, COUNT(*) OVER ()::int AS total, SUM(g.rev) OVER ()::float8 AS total_rev
          FROM g
          ORDER BY g.d DESC, g.code DESC, g.product_name
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        ),
        det AS (
          SELECT pg.*, x.rep, x.seller_name, x.customer_code, x.customer_name, x.customer_type
          FROM pg JOIN invr x ON x.id = pg.invoice_id
        )
        SELECT
          (SELECT COALESCE(json_agg(agg), '[]'::json) FROM agg) AS agg,
          (SELECT COALESCE(json_agg(det ORDER BY det.d DESC, det.code DESC, det.product_name), '[]'::json)
           FROM det) AS detail`,
      this.prisma.$queryRaw<{ id: number | null; name: string | null }[]>`
        SELECT DISTINCT i."soldById" AS id, u.name
        FROM invoices i LEFT JOIN users u ON u.id = i."soldById"
        WHERE i.status <> 2
          AND i."purchaseDate" >= (${from}::date - interval '7 hour')
          AND i."purchaseDate" < (${to}::date + 1 - interval '7 hour')
        ORDER BY 2`,
    ]);
    const agg = one?.agg ?? [];
    const detail = one?.detail ?? [];

    const codes = [
      ...new Set(agg.map((r) => r.rep).concat(detail.map((r) => r.rep))),
    ].filter((c): c is string => !!c);
    const names = await this.userNames(codes);
    const nameOf = (c: string | null) => (c ? (names.get(c) ?? null) : null);

    const byGroup = new Map<string | null, number>();
    const byCheck = new Map<string, number>();
    const expected = new Map<
      string,
      {
        code: string | null;
        name: string | null;
        group: string | null;
        revenue: number | null;
        income: number | null;
      }
    >();
    for (const r of agg) {
      const rev = r.rev === null ? null : Number(r.rev);
      if (rev !== null) {
        byGroup.set(r.grp, (byGroup.get(r.grp) ?? 0) + rev);
        const ck = r.income ? 'Có' : 'Không';
        byCheck.set(ck, (byCheck.get(ck) ?? 0) + rev);
      }
      const k = `${r.rep ?? ''}|${r.grp ?? ''}`;
      const e = expected.get(k) ?? {
        code: r.rep,
        name: nameOf(r.rep),
        group: r.grp,
        revenue: null,
        income: null,
      };
      if (rev !== null) e.revenue = (e.revenue ?? 0) + rev;
      if (r.income && r.sub !== null)
        e.income = (e.income ?? 0) + Number(r.sub);
      expected.set(k, e);
    }

    return {
      period: { ...p, from, to },
      restricted: scope.restricted,
      byGroup: [...byGroup]
        .map(([group, revenue]) => ({ group, revenue }))
        .sort((a, b) => b.revenue - a.revenue),
      byCheck: ['Có', 'Không']
        .filter((k) => byCheck.has(k))
        .map((k) => ({ key: k, revenue: byCheck.get(k)! })),
      expected: [...expected.values()].filter(
        (e) => e.revenue !== null || e.income !== null,
      ),
      detail: {
        page,
        pageSize,
        total: Number(detail[0]?.total ?? 0),
        sum:
          detail[0]?.total_rev === undefined
            ? null
            : Number(detail[0].total_rev),
        rows: detail.map((r) => ({
          pic: nameOf(r.rep),
          seller: r.seller_name,
          code: r.code,
          date: String(r.d).slice(0, 10),
          customerCode: r.customer_code,
          customerName: r.customer_name,
          customerType: r.customer_type,
          productName: r.product_name,
          group: r.grp,
          revenue: r.rev === null ? null : Number(r.rev),
          check: r.income ? 'Có' : 'Không',
          productType: r.product_type,
        })),
      },
      sellers: sellers.map((s) => ({
        id: s.id ?? 0,
        name: s.name ?? '(Trống)',
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Lên Đơn Hộ
  // ─────────────────────────────────────────────────────────────────────────
  async getOrderOnBehalf(q: KpiSaleOrderQueryDto, user?: KpiViewer) {
    const scope = this.scopeOf(user);
    const p = this.period(q);
    const ctes = await this.factCtes({
      from: p.from,
      to: p.to,
      months: p.months,
      scope,
      users: q.users,
      salePics: q.salePics,
    });
    const term = q.search?.trim();
    const search = term
      ? Prisma.sql`AND (customer_code ILIKE ${`%${term}%`} OR customer_name ILIKE ${`%${term}%`})`
      : Prisma.empty;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 100;

    // 1 câu SQL cho cả 2 bảng (tính dữ liệu 1 lần).
    const [one] = await this.fact<
      { by_seller: OrderSellerRow[]; customers: OrderCustomerRow[] }[]
    >`
      WITH ${ctes},
      lc AS (
        SELECT seller_id, customer_id, customer_code, customer_name, sale_pic, rep,
               SUM(sub_total) FILTER (WHERE NOT excluded)::float8 AS rev,
               COUNT(*) FILTER (WHERE NOT excluded) AS n
        FROM lnx GROUP BY 1, 2, 3, 4, 5, 6
      ),
      ia AS (
        SELECT seller_id, seller_name, rep, COUNT(DISTINCT code)::int AS invoices
        FROM invr GROUP BY 1, 2, 3
      ),
      la AS (
        SELECT seller_id, rep, SUM(rev)::float8 AS rev FROM lc GROUP BY 1, 2
      ),
      bs AS (
        SELECT ia.seller_id, ia.seller_name, ia.rep, la.rev, ia.invoices
        FROM ia LEFT JOIN la
          ON la.seller_id IS NOT DISTINCT FROM ia.seller_id AND la.rep IS NOT DISTINCT FROM ia.rep
      ),
      g AS (
        SELECT customer_code, customer_name, sale_pic, rep, SUM(rev)::float8 AS rev
        FROM lc
        WHERE true ${search}
        GROUP BY customer_id, 1, 2, 3, 4
        HAVING SUM(n) > 0
      ),
      pg AS (
        SELECT g.*, COUNT(*) OVER ()::int AS total, SUM(g.rev) OVER ()::float8 AS total_rev
        FROM g
        ORDER BY g.rev DESC NULLS LAST, g.customer_code
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      )
      SELECT
        (SELECT COALESCE(json_agg(bs), '[]'::json) FROM bs) AS by_seller,
        (SELECT COALESCE(json_agg(pg ORDER BY pg.rev DESC NULLS LAST, pg.customer_code), '[]'::json)
         FROM pg) AS customers`;
    const bySeller = one?.by_seller ?? [];
    const customers = one?.customers ?? [];

    return {
      period: p,
      restricted: scope.restricted,
      bySeller: bySeller.map((r) => ({
        sellerId: r.seller_id,
        seller: r.seller_name,
        rep: r.rep,
        revenue: r.rev === null ? null : Number(r.rev),
        invoices: Number(r.invoices ?? 0),
      })),
      customers: {
        page,
        pageSize,
        total: Number(customers[0]?.total ?? 0),
        sum:
          customers[0]?.total_rev === undefined
            ? null
            : Number(customers[0].total_rev),
        rows: customers.map((r) => ({
          code: r.customer_code,
          name: r.customer_name,
          salePic: r.sale_pic,
          rep: r.rep,
          revenue: r.rev === null ? null : Number(r.rev),
        })),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Logic: quy tắc đang áp dụng + doanh số theo quy tắc
  // ─────────────────────────────────────────────────────────────────────────
  async getLogic(q: KpiSaleQueryDto, user?: KpiViewer) {
    const scope = this.scopeOf(user);
    const p = this.period(q);
    const ctes = await this.factCtes({
      from: p.from,
      to: p.to,
      months: p.months,
      scope,
      users: q.users,
    });
    const [split, repRules, incomeRules, maps] = await Promise.all([
      this.fact<
        {
          rep: string | null;
          customer_type: string | null;
          product_type: string | null;
          rev: Num;
          income: Num;
        }[]
      >`
        WITH ${ctes}
        SELECT rep, customer_type, product_type,
          SUM(sub_total) FILTER (WHERE NOT excluded)::float8 AS rev,
          SUM(sub_total) FILTER (WHERE income)::float8 AS income
        FROM lnx GROUP BY 1, 2, 3`,
      this.listRepRules(),
      this.listIncomeRules(),
      this.listProductMaps(),
    ]);
    const names = await this.userNames(
      [...new Set(split.map((r) => r.rep))].filter((c): c is string => !!c),
    );
    return {
      period: p,
      restricted: scope.restricted,
      exclude: KPI_REVENUE_EXCLUDE,
      repRules: repRules.filter((r) => r.isActive),
      incomeRules: incomeRules.filter((r) => r.isActive),
      productMaps: maps,
      split: split.map((r) => ({
        code: r.rep,
        name: r.rep ? (names.get(r.rep) ?? null) : null,
        customerType: r.customer_type,
        productType: r.product_type,
        revenue: r.rev === null ? null : Number(r.rev),
        income: r.income === null ? null : Number(r.income),
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cấu hình (CRUD) — quyền reports:analytics_config
  // ─────────────────────────────────────────────────────────────────────────
  async getConfigOptions() {
    const [users, salePics, productTypes] = await Promise.all([
      this.prisma.$queryRaw<{ code: string; name: string }[]>`
        SELECT DISTINCT ON (split_part(email, '@', 1)) split_part(email, '@', 1) AS code, name
        FROM users
        WHERE email NOT LIKE '%@placeholder.local'
          AND ("isActive" OR split_part(email, '@', 1) IN (
            SELECT sale_code FROM analytics_kpi_revenue_targets
            UNION SELECT sale_code FROM analytics_kpi_product_targets
            UNION SELECT sale_code FROM analytics_kpi_sale_rep_rules
            UNION SELECT sale_code FROM analytics_kpi_income_rules))
        ORDER BY split_part(email, '@', 1), id`,
      this.prisma.$queryRaw<{ name: string }[]>`
        SELECT name FROM customer_groups
        WHERE name <> ALL(${CUSTOMER_TYPE_GROUPS}::text[]) ORDER BY name`,
      this.prisma.$queryRaw<{ name: string }[]>`
        SELECT DISTINCT parent_name AS name FROM products WHERE parent_name IS NOT NULL ORDER BY 1`,
    ]);
    return {
      users,
      customerGroups: salePics.map((r) => r.name),
      customerTypes: CUSTOMER_TYPE_GROUPS,
      productTypes: productTypes.map((r) => r.name),
      productGroups: KPI_PRODUCT_GROUPS,
      regions: ['Bắc', 'Trung', 'Nam', 'Chưa Phân Loại'],
    };
  }

  // ── Chỉ tiêu doanh số ────────────────────────────────────────────────────
  listRevenueTargets(year?: number) {
    return this.prisma.$queryRaw<unknown[]>`
      SELECT id, year, month, sale_code AS "saleCode", kpi_value::float8 AS "kpiValue",
             basic_salary::float8 AS "basicSalary", updated_at AS "updatedAt"
      FROM analytics_kpi_revenue_targets
      WHERE ${year ? Prisma.sql`year = ${year}` : Prisma.sql`true`}
      ORDER BY year DESC, sale_code, month`;
  }

  async createRevenueTarget(d: KpiRevenueTargetDto) {
    return this.write(
      'analytics_kpi_revenue_targets',
      Prisma.sql`
        INSERT INTO analytics_kpi_revenue_targets (year, month, sale_code, kpi_value, basic_salary)
        VALUES (${d.year}, ${d.month}, ${d.saleCode.trim()}, ${d.kpiValue}, ${d.basicSalary ?? 0})
        RETURNING id`,
    );
  }

  async updateRevenueTarget(id: number, d: KpiRevenueTargetUpdateDto) {
    return this.write(
      'analytics_kpi_revenue_targets',
      Prisma.sql`
        UPDATE analytics_kpi_revenue_targets SET
          year = COALESCE(${d.year ?? null}::int, year),
          month = COALESCE(${d.month ?? null}::int, month),
          sale_code = COALESCE(${d.saleCode?.trim() ?? null}::text, sale_code),
          kpi_value = COALESCE(${d.kpiValue ?? null}::float8, kpi_value),
          basic_salary = COALESCE(${d.basicSalary ?? null}::float8, basic_salary),
          updated_at = now()
        WHERE id = ${id} RETURNING id`,
    );
  }

  // ── Chỉ tiêu nhóm hàng ───────────────────────────────────────────────────
  listProductTargets(year?: number) {
    return this.prisma.$queryRaw<unknown[]>`
      SELECT id, year, month, sale_code AS "saleCode", product_group AS "productGroup",
             kpi_value::float8 AS "kpiValue", updated_at AS "updatedAt"
      FROM analytics_kpi_product_targets
      WHERE ${year ? Prisma.sql`year = ${year}` : Prisma.sql`true`}
      ORDER BY year DESC, sale_code, month, product_group`;
  }

  async createProductTarget(d: KpiProductTargetDto) {
    return this.write(
      'analytics_kpi_product_targets',
      Prisma.sql`
        INSERT INTO analytics_kpi_product_targets (year, month, sale_code, product_group, kpi_value)
        VALUES (${d.year}, ${d.month}, ${d.saleCode.trim()}, ${d.productGroup.trim()}, ${d.kpiValue})
        RETURNING id`,
    );
  }

  async updateProductTarget(id: number, d: KpiProductTargetUpdateDto) {
    return this.write(
      'analytics_kpi_product_targets',
      Prisma.sql`
        UPDATE analytics_kpi_product_targets SET
          year = COALESCE(${d.year ?? null}::int, year),
          month = COALESCE(${d.month ?? null}::int, month),
          sale_code = COALESCE(${d.saleCode?.trim() ?? null}::text, sale_code),
          product_group = COALESCE(${d.productGroup?.trim() ?? null}::text, product_group),
          kpi_value = COALESCE(${d.kpiValue ?? null}::float8, kpi_value),
          updated_at = now()
        WHERE id = ${id} RETURNING id`,
    );
  }

  // ── Quy tắc người đại diện ───────────────────────────────────────────────
  async listRepRules() {
    const rows = await this.prisma.$queryRaw<
      {
        id: number;
        priority: number;
        salePic: string;
        customerType: string | null;
        region: string | null;
        saleCode: string;
        validFrom: Date | null;
        validTo: Date | null;
        isActive: boolean;
        note: string | null;
      }[]
    >`
      SELECT id, priority, sale_pic AS "salePic", customer_type AS "customerType", region,
             sale_code AS "saleCode", valid_from AS "validFrom", valid_to AS "validTo",
             is_active AS "isActive", note
      FROM analytics_kpi_sale_rep_rules ORDER BY priority, id`;
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return rows.map((r) => ({
      ...r,
      validFrom: day(r.validFrom),
      validTo: day(r.validTo),
    }));
  }

  async createRepRule(d: KpiRepRuleDto) {
    this.checkRange(d.validFrom, d.validTo);
    return this.write(
      'analytics_kpi_sale_rep_rules',
      Prisma.sql`
        INSERT INTO analytics_kpi_sale_rep_rules
          (priority, sale_pic, customer_type, region, sale_code, valid_from, valid_to, is_active, note)
        VALUES (${d.priority}, ${d.salePic.trim()}, ${this.blank(d.customerType)}, ${this.blank(d.region)},
                ${d.saleCode.trim()}, ${d.validFrom || null}::date, ${d.validTo || null}::date,
                ${d.isActive ?? true}, ${this.blank(d.note)})
        RETURNING id`,
    );
  }

  async updateRepRule(id: number, d: KpiRepRuleUpdateDto) {
    this.checkRange(d.validFrom, d.validTo);
    // Trường có trong body (kể cả null) mới được ghi; thiếu = giữ nguyên.
    const has = (k: keyof KpiRepRuleUpdateDto) =>
      Object.prototype.hasOwnProperty.call(d, k) as boolean;
    return this.write(
      'analytics_kpi_sale_rep_rules',
      Prisma.sql`
        UPDATE analytics_kpi_sale_rep_rules SET
          priority = COALESCE(${d.priority ?? null}::int, priority),
          sale_pic = COALESCE(${d.salePic?.trim() ?? null}::text, sale_pic),
          customer_type = CASE WHEN ${has('customerType')} THEN ${this.blank(d.customerType)}::text ELSE customer_type END,
          region = CASE WHEN ${has('region')} THEN ${this.blank(d.region)}::text ELSE region END,
          sale_code = COALESCE(${d.saleCode?.trim() ?? null}::text, sale_code),
          valid_from = CASE WHEN ${has('validFrom')} THEN ${d.validFrom || null}::date ELSE valid_from END,
          valid_to = CASE WHEN ${has('validTo')} THEN ${d.validTo || null}::date ELSE valid_to END,
          is_active = COALESCE(${d.isActive ?? null}::boolean, is_active),
          note = CASE WHEN ${has('note')} THEN ${this.blank(d.note)}::text ELSE note END,
          updated_at = now()
        WHERE id = ${id} RETURNING id`,
    );
  }

  // ── Quy tắc tính thu nhập ────────────────────────────────────────────────
  listIncomeRules() {
    return this.prisma.$queryRaw<
      {
        id: number;
        saleCode: string;
        customerTypes: string[];
        productTypes: string[];
        productGroups: string[];
        isActive: boolean;
        note: string | null;
      }[]
    >`
      SELECT id, sale_code AS "saleCode", customer_types AS "customerTypes",
             product_types AS "productTypes", product_groups AS "productGroups",
             is_active AS "isActive", note
      FROM analytics_kpi_income_rules ORDER BY sale_code, id`;
  }

  async createIncomeRule(d: KpiIncomeRuleDto) {
    return this.write(
      'analytics_kpi_income_rules',
      Prisma.sql`
        INSERT INTO analytics_kpi_income_rules
          (sale_code, customer_types, product_types, product_groups, is_active, note)
        VALUES (${d.saleCode.trim()}, ${this.clean(d.customerTypes)}::text[], ${this.clean(d.productTypes)}::text[],
                ${this.clean(d.productGroups)}::text[], ${d.isActive ?? true}, ${this.blank(d.note)})
        RETURNING id`,
    );
  }

  async updateIncomeRule(id: number, d: KpiIncomeRuleUpdateDto) {
    const arr = (v?: string[]) => (v ? this.clean(v) : null);
    const has = (k: keyof KpiIncomeRuleUpdateDto) =>
      Object.prototype.hasOwnProperty.call(d, k) as boolean;
    return this.write(
      'analytics_kpi_income_rules',
      Prisma.sql`
        UPDATE analytics_kpi_income_rules SET
          sale_code = COALESCE(${d.saleCode?.trim() ?? null}::text, sale_code),
          customer_types = COALESCE(${arr(d.customerTypes)}::text[], customer_types),
          product_types = COALESCE(${arr(d.productTypes)}::text[], product_types),
          product_groups = COALESCE(${arr(d.productGroups)}::text[], product_groups),
          is_active = COALESCE(${d.isActive ?? null}::boolean, is_active),
          note = CASE WHEN ${has('note')} THEN ${this.blank(d.note)}::text ELSE note END,
          updated_at = now()
        WHERE id = ${id} RETURNING id`,
    );
  }

  // ── Gộp mã hàng ──────────────────────────────────────────────────────────
  listProductMaps() {
    return this.prisma.$queryRaw<
      {
        id: number;
        fromCode: string;
        toCode: string;
        fromName: string | null;
        toName: string | null;
        note: string | null;
      }[]
    >`
      SELECT m.id, m.from_code AS "fromCode", m.to_code AS "toCode",
             pf.name AS "fromName", pt.name AS "toName", m.note
      FROM analytics_kpi_product_code_maps m
      LEFT JOIN LATERAL (SELECT name FROM products WHERE code = m.from_code LIMIT 1) pf ON true
      LEFT JOIN LATERAL (SELECT name FROM products WHERE code = m.to_code LIMIT 1) pt ON true
      ORDER BY m.from_code`;
  }

  async createProductMap(d: KpiProductMapDto) {
    return this.write(
      'analytics_kpi_product_code_maps',
      Prisma.sql`
        INSERT INTO analytics_kpi_product_code_maps (from_code, to_code, note)
        VALUES (${d.fromCode.trim()}, ${d.toCode.trim()}, ${this.blank(d.note)})
        RETURNING id`,
    );
  }

  async updateProductMap(id: number, d: KpiProductMapUpdateDto) {
    const has = (k: keyof KpiProductMapUpdateDto) =>
      Object.prototype.hasOwnProperty.call(d, k) as boolean;
    return this.write(
      'analytics_kpi_product_code_maps',
      Prisma.sql`
        UPDATE analytics_kpi_product_code_maps SET
          from_code = COALESCE(${d.fromCode?.trim() ?? null}::text, from_code),
          to_code = COALESCE(${d.toCode?.trim() ?? null}::text, to_code),
          note = CASE WHEN ${has('note')} THEN ${this.blank(d.note)}::text ELSE note END,
          updated_at = now()
        WHERE id = ${id} RETURNING id`,
    );
  }

  // ── Xoá (dùng chung) ─────────────────────────────────────────────────────
  async deleteConfig(table: KpiConfigTable, id: number) {
    const name = KPI_CONFIG_TABLES[table];
    const n = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "${name}" WHERE id = $1`,
      id,
    );
    if (!n) throw new NotFoundException('Không tìm thấy dòng cấu hình');
    return { success: true };
  }

  // ── Tiện ích ghi ─────────────────────────────────────────────────────────
  private async write(table: string, sql: Prisma.Sql) {
    try {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>(sql);
      if (!rows.length)
        throw new NotFoundException('Không tìm thấy dòng cấu hình');
      return { id: rows[0].id, success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('duplicate key') || msg.includes('23505'))
        throw new BadRequestException(
          table === 'analytics_kpi_product_code_maps'
            ? 'Mã hàng này đã được gộp'
            : 'Đã có chỉ tiêu cho nhân viên / tháng này',
        );
      throw e;
    }
  }

  private blank(v?: string | null): string | null {
    const s = v?.trim();
    return s ? s : null;
  }

  private clean(v: string[]): string[] {
    return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
  }

  private checkRange(from?: string | null, to?: string | null) {
    if (from && to && from > to)
      throw new BadRequestException('"Từ ngày" phải trước "Đến ngày"');
  }
}
