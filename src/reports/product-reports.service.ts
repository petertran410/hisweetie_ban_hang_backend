import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductReportQueryDto, ProductViewType } from './dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

// Dòng dữ liệu chuẩn cho biểu đồ (đồng bộ schema KiotViet §8)
export interface ProductChartRow {
  subject: string;
  value: number;
  total: number;
  extra1?: string | null;
  group?: string | null;
  // Profit view
  revenue?: number;
  totalCost?: number;
  profit?: number;
  quantity?: number;
  // InOutStock view
  openingQuantity?: number;
  openingValue?: number;
  inQuantity?: number;
  inValue?: number;
  outQuantity?: number;
  outValue?: number;
  closingQuantity?: number;
  closingValue?: number;
}

@Injectable()
export class ProductReportsService {
  constructor(private prisma: PrismaService) {}

  // ── WHERE cho invoice_details join invoices (doanh thu, loại HĐ hủy/trả) ──
  private buildDetailWhereSql(query: ProductReportQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`i.status NOT IN (2, 8)`];
    if (query.fromDate)
      conds.push(Prisma.sql`i."purchaseDate" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`i."purchaseDate" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    if (query.soldById)
      conds.push(Prisma.sql`i."soldById" = ${query.soldById}`);
    if (query.customerId)
      conds.push(Prisma.sql`i."customerId" = ${query.customerId}`);
    if (query.productId)
      conds.push(Prisma.sql`d."productId" = ${query.productId}`);
    if (query.productKeyword) {
      const kw = `%${query.productKeyword}%`;
      conds.push(
        Prisma.sql`(d."productName" ILIKE ${kw} OR d."productCode" ILIKE ${kw})`,
      );
    }
    if (query.categoryLevel && query.categoryValue) {
      const col =
        query.categoryLevel === 'parent'
          ? Prisma.sql`p."parent_name"`
          : query.categoryLevel === 'middle'
            ? Prisma.sql`p."middle_name"`
            : Prisma.sql`p."child_name"`;
      conds.push(Prisma.sql`${col} = ${query.categoryValue}`);
    }
    return Prisma.join(conds, ' AND ');
  }

  // Giá vốn theo dòng: inventories.cost khớp productId + branch của HĐ
  private costJoin(): Prisma.Sql {
    return Prisma.sql`
      LEFT JOIN inventories inv
        ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"`;
  }

  // TOP N cho chart/data table: `limit` (data table) thắng `top` (chart Top 20).
  // Export truyền limit rất lớn (1000000) để lấy toàn bộ.
  private chartTop(query: ProductReportQueryDto): number {
    const n = query.limit ?? query.top ?? 20;
    return Math.max(1, Math.min(1000000, n));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART
  // ═══════════════════════════════════════════════════════════════════════════
  async getChart(query: ProductReportQueryDto): Promise<ProductChartRow[]> {
    const viewType: ProductViewType = query.viewType || 'ProductBySale';
    switch (viewType) {
      case 'ProductByProfit':
        return this.chartByProfit(query);
      case 'ProductByCategory':
        return this.chartByCategory(query);
      case 'InOutStock':
      case 'InOutStockDetail':
        return this.chartInOutStock(query);
      case 'ProductByUser':
        return this.chartByDimension(query, 'user');
      case 'ProductByCustomer':
        return this.chartByDimension(query, 'customer');
      case 'ProductBySupplier':
        return this.chartBySupplier(query);
      case 'DamageItem':
        return this.chartDamage(query);
      case 'ProductBySale':
      default:
        return this.chartBySale(query);
    }
  }

  // ── ProductBySale: SL + doanh thu theo SP ──
  private async chartBySale(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        d."productCode" AS code,
        d."productName" AS name,
        SUM(d.quantity)::float8 AS qty,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      LEFT JOIN products p ON p.id = d."productId"
      WHERE ${where}
      GROUP BY d."productCode", d."productName"
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      quantity: Number(r.qty) || 0,
      extra1: r.code || null,
    }));
  }

  // ── ProductByProfit: doanh thu − giá vốn theo SP ──
  private async chartByProfit(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        d."productCode" AS code,
        d."productName" AS name,
        SUM(d.quantity)::float8 AS qty,
        SUM(d."totalPrice")::float8 AS revenue,
        COALESCE(SUM(d.quantity * COALESCE(inv.cost, 0)), 0)::float8 AS cost
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      ${this.costJoin()}
      LEFT JOIN products p ON p.id = d."productId"
      WHERE ${where}
      GROUP BY d."productCode", d."productName"
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => {
      const revenue = Number(r.revenue) || 0;
      const cost = Number(r.cost) || 0;
      return {
        subject: r.name,
        value: revenue - cost,
        total: revenue,
        revenue,
        totalCost: cost,
        profit: revenue - cost,
        quantity: Number(r.qty) || 0,
        extra1: r.code || null,
      };
    });
  }

  // ── ProductByCategory: doanh thu theo nhóm hàng ──
  private async chartByCategory(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const level = query.categoryLevel || 'parent';
    const col =
      level === 'parent'
        ? Prisma.sql`p."parent_name"`
        : level === 'middle'
          ? Prisma.sql`p."middle_name"`
          : Prisma.sql`p."child_name"`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(${col}, 'Chưa phân nhóm') AS name,
        SUM(d.quantity)::float8 AS qty,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      LEFT JOIN products p ON p.id = d."productId"
      WHERE ${where}
      GROUP BY name
      ORDER BY revenue DESC
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      quantity: Number(r.qty) || 0,
    }));
  }

  // ── ProductByUser/Customer: doanh thu theo SP × chiều ──
  private async chartByDimension(
    query: ProductReportQueryDto,
    dim: 'user' | 'customer',
  ): Promise<ProductChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const dimName =
      dim === 'user'
        ? Prisma.sql`COALESCE(u.name, 'Chưa xác định')`
        : Prisma.sql`COALESCE(c.name, 'Khách lẻ')`;
    const join =
      dim === 'user'
        ? Prisma.sql`LEFT JOIN users u ON u.id = i."soldById"`
        : Prisma.sql`LEFT JOIN customers c ON c.id = i."customerId"`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        ${dimName} AS dim_name,
        d."productName" AS name,
        SUM(d.quantity)::float8 AS qty,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      ${join}
      WHERE ${where}
      GROUP BY dim_name, d."productName"
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      quantity: Number(r.qty) || 0,
      group: r.dim_name,
    }));
  }

  // ── ProductBySupplier: doanh thu theo SP, gắn NCC (từ phiếu nhập gần nhất) ──
  private async chartBySupplier(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        d."productName" AS name,
        COALESCE(sup.name, 'Chưa rõ NCC') AS supplier_name,
        SUM(d.quantity)::float8 AS qty,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      LEFT JOIN LATERAL (
        SELECT po."supplierId"
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi."purchaseOrderId"
        WHERE poi."productId" = d."productId" AND po.status <> 2
        ORDER BY po."purchaseDate" DESC
        LIMIT 1
      ) last_po ON true
      LEFT JOIN suppliers sup ON sup.id = last_po."supplierId"
      WHERE ${where}
      GROUP BY d."productName", sup.name
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      quantity: Number(r.qty) || 0,
      group: r.supplier_name,
    }));
  }

  // ── InOutStock: Nhập - Xuất - Tồn từ inventory_logs ──
  private async chartInOutStock(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const conds: Prisma.Sql[] = [];
    if (query.branchId)
      conds.push(Prisma.sql`l."branchId" = ${query.branchId}`);
    if (query.productId)
      conds.push(Prisma.sql`l."productId" = ${query.productId}`);
    if (query.productKeyword) {
      const kw = `%${query.productKeyword}%`;
      conds.push(
        Prisma.sql`(l."productName" ILIKE ${kw} OR l."productCode" ILIKE ${kw})`,
      );
    }
    const fromCond = query.fromDate
      ? Prisma.sql`AND l."transactionDate" >= ${new Date(query.fromDate)}`
      : Prisma.empty;
    const toCond = query.toDate
      ? Prisma.sql`AND l."transactionDate" <= ${new Date(query.toDate)}`
      : Prisma.empty;
    const extra = conds.length
      ? Prisma.sql`AND ${Prisma.join(conds, ' AND ')}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        l."productCode" AS code,
        l."productName" AS name,
        COALESCE(SUM(CASE WHEN l."transactionDate" < ${query.fromDate ? new Date(query.fromDate) : new Date(0)} THEN l.quantity ELSE 0 END), 0)::float8 AS opening,
        COALESCE(SUM(CASE WHEN l."transactionDate" < ${query.fromDate ? new Date(query.fromDate) : new Date(0)} THEN l.quantity * l."costPrice" ELSE 0 END), 0)::float8 AS opening_value,
        COALESCE(SUM(CASE WHEN l.quantity > 0 ${fromCond} ${toCond} THEN l.quantity ELSE 0 END), 0)::float8 AS stock_in,
        COALESCE(SUM(CASE WHEN l.quantity > 0 ${fromCond} ${toCond} THEN l.quantity * l."costPrice" ELSE 0 END), 0)::float8 AS stock_in_value,
        COALESCE(SUM(CASE WHEN l.quantity < 0 ${fromCond} ${toCond} THEN -l.quantity ELSE 0 END), 0)::float8 AS stock_out,
        COALESCE(SUM(CASE WHEN l.quantity < 0 ${fromCond} ${toCond} THEN -l.quantity * l."costPrice" ELSE 0 END), 0)::float8 AS stock_out_value
      FROM inventory_logs l
      WHERE 1=1 ${extra}
      GROUP BY l."productCode", l."productName"
      HAVING SUM(ABS(l.quantity)) > 0
      ORDER BY name ASC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => {
      const opening = Number(r.opening) || 0;
      const openingValue = Number(r.opening_value) || 0;
      const stockIn = Number(r.stock_in) || 0;
      const inValue = Number(r.stock_in_value) || 0;
      const stockOut = Number(r.stock_out) || 0;
      const outValue = Number(r.stock_out_value) || 0;
      const closing = opening + stockIn - stockOut;
      const closingValue = openingValue + inValue - outValue;
      return {
        subject: r.name,
        value: closing,
        total: closing,
        extra1: r.code || null,
        quantity: stockIn - stockOut,
        openingQuantity: opening,
        openingValue,
        inQuantity: stockIn,
        inValue,
        outQuantity: stockOut,
        outValue,
        closingQuantity: closing,
        closingValue,
        // Giữ các field cũ để tương thích với response/chart đang sử dụng.
        revenue: opening,
        totalCost: stockIn,
        profit: stockOut,
      };
    });
  }

  // ── DamageItem: hàng hỏng/hủy từ destructions ──
  private async chartDamage(
    query: ProductReportQueryDto,
  ): Promise<ProductChartRow[]> {
    const conds: Prisma.Sql[] = [Prisma.sql`de.status = 2`];
    if (query.fromDate)
      conds.push(
        Prisma.sql`COALESCE(de."destructionDate", de."createdAt") >= ${new Date(query.fromDate)}`,
      );
    if (query.toDate)
      conds.push(
        Prisma.sql`COALESCE(de."destructionDate", de."createdAt") <= ${new Date(query.toDate)}`,
      );
    if (query.branchId)
      conds.push(Prisma.sql`de."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        dd."productCode" AS code,
        dd."productName" AS name,
        SUM(dd.quantity)::float8 AS qty,
        SUM(dd."totalValue")::float8 AS value
      FROM destruction_details dd
      JOIN destructions de ON de.id = dd."destructionId"
      WHERE ${where}
      GROUP BY dd."productCode", dd."productName"
      ORDER BY value DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.value) || 0,
      total: Number(r.value) || 0,
      quantity: Number(r.qty) || 0,
      extra1: r.code || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW (bảng = chart data + summary)
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: ProductReportQueryDto) {
    const viewType: ProductViewType = query.viewType || 'ProductBySale';
    const rows = await this.getChart(query);
    const summary = rows.reduce(
      (acc, r) => {
        acc.totalValue += r.value || 0;
        acc.totalQuantity += r.quantity || 0;
        if (viewType === 'ProductByProfit') {
          acc.totalRevenue += r.revenue || 0;
          acc.totalCost += r.totalCost || 0;
        }
        return acc;
      },
      {
        totalRows: rows.length,
        totalValue: 0,
        totalQuantity: 0,
        totalRevenue: 0,
        totalCost: 0,
      },
    );
    return { viewType, data: rows, total: rows.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRILLDOWN: dòng hóa đơn chứa 1 sản phẩm (theo productId hoặc code)
  // ═══════════════════════════════════════════════════════════════════════════
  async getProductInvoices(query: ProductReportQueryDto) {
    const where = this.buildDetailWhereSql(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        d.id,
        i.code AS invoice_code,
        i."purchaseDate" AS purchase_date,
        u.name AS sold_by_name,
        c.name AS customer_name,
        i."priceBookId" AS price_book_id,
        i."priceBookName" AS price_book_name,
        d."productCode" AS product_code,
        d."productName" AS product_name,
        d.quantity::float8 AS quantity,
        d.price::float8 AS price,
        d.discount::float8 AS discount,
        d."discountRatio"::float8 AS discount_ratio,
        d."totalPrice"::float8 AS total_price,
        COALESCE(inv.cost, 0)::float8 AS unit_cost
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      ${this.costJoin()}
      LEFT JOIN products p ON p.id = d."productId"
      LEFT JOIN users u ON u.id = i."soldById"
      LEFT JOIN customers c ON c.id = i."customerId"
      WHERE ${where}
      ORDER BY i."purchaseDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      LEFT JOIN products p ON p.id = d."productId"
      WHERE ${where}
    `;
    const sumRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(SUM(d.quantity), 0)::float8 AS qty,
        COALESCE(SUM(d."totalPrice"), 0)::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      LEFT JOIN products p ON p.id = d."productId"
      WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;
    return {
      data: rows.map((r) => ({
        id: r.id,
        invoiceCode: r.invoice_code,
        purchaseDate: r.purchase_date,
        soldByName: r.sold_by_name || null,
        customerName: r.customer_name || 'Khách lẻ',
        productCode: r.product_code,
        productName: r.product_name,
        quantity: Number(r.quantity) || 0,
        price: Number(r.price) || 0,
        discount: Number(r.discount) || 0,
        discountRatio: Number(r.discount_ratio) || 0,
        priceAfterDiscount: (Number(r.price) || 0) - (Number(r.discount) || 0),
        totalPrice: Number(r.total_price) || 0,
        unitCost: Number(r.unit_cost) || 0,
        priceBookId: r.price_book_id ?? null,
        priceBookName: r.price_book_name || '',
      })),
      total,
      page,
      limit,
      summary: {
        totalInvoices: total,
        totalQuantity: Number(sumRows[0]?.qty) || 0,
        totalRevenue: Number(sumRows[0]?.revenue) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: ProductReportQueryDto, res: Response) {
    const viewType: ProductViewType = query.viewType || 'ProductBySale';
    // Export lấy toàn bộ theo filter, bỏ qua top 20 của chart.
    const rows = await this.getChart({ ...query, limit: 1000000 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bao cao hang hoa');
    const money = (n?: number) => Number(n) || 0;

    if (viewType === 'ProductByProfit') {
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Sản phẩm', key: 'subject', width: 36 },
        { header: 'SL bán', key: 'qty', width: 12 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
        { header: 'Giá vốn', key: 'cost', width: 18 },
        { header: 'Lợi nhuận', key: 'profit', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          qty: money(r.quantity),
          revenue: money(r.revenue),
          cost: money(r.totalCost),
          profit: money(r.profit),
        }),
      );
    } else if (viewType === 'InOutStock' || viewType === 'InOutStockDetail') {
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Sản phẩm', key: 'subject', width: 36 },
        { header: 'Tồn đầu', key: 'opening', width: 14 },
        { header: 'Giá trị đầu kỳ', key: 'openingValue', width: 18 },
        { header: 'Nhập', key: 'in', width: 14 },
        { header: 'Giá trị nhập', key: 'inValue', width: 18 },
        { header: 'Xuất', key: 'out', width: 14 },
        { header: 'Giá trị xuất', key: 'outValue', width: 18 },
        { header: 'Tồn cuối', key: 'closing', width: 14 },
        { header: 'Giá trị cuối kỳ', key: 'closingValue', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          opening: money(r.openingQuantity),
          openingValue: money(r.openingValue),
          in: money(r.inQuantity),
          inValue: money(r.inValue),
          out: money(r.outQuantity),
          outValue: money(r.outValue),
          closing: money(r.closingQuantity),
          closingValue: money(r.closingValue),
        }),
      );
    } else {
      const subjHeader =
        viewType === 'ProductByCategory' ? 'Nhóm hàng' : 'Sản phẩm';
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: subjHeader, key: 'subject', width: 36 },
        { header: 'SL', key: 'qty', width: 12 },
        {
          header: viewType === 'DamageItem' ? 'Giá trị' : 'Doanh thu',
          key: 'value',
          width: 18,
        },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          qty: money(r.quantity),
          value: money(r.value),
        }),
      );
    }

    ws.getRow(1).font = { bold: true };
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=bao-cao-hang-hoa_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }

  // ── EXPORT CHI TIẾT: toàn bộ dòng hóa đơn theo bộ lọc ──
  async exportProductInvoices(query: ProductReportQueryDto, res: Response) {
    const result = await this.getProductInvoices({ ...query, limit: 100000 });
    const isProfit = (query.viewType || 'ProductBySale') === 'ProductByProfit';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Chi tiet hang hoa');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã giao dịch', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Khách hàng', key: 'customer', width: 28 },
      { header: 'Bảng giá', key: 'priceBookName', width: 22 },
      { header: 'Sản phẩm', key: 'product', width: 36 },
      { header: 'SL', key: 'qty', width: 12 },
      { header: 'Đơn giá', key: 'price', width: 16 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Đơn giá sau giảm giá', key: 'priceAfterDiscount', width: 18 },
      { header: 'Thành tiền', key: 'total', width: 18 },
      ...(isProfit
        ? [
            { header: 'Giá vốn', key: 'unitCost', width: 16 },
            { header: 'Tổng giá vốn', key: 'totalCost', width: 16 },
            { header: 'Lợi nhuận', key: 'profit', width: 16 },
          ]
        : []),
    ];
    result.data.forEach((r, i) => {
      const row: Record<string, unknown> = {
        stt: i + 1,
        code: r.invoiceCode,
        date: new Date(r.purchaseDate).toLocaleString('vi-VN'),
        customer: r.customerName,
        priceBookName: r.priceBookName || '',
        product: r.productName,
        qty: r.quantity,
        price: r.price,
        discount: r.discount,
        priceAfterDiscount: r.priceAfterDiscount,
        total: r.totalPrice,
      };
      if (isProfit) {
        const totalCost = r.unitCost * r.quantity;
        row.unitCost = r.unitCost;
        row.totalCost = totalCost;
        row.profit = r.totalPrice - totalCost;
      }
      ws.addRow(row);
    });
    ws.getRow(1).font = { bold: true };
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=chi-tiet-hang-hoa_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }
}
