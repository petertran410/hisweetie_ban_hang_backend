import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsReportsService } from '../analytics-reports.service';
import { addDays, IsoDate, todayVn } from './analytics-period';
import {
  KE_TOAN_BLANK,
  KeToanCashQueryDto,
  KeToanMappingQueryDto,
  KeToanTransferQueryDto,
} from './analytics-ke-toan.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Báo cáo Phân tích › Kế Toán — thay Power BI (dataset accounting_dataset,
// report "Báo Cáo Kế Toán"). Dataset này KHÔNG dùng bộ lọc team sale của
// dataset_sale và không gộp hoá đơn cũ: câu SQL chép từ power_query.m.
//   • product           = products (+ trade_marks), không lọc.
//   • dim_product_inventory = inventories (tồn theo kho, nối theo mã hàng).
//   • packing_slips     = phiếu báo đơn chưa huỷ, cashAmount > 0, khách <> "Test".
//   • invoice / invoice_detail = hoá đơn status <> 2.
//   • invoice[delivery_date] = MAX(ngày tạo phiếu báo đơn) của hoá đơn
//     (packing_slip_invoices, KHÔNG lọc phiếu huỷ) — đây là cột nối dim_date.
//   • invoice_payment_note = ghi chú thanh toán tiền mặt (amount > 0).
//   • fact_transfer_detail / order_detail = phiếu chuyển hàng / đơn đặt hàng.
// So sánh chuỗi của Power BI không phân biệt hoa thường → dùng lower()/ILIKE.
// ═══════════════════════════════════════════════════════════════════════════

const KHO_HN = 'Kho Hà Nội';
const KHO_SG = 'Kho Sài Gòn';

/** Filter trang "Chuyển Hàng": NOT product_type IN (null | ...). */
const TRANSFER_EXCLUDED_TYPES = [
  'Dịch vụ',
  'Dụng cụ pha chế',
  'Hàng Khuyến Mãi',
  'Hàng sản xuất',
  'Mẫu thử',
  'Hàng OEM',
];

/** sale_qty_5days / 30days / 90days. */
const SALE_WINDOWS = [5, 30, 90] as const;

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

// ── Phép tính kiểu DAX: BLANK (null) cộng/trừ như 0 nhưng BLANK op BLANK = BLANK,
// nhân/chia với BLANK = BLANK, so sánh coi BLANK là 0. ─────────────────────────
const bAdd = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);
const bSub = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) - (b ?? 0);
const bMul = (a: number | null, k: number | null): number | null =>
  a === null || k === null ? null : a * k;
/** DIVIDE(a, b): BLANK khi a BLANK hoặc b = 0 / BLANK. */
const bDiv = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;
const v0 = (a: number | null): number => a ?? 0;
/** ROUNDUP(x, 0) — làm tròn 15 chữ số có nghĩa trước (như Excel/DAX) để tránh sai số dấu phẩy động. */
const roundUp0 = (x: number | null): number => {
  if (x === null) return 0;
  const clean = Number(x.toPrecision(15));
  return clean >= 0 ? Math.ceil(clean) : Math.floor(clean);
};

export interface MisaRow {
  code: string;
  name: string;
  productType: string | null;
  category: string | null;
  origin: string | null;
  misaCode: string;
  misaName: string;
  misaUnit: string;
  onhandHn: number | null;
  onhandSg: number | null;
}

export interface CashSlipRow {
  date: IsoDate;
  code: string;
  customerName: string | null;
  branch: string | null;
  amount: number;
}

export interface InvoiceCodRow {
  date: IsoDate | null; // invoice[delivery_date]; null = chưa có phiếu báo đơn / hoá đơn đã huỷ
  code: string;
  customerName: string | null;
  branch: string | null;
  amount: number;
  cancelled: boolean; // hoá đơn status 2 — Power BI để ở dòng trống
}

export interface ReconcileRow {
  date: IsoDate | null;
  customerName: string | null;
  delivered: number | null; // SUM(packing_slips[cash_amount])
  invoiceCod: number | null; // invoice_cod
}

export interface TransferMetrics {
  onhandHn: number | null;
  onhandSg: number | null;
  sale5: number | null;
  sale30: number | null;
  sale90: number | null;
  transfer: number | null;
  reservedSg: number | null;
  reservedHn: number | null;
  confirmed: number | null;
  avg5: number | null;
  avg30: number | null;
  avg90: number | null;
  demand: number | null;
  safe: number | null;
  point: number | null;
  available: number | null;
  target: number | null;
  rec: number;
  bulk: number;
  warning: string;
  reason: string;
  hnOutbound: string;
}

export interface TransferRow extends TransferMetrics {
  code: string;
  name: string;
}

interface TransferBase {
  onhandHn: number | null;
  onhandSg: number | null;
  sale5: number | null;
  sale30: number | null;
  sale90: number | null;
  transfer: number | null;
  reservedSg: number | null;
  reservedHn: number | null;
  confirmed: number | null;
  leadTime: number | null; // MAX(product[lead_time_hn_sg])
  convertQty: number | null; // MAX(product[convert_qty])
}

@Injectable()
export class AnalyticsKeToanService {
  constructor(
    private prisma: PrismaService,
    // Bộ tính chung của dataset_sale — dataset kế toán không dùng (giữ để đồng bộ khung).
    private base: AnalyticsReportsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Mapping Misa — tableEx "Mapping Mã Misa"
  // Dòng = sản phẩm có Tồn HN hoặc Tồn SG khác BLANK (SUMMARIZECOLUMNS bỏ dòng
  // mà mọi measure đều BLANK). Mặc định sắp theo cột đầu (Mã hàng).
  // ─────────────────────────────────────────────────────────────────────────
  async getMappingMisa(q: KeToanMappingQueryDto) {
    const types = q.productTypes ?? [];
    const names = q.productNames ?? [];
    const typeCond = this.productTypeCond(types);
    const nameCond = names.length
      ? Prisma.sql`p.name IN (${Prisma.join(names)})`
      : Prisma.sql`TRUE`;

    const [rows, typeRows, nameRows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          code: string;
          name: string;
          product_type: string | null;
          category: string | null;
          origin: string | null;
          misa_code: string;
          misa_name: string;
          misa_unit: string;
          onhand_hn: number | null;
          onhand_sg: number | null;
        }[]
      >(Prisma.sql`
        WITH onhand AS (
          SELECT pi."productId" AS product_id,
                 SUM(pi."onHand") FILTER (WHERE b.name = ${KHO_HN})::float8 AS onhand_hn,
                 SUM(pi."onHand") FILTER (WHERE b.name = ${KHO_SG})::float8 AS onhand_sg
          FROM inventories pi
          JOIN branches b ON b.id = pi."branchId"
          WHERE b.name IN (${KHO_HN}, ${KHO_SG})
          GROUP BY pi."productId"
        )
        SELECT p.code, p.name, p.parent_name AS product_type, p.child_name AS category,
               p.middle_name AS origin, p.misa_code, p.misa_name, p.misa_unit,
               o.onhand_hn, o.onhand_sg
        FROM products p
        JOIN onhand o ON o.product_id = p.id
        WHERE (o.onhand_hn IS NOT NULL OR o.onhand_sg IS NOT NULL)
          AND ${typeCond} AND ${nameCond}
        ORDER BY p.code
      `),
      this.prisma.$queryRaw<{ v: string | null }[]>(Prisma.sql`
        SELECT DISTINCT p.parent_name AS v FROM products p ORDER BY 1 NULLS FIRST
      `),
      // Slicer Tên Hàng bị slicer Loại Hàng lọc chéo (cùng bảng product).
      this.prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT DISTINCT p.name AS v FROM products p WHERE ${typeCond} ORDER BY 1
      `),
    ]);

    const data: MisaRow[] = rows.map((r) => ({
      code: r.code,
      name: r.name,
      productType: r.product_type,
      category: r.category,
      origin: r.origin,
      misaCode: r.misa_code,
      misaName: r.misa_name,
      misaUnit: r.misa_unit,
      onhandHn: num(r.onhand_hn),
      onhandSg: num(r.onhand_sg),
    }));
    const sumOrNull = (vals: (number | null)[]) =>
      vals.reduce<number | null>((s, v) => bAdd(s, v), null);

    return {
      rows: data,
      totals: {
        onhandHn: sumOrNull(data.map((r) => r.onhandHn)),
        onhandSg: sumOrNull(data.map((r) => r.onhandSg)),
      },
      options: {
        productTypes: typeRows.map((r) => r.v ?? KE_TOAN_BLANK),
        productNames: nameRows.map((r) => r.v),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  private productTypeCond(types: string[]): Prisma.Sql {
    if (!types.length) return Prisma.sql`TRUE`;
    const real = types.filter((t) => t !== KE_TOAN_BLANK);
    const parts: Prisma.Sql[] = [];
    if (real.length)
      parts.push(Prisma.sql`p.parent_name IN (${Prisma.join(real)})`);
    if (real.length !== types.length)
      parts.push(Prisma.sql`p.parent_name IS NULL`);
    return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bảng packing_slips của Power BI (dùng cho Tiền Mặt - Kho và Đối Soát).
  // Khách của phiếu = khách của 1 hoá đơn bất kỳ trong phiếu (DISTINCT ON như M).
  // ─────────────────────────────────────────────────────────────────────────
  private async packingSlips(q: KeToanCashQueryDto) {
    const conds: Prisma.Sql[] = [
      // Table.SelectRows(each [customer_name] <> "Test"): M so sánh phân biệt hoa thường, null vẫn giữ.
      Prisma.sql`c.name IS DISTINCT FROM 'Test'`,
    ];
    if (q.branch) conds.push(Prisma.sql`b.name = ${q.branch}`);
    if (q.from)
      conds.push(
        Prisma.sql`(p."createdAt" + interval '7 hours')::date >= ${q.from}::date`,
      );
    if (q.to)
      conds.push(
        Prisma.sql`(p."createdAt" + interval '7 hours')::date <= ${q.to}::date`,
      );

    const rows = await this.prisma.$queryRaw<
      {
        code: string;
        amount: number;
        branch: string | null;
        customer_name: string | null;
        customer_code: string | null;
        created_date: string;
      }[]
    >(Prisma.sql`
      WITH ps AS (
        SELECT p.id, p.code, p."cashAmount", p."branchId", p."createdAt"
        FROM packing_slips p
        WHERE p."cancelledAt" IS NULL AND p."cashAmount" > 0  -- packing_slips của Power BI
      ),
      cte_cus AS (
        SELECT DISTINCT ON (psi."packingSlipId") psi."packingSlipId", c.name, c.code AS customer_code
        FROM packing_slip_invoices psi
        JOIN ps ON ps.id = psi."packingSlipId"
        LEFT JOIN invoices i ON psi."invoiceId" = i.id
        LEFT JOIN customers c ON i."customerId" = c.id
        ORDER BY psi."packingSlipId", psi.id DESC -- M không ORDER BY nên Power BI chọn ngẫu nhiên khi phiếu có HĐ của 2 khách; lấy dòng mới nhất
      )
      SELECT p.code,
             ROUND(p."cashAmount")::float8 AS amount,
             b.name AS branch,
             rtrim(c.name) AS customer_name, -- Power BI bỏ khoảng trắng cuối
             c.customer_code,
             to_char((p."createdAt" + interval '7 hours')::date, 'YYYY-MM-DD') AS created_date
      FROM ps p
      LEFT JOIN branches b ON p."branchId" = b.id
      LEFT JOIN cte_cus c ON p.id = c."packingSlipId"
      WHERE ${Prisma.join(conds, ' AND ')}
    `);
    return rows;
  }

  /** Giá trị slicer Chi Nhánh + khoảng ngày của packing_slips (không lọc). */
  private async cashSlicers() {
    const [branches, range] = await Promise.all([
      this.prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT DISTINCT b.name AS v
        FROM packing_slips p JOIN branches b ON b.id = p."branchId"
        WHERE p."cancelledAt" IS NULL AND p."cashAmount" > 0
        ORDER BY 1
      `),
      this.prisma.$queryRaw<
        { min: string | null; max: string | null }[]
      >(Prisma.sql`
        SELECT to_char(MIN((p."createdAt" + interval '7 hours')::date), 'YYYY-MM-DD') AS min,
               to_char(MAX((p."createdAt" + interval '7 hours')::date), 'YYYY-MM-DD') AS max
        FROM packing_slips p
        WHERE p."cancelledAt" IS NULL AND p."cashAmount" > 0
      `),
    ]);
    return {
      branches: branches.map((r) => r.v),
      dateRange: { min: range[0]?.min ?? null, max: range[0]?.max ?? null },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Tiền Mặt - Kho — pivot: cột Chi Nhánh, dòng Ngày Tạo › Mã Báo Đơn ›
  // Tên Khách, giá trị SUM(cash_amount). Sắp Ngày Tạo giảm dần.
  // ─────────────────────────────────────────────────────────────────────────
  async getTienMatKho(q: KeToanCashQueryDto) {
    const [rows, slicers] = await Promise.all([
      this.packingSlips(q),
      this.cashSlicers(),
    ]);
    const data: CashSlipRow[] = rows
      .map((r) => ({
        date: r.created_date,
        code: r.code,
        customerName: r.customer_name,
        branch: r.branch,
        amount: Number(r.amount),
      }))
      .sort((a, b) =>
        a.date === b.date
          ? a.code.localeCompare(b.code)
          : a.date < b.date
            ? 1
            : -1,
      );
    const branches = [...new Set(data.map((r) => r.branch ?? ''))].sort(
      (a, b) => a.localeCompare(b),
    );
    return {
      rows: data,
      columns: branches, // cột pivot (chi nhánh có số trong kỳ)
      total: data.reduce((s, r) => s + r.amount, 0),
      ...slicers,
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Đối Soát — so tiền COD giao hàng (phiếu báo đơn) với tiền mặt ghi
  // trên hoá đơn (invoice_payment_note), theo Ngày Báo Đơn (dim_date) × khách.
  //   • Phía phiếu: dim_date = packing_slips[created_date], khách = dim_customers
  //     theo customer_code của phiếu.
  //   • Phía hoá đơn: dim_date = invoice[delivery_date], khách theo hoá đơn.
  //     Ghi chú của hoá đơn đã huỷ (không có trong bảng invoice) → dòng trống.
  // Bộ lọc Ngày / Chi Nhánh áp cho CẢ HAI phía (Power BI: slicer đặt trên
  // packing_slips nên chỉ lọc phía phiếu — xem báo cáo bàn giao).
  // ─────────────────────────────────────────────────────────────────────────
  async getDoiSoat(q: KeToanCashQueryDto) {
    const invConds: Prisma.Sql[] = [];
    if (q.branch) invConds.push(Prisma.sql`x.branch = ${q.branch}`);
    if (q.from) invConds.push(Prisma.sql`x.delivery_date >= ${q.from}::date`);
    if (q.to) invConds.push(Prisma.sql`x.delivery_date <= ${q.to}::date`);

    const [slips, invRows, slicers] = await Promise.all([
      this.packingSlips(q),
      this.prisma.$queryRaw<
        {
          code: string;
          amount: number;
          cancelled: boolean;
          branch: string | null;
          customer_name: string | null;
          delivery_date: string | null;
        }[]
      >(Prisma.sql`
        WITH ipn AS (
          SELECT ipn."invoiceId" AS invoice_id, SUM(ipn.amount)::float8 AS amount
          FROM invoice_payment_notes ipn
          WHERE ipn."paymentType" = 'cash' AND ipn.amount > 0
          GROUP BY ipn."invoiceId"
        ),
        x AS (
          SELECT i.code,
                 ipn.amount,
                 (i.status = 2) AS cancelled,
                 CASE WHEN i.status = 2 THEN NULL ELSE b.name END AS branch,
                 CASE WHEN i.status = 2 THEN NULL ELSE rtrim(c.name) END AS customer_name,
                 CASE WHEN i.status = 2 THEN NULL ELSE (
                   SELECT MAX((ps."createdAt" + interval '7 hours')::date)
                   FROM packing_slip_invoices psi
                   JOIN packing_slips ps ON ps.id = psi."packingSlipId"
                   WHERE psi."invoiceId" = i.id
                 ) END AS delivery_date
          FROM ipn
          JOIN invoices i ON i.id = ipn.invoice_id
          LEFT JOIN branches b ON b.id = i."branchId"
          LEFT JOIN customers c ON c.id = i."customerId"
        )
        SELECT x.code, x.amount, x.cancelled, x.branch, x.customer_name,
               to_char(x.delivery_date, 'YYYY-MM-DD') AS delivery_date
        FROM x
        WHERE ${invConds.length ? Prisma.join(invConds, ' AND ') : Prisma.sql`TRUE`}
      `),
      this.cashSlicers(),
    ]);

    // dim_customers[name] theo customer_code của phiếu (cùng khách với customer_name).
    const packing: CashSlipRow[] = slips
      .map((r) => ({
        date: r.created_date,
        code: r.code,
        customerName: r.customer_name,
        branch: r.branch,
        amount: Number(r.amount),
      }))
      .sort((a, b) =>
        a.date === b.date
          ? a.code.localeCompare(b.code)
          : a.date < b.date
            ? 1
            : -1,
      );

    const invoices: InvoiceCodRow[] = invRows
      .map((r) => ({
        date: r.delivery_date,
        code: r.code,
        customerName: r.customer_name,
        branch: r.branch,
        amount: Number(r.amount),
        cancelled: !!r.cancelled,
      }))
      // tableEx Hóa Đơn COD: sắp theo invoice_cod giảm dần.
      .sort((a, b) => b.amount - a.amount || a.code.localeCompare(b.code));

    // Pivot Ngày Báo Đơn × Tên Khách.
    const key = (d: string | null, c: string | null) =>
      `${d ?? ''}\u0000${c ?? ''}`;
    const map = new Map<string, ReconcileRow>();
    const cell = (d: string | null, c: string | null) => {
      const k = key(d, c);
      let row = map.get(k);
      if (!row) {
        row = { date: d, customerName: c, delivered: null, invoiceCod: null };
        map.set(k, row);
      }
      return row;
    };
    for (const r of packing) {
      const row = cell(r.date, r.customerName);
      row.delivered = bAdd(row.delivered, r.amount);
    }
    for (const r of invoices) {
      const row = cell(r.date, r.customerName);
      row.invoiceCod = bAdd(row.invoiceCod, r.amount);
    }
    // Ngày giảm dần (BLANK cuối), trong ngày theo tên khách tăng dần (BLANK đầu).
    const pivot = [...map.values()].sort((a, b) => {
      if (a.date !== b.date) {
        if (a.date === null) return 1;
        if (b.date === null) return -1;
        return a.date < b.date ? 1 : -1;
      }
      if (a.customerName === b.customerName) return 0;
      if (a.customerName === null) return -1;
      if (b.customerName === null) return 1;
      return a.customerName.localeCompare(b.customerName, 'vi');
    });

    const totalDelivered = packing.reduce<number | null>(
      (s, r) => bAdd(s, r.amount),
      null,
    );
    const totalInvoice = invoices.reduce<number | null>(
      (s, r) => bAdd(s, r.amount),
      null,
    );
    return {
      pivot,
      packing,
      invoices,
      totals: { delivered: totalDelivered, invoiceCod: totalInvoice },
      ...slicers,
      updatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trang Chuyển Hàng — tableEx "Điều chuyển hàng Hà Nội -> Sài Gòn".
  // Filter trang: is_active, loại hàng (bỏ null + 6 loại), weight > 100, brand
  // không chứa "Boduo". Mọi sản phẩm qua filter đều có dòng (warning_status
  // luôn khác BLANK). Sắp theo SL đề xuất (thùng) giảm dần.
  // sale_qty_Ndays: N ngày gần nhất trước hôm nay, bỏ Chủ Nhật (TOPN trên
  // dim_date) — dim_date nối invoice[delivery_date] nên "ngày bán" = ngày báo đơn.
  // Slicer Chi Nhánh / Ngày của trang Power BI đặt trên packing_slips, không
  // tác động bảng này → không đưa vào.
  // ─────────────────────────────────────────────────────────────────────────
  async getChuyenHang(q: KeToanTransferQueryDto, today: IsoDate = todayVn()) {
    const windows = this.saleWindows(today);
    const d90 = windows[90];
    const d30 = windows[30];
    const d5 = windows[5];
    const names = q.productNames ?? [];
    const lowerTypes = TRANSFER_EXCLUDED_TYPES.map((t) => t.toLowerCase());

    const prodFilter = Prisma.sql`
      p."isActive" = true
      AND p.parent_name IS NOT NULL
      AND lower(p.parent_name) NOT IN (${Prisma.join(lowerTypes)})
      AND p.weight::float8 > 100
      AND (tm.name IS NULL OR tm.name NOT ILIKE '%boduo%')
    `;
    const nameFilter = names.length
      ? Prisma.sql`AND p.name IN (${Prisma.join(names)})`
      : Prisma.empty;

    const [rows, nameRows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          code: string;
          name: string;
          convert_qty: number | null;
          lead_time: number;
          onhand_hn: number | null;
          onhand_sg: number | null;
          sale5: number | null;
          sale30: number | null;
          sale90: number | null;
          transfer: number | null;
          reserved_sg: number | null;
          reserved_hn: number | null;
          confirmed: number | null;
        }[]
      >(Prisma.sql`
        WITH prod AS (
          SELECT p.id, p.code, p.name, p."conversionValue"::float8 AS convert_qty,
                 CASE WHEN lower(p.name) LIKE '%bảo quản tủ đông%' THEN 3 ELSE 5 END AS lead_time
          FROM products p
          LEFT JOIN trade_marks tm ON p."tradeMarkId" = tm.id
          WHERE ${prodFilter} ${nameFilter}
        ),
        onhand AS (
          SELECT pi."productId" AS product_id,
                 SUM(pi."onHand") FILTER (WHERE b.name = ${KHO_HN})::float8 AS hn,
                 SUM(pi."onHand") FILTER (WHERE b.name = ${KHO_SG})::float8 AS sg
          FROM inventories pi
          JOIN prod ON prod.id = pi."productId"
          JOIN branches b ON b.id = pi."branchId"
          WHERE b.name IN (${KHO_HN}, ${KHO_SG})
          GROUP BY pi."productId"
        ),
        deliv AS (
          SELECT psi."invoiceId" AS invoice_id,
                 MAX((ps."createdAt" + interval '7 hours')::date) AS d
          FROM packing_slip_invoices psi
          JOIN packing_slips ps ON ps.id = psi."packingSlipId"
          GROUP BY psi."invoiceId"
        ),
        sales AS (
          SELECT ind."productId" AS product_id,
                 SUM(ind.quantity) FILTER (WHERE dv.d = ANY(${d5}::date[]))::float8 AS s5,
                 SUM(ind.quantity) FILTER (WHERE dv.d = ANY(${d30}::date[]))::float8 AS s30,
                 SUM(ind.quantity)::float8 AS s90
          FROM deliv dv
          JOIN invoices i ON i.id = dv.invoice_id
          JOIN branches b ON b.id = i."branchId"
          JOIN invoice_details ind ON ind."invoiceId" = i.id
          JOIN prod ON prod.id = ind."productId"
          WHERE dv.d = ANY(${d90}::date[])
            AND i.status <> 2
            AND b.name = ${KHO_SG}
          GROUP BY ind."productId"
        ),
        transfer AS (
          SELECT td."productCode" AS code, SUM(td."sendQuantity")::float8 AS qty
          FROM transfer_details td
          JOIN transfers t ON td."transferId" = t.id
          JOIN branches bf ON t."fromBranchId" = bf.id
          JOIN branches bt ON t."toBranchId" = bt.id
          WHERE t.status = 2 AND bf.name = ${KHO_HN} AND bt.name = ${KHO_SG}
          GROUP BY td."productCode"
        ),
        ord AS (
          SELECT oi."productCode" AS code,
                 SUM(oi.quantity) FILTER (
                   WHERE b.name = ${KHO_SG} AND lower(o."statusValue") IN ('đã xác nhận', 'phiếu tạm')
                 )::float8 AS reserved_sg,
                 SUM(oi.quantity) FILTER (
                   WHERE b.name = ${KHO_HN} AND lower(o."statusValue") IN ('đã xác nhận', 'phiếu tạm')
                 )::float8 AS reserved_hn,
                 SUM(oi.quantity) FILTER (
                   WHERE b.name = ${KHO_SG} AND lower(o."statusValue") = 'đã xác nhận'
                 )::float8 AS confirmed
          FROM orders o
          JOIN order_items oi ON o.id = oi."orderId"
          LEFT JOIN branches b ON o."branchId" = b.id
          WHERE o.status IN (5, 1)
          GROUP BY oi."productCode"
        )
        SELECT prod.code, prod.name, prod.convert_qty, prod.lead_time,
               oh.hn AS onhand_hn, oh.sg AS onhand_sg,
               s.s5 AS sale5, s.s30 AS sale30, s.s90 AS sale90,
               tr.qty AS transfer,
               od.reserved_sg, od.reserved_hn, od.confirmed
        FROM prod
        LEFT JOIN onhand oh ON oh.product_id = prod.id
        LEFT JOIN sales s ON s.product_id = prod.id
        LEFT JOIN transfer tr ON tr.code = prod.code
        LEFT JOIN ord od ON od.code = prod.code
      `),
      this.prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT DISTINCT p.name AS v
        FROM products p LEFT JOIN trade_marks tm ON p."tradeMarkId" = tm.id
        WHERE ${prodFilter}
        ORDER BY 1
      `),
    ]);

    const bases = rows.map((r) => ({
      code: r.code,
      name: r.name,
      base: {
        onhandHn: num(r.onhand_hn),
        onhandSg: num(r.onhand_sg),
        sale5: num(r.sale5),
        sale30: num(r.sale30),
        sale90: num(r.sale90),
        transfer: num(r.transfer),
        reservedSg: num(r.reserved_sg),
        reservedHn: num(r.reserved_hn),
        confirmed: num(r.confirmed),
        leadTime: num(r.lead_time),
        convertQty: num(r.convert_qty),
      } satisfies TransferBase,
    }));

    const data: TransferRow[] = bases
      .map((b) => ({
        code: b.code,
        name: b.name,
        ...this.transferMetrics(b.base),
      }))
      .sort((a, b) => b.bulk - a.bulk || a.code.localeCompare(b.code));

    // Dòng tổng của tableEx: measure tính lại trên toàn bộ sản phẩm (không cộng dòng).
    const sumOf = (k: keyof TransferBase) =>
      bases.reduce<number | null>((s, b) => bAdd(s, b.base[k]), null);
    const maxOf = (k: keyof TransferBase) =>
      bases.reduce<number | null>((m, b) => {
        const v = b.base[k];
        return v === null ? m : m === null ? v : Math.max(m, v);
      }, null);
    const totals = bases.length
      ? this.transferMetrics({
          onhandHn: sumOf('onhandHn'),
          onhandSg: sumOf('onhandSg'),
          sale5: sumOf('sale5'),
          sale30: sumOf('sale30'),
          sale90: sumOf('sale90'),
          transfer: sumOf('transfer'),
          reservedSg: sumOf('reservedSg'),
          reservedHn: sumOf('reservedHn'),
          confirmed: sumOf('confirmed'),
          leadTime: maxOf('leadTime'),
          convertQty: maxOf('convertQty'),
        })
      : null;

    const range = (dates: IsoDate[]) => ({
      from: dates[dates.length - 1],
      to: dates[0],
    });
    return {
      asOf: today,
      windows: { d5: range(d5), d30: range(d30), d90: range(d90) },
      rows: data,
      totals,
      productNames: nameRows.map((r) => r.v),
      updatedAt: new Date().toISOString(),
    };
  }

  /** TOPN(N, FILTER(ALL(dim_date), Date < TODAY() && WEEKDAY(Date,2) <> 7), Date, DESC). */
  private saleWindows(
    today: IsoDate,
  ): Record<(typeof SALE_WINDOWS)[number], IsoDate[]> {
    const max = SALE_WINDOWS[SALE_WINDOWS.length - 1];
    const dates: IsoDate[] = [];
    let d = addDays(today, -1);
    // dim_date bắt đầu 01/01/2024.
    while (dates.length < max && d >= '2024-01-01') {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Chủ Nhật
      if (dow !== 0) dates.push(d);
      d = addDays(d, -1);
    }
    return {
      5: dates.slice(0, 5),
      30: dates.slice(0, 30),
      90: dates.slice(0, 90),
    };
  }

  /** Các measure của bảng điều chuyển, đúng thứ tự phép tính DAX. */
  private transferMetrics(b: TransferBase): TransferMetrics {
    const avg5 = bDiv(b.sale5, 5);
    const avg30 = bDiv(b.sale30, 30);
    const avg90 = bDiv(b.sale90, 90);
    // 0.6*[avg5] + 0.3*[avg30] + 0.1*[avg90]
    const demand = bAdd(
      bAdd(bMul(avg5, 0.6), bMul(avg30, 0.3)),
      bMul(avg90, 0.1),
    );
    const safe = bMul(demand, 2);
    const point = bMul(demand, b.leadTime === null ? 2 : 2 + b.leadTime);
    const available = bSub(bAdd(b.onhandSg, b.transfer), b.reservedSg);
    const target = bAdd(safe, point);
    const diff = bSub(target, available);
    const rec = Math.max(0, v0(diff)); // MAX(0, BLANK) = 0
    const bulk = roundUp0(bDiv(rec, b.convertQty));
    // hn_outbound: target_qty = bulk * MAX(convert_qty)
    const targetQty = bMul(bulk, b.convertQty);
    const hnOutbound =
      v0(targetQty) === 0
        ? 'Không chuyển'
        : v0(targetQty) > v0(b.onhandHn)
          ? 'Không Đủ'
          : 'Đủ';
    const conf = v0(b.confirmed);
    const avail = v0(available);
    const warning =
      conf > avail
        ? 'Nguy cơ thiếu/đơn hàng xác nhận'
        : v0(safe) > avail
          ? 'Cần điều chuyển'
          : v0(point) > avail
            ? 'Cần xem xét'
            : avail > rec
              ? 'Đủ hàng'
              : 'Chưa xác định';
    const reason =
      conf > avail
        ? 'Đơn hàng xác nhận > tồn khả dụng'
        : v0(safe) > avail
          ? 'Dưới tồn an toàn'
          : v0(point) > avail
            ? 'Dưới điểm điều chuyển'
            : 'Đủ hàng'; // point <= available luôn đúng ở nhánh này
    return {
      onhandHn: b.onhandHn,
      onhandSg: b.onhandSg,
      sale5: b.sale5,
      sale30: b.sale30,
      sale90: b.sale90,
      transfer: b.transfer,
      reservedSg: b.reservedSg,
      reservedHn: b.reservedHn,
      confirmed: b.confirmed,
      avg5,
      avg30,
      avg90,
      demand,
      safe,
      point,
      available,
      target,
      rec,
      bulk,
      warning,
      reason,
      hnOutbound,
    };
  }
}
