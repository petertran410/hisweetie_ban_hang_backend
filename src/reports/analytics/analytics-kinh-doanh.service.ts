import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsReportsService } from '../analytics-reports.service';
import {
  CurrentPeriod,
  IsoDate,
  addDays,
  compareWindow,
  currentPeriod,
  daxDate,
  edate,
  isoWeekday,
  parts,
  todayVn,
} from './analytics-period';
import {
  KdChurnQueryDto,
  KdCustomerKeyDto,
  KdCustomerKeyUpdateDto,
  KdCustomerQueryDto,
  KdDlclColumnDto,
  KdDlclColumnUpdateDto,
  KdJamFlavorDto,
  KdJamFlavorUpdateDto,
  KdVisualTargetDto,
  KdVisualTargetUpdateDto,
  KdDashboardView,
  KdMetric,
  KdPivotQueryDto,
  KdQueryDto,
} from './analytics-kinh-doanh.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Phân tích › Kinh Doanh — các trang BC Định Kì, Khách Hàng, Sản Phẩm, Đối Thủ
// (thay các trang ẩn của report Power BI "Báo Cáo Kinh Doanh", dataset_sale).
//
// Dùng chung bộ tính toán của AnalyticsReportsService (baseCtes: hoá đơn đã lọc
// team sale + gộp hoá đơn cũ, khách cha, vùng…) rồi nối thêm CTE riêng:
//   kd_inv  = invx + tên khách, tỉnh, sale_pic, nhóm bán của người bán, cờ khách KEY…
//   kd_line = dòng hàng (line_raw) + mã/tên hàng + thuộc tính sản phẩm, áp bộ lọc sản phẩm
// Một hàm tổng hợp chung (agg) gom theo các chiều cho phép + các khoảng ngày (k).
//
// Quy ước như Power BI:
//   • Revenue (cấp hoá đơn) = SUM(total) hoá đơn chưa huỷ; Revenue Detail (cấp dòng)
//     = SUM(sub_total) dòng của hoá đơn chưa huỷ; Total Quantity = SUM(quantity) mọi dòng.
//   • Bộ lọc sản phẩm chỉ lọc dòng hàng (dim_product → invoice_detail), KHÔNG lọc
//     số cấp hoá đơn; switch_dynamics_metrics chuyển sang số cấp dòng khi có lọc /
//     trục sản phẩm.
// ═══════════════════════════════════════════════════════════════════════════

type Level = 'inv' | 'line';

export interface KRange {
  k: string;
  from: IsoDate;
  to: IsoDate;
}

export interface Metrics {
  amount: number;
  orders: number;
  customers: number;
  quantity: number;
  newCustomers: number;
  newAmount: number;
}

export interface AggOut extends Metrics {
  /** Số mã khách khác nhau (DISTINCTCOUNT(invoice[customer_code])). */
  codes: number;
  /** Ngày mua lớn nhất trong nhóm. */
  maxD: string | null;
  set: number;
  k: string;
  dims: Record<string, string | null>;
}

interface AggSpec {
  level: Level;
  sets: string[][];
  ranges: KRange[];
  where?: Prisma.Sql;
  needNew?: boolean;
  needLast?: boolean;
}

interface CteOpts {
  needNew?: boolean;
  needLast?: boolean;
}

/** WEEKNUM(date, 2) của DAX: tuần bắt đầu Thứ 2, tuần 1 chứa ngày 1/1. */
const WEEKNUM_SQL = `((extract(doy FROM x.d)::int - 1 + extract(isodow FROM date_trunc('year', x.d))::int - 1) / 7 + 1)`;

/** Các chiều được phép gom (biểu thức SQL cố định trên alias x của kd_inv / kd_line). */
const DIMS: Record<string, { sql: string; line?: boolean }> = {
  year: { sql: `extract(year FROM x.d)::int::text` },
  month: { sql: `extract(month FROM x.d)::int::text` },
  ym: { sql: `to_char(x.d, 'YYYY-MM')` },
  week: {
    sql: `(extract(year FROM x.d)::int * 100 + ${WEEKNUM_SQL})::text`,
  },
  day: { sql: `extract(day FROM x.d)::int::text` },
  weekday: { sql: `extract(isodow FROM x.d)::int::text` },
  date: { sql: `x.d::text` },
  customer_code: { sql: `x.customer_code` },
  customer_name: { sql: `x.customer_name` },
  parent_name: { sql: `x.parent_name` },
  customer_type: { sql: `x.customer_type` },
  region: { sql: `x.region` },
  province: { sql: `x.province` },
  sale_pic: { sql: `x.sale_pic` },
  sale_admin_pic: { sql: `x.sale_admin_pic` },
  cust_team: { sql: `x.cust_team` },
  team: { sql: `x.team_name` },
  seller: { sql: `x.seller_name` },
  invoice_code: { sql: `x.code` },
  is_key: { sql: `COALESCE(x.is_key, false)::text` },
  is_key_vip: { sql: `COALESCE(x.is_key_vip, false)::text` },
  last_d: { sql: `x.last_d::text` },
  has_pic: { sql: `(x.sale_admin_pic IS NOT NULL)::text` },
  product_code: { sql: `x.product_code`, line: true },
  product_name: { sql: `x.product_name`, line: true },
  product_type: { sql: `x.product_type`, line: true },
  brand: { sql: `x.brand`, line: true },
  category: { sql: `x.category`, line: true },
  group2026: { sql: `x.group2026`, line: true },
  visual_group: { sql: `x.visual_group`, line: true },
  jam_flavor: { sql: `x.jam_flavor`, line: true },
  jam_brand: { sql: `x.jam_brand`, line: true },
};

const BLANK = '__blank__';
/** Giá trị đại diện cho ô trống trong path của pivot. */
export const NULL_TOKEN = '__null__';
const SALE_PIC_GROUPS = ['thanhptp', 'anhmtv', 'phuongnt'];
const DLCL_GROUPS = {
  lermao: 'KH ĐLCL Mứt Lermao',
  boduo: 'KH ĐL BODUO',
  ph: 'KH ĐL Trà Phượng Hoàng',
};
const KEY_SALE_PIC: Record<string, string> = {
  'KEY Sale 1': 'thanhptp',
  'KEY Sale 2': 'anhmtv',
  'KEY Sale 3': 'tranglt',
  'KEY Sale 4': 'phuongnt',
  'KEY Sale 5': 'vuba',
};

/** Điều kiện cố định theo phạm vi biểu đồ (alias x = kd_inv, kc = kd_cust; pr = prod). */
const SCOPE_CUSTOMER: Record<string, string> = {
  keyLermao: 'kc.dlcl_lermao',
  lermaoKey: 'kc.dlcl_lermao',
  mutLermaoKey: 'kc.dlcl_lermao',
  boduoKey: 'kc.dlcl_boduo',
  phKey: 'kc.dlcl_ph',
  vip: 'x.is_vip',
};
const SCOPE_PRODUCT: Record<string, string> = {
  lermaoKey: `pr.product_type = 'Hàng thương hiệu' AND pr.brand = 'Lermao'`,
  mutLermaoKey: `pr.product_type = 'Hàng thương hiệu' AND pr.brand = 'Lermao' AND pr.category = 'Mứt'`,
  boduoKey: `pr.brand = 'Boduo'`,
  phKey: `pr.product_type = 'Hàng thương hiệu' AND pr.brand = 'Phượng Hoàng'`,
  lermaoPh: `pr.product_type = 'Hàng thương hiệu' AND pr.brand IN ('Lermao', 'Phượng Hoàng')`,
  toppingLermao: `pr.product_type = 'Hàng thương hiệu' AND pr.brand = 'Lermao'`,
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const ddmm = (d: IsoDate) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

@Injectable()
export class AnalyticsKinhDoanhService {
  constructor(
    private prisma: PrismaService,
    private base: AnalyticsReportsService,
  ) {}

  /**
   * $queryRaw chạy với JIT tắt: các câu tổng hợp lớn có chi phí ước lượng cao nên
   * Postgres bật JIT, riêng bước biên dịch mất vài giây (nhiều hơn cả thời gian chạy).
   */
  private async qr<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    const sql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$queryRaw<T>(sql),
    ]);
    return rows;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // BỘ TÍNH TOÁN CHUNG
  // ═════════════════════════════════════════════════════════════════════════

  /** Có lọc sản phẩm (ISFILTERED(dim_product)) → switch_dynamics_metrics dùng số cấp dòng. */
  productFiltered(q: KdQueryDto): boolean {
    return !!(
      (q.scope && SCOPE_PRODUCT[q.scope]) ||
      q.productGroup ||
      q.visualProductGroup ||
      q.productType ||
      q.brand ||
      q.category ||
      q.productCode
    );
  }

  /** Mức tính của switch_dynamics_metrics cho 1 biểu đồ. */
  levelFor(q: KdQueryDto, productAxis = false): Level {
    return this.productFiltered(q) || productAxis || q.metric === 'quantity'
      ? 'line'
      : 'inv';
  }

  /** CTE chung: baseCtes của Tổng Quan + kd_inv / kd_line. dateCond dùng alias x.d. */
  async ctes(
    q: KdQueryDto,
    dateCond: Prisma.Sql,
    opts: CteOpts = {},
  ): Promise<Prisma.Sql> {
    const base = await this.base.baseCtes(q, dateCond);
    const lake = await this.base.dataLakeReady();

    const custConds: Prisma.Sql[] = [];
    if (q.customerType)
      custConds.push(Prisma.sql`x.customer_type = ${q.customerType}`);
    if (q.specialGroup) custConds.push(this.specialGroupCond(q.specialGroup));
    const scopeCust = q.scope ? SCOPE_CUSTOMER[q.scope] : undefined;
    if (scopeCust) custConds.push(Prisma.raw(scopeCust));
    const custAnd = custConds.length
      ? Prisma.sql`AND ${Prisma.join(custConds, ' AND ')}`
      : Prisma.empty;

    const prodAnd = this.prodConds(q, Prisma.raw('l.product_code'));

    const oldSeller = lake
      ? Prisma.sql`
        UNION ALL
        SELECT x.code, s.seller_name, s.team_name
        FROM inv_raw x
        JOIN data_lake.invoice o ON o.code = x.code
        JOIN kd_seller s ON s.kiot_viet_id::text = o."soldById"
        WHERE NOT x.is_new`
      : Prisma.empty;

    const lastCtes = opts.needLast ? this.lastCte(lake) : Prisma.empty;

    // invoice[Is New Customer This Month]: tháng mua đầu tiên của KHÁCH CHA (mọi hoá đơn,
    // mọi người bán) trùng tháng của hoá đơn. Bảng khách cha → ngày mua đầu được tính sẵn
    // (parentFirstOrders, có cache) rồi truyền vào dạng JSON.
    const newCtes = opts.needNew
      ? Prisma.sql`
      kd_parent_first AS (
        SELECT key AS parent_name, value::date AS first_d
        FROM json_each_text(${JSON.stringify(await this.parentFirstOrders())}::json)
      ),`
      : Prisma.empty;
    const newExpr = opts.needNew
      ? Prisma.sql`COALESCE(date_trunc('month', pf.first_d) = date_trunc('month', x.d), false)`
      : Prisma.sql`false`;
    const newJoin = opts.needNew
      ? Prisma.sql`LEFT JOIN kd_parent_first pf ON pf.parent_name = x.parent_name`
      : Prisma.empty;

    const lastCols = opts.needLast
      ? Prisma.sql`kl.last_d, ${this.adminPicSql()} AS sale_admin_pic`
      : Prisma.sql`NULL::date AS last_d, NULL::text AS sale_admin_pic`;
    const lastJoin = opts.needLast
      ? Prisma.sql`LEFT JOIN kd_last kl ON kl.code = cu.code`
      : Prisma.empty;

    return Prisma.sql`
      ${base},
      kd_seller AS (
        SELECT DISTINCT ON (u.id) u.id AS user_id, u.kiot_viet_id, u.name AS seller_name, t.name AS team_name
        FROM analytics_sale_team_members m
        JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale
        JOIN users u ON u.id = m.user_id
        ORDER BY u.id
      ),
      kd_inv_seller AS MATERIALIZED (
        SELECT DISTINCT ON (z.code) z.* FROM (
          SELECT x.code, s.seller_name, s.team_name
          FROM inv_raw x
          JOIN invoices i ON i.id = x.id
          JOIN kd_seller s ON s.user_id = i."soldById"
          WHERE x.is_new
          ${oldSeller}
        ) z ORDER BY z.code
      ),
      kd_salepic AS (
        SELECT g."customerId", string_agg(DISTINCT cg.name, ', ' ORDER BY cg.name) AS sale_pic
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (${Prisma.join(SALE_PIC_GROUPS)})
        GROUP BY g."customerId"
      ),
      kd_cgroups AS (
        SELECT g."customerId",
          bool_or(cg.name = ${DLCL_GROUPS.lermao}) AS dlcl_lermao,
          bool_or(cg.name = ${DLCL_GROUPS.boduo}) AS dlcl_boduo,
          bool_or(cg.name = ${DLCL_GROUPS.ph}) AS dlcl_ph
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (${Prisma.join(Object.values(DLCL_GROUPS))})
        GROUP BY g."customerId"
      ),
      ${lastCtes}
      ${newCtes}
      kd_cust AS MATERIALIZED (
        SELECT cu.code, c.name AS customer_name, c."totalDebt"::float8 AS debt, c.groups,
          COALESCE(na."newCityName", oa."cityName") AS province,
          sp.sale_pic,
          CASE sp.sale_pic WHEN 'thanhptp' THEN 'Team Sale 1' WHEN 'anhmtv' THEN 'Team Sale 2'
                           WHEN 'phuongnt' THEN 'Team Sale 4' END AS cust_team,
          (k1.customer_code IS NOT NULL OR k2.customer_code IS NOT NULL) AS is_key,
          (COALESCE(k1.is_vip, false) OR COALESCE(k2.is_vip, false)) AS is_key_vip,
          COALESCE(cg.dlcl_lermao, false) AS dlcl_lermao,
          COALESCE(cg.dlcl_boduo, false) AS dlcl_boduo,
          COALESCE(cg.dlcl_ph, false) AS dlcl_ph,
          ${lastCols}
        FROM cust cu
        JOIN customers c ON c.id = cu.id
        LEFT JOIN addr_new na ON na."customerId" = cu.id
        LEFT JOIN addr_old oa ON oa."customerId" = cu.id
        LEFT JOIN kd_salepic sp ON sp."customerId" = cu.id
        LEFT JOIN kd_cgroups cg ON cg."customerId" = cu.id
        LEFT JOIN analytics_kd_customer_keys k1 ON k1.customer_code = cu.code
        LEFT JOIN analytics_kd_customer_keys k2 ON strpos(cu.code, '.1') > 0
             AND k2.customer_code = left(cu.code, strpos(cu.code, '.1') - 1)
        ${lastJoin}
      ),
      kd_inv AS MATERIALIZED (
        SELECT x.id, x.code, x.d, x.total, x.ok, x.is_new, x.customer_code, x.parent_name,
               x.customer_type, x.is_vip, x.region,
               kc.customer_name, kc.province, kc.debt, kc.groups, kc.sale_pic, kc.cust_team,
               kc.is_key, kc.is_key_vip, kc.dlcl_lermao, kc.dlcl_boduo, kc.dlcl_ph,
               kc.last_d, kc.sale_admin_pic,
               s.seller_name, s.team_name,
               ${newExpr} AS is_new_cust
        FROM invx x
        LEFT JOIN kd_cust kc ON kc.code = x.customer_code
        LEFT JOIN kd_inv_seller s ON s.code = x.code
        ${newJoin}
        WHERE true ${custAnd}
      ),
      kd_prod AS (
        SELECT DISTINCT ON (p.code) p.code, p.name, NULLIF(p."conversionValue", 0)::float8 AS convert_qty
        FROM products p ORDER BY p.code, p.id
      ),
      kd_line AS MATERIALIZED (
        SELECT x.*, l.product_code, kp.name AS product_name, kp.convert_qty,
               ROUND(l.quantity)::float8 AS quantity, ROUND(l.sub_total)::float8 AS sub_total,
               pr.product_type, pr.brand, pr.category, pr.group2026, pr.visual_group,
               jf.jam_flavor, jf.brand AS jam_brand
        FROM line_raw l
        JOIN kd_inv x ON x.code = l.code
        LEFT JOIN prod pr ON pr.code = l.product_code
        LEFT JOIN kd_prod kp ON kp.code = l.product_code
        LEFT JOIN analytics_kd_jam_flavors jf ON jf.product_code = l.product_code
        WHERE true ${prodAnd}
      )`;
  }

  /** Điều kiện lọc sản phẩm (alias pr = prod; codeExpr = biểu thức mã hàng). Trả "AND …" hoặc rỗng. */
  prodConds(q: KdQueryDto, codeExpr: Prisma.Sql): Prisma.Sql {
    const conds: Prisma.Sql[] = [];
    if (q.productGroup)
      conds.push(Prisma.sql`pr.group2026 = ${q.productGroup}`);
    if (q.visualProductGroup)
      conds.push(Prisma.sql`pr.visual_group = ${q.visualProductGroup}`);
    if (q.productType)
      conds.push(Prisma.sql`pr.product_type = ${q.productType}`);
    if (q.brand) conds.push(Prisma.sql`pr.brand = ${q.brand}`);
    if (q.category) conds.push(Prisma.sql`pr.category = ${q.category}`);
    if (q.productCode) conds.push(Prisma.sql`${codeExpr} = ${q.productCode}`);
    const scopeProd = q.scope ? SCOPE_PRODUCT[q.scope] : undefined;
    if (scopeProd) conds.push(Prisma.raw(scopeProd));
    return conds.length
      ? Prisma.sql`AND ${Prisma.join(conds, ' AND ')}`
      : Prisma.empty;
  }

  private parentFirstCache?: { at: number; data: Record<string, string> };
  private parentFirstPending?: Promise<Record<string, string>>;

  /** Ngày mua đầu tiên của từng khách cha trên mọi hoá đơn (cache 10 phút). */
  async parentFirstOrders(): Promise<Record<string, string>> {
    const c = this.parentFirstCache;
    if (c && Date.now() - c.at < 10 * 60_000) return c.data;
    if (this.parentFirstPending) return this.parentFirstPending;
    this.parentFirstPending = (async () => {
      const lake = await this.base.dataLakeReady();
      const old = lake
        ? Prisma.sql`UNION ALL
          SELECT o."customerCode", (o."purchaseDate" + interval '7 hour')::date
          FROM data_lake.invoice o WHERE o.status <> 2 AND o."customerCode" IS NOT NULL`
        : Prisma.empty;
      const rows = await this.qr<{ p: string; d: string }[]>`
        WITH rules AS (
          SELECT id, match_type, lower(pattern) AS pat, parent_name, priority
          FROM analytics_customer_parent_rules WHERE is_active
        ),
        allinv AS (
          SELECT c.code, MIN((i."purchaseDate" + interval '7 hour')::date) AS d
          FROM invoices i JOIN customers c ON c.id = i."customerId"
          WHERE i.status <> 2 GROUP BY c.code
          ${old}
        ),
        firsts AS (SELECT code, MIN(d) AS d FROM allinv GROUP BY code),
        allcust AS (
          SELECT DISTINCT ON (c.code) c.code, c.name FROM customers c
          WHERE c.code IN (SELECT code FROM firsts) ORDER BY c.code, c.id
        )
        SELECT COALESCE((
            SELECT r.parent_name FROM rules r
            WHERE (r.match_type = 'code' AND lower(ac.code) = r.pat)
               OR (r.match_type = 'name_contains' AND strpos(lower(ac.name), r.pat) > 0)
            ORDER BY r.priority, r.id LIMIT 1
          ), ac.name) AS p, MIN(f.d)::text AS d
        FROM allcust ac JOIN firsts f ON f.code = ac.code
        GROUP BY 1`;
      const data: Record<string, string> = {};
      for (const r of rows) if (r.p) data[r.p] = r.d;
      this.parentFirstCache = { at: Date.now(), data };
      return data;
    })().finally(() => {
      this.parentFirstPending = undefined;
    });
    return this.parentFirstPending;
  }

  /** kd_last: last_order_time của dim_customers = MAX ngày mua trên MỌI hoá đơn (mọi người bán) của khách trong cust. */
  private lastCte(lake: boolean): Prisma.Sql {
    const old = lake
      ? Prisma.sql`UNION ALL
          SELECT o."customerCode", (o."purchaseDate" + interval '7 hour')::date
          FROM data_lake.invoice o
          WHERE o.status <> 2 AND o."customerCode" IN (SELECT code FROM cust)`
      : Prisma.empty;
    return Prisma.sql`
      kd_last AS (
        SELECT z.code, MAX(z.d) AS last_d FROM (
          SELECT c.code, (i."purchaseDate" + interval '7 hour')::date AS d
          FROM invoices i JOIN customers c ON c.id = i."customerId"
          WHERE i.status <> 2 AND c.code IN (SELECT code FROM cust)
          ${old}
        ) z GROUP BY z.code
      ),`;
  }

  /**
   * dim_customers[sale_admin_pic] — chép nguyên DAX (alias cu = cust, sp = kd_salepic, kl = kd_last).
   * DAX so sánh chuỗi không phân biệt hoa thường; vùng so với "Bắc"/"Trung"/"Nam" (dữ liệu là
   * "Miền Bắc"…) nên nhánh Khách Buôn không bao giờ khớp — giữ nguyên như Power BI.
   */
  private adminPicSql(): Prisma.Sql {
    const m = (pics: string[]) =>
      Prisma.sql`sp.sale_pic IN (${Prisma.join(pics)})`;
    const branch = (pics: string[]) => Prisma.sql`
      WHEN ${m(pics)} AND lower(cu.customer_type) = lower('Khách buôn') AND cu.region IN ('Bắc','Trung') THEN 'Khách Buôn 1 (Miền Bắc + Miền Trung)'
      WHEN ${m(pics)} AND lower(cu.customer_type) = lower('Khách buôn') AND cu.region IN ('Nam') THEN 'Khách Buôn 2 (Miền Nam)'
      WHEN ${m(pics)} AND lower(cu.customer_type) = lower('Khách chuỗi') THEN 'Khách Chuỗi'
      WHEN ${m(pics)} AND lower(cu.customer_type) = lower('Khách lẻ') THEN 'Khách Lẻ'`;
    return Prisma.sql`CASE WHEN extract(year FROM kl.last_d) >= 2025 THEN (CASE
      WHEN cu.parent_name = 'Chuỗi Sunday Basic' AND cu.code <> 'KH002589' THEN NULL
      ${branch(['thanhptp'])}
      ${branch(['tranglt', 'anhmtv', 'phuongnt', 'vuba'])}
    END) END`;
  }

  /** query_customer_special_group: điều kiện trên kd_inv (alias x, các cột của kd_cust qua join). */
  private specialGroupCond(group: string): Prisma.Sql {
    if (group === 'ĐLCL Boduo') return Prisma.sql`kc.dlcl_boduo`;
    if (group === 'ĐLCL Lermao') return Prisma.sql`kc.dlcl_lermao`;
    if (group === 'ĐLCL Phượng Hoàng') return Prisma.sql`kc.dlcl_ph`;
    if (group === 'VIP Công Ty') return Prisma.sql`x.is_vip`;
    if (KEY_SALE_PIC[group])
      return Prisma.sql`(kc.is_key AND kc.sale_pic = ${KEY_SALE_PIC[group]})`;
    return Prisma.sql`strpos(COALESCE(kc.groups, ''), ${group}) > 0`;
  }

  /** Tổng hợp chung cho 1 phần (xem aggMulti). */
  async agg(q: KdQueryDto, spec: AggSpec): Promise<AggOut[]> {
    return (await this.aggMulti(q, [spec]))[0];
  }

  /**
   * Tổng hợp chung: mỗi phần gom số theo các bộ chiều (sets) × khoảng ngày (ranges, mỗi
   * khoảng có khoá k; một ngày có thể thuộc nhiều khoảng). Mọi phần chạy trong CÙNG một
   * câu SQL để dùng chung CTE (hoá đơn / khách / dòng hàng chỉ tính một lần).
   */
  async aggMulti(q: KdQueryDto, specs: AggSpec[]): Promise<AggOut[][]> {
    const parts = specs
      .map((spec, idx) => ({ spec, idx }))
      .filter((x) => x.spec.ranges.length && x.spec.sets.length);
    if (!parts.length) return specs.map(() => []);
    const allRanges = parts.flatMap((x) => x.spec.ranges);
    const from = allRanges.reduce(
      (a, r) => (r.from < a ? r.from : a),
      allRanges[0].from,
    );
    const to = allRanges.reduce(
      (a, r) => (r.to > a ? r.to : a),
      allRanges[0].to,
    );
    const ctes = await this.ctes(
      q,
      Prisma.sql`x.d BETWEEN ${from}::date AND ${to}::date`,
      {
        needNew: parts.some((x) => x.spec.needNew),
        needLast: parts.some((x) => x.spec.needLast),
      },
    );
    const union = [...new Set(parts.flatMap((x) => x.spec.sets.flat()))];
    const metricsSql = (level: Level) =>
      level === 'line'
        ? Prisma.sql`
          COALESCE(SUM(x.sub_total) FILTER (WHERE x.ok), 0)::float8 AS amount,
          COUNT(DISTINCT x.code) FILTER (WHERE x.ok)::int AS orders,
          COUNT(DISTINCT COALESCE(x.customer_code, ${BLANK})) FILTER (WHERE x.ok)::int AS customers,
          COALESCE(SUM(x.quantity), 0)::float8 AS quantity,
          0::int AS new_customers, 0::float8 AS new_amount,
          COUNT(DISTINCT COALESCE(x.customer_code, ${BLANK})) FILTER (WHERE x.ok)::int AS codes,
          MAX(x.d)::text AS max_d`
        : Prisma.sql`
          COALESCE(SUM(x.total) FILTER (WHERE x.ok), 0)::float8 AS amount,
          COUNT(DISTINCT x.code) FILTER (WHERE x.ok)::int AS orders,
          COUNT(DISTINCT COALESCE(x.parent_name, ${BLANK})) FILTER (WHERE x.ok)::int AS customers,
          0::float8 AS quantity,
          COUNT(DISTINCT COALESCE(x.parent_name, ${BLANK})) FILTER (WHERE x.is_new_cust)::int AS new_customers,
          COALESCE(SUM(x.total) FILTER (WHERE x.ok AND x.is_new_cust), 0)::float8 AS new_amount,
          COUNT(DISTINCT COALESCE(x.customer_code, ${BLANK})) FILTER (WHERE x.ok)::int AS codes,
          MAX(x.d)::text AS max_d`;

    // Chỉ mang theo các cột cần cho chỉ số (hàng hẹp → sắp xếp COUNT DISTINCT nhanh hơn).
    const baseCols = (level: Level) =>
      Prisma.raw(
        level === 'line'
          ? 'x.d, x.code, x.ok, x.sub_total, x.quantity, x.customer_code'
          : 'x.d, x.code, x.ok, x.total, x.parent_name, x.customer_code, x.is_new_cust',
      );
    const meta: { masks: number[]; sets: string[][] }[] = [];
    const selects = parts.map(({ spec }, pi) => {
      const dims = [...new Set(spec.sets.flat())];
      for (const d of dims) {
        if (!DIMS[d]) throw new Error(`Chiều không hợp lệ: ${d}`);
        if (DIMS[d].line && spec.level !== 'line')
          throw new Error(`Chiều ${d} chỉ có ở cấp dòng hàng`);
      }
      // GROUPING(...) → bitmask: bit = 1 khi chiều KHÔNG nằm trong bộ.
      const masks = spec.sets.map((set) =>
        dims.reduce(
          (m, d, i) => (set.includes(d) ? m : m | (1 << (dims.length - 1 - i))),
          0,
        ),
      );
      meta.push({ masks, sets: spec.sets });
      const uniqueSets = spec.sets.filter(
        (_, i) => masks.indexOf(masks[i]) === i,
      );
      const values = Prisma.join(
        spec.ranges.map(
          (r) => Prisma.sql`(${r.k}::text, ${r.from}::date, ${r.to}::date)`,
        ),
      );
      const dimCols = dims.map((d) =>
        Prisma.raw(`${DIMS[d].sql} AS "dim_${d}"`),
      );
      const outDims = union.map((d) =>
        dims.includes(d)
          ? Prisma.raw(`x."dim_${d}"`)
          : Prisma.raw(`NULL::text AS "dim_${d}"`),
      );
      const groupSets = Prisma.join(
        uniqueSets.map(
          (set) =>
            Prisma.sql`(${Prisma.join(
              [
                Prisma.raw('r.k'),
                ...set.map((d) => Prisma.raw(`x."dim_${d}"`)),
              ],
              ', ',
            )})`,
        ),
        ', ',
      );
      const gExpr = dims.length
        ? Prisma.sql`GROUPING(${Prisma.join(
            dims.map((d) => Prisma.raw(`x."dim_${d}"`)),
            ', ',
          )})::int`
        : Prisma.sql`0`;
      const table = Prisma.raw(spec.level === 'line' ? 'kd_line' : 'kd_inv');
      return Prisma.sql`
        SELECT ${pi}::int AS part, ${gExpr} AS g, r.k${union.length ? Prisma.sql`, ${Prisma.join(outDims, ', ')}` : Prisma.empty},
               ${metricsSql(spec.level)}
        FROM (
          SELECT ${baseCols(spec.level)}${dims.length ? Prisma.sql`, ${Prisma.join(dimCols, ', ')}` : Prisma.empty}
          FROM ${table} x WHERE ${spec.where ?? Prisma.sql`true`}
        ) x
        JOIN (VALUES ${values}) r(k, f, t) ON x.d BETWEEN r.f AND r.t
        GROUP BY GROUPING SETS (${groupSets})`;
    });

    const rows = await this.qr<Record<string, unknown>[]>`
      WITH ${ctes}
      ${Prisma.join(selects, ' UNION ALL ')}`;

    const out: AggOut[][] = specs.map(() => []);
    for (const r of rows) {
      const pi = Number(r.part);
      const { masks, sets } = meta[pi];
      const g = Number(r.g);
      masks.forEach((m, set) => {
        if (m !== g) return;
        const dims: Record<string, string | null> = {};
        for (const d of sets[set])
          dims[d] = (r[`dim_${d}`] as string | null) ?? null;
        out[parts[pi].idx].push({
          set,
          k: String(r.k),
          dims,
          amount: Number(r.amount ?? 0),
          orders: Number(r.orders ?? 0),
          customers: Number(r.customers ?? 0),
          quantity: Number(r.quantity ?? 0),
          newCustomers: Number(r.new_customers ?? 0),
          newAmount: Number(r.new_amount ?? 0),
          codes: Number(r.codes ?? 0),
          maxD: (r.max_d as string | null) ?? null,
        });
      });
    }
    return out;
  }

  /** Chỉ số của bộ chiều dims trong danh sách sets (không phân biệt thứ tự). */
  setIndex(sets: string[][], dims: string[]): number {
    const key = [...dims].sort().join('|');
    return sets.findIndex((s) => [...s].sort().join('|') === key);
  }

  /** Số khách mới theo kiểu New_Customers_ThisWeek: lần mua đầu (trong ngữ cảnh lọc, mọi ngày) rơi vào khoảng. */
  async firstOrderCustomers(
    q: KdQueryDto,
    ranges: KRange[],
  ): Promise<{ k: string; team: string | null; n: number; amount: number }[]> {
    if (!ranges.length) return [];
    const to = ranges.reduce((a, r) => (r.to > a ? r.to : a), ranges[0].to);
    const ctes = await this.ctes(q, Prisma.sql`x.d <= ${to}::date`);
    const values = Prisma.join(
      ranges.map(
        (r) => Prisma.sql`(${r.k}::text, ${r.from}::date, ${r.to}::date)`,
      ),
    );
    // team = NULL: toàn bộ; team = tên nhóm: lần mua đầu với nhóm bán đó (dòng dim_user[group_sale_name]).
    // Doanh số khách mới = SUM(invoice[total]) trong kỳ (DAX không lọc trạng thái).
    const rows = await this.qr<
      { k: string; team: string | null; n: number; amount: number }[]
    >`
      WITH ${ctes},
      f AS (
        SELECT CASE WHEN GROUPING(x.team_name) = 0 THEN COALESCE(x.team_name, '') END AS team,
               x.customer_code, MIN(x.d) AS first_d
        FROM kd_inv x WHERE x.customer_code IS NOT NULL
        GROUP BY GROUPING SETS ((x.customer_code), (x.team_name, x.customer_code))
      ),
      rr AS (SELECT * FROM (VALUES ${values}) r(k, f, t)),
      hit AS (
        SELECT rr.k, rr.f, rr.t, f.team, f.customer_code
        FROM rr JOIN f ON f.first_d BETWEEN rr.f AND rr.t
      ),
      amt AS (
        SELECT h.k, h.team, SUM(x.total) AS amount
        FROM hit h JOIN kd_inv x ON x.customer_code = h.customer_code
         AND x.d BETWEEN h.f AND h.t
         AND (h.team IS NULL OR COALESCE(x.team_name, '') = h.team)
        GROUP BY h.k, h.team
      )
      SELECT h.k, h.team, COUNT(*)::int AS n, COALESCE(MAX(a.amount), 0)::float8 AS amount
      FROM hit h LEFT JOIN amt a ON a.k = h.k AND a.team IS NOT DISTINCT FROM h.team
      GROUP BY h.k, h.team`;
    return rows.map((r) => ({
      k: String(r.k),
      team: r.team,
      n: Number(r.n),
      amount: Number(r.amount),
    }));
  }

  /** Chỉ tiêu doanh số tháng theo nhóm bán (KPI Sale: analytics_kpi_revenue_targets). */
  async teamTargets(
    q: KdQueryDto,
    year: number,
    months: number[],
  ): Promise<{ month: number; team: string; value: number }[]> {
    const team = q.saleTeamId
      ? Prisma.sql`AND t.id = ${q.saleTeamId}`
      : Prisma.empty;
    const rows = await this.qr<
      { month: number; team: string; value: number }[]
    >`
      WITH map AS (
        SELECT DISTINCT split_part(u.email, '@', 1) AS sale_code, t.name AS team
        FROM analytics_sale_team_members m
        JOIN analytics_sale_teams t ON t.id = m.team_id AND t.is_sale ${team}
        JOIN users u ON u.id = m.user_id
      )
      SELECT k.month, map.team, SUM(k.kpi_value)::float8 AS value
      FROM analytics_kpi_revenue_targets k JOIN map ON map.sale_code = k.sale_code
      WHERE k.year = ${year} AND k.month = ANY(${months}::int[])
      GROUP BY 1, 2`;
    return rows.map((r) => ({
      month: Number(r.month),
      team: r.team,
      value: Number(r.value),
    }));
  }

  /** Chỉ tiêu tháng theo nhóm hàng 2026 (kpi_product_group_2026 = tổng KPI Sale theo nhóm). */
  async group2026Targets(year: number, month: number) {
    const rows = await this.qr<{ g: string; v: number }[]>`
      SELECT product_group AS g, SUM(kpi_value)::float8 AS v
      FROM analytics_kpi_product_targets WHERE year = ${year} AND month = ${month}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.g, Number(r.v)]));
  }

  /** Chỉ tiêu tháng theo nhóm hàng hiển thị (kpi_product_group_2025). */
  async visualTargets(year: number, months: number[]) {
    const rows = await this.qr<{ g: string; m: number; v: number }[]>`
      SELECT visual_product_group AS g, month AS m, SUM(kpi_value)::float8 AS v
      FROM analytics_kd_visual_group_targets
      WHERE year = ${year} AND month = ANY(${months}::int[])
      GROUP BY 1, 2`;
    return rows.map((r) => ({ g: r.g, m: Number(r.m), v: Number(r.v) }));
  }

  /** Card "Nợ Hiện Tại": SUM(dim_customers[debt]) — chỉ chịu lọc theo khách (không theo ngày / người bán). */
  async currentDebt(q: KdQueryDto) {
    const conds: Prisma.Sql[] = [];
    if (q.customerGroupId)
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM customer_group_details g
        WHERE g."customerId" = c.id AND g."customerGroupId" = ${q.customerGroupId})`);
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`
      : Prisma.empty;
    if (q.parentName || q.region || q.customerType) {
      // Cần khách cha / vùng / loại khách → dùng custCte trên toàn bộ khách.
      await this.base.dataLakeReady();
      const cc: Prisma.Sql[] = [];
      if (q.parentName) cc.push(Prisma.sql`cu.parent_name = ${q.parentName}`);
      if (q.region) cc.push(Prisma.sql`cu.region = ${q.region}`);
      if (q.customerType)
        cc.push(Prisma.sql`cu.customer_type = ${q.customerType}`);
      const r = await this.qr<{ v: number }[]>`
        WITH ${this.base.custCte(Prisma.sql`true`)}
        SELECT COALESCE(SUM(c."totalDebt"), 0)::float8 AS v
        FROM cust cu JOIN customers c ON c.id = cu.id
        WHERE ${Prisma.join(cc, ' AND ')}
          ${q.customerGroupId ? Prisma.sql`AND EXISTS (SELECT 1 FROM customer_group_details g WHERE g."customerId" = c.id AND g."customerGroupId" = ${q.customerGroupId})` : Prisma.empty}`;
      return Number(r[0]?.v ?? 0);
    }
    const r = await this.qr<{ v: number }[]>`
      SELECT COALESCE(SUM(c."totalDebt"), 0)::float8 AS v FROM (
        SELECT DISTINCT ON (code) * FROM customers ORDER BY code, id
      ) c ${where}`;
    return Number(r[0]?.v ?? 0);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Kỳ
  // ─────────────────────────────────────────────────────────────────────────
  today(q: KdQueryDto): IsoDate {
    const t = todayVn();
    return q.refDate && q.refDate < t ? q.refDate : t;
  }

  period(q: KdQueryDto): CurrentPeriod | null {
    return currentPeriod(
      { year: q.year, months: q.months ?? [] },
      this.today(q),
    );
  }

  /** Các khoảng ngày (1 khoảng / tháng) của kỳ đang lọc, cùng khoá k. */
  periodRanges(p: CurrentPeriod, year: number, k: string): KRange[] {
    return p.months.map((m) => {
      let from = daxDate(year, m, 1);
      let to = daxDate(year, m + 1, 0);
      if (from < p.min) from = p.min;
      if (to > p.max) to = p.max;
      return { k, from, to };
    });
  }

  /** DATEADD(dates, -1, MONTH) cho 1 khoảng liên tục (ngày cuối tháng → cuối tháng trước). */
  shiftMonth(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate } {
    const t = parts(to);
    const isMonthEnd = daxDate(t.y, t.m + 1, 0) === to;
    return {
      from: edate(from, -1),
      to: isMonthEnd ? daxDate(t.y, t.m, 0) : edate(to, -1),
    };
  }

  /** Tuần (WEEKNUM kiểu 2) của 1 ngày: khoá yyyyww + nhãn "Tuần N (dd/MM - dd/MM)". */
  weekOf(d: IsoDate): { key: string; label: string; start: IsoDate } {
    const { y } = parts(d);
    const jan1 = daxDate(y, 1, 1);
    const doy =
      Math.round(
        (Date.UTC(parts(d).y, parts(d).m - 1, parts(d).d) - Date.UTC(y, 0, 1)) /
          86400000,
      ) + 1;
    const wn = Math.floor((doy - 1 + isoWeekday(jan1) - 1) / 7) + 1;
    const start = addDays(d, 1 - isoWeekday(d));
    const end = addDays(start, 6);
    return {
      key: String(y * 100 + wn),
      label: `Tuần ${wn} (${ddmm(start)} - ${ddmm(end)})`,
      start,
    };
  }

  /** Các tuần trong kỳ, mỗi tuần là các ngày thuộc kỳ (tuần cắt theo năm như WEEKNUM). */
  weekRanges(p: CurrentPeriod, year: number): (KRange & { label: string })[] {
    const out = new Map<string, KRange & { label: string }>();
    for (const r of this.periodRanges(p, year, '')) {
      let d = r.from;
      while (d <= r.to) {
        const w = this.weekOf(d);
        const cur = out.get(w.key);
        if (!cur) out.set(w.key, { k: w.key, from: d, to: d, label: w.label });
        else if (d > cur.to) cur.to = d;
        d = addDays(d, 1);
      }
    }
    return [...out.values()].sort((a, b) => a.from.localeCompare(b.from));
  }

  /** Tuần này / tuần trước / tháng này / tháng trước theo "hôm nay" (dim_date[week_offset], month_offset). */
  relRanges(today: IsoDate) {
    const { y, m } = parts(today);
    const weekStart = addDays(today, 1 - isoWeekday(today));
    const jan1 = daxDate(y, 1, 1);
    // revenue_detail_thisweek: WEEKNUM(TODAY) trong năm hiện tại (cắt theo năm, tới hôm nay)
    const thisWeek = { from: weekStart < jan1 ? jan1 : weekStart, to: today };
    const lastWeek = {
      from: addDays(weekStart, -7),
      to: addDays(weekStart, -1),
    };
    const prevWeek = {
      from: addDays(weekStart, -14),
      to: addDays(weekStart, -8),
    };
    const thisMonth = { from: daxDate(y, m, 1), to: today };
    const lastMonth = { from: daxDate(y, m - 1, 1), to: daxDate(y, m, 0) };
    return { thisWeek, lastWeek, prevWeek, thisMonth, lastMonth, weekStart };
  }

  metricOf(r: Metrics | undefined, metric: KdMetric = 'amount'): number {
    if (!r) return 0;
    return r[metric];
  }

  zero(): Metrics {
    return {
      amount: 0,
      orders: 0,
      customers: 0,
      quantity: 0,
      newCustomers: 0,
      newAmount: 0,
    };
  }

  div(a: number | null | undefined, b: number | null | undefined) {
    return a !== null && a !== undefined && b ? a / b : null;
  }

  growth(cur: number, prev: number) {
    return prev ? (cur - prev) / prev : null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DANH SÁCH CHO BỘ LỌC RIÊNG
  // ═════════════════════════════════════════════════════════════════════════
  async getOptions() {
    await this.base.dataLakeReady();
    const [
      types,
      brands,
      categories,
      products,
      parents,
      ctypes,
      demandCustomers,
    ] = await Promise.all([
      this.qr<{ v: string }[]>`
          SELECT DISTINCT parent_name AS v FROM products WHERE parent_name IS NOT NULL ORDER BY 1`,
      this.qr<{ v: string }[]>`
          SELECT DISTINCT tm.name AS v FROM trade_marks tm
          JOIN products p ON p."tradeMarkId" = tm.id ORDER BY 1`,
      this.qr<{ v: string }[]>`
          SELECT DISTINCT child_name AS v FROM products WHERE child_name IS NOT NULL ORDER BY 1`,
      this.qr<{ code: string; name: string }[]>`
          SELECT DISTINCT ON (p.code) p.code, p.name FROM products p
          WHERE EXISTS (SELECT 1 FROM invoice_details d WHERE d."productId" = p.id)
          ORDER BY p.code, p.id`,
      this.qr<{ v: string }[]>`
          WITH ${this.base.custCte(Prisma.sql`c.id IN (SELECT DISTINCT "customerId" FROM invoices WHERE status <> 2 AND "purchaseDate" >= now() - interval '2 year')`)}
          SELECT DISTINCT parent_name AS v FROM cust WHERE parent_name IS NOT NULL ORDER BY 1`,
      this.qr<{ v: string }[]>`
          SELECT name AS v FROM customer_groups
          WHERE name IN ('Khách chuỗi','Khách lẻ','Khách buôn') ORDER BY 1`,
      this.qr<{ code: string; name: string }[]>`
          SELECT DISTINCT c.code, c.name FROM customer_demands cd
          JOIN customers c ON c.id = cd.customer_id ORDER BY c.name`,
    ]);
    return {
      productTypes: types.map((r) => r.v),
      brands: brands.map((r) => r.v).filter(Boolean),
      categories: categories.map((r) => r.v),
      products: products.map((r) => ({ code: r.code, name: r.name })),
      parents: parents.map((r) => r.v),
      customerTypes: ctypes.map((r) => r.v),
      specialGroups: [
        'ĐLCL Boduo',
        'ĐLCL Lermao',
        'ĐLCL Phượng Hoàng',
        'VIP Công Ty',
        'KEY Sale 1',
        'KEY Sale 2',
        'KEY Sale 3',
        'KEY Sale 4',
        'KEY Sale 5',
        'Hiển Setup',
        'chị Bé Setup',
      ],
      demandCustomers,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG BC ĐỊNH KÌ — phần "Chi Tiết" (các pivot) + Nợ hiện tại
  // ═════════════════════════════════════════════════════════════════════════
  async getPeriodicDetail(q: KdQueryDto) {
    const today = this.today(q);
    const rel = this.relRanges(today);
    const { y, m } = parts(today);
    const lm = parts(rel.lastMonth.from);
    const period = this.period(q);
    const weeks = period ? this.weekRanges(period, q.year) : [];

    const relR: KRange[] = [
      { k: 'tw', ...rel.thisWeek },
      { k: 'lw', ...rel.lastWeek },
    ];
    const [[lines, weekly, revYear], debt, g26, vt, plan] = await Promise.all([
      this.aggMulti(q, [
        {
          level: 'line',
          sets: [[], ['group2026'], ['visual_group'], ['seller'], ['region']],
          ranges: relR,
        },
        { level: 'line', sets: [['visual_group'], []], ranges: weeks },
        {
          level: 'inv',
          sets: [[]],
          ranges: period ? this.periodRanges(period, q.year, 'p') : [],
        },
      ]),
      this.currentDebt(q),
      this.group2026Targets(y, m),
      this.visualTargets(lm.y === y ? y : y, [m]).then(async (cur) => {
        const last =
          lm.y === y
            ? await this.visualTargets(y, [lm.m])
            : await this.visualTargets(lm.y, [lm.m]);
        return { cur, last };
      }),
      period
        ? this.teamTargets(
            q,
            q.year,
            Array.from({ length: parts(period.max).m }, (_, i) => i + 1),
          )
        : Promise.resolve([]),
    ]);

    const pick = (set: number, dim: string | null, k: string) =>
      lines.find(
        (r) =>
          r.set === set &&
          r.k === k &&
          (dim === null || r.dims[Object.keys(r.dims)[0]] === dim),
      );
    const bySet = (set: number, dimKey: string) => {
      const keys = new Set(
        lines.filter((r) => r.set === set).map((r) => r.dims[dimKey] ?? null),
      );
      return [...keys].map((key) => ({
        key,
        thisWeek:
          lines.find(
            (r) => r.set === set && r.k === 'tw' && r.dims[dimKey] === key,
          )?.amount ?? 0,
        lastWeek:
          lines.find(
            (r) => r.set === set && r.k === 'lw' && r.dims[dimKey] === key,
          )?.amount ?? 0,
      }));
    };

    // O1: nhóm hàng 2026 — kế hoạch tuần = KPI tháng (tháng của hôm nay) / 4
    const o1 = bySet(1, 'group2026')
      .filter((r) => r.key !== null)
      .map((r) => {
        const plan = g26.has(r.key!) ? g26.get(r.key!)! / 4 : null;
        return {
          ...r,
          plan,
          rateThisWeek: this.div(r.thisWeek, plan),
          rateLastWeek: this.div(r.lastWeek, plan),
        };
      })
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    // O2: nhóm hàng hiển thị — tuần trước so với KPI tháng trước / 4
    const vtCur = new Map(vt.cur.map((t) => [t.g, t.v]));
    const vtLast = new Map(vt.last.map((t) => [t.g, t.v]));
    const o2 = bySet(2, 'visual_group')
      .filter((r) => r.key !== null)
      .map((r) => {
        const plan = vtCur.has(r.key!) ? vtCur.get(r.key!)! / 4 : null;
        const planLast = vtLast.has(r.key!) ? vtLast.get(r.key!)! / 4 : null;
        return {
          ...r,
          plan,
          rateThisWeek: this.div(r.thisWeek, plan),
          rateLastWeek: this.div(r.lastWeek, planLast),
        };
      })
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const staff = bySet(3, 'seller').sort((a, b) => b.thisWeek - a.thisWeek);
    const central = bySet(4, 'region').filter((r) => r.key === 'Miền Trung');
    const totals = {
      thisWeek: pick(0, null, 'tw')?.amount ?? 0,
      lastWeek: pick(0, null, 'lw')?.amount ?? 0,
    };

    // Pivot doanh số nhóm hàng × tuần (theo kỳ đang lọc)
    const weekCols = weeks.map((w) => ({ key: w.k, label: w.label }));
    const weeklyRows = new Map<string, Record<string, number>>();
    const weeklyTotal: Record<string, number> = {};
    for (const r of weekly) {
      if (r.set === 0) {
        const g = r.dims.visual_group ?? '(Trống)';
        if (!weeklyRows.has(g)) weeklyRows.set(g, {});
        weeklyRows.get(g)![r.k] = r.amount;
      } else weeklyTotal[r.k] = r.amount;
    }

    const revenue = revYear[0]?.amount ?? 0;
    const planYear = plan.reduce((s, t) => s + t.value, 0);

    return {
      today,
      ranges: rel,
      updatedAt: new Date().toISOString(),
      debt: {
        value: debt,
        revenue,
        plan: planYear || null,
        rate: this.div(revenue, planYear),
      },
      o1,
      o2,
      staff,
      central,
      totals,
      weekly: {
        columns: weekCols,
        rows: [...weeklyRows.entries()]
          .map(([group, values]) => ({ group, values }))
          .sort((a, b) => a.group.localeCompare(b.group)),
        total: weeklyTotal,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG BC ĐỊNH KÌ — bảng điều hành Tuần này / Tuần trước / Tháng (html_weekly…)
  // ═════════════════════════════════════════════════════════════════════════
  async getPeriodicDashboard(q: KdQueryDto, view: KdDashboardView) {
    const today = this.today(q);
    const rel = this.relRanges(today);
    const cur =
      view === 'week'
        ? rel.thisWeek
        : view === 'lastWeek'
          ? rel.lastWeek
          : rel.thisMonth;
    const prev =
      view === 'week'
        ? rel.lastWeek
        : view === 'lastWeek'
          ? rel.prevWeek
          : rel.lastMonth;
    // Tháng dùng để lấy KPI: tháng của "hôm nay" (KPI_target_*_thismonth).
    const { y, m } = parts(today);
    const R: KRange[] = [
      { k: 'c', ...cur },
      { k: 'p', ...prev },
    ];
    const div = view === 'month' ? 1 : 4;

    const [[lines, inv, top], newCus, teamKpi, g26, debtInfo] =
      await Promise.all([
        this.aggMulti(q, [
          {
            level: 'line',
            sets: [[], ['group2026'], ['visual_group'], ['region']],
            ranges: R,
          },
          { level: 'inv', sets: [[], ['team']], ranges: R },
          // Top 5 Lermao / Phượng Hoàng theo sản lượng (kỳ hiện tại)
          {
            level: 'line',
            sets: [['visual_group', 'product_name']],
            ranges: [{ k: 'c', ...cur }],
            where: Prisma.sql`x.visual_group IN ('4.Lermao', '5.Phượng Hoàng')`,
          },
        ]),
        this.firstOrderCustomers(q, R).then((rows) => ({
          byTeam: rows.filter((r) => r.team !== null),
          total: rows.filter((r) => r.team === null),
        })),
        this.teamTargets(q, y, [m]),
        this.group2026Targets(y, m),
        this.debtOver30(q, today),
      ]);

    const L = (set: number, k: string, key?: string, dim?: string) =>
      lines.find(
        (r) => r.set === set && r.k === k && (!dim || r.dims[dim] === key),
      );
    const I = (set: number, k: string, team?: string | null) =>
      inv.find(
        (r) =>
          r.set === set && r.k === k && (set === 0 || r.dims.team === team),
      );

    const kpiTotal = teamKpi.reduce((s, t) => s + t.value, 0);
    const revCur = L(0, 'c')?.amount ?? 0;
    const revPrev = L(0, 'p')?.amount ?? 0;
    const newTotal = (k: string) =>
      newCus.total.find((r) => r.k === k) ?? { n: 0, amount: 0 };

    const groups = [
      ...new Set(lines.filter((r) => r.set === 1).map((r) => r.dims.group2026)),
    ]
      .filter((g): g is string => !!g)
      .sort()
      .map((g) => {
        const c = L(1, 'c', g, 'group2026')?.amount ?? 0;
        const p = L(1, 'p', g, 'group2026')?.amount ?? 0;
        const plan = g26.has(g) ? g26.get(g)! / div : null;
        return {
          key: g,
          actual: c,
          previous: p,
          plan,
          rate: this.div(c, plan),
          growth: this.growth(c, p),
        };
      })
      .filter((r) => r.actual > 0);

    const visual = [
      ...new Set(
        lines.filter((r) => r.set === 2).map((r) => r.dims.visual_group),
      ),
    ]
      .filter((g): g is string => !!g)
      .sort()
      .map((g) => {
        const c = L(2, 'c', g, 'visual_group')?.amount ?? 0;
        const p = L(2, 'p', g, 'visual_group')?.amount ?? 0;
        return {
          key: g,
          actual: c,
          previous: p,
          share: this.div(c, revCur),
          growth: this.growth(c, p),
        };
      })
      .filter((r) => r.actual > 0);

    const teamNames = [
      ...new Set(inv.filter((r) => r.set === 1).map((r) => r.dims.team)),
    ].filter((t): t is string => !!t);
    const teams = teamNames
      .map((t) => {
        const c = I(1, 'c', t);
        const kpi = teamKpi
          .filter((x) => x.team === t)
          .reduce((s, x) => s + x.value, 0);
        const target = kpi ? kpi / div : null;
        return {
          team: t,
          revenue: c?.amount ?? 0,
          orders: c?.orders ?? 0,
          newCustomers:
            newCus.byTeam.find((r) => r.k === 'c' && r.team === t)?.n ?? 0,
          target,
          rate: this.div(c?.amount ?? 0, target),
        };
      })
      .filter((t) => t.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const topOf = (g: string) =>
      top
        .filter((r) => r.dims.visual_group === g && r.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5)
        .map((r) => ({
          name: r.dims.product_name ?? '(Trống)',
          quantity: r.quantity,
          amount: r.amount,
        }));

    const target = kpiTotal ? kpiTotal / div : null;
    return {
      view,
      today,
      current: cur,
      previous: prev,
      updatedAt: new Date().toISOString(),
      finance: {
        revenue: {
          current: revCur,
          previous: revPrev,
          growth: this.growth(revCur, revPrev),
        },
        orders: {
          current: I(0, 'c')?.orders ?? 0,
          previous: I(0, 'p')?.orders ?? 0,
          growth: this.growth(I(0, 'c')?.orders ?? 0, I(0, 'p')?.orders ?? 0),
        },
        kpi: { actual: revCur, target, rate: this.div(revCur, target) },
        central: {
          current: L(3, 'c', 'Miền Trung', 'region')?.amount ?? 0,
          previous: L(3, 'p', 'Miền Trung', 'region')?.amount ?? 0,
        },
      },
      groups,
      visual,
      debt: debtInfo,
      customers: {
        newCurrent: newTotal('c').n,
        newPrevious: newTotal('p').n,
        newAmountCurrent: newTotal('c').amount,
        newAmountPrevious: newTotal('p').amount,
      },
      teams,
      topLermao: topOf('4.Lermao'),
      topPhuongHoang: topOf('5.Phượng Hoàng'),
    };
  }

  /** Công nợ cuối kỳ (mọi khách) + số khách còn nợ và đã > 30 ngày chưa mua. */
  async debtOver30(q: KdQueryDto, today: IsoDate) {
    const lake = await this.base.dataLakeReady();
    const r = await this.qr<{ debt: number; n: number }[]>`
      WITH c AS (SELECT DISTINCT ON (code) id, code, "totalDebt" FROM customers ORDER BY code, id),
      last AS (
        SELECT code, MAX(d) AS d FROM (
          SELECT c.code, (i."purchaseDate" + interval '7 hour')::date AS d
          FROM invoices i JOIN customers c ON c.id = i."customerId" WHERE i.status <> 2
          ${lake ? Prisma.sql`UNION ALL SELECT o."customerCode", (o."purchaseDate" + interval '7 hour')::date FROM data_lake.invoice o WHERE o.status <> 2` : Prisma.empty}
        ) z GROUP BY code
      )
      SELECT COALESCE(SUM(c."totalDebt"), 0)::float8 AS debt,
             COUNT(DISTINCT c.code) FILTER (WHERE c."totalDebt" > 0
               AND (${today}::date - COALESCE(l.d, date '1899-12-30')) > 30)::int AS n
      FROM c LEFT JOIN last l ON l.code = c.code`;
    void q;
    return { total: Number(r[0]?.debt ?? 0), over30: Number(r[0]?.n ?? 0) };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG BC ĐỊNH KÌ — "Vùng" (html_region): tháng này theo vùng
  // ═════════════════════════════════════════════════════════════════════════
  async getPeriodicRegion(q: KdQueryDto) {
    const today = this.today(q);
    const rel = this.relRanges(today);
    const R: KRange[] = [
      { k: 'c', ...rel.thisMonth },
      { k: 'p', ...rel.lastMonth },
    ];
    const [[lines, inv, prods], newCus] = await Promise.all([
      this.aggMulti(q, [
        {
          level: 'line',
          sets: [['region'], [], ['region', 'customer_type']],
          ranges: R,
        },
        {
          level: 'inv',
          sets: [['region']],
          ranges: [{ k: 'c', ...rel.thisMonth }],
        },
        {
          level: 'line',
          sets: [['region', 'product_type', 'product_name']],
          ranges: [{ k: 'c', ...rel.thisMonth }],
          where: Prisma.sql`x.product_type IN ('Hàng thương hiệu', 'Hàng thương mại') AND x.region IS NOT NULL`,
        },
      ]),
      this.newCustomersByRegion(q, rel.thisMonth),
    ]);
    // active_customer_thismonth: DISTINCTCOUNT(invoice[customer_code]) → đếm theo mã khách.
    const activeByRegion = new Map(
      inv.map((r) => [r.dims.region ?? '', r.codes]),
    );
    const totalThis =
      lines.find((r) => r.set === 1 && r.k === 'c')?.amount ?? 0;
    const regions = [
      ...new Set(lines.filter((r) => r.set === 0).map((r) => r.dims.region)),
    ]
      .filter((x): x is string => !!x)
      .map((region) => {
        const c =
          lines.find(
            (r) => r.set === 0 && r.k === 'c' && r.dims.region === region,
          )?.amount ?? 0;
        const p =
          lines.find(
            (r) => r.set === 0 && r.k === 'p' && r.dims.region === region,
          )?.amount ?? 0;
        const orders = inv.find((r) => r.dims.region === region)?.orders ?? 0;
        const ct = (t: string) =>
          lines.find(
            (r) =>
              r.set === 2 &&
              r.k === 'c' &&
              r.dims.region === region &&
              r.dims.customer_type === t,
          )?.amount ?? 0;
        const top = (type: string) =>
          prods
            .filter(
              (r) =>
                r.dims.region === region &&
                r.dims.product_type === type &&
                r.amount > 0,
            )
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 10)
            .map((r) => ({
              name: r.dims.product_name ?? '(Trống)',
              amount: r.amount,
              quantity: r.quantity,
            }));
        return {
          region,
          current: c,
          previous: p,
          share: this.div(c, totalThis),
          growth: this.growth(c, p),
          activeCustomers: activeByRegion.get(region) ?? 0,
          newCustomers: newCus.get(region) ?? 0,
          orders,
          aov: this.div(c, orders),
          customerTypes: {
            le: ct('Khách lẻ'),
            buon: ct('Khách buôn'),
            chuoi: ct('Khách chuỗi'),
          },
          topBrand: top('Hàng thương hiệu'),
          topTrade: top('Hàng thương mại'),
        };
      })
      .sort((a, b) => b.current - a.current);
    return {
      today,
      month: rel.thisMonth,
      updatedAt: new Date().toISOString(),
      totalCurrent: totalThis,
      regions,
    };
  }

  /** New_Customers_ThisMonth theo vùng: khách có lần mua đầu (ngữ cảnh lọc, mọi ngày) trong tháng. */
  private async newCustomersByRegion(
    q: KdQueryDto,
    r: { from: IsoDate; to: IsoDate },
  ) {
    const ctes = await this.ctes(q, Prisma.sql`x.d <= ${r.to}::date`);
    const rows = await this.qr<{ region: string; n: number }[]>`
      WITH ${ctes},
      f AS (SELECT region, customer_code, MIN(d) AS first_d FROM kd_inv
            WHERE customer_code IS NOT NULL GROUP BY 1, 2)
      SELECT region, COUNT(*)::int AS n FROM f
      WHERE first_d BETWEEN ${r.from}::date AND ${r.to}::date AND region IS NOT NULL
      GROUP BY 1`;
    return new Map(rows.map((x) => [x.region, Number(x.n)]));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PIVOT CHUNG (matrix Power BI) — tải theo từng cấp khi mở nút
  // ═════════════════════════════════════════════════════════════════════════

  /** Các ngày của tuần số wn (WEEKNUM kiểu 2) trong năm y, cắt theo năm và hôm nay. */
  weekNumRange(y: number, wn: number, today: IsoDate) {
    if (wn < 1) return null;
    const jan1 = daxDate(y, 1, 1);
    const start = addDays(jan1, (wn - 1) * 7 - (isoWeekday(jan1) - 1));
    let from = start < jan1 ? jan1 : start;
    let to = addDays(start, 6);
    const dec31 = daxDate(y, 12, 31);
    if (to > dec31) to = dec31;
    if (to > today) to = today;
    if (from > to) return null;
    if (from > dec31) from = dec31;
    return { from, to };
  }

  private pathCond(rows: string[], path: string[]): Prisma.Sql {
    if (!path.length) return Prisma.sql`true`;
    return Prisma.join(
      path.map((v, i) => {
        const expr = Prisma.raw(DIMS[rows[i]].sql);
        return v === NULL_TOKEN
          ? Prisma.sql`${expr} IS NULL`
          : Prisma.sql`${expr} = ${v}`;
      }),
      ' AND ',
    );
  }

  async getPivot(q: KdPivotQueryDto) {
    const rows = q.rows;
    const path = q.path ?? [];
    if (path.length >= rows.length)
      throw new BadRequestException('path dài hơn số cấp dòng');
    const dim = rows[path.length];
    const period = this.period(q);
    const cols = q.cols ?? 'month';
    const growth = q.growth ?? 'none';
    if (!period)
      return { dim, columns: [], rows: [], total: null, metric: 'amount' };
    const today = this.today(q);
    const metric: KdMetric =
      growth === 'wow' ? 'amount' : (q.metric ?? 'amount');
    const ctxDims = rows.slice(0, path.length + 1);
    const rowLevel: Level =
      q.detail || growth === 'wow'
        ? 'line'
        : this.levelFor(
            q,
            ctxDims.some((d) => DIMS[d].line),
          );
    const totalLevel: Level =
      q.detail || growth === 'wow' ? 'line' : this.levelFor(q, false);

    // Cột
    const columns: { key: string; label: string; ranges: KRange[] }[] = [];
    if (cols === 'month') {
      for (const r of this.periodRanges(period, q.year, '')) {
        const m = parts(r.from).m;
        columns.push({
          key: String(m),
          label: `Tháng ${pad2(m)}`,
          ranges: [{ ...r, k: String(m) }],
        });
      }
    } else if (cols === 'week') {
      for (const w of this.weekRanges(period, q.year))
        columns.push({ key: w.k, label: w.label, ranges: [w] });
    }
    const R: KRange[] = [
      ...columns.flatMap((c) => c.ranges),
      ...this.periodRanges(period, q.year, 'T'),
    ];
    if (growth === 'mom') {
      for (const c of columns)
        for (const r of c.ranges)
          R.push({ k: `p${c.key}`, ...this.shiftMonth(r.from, r.to) });
      for (const r of this.periodRanges(period, q.year, ''))
        R.push({ k: 'pT', ...this.shiftMonth(r.from, r.to) });
    } else if (growth === 'wow') {
      const add = (k: string, y: number, wn: number) => {
        const cur = this.weekNumRange(y, wn, today);
        const prev = this.weekNumRange(y, wn - 1, today);
        if (cur) R.push({ k: `w${k}`, ...cur });
        if (prev) R.push({ k: `p${k}`, ...prev });
      };
      if (cols === 'week')
        for (const c of columns)
          add(c.key, Math.floor(Number(c.key) / 100), Number(c.key) % 100);
      const wk = Number(this.weekOf(period.max).key);
      add('T', Math.floor(wk / 100), wk % 100);
    }

    const where = this.pathCond(rows, path);
    const sameLevel = rowLevel === totalLevel || path.length > 0;
    const [main, tot] = await this.aggMulti(q, [
      {
        level: rowLevel,
        sets: path.length === 0 && sameLevel ? [[dim], []] : [[dim]],
        ranges: R,
        where,
        needLast: rows.includes('sale_admin_pic'),
      },
      {
        level: totalLevel,
        sets: [[]],
        ranges: path.length === 0 && !sameLevel ? R : [],
      },
    ]);

    const cellKeys = [...columns.map((c) => c.key), 'T'];
    const build = (list: AggOut[]) => {
      const byK = new Map(list.map((r) => [r.k, r]));
      const v: Record<string, [number, number, number, number]> = {};
      const g: Record<string, number | null> = {};
      for (const k of cellKeys) {
        const c = byK.get(k);
        if (c) v[k] = [c.amount, c.orders, c.quantity, c.customers];
        if (growth === 'mom') {
          const prev = this.metricOf(byK.get(`p${k}`), metric);
          g[k] = prev ? (this.metricOf(c, metric) - prev) / prev : null;
        } else if (growth === 'wow') {
          const prev = byK.get(`p${k}`)?.amount ?? 0;
          const cur = byK.get(`w${k}`)?.amount ?? 0;
          g[k] = prev ? (cur - prev) / prev : null;
        }
      }
      return { v, g };
    };
    const groups = new Map<string | null, AggOut[]>();
    for (const r of main) {
      if (r.set !== 0) continue;
      const key = r.dims[dim] ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const totalRows = path.length
      ? []
      : sameLevel
        ? main.filter((r) => r.set === 1)
        : tot;
    const metricIdx = { amount: 0, orders: 1, quantity: 2, customers: 3 }[
      metric
    ];
    const outRows = [...groups.entries()]
      .map(([key, list]) => ({ key, ...build(list) }))
      .filter((r) => r.v.T)
      .sort((a, b) => (b.v.T?.[metricIdx] ?? 0) - (a.v.T?.[metricIdx] ?? 0));
    return {
      dim,
      metric,
      columns: columns.map((c) => ({ key: c.key, label: c.label })),
      rows: outRows,
      total: path.length ? null : build(totalRows),
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG KHÁCH HÀNG
  // ═════════════════════════════════════════════════════════════════════════
  private axisDim(q: KdQueryDto): 'month' | 'day' | 'weekday' {
    return q.axis === 'day'
      ? 'day'
      : q.axis === 'weekday'
        ? 'weekday'
        : 'month';
  }

  /** Năm nay vs năm trước theo trục (switch_dynamics_metrics_sameYear). */
  private sameYearKRanges(p: CurrentPeriod, q: KdQueryDto): KRange[] {
    return this.base
      .sameYearRanges(p, q.year, q.axis ?? 'month')
      .map((r) => ({ k: `y:${r.k}`, from: r.from, to: r.to }));
  }

  private pick(
    list: AggOut[],
    set: number,
    k: string,
    dims: Record<string, string | null> = {},
  ) {
    return list.find(
      (r) =>
        r.set === set &&
        r.k === k &&
        Object.entries(dims).every(([d, v]) => r.dims[d] === v),
    );
  }

  private series(
    list: AggOut[],
    set: number,
    k: string,
    dim: string,
    metric: KdMetric,
  ) {
    return list
      .filter((r) => r.set === set && r.k === k)
      .map((r) => ({
        key: r.dims[dim] ?? null,
        value: this.metricOf(r, metric),
      }))
      .sort((a, b) => b.value - a.value);
  }

  async getCustomerSection(q: KdCustomerQueryDto) {
    const period = this.period(q);
    const updatedAt = new Date().toISOString();
    if (!period) return { section: q.section, period: null, updatedAt };
    const base = {
      section: q.section,
      updatedAt,
      period: { from: period.min, to: period.max },
    };
    switch (q.section) {
      case 'overview':
        return { ...base, ...(await this.customerOverview(q, period)) };
      case 'region':
        return { ...base, ...(await this.customerRegion(q, period)) };
      case 'detail':
        return { ...base, ...(await this.customerWow(q, period)) };
      case 'repeat':
        return { ...base, ...(await this.customerRepeat(q, period)) };
      case 'demand':
        return { ...base, ...(await this.customerDemand(q, period)) };
      case 'lermao':
      case 'mutLermao':
        return { ...base, ...(await this.customerLermao(q, period)) };
      case 'boduo':
      case 'phuongHoang':
        return { ...base, ...(await this.customerBrandKey(q, period)) };
      default:
        return base;
    }
  }

  /** Bookmark "Tất Cả": thẻ, xu hướng, cơ cấu khách / loại hàng, top khách, vùng, danh mục, tỉnh. */
  private async customerOverview(q: KdQueryDto, p: CurrentPeriod) {
    const metric = q.metric ?? 'amount';
    const lvl = this.levelFor(q);
    const axis = this.axisDim(q);
    const cmp = compareWindow(p);
    const cur = this.periodRanges(p, q.year, 'c');
    const extra: KRange[] = [
      ...cur.map((r) => ({
        k: `p:${parts(r.from).m}`,
        ...this.shiftMonth(r.from, r.to),
      })),
      ...this.sameYearKRanges(p, q),
    ];
    // switch_dynamics_metrics_all_brand bỏ lọc thương hiệu → chỉ cần truy vấn riêng khi đang lọc thương hiệu.
    const provSeparate = !!q.brand;
    const metricSets = [
      [],
      ['month'],
      [axis],
      ['customer_type', 'month'],
      ['parent_name'],
      ['region'],
      ...(provSeparate ? [] : [['province']]),
    ];
    const invSets = [[], ['is_key'], ['is_key_vip'], ['customer_type']];
    const lineSets = [
      [],
      ['product_type', 'month'],
      ['category'],
      ['customer_type'],
    ];
    const qAllBrand = { ...q, brand: undefined } as KdQueryDto;
    // 2 câu chạy song song: (1) các số cần kỳ so sánh / năm trước (khoảng ngày dài),
    // (2) các biểu đồ chỉ trong kỳ hiện tại (CTE nhỏ hơn).
    const [[inv, X], [M0, line], prov] = await Promise.all([
      this.aggMulti(q, [
        {
          level: 'inv',
          needNew: true,
          sets: invSets,
          ranges: [...cur, { k: 'p', from: cmp.from, to: cmp.to }],
        },
        // tháng trước (waterfall) / năm trước (xu hướng): chỉ cần tổng theo từng khoá
        { level: lvl, sets: [[]], ranges: extra },
      ]),
      this.aggMulti(q, [
        { level: lvl, sets: metricSets, ranges: cur },
        { level: 'line', sets: lineSets, ranges: cur },
      ]),
      provSeparate
        ? this.agg(qAllBrand, {
            level: this.levelFor(qAllBrand),
            sets: [['province']],
            ranges: cur,
          })
        : Promise.resolve(null),
    ]);
    const mi = (dims: string[]) => this.setIndex(metricSets, dims);
    const M = [...M0, ...X.map((r) => ({ ...r, set: mi([]) }))];
    const ii = (dims: string[]) => this.setIndex(invSets, dims);
    const li = (dims: string[]) => this.setIndex(lineSets, dims);

    const card = (
      pickV: (r: AggOut | undefined) => number | null,
      dims: Record<string, string> = {},
    ) => {
      const set = ii(Object.keys(dims));
      const c = pickV(this.pick(inv, set, 'c', dims));
      const pr = pickV(this.pick(inv, set, 'p', dims));
      return {
        current: c,
        previous: pr,
        growth: c !== null && pr ? (c - pr) / pr : null,
      };
    };
    const totalOf = (k: string) =>
      this.metricOf(this.pick(M, mi([]), k), metric);
    const monthVal = (m: number) =>
      this.metricOf(
        this.pick(M, mi(['month']), 'c', { month: String(m) }),
        metric,
      );
    return {
      metric,
      level: lvl,
      compareLabel: cmp.label,
      compareRange: { from: cmp.from, to: cmp.to },
      cards: {
        revenue: card((r) => r?.amount ?? 0),
        newCustomers: card((r) => r?.newCustomers ?? 0),
        keyPerSale: card((r) => r?.amount ?? 0, { is_key: 'true' }),
        activeCustomers: card((r) => r?.customers ?? 0),
        vip: card((r) => r?.amount ?? 0, { is_key_vip: 'true' }),
        arpc: card((r) => this.div(r?.amount ?? 0, r?.customers ?? 0)),
        aov: card((r) => this.div(r?.amount ?? 0, r?.orders ?? 0)),
        newRevenue: card((r) => r?.newAmount ?? 0),
      },
      trend: this.base.axisKeys(p, q.year, q.axis ?? 'month').map((k) => ({
        key: k,
        label: this.base.axisLabel(q.axis ?? 'month', Number(k)),
        current: this.metricOf(
          this.pick(M, mi([axis]), 'c', { [axis]: k }),
          metric,
        ),
        previous: totalOf(`y:${k}`),
      })),
      waterfall: p.months.map((m) => {
        const c = monthVal(m);
        const pr = totalOf(`p:${m}`);
        return {
          month: m,
          value: c,
          previous: pr,
          growth: pr ? (c - pr) / pr : null,
        };
      }),
      byCustomerTypeMonth: M.filter(
        (r) => r.set === mi(['customer_type', 'month']) && r.k === 'c',
      ).map((r) => ({
        month: Number(r.dims.month),
        key: r.dims.customer_type,
        value: this.metricOf(r, metric),
      })),
      byProductTypeMonth: line
        .filter((r) => r.set === li(['product_type', 'month']) && r.k === 'c')
        .map((r) => ({
          month: Number(r.dims.month),
          key: r.dims.product_type,
          value: this.metricOf(r, metric),
        })),
      topCustomers: this.series(
        M,
        mi(['parent_name']),
        'c',
        'parent_name',
        metric,
      ).slice(0, 10),
      byRegion: this.series(M, mi(['region']), 'c', 'region', metric),
      byCategory: this.series(line, li(['category']), 'c', 'category', metric),
      byProvince: prov
        ? this.series(prov, 0, 'c', 'province', metric)
        : this.series(M, mi(['province']), 'c', 'province', metric),
      byCustomerType: [
        ...inv
          .filter((r) => r.set === ii(['customer_type']) && r.k === 'c')
          .map((r) => r.dims.customer_type),
        '__total__',
      ].map((key) => {
        const tot = key === '__total__';
        const i = tot
          ? this.pick(inv, ii([]), 'c')
          : this.pick(inv, ii(['customer_type']), 'c', { customer_type: key });
        const l = tot
          ? this.pick(line, li([]), 'c')
          : this.pick(line, li(['customer_type']), 'c', { customer_type: key });
        return {
          key,
          quantity: l?.quantity ?? 0,
          orders: i?.orders ?? 0,
          revenue: l?.amount ?? 0,
          aov: this.div(i?.amount, i?.orders),
          aoc: this.div(i?.orders, i?.customers),
          arpc: this.div(i?.amount, i?.customers),
          newCustomers: i?.newCustomers ?? 0,
        };
      }),
    };
  }

  /** Bookmark "Vùng": xu hướng theo vùng, bảng theo vùng. */
  private async customerRegion(q: KdQueryDto, p: CurrentPeriod) {
    const metric = q.metric ?? 'amount';
    const lvl = this.levelFor(q);
    const axis = this.axisDim(q);
    const cur = this.periodRanges(p, q.year, 'c');
    const sets = [['region'], [], ['region', axis]];
    const [inv, line] = await this.aggMulti(q, [
      { level: 'inv', needNew: true, sets, ranges: cur },
      { level: 'line', sets, ranges: cur },
    ]);
    const M = lvl === 'inv' ? inv : line;
    const regions = [
      ...new Set(inv.filter((r) => r.set === 0).map((r) => r.dims.region)),
    ];
    const row = (key: string | null, total = false) => {
      const i = total
        ? this.pick(inv, 1, 'c')
        : this.pick(inv, 0, 'c', { region: key });
      const l = total
        ? this.pick(line, 1, 'c')
        : this.pick(line, 0, 'c', { region: key });
      return {
        key: total ? '__total__' : key,
        revenue: l?.amount ?? 0,
        activeCustomers: i?.customers ?? 0,
        aov: this.div(i?.amount, i?.orders),
        newCustomers: i?.newCustomers ?? 0,
      };
    };
    return {
      metric,
      axisKeys: this.base.axisKeys(p, q.year, q.axis ?? 'month').map((k) => ({
        key: k,
        label: this.base.axisLabel(q.axis ?? 'month', Number(k)),
      })),
      trend: M.filter((r) => r.set === 2).map((r) => ({
        region: r.dims.region,
        key: r.dims[axis],
        value: this.metricOf(r, metric),
      })),
      byRegion: this.series(M, 0, 'c', 'region', metric),
      table: [...regions.map((r) => row(r)), row(null, true)],
    };
  }

  /** Bookmark "Chi Tiết": 10 khách key tăng / giảm mua (Revenue WoW %, tuần cuối của kỳ). */
  private async customerWow(q: KdQueryDto, p: CurrentPeriod) {
    const today = this.today(q);
    const wk = Number(this.weekOf(p.max).key);
    const y = Math.floor(wk / 100);
    const wn = wk % 100;
    const cur = this.weekNumRange(y, wn, today);
    const prev = this.weekNumRange(y, wn - 1, today);
    if (!cur || !prev) return { week: null, increase: [], decrease: [] };
    const res = await this.agg({ ...q, scope: 'vip' } as KdQueryDto, {
      level: 'line',
      sets: [['parent_name']],
      ranges: [
        { k: 'w', ...cur },
        { k: 'p', ...prev },
      ],
    });
    const keys = [...new Set(res.map((r) => r.dims.parent_name))];
    const list = keys
      .map((key) => {
        const c = this.pick(res, 0, 'w', { parent_name: key })?.amount ?? 0;
        const pr = this.pick(res, 0, 'p', { parent_name: key })?.amount ?? 0;
        return {
          key,
          current: c,
          previous: pr,
          growth: pr ? (c - pr) / pr : null,
        };
      })
      .filter((r) => r.growth !== null);
    return {
      week: { ...cur, label: this.weekOf(cur.from).label, previous: prev },
      increase: [...list]
        .sort((a, b) => b.growth! - a.growth!)
        .filter((r) => r.growth! > 0)
        .slice(0, 10),
      decrease: [...list]
        .sort((a, b) => a.growth! - b.growth!)
        .filter((r) => r.growth! < 0)
        .slice(0, 10),
    };
  }

  /** Danh sách khách có sale_admin_pic (toàn bộ dim_customers, không theo ngày) — total_customer_pic. */
  private async picCustomers(q: KdQueryDto) {
    await this.base.dataLakeReady();
    const lake = await this.base.dataLakeReady();
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (q.parentName) conds.push(Prisma.sql`cu.parent_name = ${q.parentName}`);
    if (q.region) conds.push(Prisma.sql`cu.region = ${q.region}`);
    if (q.customerType)
      conds.push(Prisma.sql`cu.customer_type = ${q.customerType}`);
    if (q.customerGroupId)
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM customer_group_details g
        WHERE g."customerId" = cu.id AND g."customerGroupId" = ${q.customerGroupId})`);
    const rows = await this.qr<
      {
        code: string;
        name: string;
        parent_name: string | null;
        region: string | null;
        province: string | null;
        cust_team: string | null;
        sale_admin_pic: string;
        last_d: Date | null;
      }[]
    >`
      WITH ${this.base
        .custCte(Prisma.sql`c.id IN (SELECT g."customerId" FROM customer_group_details g
             JOIN customer_groups cg ON cg.id = g."customerGroupId" WHERE cg.name IN (${Prisma.join(SALE_PIC_GROUPS)}))`)},
      kd_salepic AS (
        SELECT g."customerId", string_agg(DISTINCT cg.name, ', ' ORDER BY cg.name) AS sale_pic
        FROM customer_group_details g JOIN customer_groups cg ON cg.id = g."customerGroupId"
        WHERE cg.name IN (${Prisma.join(SALE_PIC_GROUPS)})
        GROUP BY g."customerId"
      ),
      ${this.lastCte(lake)}
      pc AS (
        SELECT cu.code, c.name, cu.parent_name, cu.region,
          COALESCE(na."newCityName", oa."cityName") AS province,
          CASE sp.sale_pic WHEN 'thanhptp' THEN 'Team Sale 1' WHEN 'anhmtv' THEN 'Team Sale 2'
                           WHEN 'phuongnt' THEN 'Team Sale 4' END AS cust_team,
          ${this.adminPicSql()} AS sale_admin_pic, kl.last_d
        FROM cust cu JOIN customers c ON c.id = cu.id
        LEFT JOIN addr_new na ON na."customerId" = cu.id
        LEFT JOIN addr_old oa ON oa."customerId" = cu.id
        LEFT JOIN kd_salepic sp ON sp."customerId" = cu.id
        LEFT JOIN kd_last kl ON kl.code = cu.code
        WHERE ${Prisma.join(conds, ' AND ')}
      )
      SELECT * FROM pc WHERE sale_admin_pic IS NOT NULL`;
    return rows;
  }

  /** Đếm khách cha phân bổ (total_customer_pic) theo các chiều. */
  private picCount(list: { parent_name: string | null }[]): number {
    return new Set(list.map((r) => r.parent_name).filter((x) => x !== null))
      .size;
  }

  /** Bookmark "Repeat Customer": tỷ lệ khách cũ tái mua, khách phụ trách, pivot & danh sách theo Sale Admin. */
  private async customerRepeat(q: KdQueryDto, p: CurrentPeriod) {
    const cur = this.periodRanges(p, q.year, 'c');
    const ytdFrom = daxDate(parts(p.max).y, 1, 1);
    const mtdFrom = daxDate(parts(p.max).y, parts(p.max).m, 1);
    const lm = this.periodRanges(p, q.year, 'lm').map((r) => ({
      k: 'lm',
      ...this.shiftMonth(r.from, r.to),
    }));
    const sets = [
      ['sale_admin_pic', 'ym'],
      ['sale_admin_pic', 'region', 'ym'],
      ['sale_admin_pic'],
      ['sale_admin_pic', 'region'],
      ['ym'],
      [],
      ['has_pic'],
      ['has_pic', 'ym'],
    ];
    const [[all, perCus], pics] = await Promise.all([
      this.aggMulti(q, [
        { level: 'inv', needNew: true, needLast: true, sets, ranges: cur },
        {
          level: 'inv',
          needLast: true,
          where: Prisma.sql`x.sale_admin_pic IS NOT NULL`,
          sets: [['customer_code']],
          ranges: [
            { k: 'ytd', from: ytdFrom, to: p.max },
            { k: 'mtd', from: mtdFrom, to: p.max },
            ...lm,
          ],
        },
      ]),
      this.picCustomers(q),
    ]);
    const inv = all.filter((r) => r.set <= 5);
    // Số của riêng khách có sale_admin_pic (FILTER(dim_customers, NOT ISBLANK(sale_admin_pic))).
    const picInv = all
      .filter(
        (r) =>
          r.k === 'c' &&
          (r.set === 6 || r.set === 7) &&
          r.dims.has_pic === 'true',
      )
      .map((r) => ({ ...r, set: r.set === 6 ? 0 : 1 }));
    const picTotal = (f: (r: (typeof pics)[number]) => boolean) =>
      this.picCount(pics.filter(f));
    const rate = (active: number, nw: number, total: number) =>
      this.div(active - nw, total - nw);
    const cell = (r: AggOut | undefined, total: number) => ({
      revenue: r?.amount ?? 0,
      orders: r?.orders ?? 0,
      active: r?.customers ?? 0,
      newCustomers: r?.newCustomers ?? 0,
      picTotal: total,
      // Dòng không có Sale Admin: FILTER(sale_admin_pic không trống) rỗng → BLANK.
      rate: r && total ? rate(r.customers, r.newCustomers, total) : null,
    });

    const groups = [
      ...new Set(
        inv.filter((r) => r.set === 2).map((r) => r.dims.sale_admin_pic),
      ),
    ];
    const months = [
      ...new Set(inv.filter((r) => r.set === 4).map((r) => r.dims.ym!)),
    ].sort();
    const pivot = groups.map((g) => {
      const tot = g ? picTotal((x) => x.sale_admin_pic === g) : 0;
      const regions = [
        ...new Set(
          inv
            .filter((r) => r.set === 3 && r.dims.sale_admin_pic === g)
            .map((r) => r.dims.region),
        ),
      ];
      return {
        key: g,
        cells: Object.fromEntries(
          months.map((m) => [
            m,
            cell(this.pick(inv, 0, 'c', { sale_admin_pic: g, ym: m }), tot),
          ]),
        ),
        total: cell(this.pick(inv, 2, 'c', { sale_admin_pic: g }), tot),
        children: regions.map((rg) => {
          const t2 = g
            ? picTotal((x) => x.sale_admin_pic === g && x.region === rg)
            : 0;
          return {
            key: rg,
            cells: Object.fromEntries(
              months.map((m) => [
                m,
                cell(
                  this.pick(inv, 1, 'c', {
                    sale_admin_pic: g,
                    region: rg,
                    ym: m,
                  }),
                  t2,
                ),
              ]),
            ),
            total: cell(
              this.pick(inv, 3, 'c', { sale_admin_pic: g, region: rg }),
              t2,
            ),
          };
        }),
      };
    });
    const allPic = this.picCount(pics);
    const totalRow = {
      key: '__total__',
      cells: Object.fromEntries(
        months.map((m) => {
          const all = this.pick(inv, 4, 'c', { ym: m });
          const sub = this.pick(picInv, 1, 'c', { ym: m });
          return [
            m,
            {
              ...cell(all, allPic),
              rate: sub ? rate(sub.customers, sub.newCustomers, allPic) : null,
            },
          ];
        }),
      ),
      total: {
        ...cell(this.pick(inv, 5, 'c'), allPic),
        rate: (() => {
          const s = this.pick(picInv, 0, 'c');
          return s ? rate(s.customers, s.newCustomers, allPic) : null;
        })(),
      },
    };

    const byGroup = groups
      .filter((g): g is string => !!g)
      .map((g) => {
        const r = this.pick(inv, 2, 'c', { sale_admin_pic: g });
        const t = picTotal((x) => x.sale_admin_pic === g);
        return {
          key: g,
          rate: r ? rate(r.customers, r.newCustomers, t) : null,
        };
      });
    const byGroupRegion = inv
      .filter((r) => r.set === 3 && r.dims.sale_admin_pic)
      .map((r) => {
        const t = picTotal(
          (x) =>
            x.sale_admin_pic === r.dims.sale_admin_pic &&
            x.region === r.dims.region,
        );
        return {
          group: r.dims.sale_admin_pic,
          region: r.dims.region,
          rate: rate(r.customers, r.newCustomers, t),
        };
      });
    const teamRegion = new Map<string, Set<string>>();
    for (const x of pics) {
      if (!x.parent_name) continue;
      const k = `${x.cust_team ?? ''}|${x.region ?? ''}`;
      if (!teamRegion.has(k)) teamRegion.set(k, new Set());
      teamRegion.get(k)!.add(x.parent_name);
    }
    const perCode = new Map<string, Map<string, number>>();
    for (const r of perCus) {
      const code = r.dims.customer_code ?? '';
      if (!perCode.has(code)) perCode.set(code, new Map());
      perCode.get(code)!.set(r.k, r.amount);
    }
    const customers = pics
      .map((x) => {
        const m = perCode.get(x.code);
        const ytd = m?.get('ytd') ?? null;
        const mtd = m?.get('mtd') ?? null;
        const last = m?.get('lm') ?? null;
        return {
          code: x.code,
          name: x.name,
          parentName: x.parent_name,
          group: x.sale_admin_pic,
          province: x.province,
          lastOrder: x.last_d ? x.last_d.toISOString().slice(0, 10) : null,
          ytd,
          lastMonth: last,
          currentMonth: mtd,
          mom: mtd !== null && last ? (mtd - last) / last : null,
        };
      })
      .sort((a, b) => (b.ytd ?? 0) - (a.ytd ?? 0));

    return {
      months,
      byGroup,
      byGroupRegion,
      picByTeamRegion: [...teamRegion.entries()].map(([k, set]) => {
        const [team, region] = k.split('|');
        return { team: team || null, region: region || null, value: set.size };
      }),
      pivot: [...pivot, totalRow],
      customers: customers.slice(0, 2000),
      customerCount: customers.length,
    };
  }

  /** Bookmark "Churn Customer": khách lâu chưa mua (churn_sale_group) + theo người bán. */
  async getCustomerChurn(q: KdChurnQueryDto) {
    const p = this.period(q);
    if (!p) return { period: null, customers: [], bySalePic: [] };
    const today = this.today(q);
    const group = q.churnGroup ?? '1.Khách Churn';
    const cd = Prisma.sql`(${today}::date - x.last_d)`;
    const grp = Prisma.sql`CASE
      WHEN (x.customer_type = 'Khách buôn' AND ${cd} BETWEEN 10 AND 45)
        OR (x.customer_type = 'Khách chuỗi' AND ${cd} BETWEEN 15 AND 45)
        OR (x.customer_type = 'Khách lẻ' AND ${cd} BETWEEN 30 AND 60) THEN '1.Khách Churn'
      WHEN (x.customer_type IN ('Khách buôn', 'Khách chuỗi') AND ${cd} > 45)
        OR (x.customer_type = 'Khách lẻ' AND ${cd} > 60) THEN '2.Khách bỏ mã'
      ELSE '3.Bình thường' END`;
    const where =
      group === 'all' ? Prisma.sql`true` : Prisma.sql`${grp} = ${group}`;
    const metric = q.metric ?? 'amount';
    const cur = this.periodRanges(p, q.year, 'c');
    const [inv, line] = await this.aggMulti(q, [
      {
        level: this.levelFor(q),
        needLast: true,
        where,
        sets: [
          [
            'customer_code',
            'customer_name',
            'parent_name',
            'sale_pic',
            'last_d',
          ],
        ],
        ranges: cur,
      },
      {
        level: 'line',
        needLast: true,
        where,
        sets: [['customer_code', 'product_name']],
        ranges: cur,
      },
    ]);
    const prods = new Map<string, { name: string | null; value: number }[]>();
    for (const r of line) {
      const c = r.dims.customer_code ?? '';
      if (!prods.has(c)) prods.set(c, []);
      prods
        .get(c)!
        .push({ name: r.dims.product_name, value: this.metricOf(r, metric) });
    }
    const customers = inv
      .map((r) => {
        const last = r.dims.last_d;
        return {
          code: r.dims.customer_code,
          name: r.dims.customer_name,
          lastOrder: last,
          churnDays: last
            ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000)
            : null,
          value: this.metricOf(r, metric),
          products: (prods.get(r.dims.customer_code ?? '') ?? []).sort(
            (a, b) => b.value - a.value,
          ),
        };
      })
      .sort((a, b) => (b.churnDays ?? 0) - (a.churnDays ?? 0));
    const bySale = new Map<string, Set<string>>();
    for (const r of inv) {
      const k = r.dims.sale_pic ?? '(Trống)';
      if (!bySale.has(k)) bySale.set(k, new Set());
      if (r.dims.parent_name) bySale.get(k)!.add(r.dims.parent_name);
    }
    return {
      period: { from: p.min, to: p.max },
      today,
      group,
      metric,
      customerCount: customers.length,
      customers: customers.slice(0, 500),
      bySalePic: [...bySale.entries()]
        .map(([key, s]) => ({ key, value: s.size }))
        .sort((a, b) => b.value - a.value),
    };
  }

  /** Bookmark "Demand": Theo dõi Demand Maycha (nhu cầu khách khai báo vs thực mua). */
  private async customerDemand(q: KdCustomerQueryDto, p: CurrentPeriod) {
    const bulk = q.unit === 'bulk';
    const from = daxDate(q.year, p.months[0], 1);
    const to = daxDate(q.year, p.months[p.months.length - 1], 1);
    const custCond = q.demandCustomer
      ? Prisma.sql`AND c.code = ${q.demandCustomer}`
      : Prisma.empty;
    const demand = await this.qr<
      {
        code: string;
        product_code: string;
        product_name: string;
        m: number;
        qty: number;
      }[]
    >`
      SELECT c.code, pr.code AS product_code, pr.name AS product_name,
             extract(month FROM dm.demand_month)::int AS m,
             SUM(${bulk ? Prisma.sql`l.quantity_base / NULLIF(pr."conversionValue", 0)` : Prisma.sql`l.quantity_base`})::float8 AS qty
      FROM customer_demands d
      JOIN customer_demand_months dm ON dm.demand_id = d.id
      JOIN customer_demand_lines l ON l.demand_month_id = dm.id
      JOIN customers c ON c.id = d.customer_id
      JOIN products pr ON pr.id = l.product_id
      WHERE dm.status <> 'CANCELLED' AND dm.demand_month BETWEEN ${from}::date AND ${to}::date
        AND extract(month FROM dm.demand_month)::int = ANY(${p.months}::int[]) ${custCond}
      GROUP BY 1, 2, 3, 4`;
    const codes = [...new Set(demand.map((r) => r.code))];
    const actual = codes.length
      ? await (async () => {
          const ctes = await this.ctes(q, this.base.periodCond(p));
          return this.qr<
            {
              product_code: string;
              product_name: string;
              m: number;
              qty: number;
            }[]
          >`
            WITH ${ctes}
            SELECT x.product_code, x.product_name, extract(month FROM x.d)::int AS m,
                   SUM(${bulk ? Prisma.sql`x.quantity / NULLIF(x.convert_qty, 0)` : Prisma.sql`x.quantity`})::float8 AS qty
            FROM kd_line x WHERE x.customer_code IN (${Prisma.join(codes)})
            GROUP BY 1, 2, 3`;
        })()
      : [];
    const products = new Map<
      string,
      {
        name: string;
        demand: Record<number, number>;
        actual: Record<number, number>;
      }
    >();
    const get = (code: string, name: string) => {
      if (!products.has(code))
        products.set(code, { name, demand: {}, actual: {} });
      return products.get(code)!;
    };
    for (const r of demand) {
      const x = get(r.product_code, r.product_name);
      x.demand[r.m] = (x.demand[r.m] ?? 0) + Number(r.qty ?? 0);
    }
    for (const r of actual) {
      if (!products.has(r.product_code)) continue; // chỉ sản phẩm có demand
      const x = get(r.product_code, r.product_name);
      x.actual[r.m] = (x.actual[r.m] ?? 0) + Number(r.qty ?? 0);
    }
    return {
      unit: bulk ? 'bulk' : 'base',
      months: p.months,
      customers: codes.length,
      rows: [...products.entries()]
        .map(([code, v]) => ({ code, ...v }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Bookmark ĐLCL Lermao / Mứt Lermao: bảng KHCL Lermao (khách × sản phẩm) + chi tiết. */
  private async customerLermao(q: KdCustomerQueryDto, p: CurrentPeriod) {
    const mut = q.section === 'mutLermao';
    const scope = mut ? 'mutLermaoKey' : 'lermaoKey';
    const [dlcl, lines] = await Promise.all([
      mut ? Promise.resolve(null) : this.dlclPivot(q, p),
      mut
        ? this.lineListing({ ...q, scope } as KdQueryDto, p)
        : Promise.resolve(undefined),
    ]);
    return { scope, dlcl, lines };
  }

  /** Field parameter "KHCL Lermao": sản lượng hàng thương hiệu Lermao của từng khách ĐLCL. */
  private async dlclPivot(q: KdQueryDto, p: CurrentPeriod) {
    const ctes = await this.ctes(q, this.base.periodCond(p));
    const columns = await this.qr<{ label: string }[]>`
      SELECT label FROM analytics_kd_dlcl_columns ORDER BY sort_order, id`;
    const rows = await this.qr<
      {
        category: string | null;
        product_name: string | null;
        label: string;
        qty: number;
        g: number;
      }[]
    >`
      WITH ${ctes},
      dc AS (SELECT label, unnest(customer_codes) AS code FROM analytics_kd_dlcl_columns),
      lm AS (
        SELECT x.* FROM kd_line x
        WHERE x.product_type = 'Hàng thương hiệu' AND x.brand = 'Lermao'
      ),
      cm AS (
        SELECT DISTINCT c.customer_code, dc.label
        FROM (SELECT DISTINCT customer_code FROM lm WHERE customer_code IS NOT NULL) c
        JOIN dc ON strpos(c.customer_code, dc.code) > 0
        UNION ALL
        SELECT DISTINCT customer_code, '__all__' FROM lm
      )
      SELECT GROUPING(x.category, x.product_name)::int AS g, x.category, x.product_name, cm.label,
             SUM(x.quantity)::float8 AS qty
      FROM lm x JOIN cm ON COALESCE(cm.customer_code, '') = COALESCE(x.customer_code, '')
      GROUP BY GROUPING SETS ((x.category, x.product_name, cm.label), (x.category, cm.label), (cm.label))`;
    const tree = new Map<
      string,
      {
        values: Record<string, number>;
        products: Map<string, Record<string, number>>;
      }
    >();
    const total: Record<string, number> = {};
    for (const r of rows) {
      const g = Number(r.g);
      const qty = Number(r.qty);
      if (g === 3) {
        total[r.label] = qty;
        continue;
      }
      const cat = r.category ?? '(Trống)';
      if (!tree.has(cat)) tree.set(cat, { values: {}, products: new Map() });
      const node = tree.get(cat)!;
      if (g === 1) node.values[r.label] = qty;
      else {
        const pn = r.product_name ?? '(Trống)';
        if (!node.products.has(pn)) node.products.set(pn, {});
        node.products.get(pn)![r.label] = qty;
      }
    }
    return {
      columns: [...columns.map((c) => c.label), '__all__'],
      rows: [...tree.entries()].map(([category, n]) => ({
        category,
        values: n.values,
        products: [...n.products.entries()].map(([name, values]) => ({
          name,
          values,
        })),
      })),
      total,
    };
  }

  /** Bảng chi tiết dòng hàng (tableEx "Báo cáo chi tiết doanh số sản phẩm …"). */
  async lineListing(q: KdQueryDto, p: CurrentPeriod, limit = 2000) {
    const lake = await this.base.dataLakeReady();
    const ctes = await this.ctes(q, this.base.periodCond(p));
    const prodAnd = this.prodConds(q, Prisma.raw('p.code'));
    const old = lake
      ? Prisma.sql`
        UNION ALL
        SELECT x.d, x.code, x.customer_code, x.customer_name, x.parent_name, x.total,
               od."productCode" AS product_code, kp.name AS product_name,
               COALESCE(od.quantity, 0)::float8, COALESCE(od.price, 0)::float8, COALESCE(od.discount, 0)::float8
        FROM data_lake.invoice_detail od
        JOIN kd_inv x ON NOT x.is_new AND x.code = od."invoiceCode"
        LEFT JOIN prod pr ON pr.code = od."productCode"
        LEFT JOIN kd_prod kp ON kp.code = od."productCode"
        WHERE true ${this.prodConds(q, Prisma.raw('od."productCode"'))}`
      : Prisma.empty;
    const rows = await this.qr<
      {
        d: Date;
        code: string;
        customer_code: string | null;
        customer_name: string | null;
        parent_name: string | null;
        total: number;
        product_code: string | null;
        product_name: string | null;
        quantity: number;
        price: number;
        discount: number;
      }[]
    >`
      WITH ${ctes}
      SELECT * FROM (
        SELECT x.d, x.code, x.customer_code, x.customer_name, x.parent_name, x.total,
               p.code AS product_code, kp.name AS product_name,
               COALESCE(d.quantity, 0)::float8 AS quantity, COALESCE(d.price, 0)::float8 AS price,
               COALESCE(d.discount, 0)::float8 AS discount
        FROM invoice_details d
        JOIN kd_inv x ON x.is_new AND x.id = d."invoiceId"
        LEFT JOIN products p ON p.id = d."productId"
        LEFT JOIN prod pr ON pr.code = p.code
        LEFT JOIN kd_prod kp ON kp.code = p.code
        WHERE x.ok ${prodAnd}
        ${old}
      ) z ORDER BY z.d DESC, z.code
      LIMIT ${limit + 1}`;
    return {
      truncated: rows.length > limit,
      rows: rows.slice(0, limit).map((r) => ({
        date: r.d.toISOString().slice(0, 10),
        invoiceCode: r.code,
        customerCode: r.customer_code,
        customerName: r.customer_name,
        parentName: r.parent_name,
        productCode: r.product_code,
        productName: r.product_name,
        quantity: Math.round(Number(r.quantity)),
        price: Number(r.price),
        discount: Number(r.discount),
        amount: Math.round(
          Number(r.quantity) * (Number(r.price) - Number(r.discount)),
        ),
        discount100: Number(r.total) === 0,
      })),
    };
  }

  /** Bookmark ĐLCL Boduo / ĐLCL Phượng Hoàng: biểu đồ + chi tiết của khách ưu tiên. */
  private async customerBrandKey(q: KdCustomerQueryDto, p: CurrentPeriod) {
    const boduo = q.section === 'boduo';
    const scope = boduo ? 'boduoKey' : 'phKey';
    const qs = { ...q, scope } as KdQueryDto;
    const metric = q.metric ?? 'amount';
    const axis = this.axisDim(q);
    const cur = this.periodRanges(p, q.year, 'c');
    const [res, lines] = await Promise.all([
      this.agg(qs, {
        level: 'line',
        sets: [['ym'], [axis], ['category'], ['product_name']],
        ranges: cur,
      }),
      this.lineListing(qs, p),
    ]);
    return {
      scope,
      metric,
      byMonth: res
        .filter((r) => r.set === 0)
        .map((r) => ({ key: r.dims.ym, value: this.metricOf(r, metric) }))
        .sort((a, b) => String(a.key).localeCompare(String(b.key))),
      trend: this.base.axisKeys(p, q.year, q.axis ?? 'month').map((k) => ({
        key: k,
        label: this.base.axisLabel(q.axis ?? 'month', Number(k)),
        value: this.metricOf(this.pick(res, 1, 'c', { [axis]: k }), metric),
      })),
      byCategory: this.series(res, 2, 'c', 'category', metric),
      topProducts: this.series(res, 3, 'c', 'product_name', metric).slice(0, 5),
      lines,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG SẢN PHẨM
  // ═════════════════════════════════════════════════════════════════════════
  async getProductPage(q: KdQueryDto) {
    const p = this.period(q);
    const updatedAt = new Date().toISOString();
    if (!p) return { period: null, updatedAt };
    const metric = q.metric ?? 'amount';
    const lvl = this.levelFor(q);
    const cur = this.periodRanges(p, q.year, 'c');
    const shifted = cur.map((r) => ({
      k: `p:${parts(r.from).m}`,
      ...this.shiftMonth(r.from, r.to),
    }));
    const [line, month, lp] = await this.aggMulti(q, [
      {
        level: 'line',
        sets: [
          ['brand', 'month'],
          ['category', 'month'],
          ['brand'],
          ['category'],
        ],
        ranges: cur,
      },
      { level: lvl, sets: [['month'], []], ranges: [...cur, ...shifted] },
      {
        level: 'line',
        sets: [[]],
        ranges: cur,
        where: Prisma.sql`x.product_type = 'Hàng thương hiệu' AND x.brand IN ('Lermao', 'Phượng Hoàng')`,
      },
    ]);
    const seriesOf = (
      dim: 'brand' | 'category',
      set: number,
      totalSet: number,
    ) => {
      const totals = this.series(line, totalSet, 'c', dim, metric);
      return {
        keys: totals.map((t) => t.key),
        points: line
          .filter((r) => r.set === set)
          .map((r) => ({
            key: r.dims[dim],
            month: Number(r.dims.month),
            value: this.metricOf(r, metric),
          })),
      };
    };
    return {
      period: { from: p.min, to: p.max, months: p.months },
      updatedAt,
      metric,
      lermaoPhTotal: this.metricOf(lp[0], metric),
      byBrand: seriesOf('brand', 0, 2),
      byCategory: seriesOf('category', 1, 3),
      waterfall: p.months.map((m) => {
        const c = this.metricOf(
          this.pick(month, 0, 'c', { month: String(m) }),
          metric,
        );
        const pr = this.metricOf(this.pick(month, 1, `p:${m}`), metric);
        return {
          month: m,
          value: c,
          previous: pr,
          growth: pr ? (c - pr) / pr : null,
        };
      }),
    };
  }

  /** "Báo Cáo Tồn Kho Chi Tiết": tồn kho theo sản phẩm × chi nhánh (dim_product_inventory). */
  async getInventory(q: KdQueryDto) {
    const rows = await this.qr<
      {
        product: string;
        branch: string | null;
        onhand: number;
        onorder: number;
        reserved: number;
        near: number;
        damaged: number;
        promo: number;
      }[]
    >`
      WITH ${this.base.prodCte()}
      SELECT p.name AS product, b.name AS branch,
        SUM(pi."onHand")::float8 AS onhand, SUM(pi."onOrder")::float8 AS onorder,
        SUM(pi.reserved)::float8 AS reserved, SUM(pi."nearExpiryQuantity")::float8 AS near,
        SUM(pi."damagedQuantity")::float8 AS damaged, SUM(pi."promoQuantity")::float8 AS promo
      FROM inventories pi
      JOIN products p ON p.id = pi."productId"
      LEFT JOIN branches b ON b.id = pi."branchId"
      LEFT JOIN prod pr ON pr.code = p.code
      WHERE true ${this.prodConds(q, Prisma.raw('p.code'))}
      GROUP BY 1, 2
      HAVING SUM(pi."onHand") <> 0 OR SUM(pi."onOrder") <> 0 OR SUM(pi.reserved) <> 0
          OR SUM(pi."nearExpiryQuantity") <> 0 OR SUM(pi."damagedQuantity") <> 0 OR SUM(pi."promoQuantity") <> 0`;
    const branches = [
      ...new Set(rows.map((r) => r.branch ?? '(Trống)')),
    ].sort();
    const byProduct = new Map<string, Record<string, number[]>>();
    for (const r of rows) {
      if (!byProduct.has(r.product)) byProduct.set(r.product, {});
      byProduct.get(r.product)![r.branch ?? '(Trống)'] = [
        r.onhand,
        r.onorder,
        r.reserved,
        r.near,
        r.damaged,
        r.promo,
      ].map(Number);
    }
    return {
      branches,
      rows: [...byProduct.entries()]
        .map(([product, values]) => ({ product, values }))
        .sort((a, b) => a.product.localeCompare(b.product)),
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TRANG ĐỐI THỦ
  // ═════════════════════════════════════════════════════════════════════════
  async getCompetitorPage(q: KdQueryDto) {
    const p = this.period(q);
    const updatedAt = new Date().toISOString();
    if (!p) return { period: null, updatedAt };
    const cur = this.periodRanges(p, q.year, 'c');
    const weeks = this.weekRanges(p, q.year);
    const months = p.months;
    const LB = `x.visual_group IN ('4.Lermao', '1.Boduo')`;
    // 2 câu song song: phần cấp dòng hàng và phần cấp hoá đơn (có khách mới).
    const [
      [brand, top, flavor, vgWeek],
      [teamMonth, teamWeek, newCus, newDetail, revAll],
      debt,
      teamKpi,
      vt,
      plan,
    ] = await Promise.all([
      this.aggMulti(q, [
        {
          level: 'line',
          sets: [['visual_group']],
          ranges: cur,
          where: Prisma.raw(LB),
        },
        {
          level: 'line',
          sets: [['visual_group', 'product_name']],
          ranges: cur,
          where: Prisma.sql`((x.visual_group = '4.Lermao' AND x.category IN ('Mứt', 'Siro'))
                          OR (x.visual_group = '1.Boduo' AND x.category IN ('Mứt', 'Siro', 'Sốt')))`,
        },
        {
          level: 'line',
          sets: [['jam_flavor', 'jam_brand']],
          ranges: cur,
          where: Prisma.sql`x.jam_flavor IS NOT NULL AND x.jam_brand IN ('Lermao', 'Boduo')`,
        },
        {
          level: 'line',
          sets: [['visual_group', 'week'], ['week'], ['visual_group'], []],
          ranges: weeks,
        },
      ]),
      this.aggMulti(q, [
        {
          level: 'inv',
          sets: [['team', 'month'], ['month'], ['team'], []],
          ranges: cur,
        },
        {
          level: 'inv',
          sets: [['team', 'week'], ['week'], ['team'], []],
          ranges: weeks,
        },
        {
          level: 'inv',
          needNew: true,
          where: Prisma.sql`x.is_new_cust`,
          sets: [
            ['ym', 'team'],
            ['ym', 'week', 'team'],
            ['ym'],
            ['ym', 'week'],
            ['team'],
            [],
          ],
          ranges: cur,
        },
        {
          level: 'inv',
          needNew: true,
          where: Prisma.sql`x.is_new_cust`,
          sets: [['team', 'customer_code', 'customer_name', 'ym']],
          ranges: cur,
        },
        { level: 'inv', sets: [[]], ranges: cur },
      ]),
      this.currentDebt(q),
      this.teamTargets(q, q.year, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      this.visualTargets(q.year, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      this.teamTargets(
        q,
        q.year,
        Array.from({ length: parts(p.max).m }, (_, i) => i + 1),
      ),
    ]);

    const kpiOf = (team: string | null, month: number) =>
      teamKpi
        .filter((t) => t.month === month && (team === null || t.team === team))
        .reduce((s, t) => s + t.value, 0) || null;
    const vtOf = (g: string | null, month: number) =>
      vt
        .filter((t) => t.m === month && (g === null || t.g === g))
        .reduce((s, t) => s + t.v, 0) || null;
    const teams = [
      ...new Set(teamMonth.filter((r) => r.set === 2).map((r) => r.dims.team)),
    ].sort((a, b) => String(a).localeCompare(String(b)));

    // Nhân sự theo tháng
    const monthRows = months.map((m) => ({
      key: String(m),
      label: `Tháng ${m}`,
      cells: Object.fromEntries(
        [...teams, '__total__'].map((t) => {
          const r =
            t === '__total__'
              ? this.pick(teamMonth, 1, 'c', { month: String(m) })
              : this.pick(teamMonth, 0, 'c', { team: t, month: String(m) });
          const plan = kpiOf(t === '__total__' ? null : t, m);
          return [
            t ?? '(Trống)',
            {
              actual: r?.amount ?? 0,
              plan,
              rate: this.div(r?.amount ?? 0, plan),
            },
          ];
        }),
      ),
    }));
    // Nhân sự theo tuần (kế hoạch tuần = KPI tháng của ngày đầu tuần ÷ 4)
    const weekPlanMonth = (w: KRange) => parts(w.from).m;
    const weekRows = weeks.map((w) => {
      const m = weekPlanMonth(w);
      return {
        key: w.k,
        label: w.label,
        cells: Object.fromEntries(
          [...teams, '__total__'].map((t) => {
            const r =
              t === '__total__'
                ? this.pick(teamWeek, 1, w.k, { week: w.k })
                : this.pick(teamWeek, 0, w.k, { team: t, week: w.k });
            const k = kpiOf(t === '__total__' ? null : t, m);
            const plan = k === null ? null : k / 4;
            return [
              t ?? '(Trống)',
              {
                actual: r?.amount ?? 0,
                plan,
                rate: this.div(r?.amount ?? 0, plan),
              },
            ];
          }),
        ),
      };
    });
    // Nhóm hàng theo tuần
    const groups = [
      ...new Set(
        vgWeek.filter((r) => r.set === 2).map((r) => r.dims.visual_group),
      ),
    ].sort((a, b) => String(a).localeCompare(String(b)));
    const groupWeekRows = [...groups, '__total__'].map((g) => ({
      key: g,
      cells: Object.fromEntries(
        weeks.map((w) => {
          const m = weekPlanMonth(w);
          const r =
            g === '__total__'
              ? this.pick(vgWeek, 1, w.k, { week: w.k })
              : this.pick(vgWeek, 0, w.k, { visual_group: g, week: w.k });
          const t = vtOf(g === '__total__' ? null : g, m);
          const plan = t === null ? null : t / 4;
          return [
            w.k,
            {
              actual: r?.amount ?? 0,
              plan,
              rate: this.div(r?.amount ?? 0, plan),
            },
          ];
        }),
      ),
    }));

    // So sánh Lermao vs Boduo
    const b = (g: string) => this.pick(brand, 0, 'c', { visual_group: g });
    const ler = b('4.Lermao');
    const bod = b('1.Boduo');
    const side = (r: AggOut | undefined) => ({
      revenue: r?.amount ?? 0,
      quantity: r?.quantity ?? 0,
      orders: r?.orders ?? 0,
      customers: r?.customers ?? 0,
    });
    const topOf = (g: string) =>
      top
        .filter((r) => r.dims.visual_group === g && r.amount > 0)
        .sort((a, z) => z.amount - a.amount)
        .slice(0, 10)
        .map((r) => ({
          name: r.dims.product_name,
          amount: r.amount,
          quantity: r.quantity,
        }));
    const flavors = new Map<string, { lermao: number; boduo: number }>();
    for (const r of flavor) {
      const f = r.dims.jam_flavor ?? '';
      if (!flavors.has(f)) flavors.set(f, { lermao: 0, boduo: 0 });
      if (r.dims.jam_brand === 'Lermao') flavors.get(f)!.lermao = r.quantity;
      else flavors.get(f)!.boduo = r.quantity;
    }

    // Khách mới phát sinh
    const newTeams = [
      ...new Set(newCus.filter((r) => r.set === 4).map((r) => r.dims.team)),
    ].sort((a, z) => String(a).localeCompare(String(z)));
    const newCell = (r: AggOut | undefined) => ({
      revenue: r?.amount ?? 0,
      orders: r?.orders ?? 0,
      customers: r?.customers ?? 0,
    });
    const yms = [
      ...new Set(newCus.filter((r) => r.set === 2).map((r) => r.dims.ym!)),
    ].sort();
    const newPivot = [...yms, '__total__'].map((ym) => {
      const tot = ym === '__total__';
      const cells = (pickTeam: (t: string | null) => AggOut | undefined) =>
        Object.fromEntries(
          [...newTeams, '__total__'].map((t) => [
            t ?? '(Trống)',
            newCell(pickTeam(t === '__total__' ? '__total__' : t)),
          ]),
        );
      return {
        key: ym,
        cells: cells((t) =>
          tot
            ? t === '__total__'
              ? this.pick(newCus, 5, 'c')
              : this.pick(newCus, 4, 'c', { team: t })
            : t === '__total__'
              ? this.pick(newCus, 2, 'c', { ym })
              : this.pick(newCus, 0, 'c', { ym, team: t }),
        ),
        weeks: tot
          ? []
          : [
              ...new Set(
                newCus
                  .filter((r) => r.set === 3 && r.dims.ym === ym)
                  .map((r) => r.dims.week!),
              ),
            ]
              .sort()
              .map((wk) => ({
                key: wk,
                label: this.weekLabel(wk),
                cells: cells((t) =>
                  t === '__total__'
                    ? this.pick(newCus, 3, 'c', { ym, week: wk })
                    : this.pick(newCus, 1, 'c', { ym, week: wk, team: t }),
                ),
              })),
      };
    });

    const revenue = revAll[0]?.amount ?? 0;
    const planYear = plan.reduce((s, t) => s + t.value, 0);
    return {
      period: { from: p.min, to: p.max, months },
      updatedAt,
      debt: {
        value: debt,
        revenue,
        plan: planYear || null,
        rate: this.div(revenue, planYear),
      },
      brandCompare: {
        lermao: side(ler),
        boduo: side(bod),
        topLermao: topOf('4.Lermao'),
        topBoduo: topOf('1.Boduo'),
        flavors: [...flavors.entries()]
          .map(([f, v]) => ({ flavor: f, ...v }))
          .sort((a, z) => z.lermao + z.boduo - (a.lermao + a.boduo)),
      },
      teams: teams.map((t) => t ?? '(Trống)'),
      staffMonth: monthRows,
      staffWeek: weekRows,
      weeks: weeks.map((w) => ({ key: w.k, label: w.label })),
      groupWeek: groupWeekRows,
      newTeams: newTeams.map((t) => t ?? '(Trống)'),
      newCustomers: newPivot,
      newCustomerList: newDetail
        .map((r) => ({
          team: r.dims.team,
          code: r.dims.customer_code,
          name: r.dims.customer_name,
          month: r.dims.ym,
          lastDate: r.maxD,
          orders: r.orders,
          revenue: r.amount,
        }))
        .sort(
          (a, z) =>
            String(z.month).localeCompare(String(a.month)) ||
            z.revenue - a.revenue,
        ),
    };
  }

  /** Nhãn "Tuần N (dd/MM - dd/MM)" từ khoá yyyyww. */
  weekLabel(key: string): string {
    const y = Math.floor(Number(key) / 100);
    const wn = Number(key) % 100;
    const r = this.weekNumRange(y, wn, '9999-12-31');
    return r ? this.weekOf(r.from).label : key;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CẤU HÌNH (bảng thay "Enter data" / Excel của Power BI)
  // ═════════════════════════════════════════════════════════════════════════
  listVisualTargets(year?: number) {
    return this.qr<
      {
        id: number;
        visualProductGroup: string;
        year: number;
        month: number;
        kpiValue: number;
      }[]
    >`
      SELECT id, visual_product_group AS "visualProductGroup", year, month, kpi_value AS "kpiValue"
      FROM analytics_kd_visual_group_targets
      ${year ? Prisma.sql`WHERE year = ${year}` : Prisma.empty}
      ORDER BY year DESC, month, visual_product_group`;
  }

  async upsertVisualTarget(d: KdVisualTargetDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_kd_visual_group_targets (visual_product_group, year, month, kpi_value)
      VALUES (${d.visualProductGroup}, ${d.year}, ${d.month}, ${d.kpiValue})
      ON CONFLICT (visual_product_group, year, month)
      DO UPDATE SET kpi_value = EXCLUDED.kpi_value, updated_at = now()`;
    return { ok: true };
  }

  async updateVisualTarget(id: number, d: KdVisualTargetUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_kd_visual_group_targets SET kpi_value = ${d.kpiValue}, updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy chỉ tiêu');
    return { ok: true };
  }

  async deleteVisualTarget(id: number) {
    await this.prisma
      .$executeRaw`DELETE FROM analytics_kd_visual_group_targets WHERE id = ${id}`;
    return { ok: true };
  }

  listCustomerKeys() {
    return this.qr<
      {
        id: number;
        customerCode: string;
        customerName: string | null;
        isVip: boolean;
      }[]
    >`
      SELECT k.id, k.customer_code AS "customerCode", c.name AS "customerName", k.is_vip AS "isVip"
      FROM analytics_kd_customer_keys k
      LEFT JOIN LATERAL (SELECT name FROM customers WHERE code = k.customer_code ORDER BY id LIMIT 1) c ON true
      ORDER BY k.customer_code`;
  }

  async createCustomerKey(d: KdCustomerKeyDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_kd_customer_keys (customer_code, is_vip)
      VALUES (${d.customerCode.trim()}, ${d.isVip ?? false})
      ON CONFLICT (customer_code) DO UPDATE SET is_vip = EXCLUDED.is_vip, updated_at = now()`;
    return { ok: true };
  }

  async updateCustomerKey(id: number, d: KdCustomerKeyUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_kd_customer_keys SET is_vip = ${d.isVip}, updated_at = now() WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy khách');
    return { ok: true };
  }

  async deleteCustomerKey(id: number) {
    await this.prisma
      .$executeRaw`DELETE FROM analytics_kd_customer_keys WHERE id = ${id}`;
    return { ok: true };
  }

  listDlclColumns() {
    return this.qr<
      {
        id: number;
        label: string;
        customerCodes: string[];
        sortOrder: number;
      }[]
    >`
      SELECT id, label, customer_codes AS "customerCodes", sort_order AS "sortOrder"
      FROM analytics_kd_dlcl_columns ORDER BY sort_order, id`;
  }

  async createDlclColumn(d: KdDlclColumnDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_kd_dlcl_columns (label, customer_codes, sort_order)
      VALUES (${d.label}, ${d.customerCodes}::text[], ${d.sortOrder})`;
    return { ok: true };
  }

  async updateDlclColumn(id: number, d: KdDlclColumnUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_kd_dlcl_columns SET
        label = COALESCE(${d.label ?? null}, label),
        customer_codes = COALESCE(${d.customerCodes ?? null}::text[], customer_codes),
        sort_order = COALESCE(${d.sortOrder ?? null}::int, sort_order),
        updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy cột');
    return { ok: true };
  }

  async deleteDlclColumn(id: number) {
    await this.prisma
      .$executeRaw`DELETE FROM analytics_kd_dlcl_columns WHERE id = ${id}`;
    return { ok: true };
  }

  listJamFlavors() {
    return this.qr<
      {
        id: number;
        productCode: string;
        productName: string | null;
        brand: string;
        jamFlavor: string;
      }[]
    >`
      SELECT j.id, j.product_code AS "productCode", p.name AS "productName", j.brand, j.jam_flavor AS "jamFlavor"
      FROM analytics_kd_jam_flavors j
      LEFT JOIN LATERAL (SELECT name FROM products WHERE code = j.product_code ORDER BY id LIMIT 1) p ON true
      ORDER BY j.brand, j.jam_flavor, j.product_code`;
  }

  async createJamFlavor(d: KdJamFlavorDto) {
    await this.prisma.$executeRaw`
      INSERT INTO analytics_kd_jam_flavors (product_code, brand, jam_flavor)
      VALUES (${d.productCode.trim()}, ${d.brand}, ${d.jamFlavor})
      ON CONFLICT (product_code) DO UPDATE SET brand = EXCLUDED.brand,
        jam_flavor = EXCLUDED.jam_flavor, updated_at = now()`;
    return { ok: true };
  }

  async updateJamFlavor(id: number, d: KdJamFlavorUpdateDto) {
    const n = await this.prisma.$executeRaw`
      UPDATE analytics_kd_jam_flavors SET
        brand = COALESCE(${d.brand ?? null}, brand),
        jam_flavor = COALESCE(${d.jamFlavor ?? null}, jam_flavor),
        updated_at = now()
      WHERE id = ${id}`;
    if (!n) throw new NotFoundException('Không tìm thấy sản phẩm');
    return { ok: true };
  }

  async deleteJamFlavor(id: number) {
    await this.prisma
      .$executeRaw`DELETE FROM analytics_kd_jam_flavors WHERE id = ${id}`;
    return { ok: true };
  }
}
