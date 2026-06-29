import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';
import { CustomerReportQueryDto, CustomerViewType } from './dto';
import { ReportQueryDto } from './dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

// Dòng dữ liệu chuẩn cho biểu đồ Khách hàng (đồng bộ schema KiotViet §8)
export interface CustomerChartRow {
  subject: string;
  value: number;
  total: number;
  extra1?: string | null;
  // Profit view
  revenue?: number;
  totalCost?: number;
  profit?: number;
  // Debt view
  opening?: number;
  debit?: number;
  credit?: number;
  closing?: number;
}

const CUSTOMER_INVOICE_EXCLUDE_STATUS = [2, 8]; // CANCELLED, ...
const DEBT_GROUP_SIZE = 200;

@Injectable()
export class CustomerReportsService {
  constructor(
    private prisma: PrismaService,
    private reportsService: ReportsService,
  ) {}

  // Chuyển DTO Customer → DTO chung (ReportQueryDto) để tái dùng logic legacy.
  private toReportQuery(query: CustomerReportQueryDto): ReportQueryDto {
    return {
      fromDate: query.fromDate,
      toDate: query.toDate,
      branchId: query.branchId,
      customerId: query.customerId,
      customerGroupId: query.customerGroupId,
      page: query.page,
      limit: query.limit,
    } as ReportQueryDto;
  }

  // TOP N cho chart/data table: `limit` (data table) thắng `top` (chart Top 20).
  private chartTop(query: CustomerReportQueryDto): number {
    const n = query.limit ?? query.top ?? 20;
    return Math.max(1, Math.min(1000000, n));
  }

  // ── WHERE invoice_details join invoices (cho Profit raw SQL) ──
  private buildDetailWhereSql(query: CustomerReportQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [
      Prisma.sql`i.status NOT IN (${Prisma.join(CUSTOMER_INVOICE_EXCLUDE_STATUS)})`,
    ];
    if (query.fromDate)
      conds.push(Prisma.sql`i."purchaseDate" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`i."purchaseDate" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    if (query.customerId)
      conds.push(Prisma.sql`i."customerId" = ${query.customerId}`);
    if (query.customerKeyword) {
      const kw = `%${query.customerKeyword}%`;
      conds.push(
        Prisma.sql`(c.name ILIKE ${kw} OR c.code ILIKE ${kw} OR c."contactNumber" ILIKE ${kw})`,
      );
    }
    return Prisma.join(conds, ' AND ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART (Top N)
  // ═══════════════════════════════════════════════════════════════════════════
  async getChart(query: CustomerReportQueryDto): Promise<CustomerChartRow[]> {
    const viewType: CustomerViewType = query.viewType || 'CustomerBySale';
    switch (viewType) {
      case 'CustomerByProfit':
        return this.chartByProfit(query);
      case 'CustomerDebt':
        return this.chartByDebt(query);
      case 'CustomerByProduct':
        return this.chartByProduct(query);
      case 'CustomerBySale':
      default:
        return this.chartBySale(query);
    }
  }

  // ── CustomerBySale: doanh thu thuần (grandTotal − trả hàng) theo KH ──
  private async chartBySale(
    query: CustomerReportQueryDto,
  ): Promise<CustomerChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.code AS code,
        c.name AS name,
        SUM(i_rev.revenue)::float8 AS revenue
      FROM (
        SELECT
          i.id,
          i."customerId",
          i."grandTotal" AS revenue
        FROM invoices i
        LEFT JOIN customers c ON c.id = i."customerId"
        WHERE ${where}
      ) i_rev
      JOIN customers c ON c.id = i_rev."customerId"
      WHERE c."isActive" = true
      GROUP BY c.code, c.name
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name || 'Khách lẻ',
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      extra1: r.code || null,
    }));
  }

  // ── CustomerByProfit: doanh thu − giá vốn theo KH ──
  private async chartByProfit(
    query: CustomerReportQueryDto,
  ): Promise<CustomerChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.code AS code,
        c.name AS name,
        SUM(d."totalPrice")::float8 AS revenue,
        COALESCE(SUM(d.quantity * COALESCE(inv.cost, 0)), 0)::float8 AS cost
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      LEFT JOIN inventories inv
        ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
      WHERE ${where} AND c."isActive" = true
      GROUP BY c.code, c.name
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => {
      const revenue = Number(r.revenue) || 0;
      const cost = Number(r.cost) || 0;
      return {
        subject: r.name || 'Khách lẻ',
        value: revenue - cost,
        total: revenue,
        revenue,
        totalCost: cost,
        profit: revenue - cost,
        extra1: r.code || null,
      };
    });
  }

  // ── CustomerDebt: nợ cuối kỳ theo KH (tái dùng aggregate legacy) ──
  private async chartByDebt(
    query: CustomerReportQueryDto,
  ): Promise<CustomerChartRow[]> {
    const legacy = await this.reportsService.getCustomerDebtChart(
      this.toReportQuery(query),
    );
    return legacy.map((r) => ({
      subject: r.subject,
      value: r.value,
      total: r.total,
      extra1: r.extra1,
      closing: r.value,
    }));
  }

  // ── CustomerByProduct: doanh thu (totalPrice) theo KH ──
  private async chartByProduct(
    query: CustomerReportQueryDto,
  ): Promise<CustomerChartRow[]> {
    const where = this.buildDetailWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.code AS code,
        c.name AS name,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      WHERE ${where} AND c."isActive" = true
      GROUP BY c.code, c.name
      ORDER BY revenue DESC
      LIMIT ${this.chartTop(query)}
    `;
    return rows.map((r) => ({
      subject: r.name || 'Khách lẻ',
      value: Number(r.revenue) || 0,
      total: Number(r.revenue) || 0,
      extra1: r.code || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW (bảng tổng hợp theo KH — Lv1)
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: CustomerReportQueryDto) {
    const viewType: CustomerViewType = query.viewType || 'CustomerBySale';

    if (viewType === 'CustomerDebt') {
      return this.getDebtGroups(query);
    }

    const rows = await this.getChart(query);
    const summary = rows.reduce(
      (acc, r) => {
        acc.totalValue += r.value || 0;
        if (viewType === 'CustomerByProfit') {
          acc.totalRevenue += r.revenue || 0;
          acc.totalCost += r.totalCost || 0;
        }
        return acc;
      },
      { totalRows: rows.length, totalValue: 0, totalRevenue: 0, totalCost: 0 },
    );
    return { viewType, data: rows, total: rows.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBT Lv1: nhóm rank công nợ (200 KH / nhóm) — giống KiotViet BigCustomerDebt
  // ═══════════════════════════════════════════════════════════════════════════
  private async getDebtGroups(query: CustomerReportQueryDto) {
    if (query.toDate && !query.fromDate) {
      throw new BadRequestException(
        'Vui lòng chọn "Từ ngày" khi đã chọn "Đến ngày"',
      );
    }
    // Lấy toàn bộ aggregate qua preview legacy (đã sort desc theo closingDebt).
    const legacy = await this.reportsService.getCustomerDebtPreview({
      ...this.toReportQuery(query),
      page: 1,
      limit: 1000000,
    });

    const all = legacy.data as Array<{
      customerId: number;
      customerCode: string;
      customerName: string;
      openingDebt: number;
      debit: number;
      credit: number;
      closingDebt: number;
    }>;

    const groups: any[] = [];
    for (let i = 0; i < all.length; i += DEBT_GROUP_SIZE) {
      const slice = all.slice(i, i + DEBT_GROUP_SIZE);
      const start = i + 1;
      const end = i + slice.length;
      const agg = slice.reduce(
        (acc, r) => {
          acc.opening += r.openingDebt;
          acc.debit += r.debit;
          acc.credit += r.credit;
          acc.closing += r.closingDebt;
          return acc;
        },
        { opening: 0, debit: 0, credit: 0, closing: 0 },
      );
      groups.push({
        subject: `Khách hàng từ ${start} đến ${end}`,
        value: agg.closing,
        total: agg.closing,
        opening: agg.opening,
        debit: agg.debit,
        credit: agg.credit,
        closing: agg.closing,
        rankStart: start,
        rankEnd: end,
        customerIds: slice.map((r) => r.customerId),
      });
    }

    return {
      viewType: 'CustomerDebt' as const,
      data: groups,
      total: groups.length,
      summary: {
        totalRows: all.length,
        totalValue: legacy.summary.totalClosing,
        totalOpening: legacy.summary.totalOpening,
        totalDebit: legacy.summary.totalDebit,
        totalCredit: legacy.summary.totalCredit,
        totalClosing: legacy.summary.totalClosing,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBT Lv2: danh sách KH trong 1 nhóm rank (rankStart..rankEnd)
  // ═══════════════════════════════════════════════════════════════════════════
  async getDebtCustomers(query: CustomerReportQueryDto) {
    const legacy = await this.reportsService.getCustomerDebtPreview({
      ...this.toReportQuery(query),
      page: 1,
      limit: 1000000,
    });
    const all = legacy.data as any[];
    const start = (query.rankStart || 1) - 1;
    const end = query.rankEnd || all.length;
    const slice = all.slice(start, end);

    const summary = slice.reduce(
      (acc, r) => {
        acc.totalOpening += r.openingDebt;
        acc.totalDebit += r.debit;
        acc.totalCredit += r.credit;
        acc.totalClosing += r.closingDebt;
        return acc;
      },
      {
        totalCustomers: slice.length,
        totalOpening: 0,
        totalDebit: 0,
        totalCredit: 0,
        totalClosing: 0,
      },
    );

    return { data: slice, total: slice.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBT Lv3: chi tiết phát sinh công nợ của 1 KH
  // ═══════════════════════════════════════════════════════════════════════════
  async getDebtDocuments(query: CustomerReportQueryDto) {
    if (!query.customerId) {
      throw new BadRequestException('Thiếu customerId');
    }
    if (query.toDate && !query.fromDate) {
      throw new BadRequestException(
        'Vui lòng chọn "Từ ngày" khi đã chọn "Đến ngày"',
      );
    }

    const fromDate = query.fromDate ? new Date(query.fromDate) : new Date(0);
    const toDate = query.toDate ? new Date(query.toDate) : new Date();
    const branchFilter = query.branchId ? { branchId: query.branchId } : {};

    // Nợ đầu kỳ: tái dùng aggregate legacy (giới hạn 1 KH).
    const legacy = await this.reportsService.getCustomerDebtPreview({
      ...this.toReportQuery(query),
      customerId: query.customerId,
      page: 1,
      limit: 1,
    });
    const opening =
      (legacy.data[0] as any)?.openingDebt ?? 0;

    const [invoices, cashFlowsRaw, returnOrders] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          customerId: query.customerId,
          status: { not: 2 },
          purchaseDate: { gte: fromDate, lte: toDate },
          ...branchFilter,
        },
        orderBy: { purchaseDate: 'asc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          grandTotal: true,
        },
      }),
      this.prisma.cashFlow.findMany({
        where: {
          partnerId: query.customerId,
          partnerType: 'C',
          status: { not: 2 },
          transDate: { gte: fromDate, lte: toDate },
          ...branchFilter,
        },
        orderBy: { transDate: 'asc' },
        select: {
          id: true,
          code: true,
          transDate: true,
          amount: true,
          isReceipt: true,
        },
      }),
      this.prisma.returnOrder.findMany({
        where: {
          customerId: query.customerId,
          OR: [
            { status: 2 },
            { status: 4, refundType: 'debt_offset' },
            { status: 4, refundType: 'cash_refund' },
          ],
          createdAt: { gte: fromDate, lte: toDate },
          ...branchFilter,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          createdAt: true,
          refundAmount: true,
        },
      }),
    ]);

    const cashFlows = cashFlowsRaw.filter(
      (cf) => !(cf.isReceipt && cf.code.startsWith('TTTUHD')),
    );

    type Doc = {
      time: Date;
      code: string;
      type: string;
      debit: number;
      credit: number;
    };
    const docs: Doc[] = [];
    for (const inv of invoices)
      docs.push({
        time: inv.purchaseDate,
        code: inv.code,
        type: 'Bán hàng',
        debit: Number(inv.grandTotal),
        credit: 0,
      });
    for (const cf of cashFlows) {
      if (cf.isReceipt)
        docs.push({
          time: cf.transDate,
          code: cf.code,
          type: 'Thanh toán',
          debit: 0,
          credit: Number(cf.amount),
        });
      else
        docs.push({
          time: cf.transDate,
          code: cf.code,
          type: 'Chi tiền cho KH',
          debit: Number(cf.amount),
          credit: 0,
        });
    }
    for (const ro of returnOrders)
      docs.push({
        time: ro.createdAt,
        code: ro.code,
        type: 'Trả hàng',
        debit: 0,
        credit: Number(ro.refundAmount),
      });

    docs.sort((a, b) => a.time.getTime() - b.time.getTime());

    let running = opening;
    const data = docs.map((d) => {
      running += d.debit - d.credit;
      return {
        code: d.code,
        date: d.time,
        type: d.type,
        debit: d.debit,
        credit: d.credit,
        balance: running,
      };
    });

    const summary = {
      openingDebt: opening,
      totalDebit: docs.reduce((s, d) => s + d.debit, 0),
      totalCredit: docs.reduce((s, d) => s + d.credit, 0),
      closingDebt: running,
      totalRows: data.length,
    };

    return { data, total: data.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INVOICES Lv2: dòng hóa đơn của 1 KH (Sale / Profit / Product)
  // ═══════════════════════════════════════════════════════════════════════════
  async getCustomerInvoices(query: CustomerReportQueryDto) {
    const where = this.buildDetailWhereSql(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        d.id,
        i.code AS invoice_code,
        i."purchaseDate" AS purchase_date,
        c.name AS customer_name,
        d."productCode" AS product_code,
        d."productName" AS product_name,
        d.quantity::float8 AS quantity,
        d.price::float8 AS price,
        d.discount::float8 AS discount,
        d."totalPrice"::float8 AS total_price,
        COALESCE(inv.cost, 0)::float8 AS unit_cost
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      LEFT JOIN inventories inv
        ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
      WHERE ${where}
      ORDER BY i."purchaseDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalRow = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      WHERE ${where}
    `;
    const total = Number(totalRow[0]?.total) || 0;

    const summaryRow = await this.prisma.$queryRaw<any[]>`
      SELECT
        COUNT(*)::int AS rows,
        COALESCE(SUM(d.quantity), 0)::float8 AS qty,
        COALESCE(SUM(d."totalPrice"), 0)::float8 AS revenue,
        COALESCE(SUM(d.quantity * COALESCE(inv.cost, 0)), 0)::float8 AS cost
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      LEFT JOIN inventories inv
        ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
      WHERE ${where}
    `;
    const s = summaryRow[0] || {};

    return {
      data: rows.map((r) => {
        const revenue = Number(r.total_price) || 0;
        const cost = (Number(r.quantity) || 0) * (Number(r.unit_cost) || 0);
        return {
          id: r.id,
          invoiceCode: r.invoice_code,
          purchaseDate: r.purchase_date,
          customerName: r.customer_name,
          productCode: r.product_code,
          productName: r.product_name,
          quantity: Number(r.quantity) || 0,
          price: Number(r.price) || 0,
          discount: Number(r.discount) || 0,
          priceAfterDiscount:
            (Number(r.price) || 0) - (Number(r.discount) || 0),
          totalPrice: revenue,
          cost,
          profit: revenue - cost,
        };
      }),
      total,
      page,
      limit,
      summary: {
        totalInvoices: Number(s.rows) || 0,
        totalQuantity: Number(s.qty) || 0,
        totalRevenue: Number(s.revenue) || 0,
        totalCost: Number(s.cost) || 0,
        totalProfit: (Number(s.revenue) || 0) - (Number(s.cost) || 0),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT EXCEL — bảng tổng hợp (overview) theo ViewType
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: CustomerReportQueryDto, res: Response) {
    const viewType: CustomerViewType = query.viewType || 'CustomerBySale';
    // Lấy toàn bộ theo filter (bỏ limit/top).
    const fullQuery = { ...query, limit: 1000000, top: undefined };
    const preview = await this.getPreview(fullQuery);
    const rows = preview.data as any[];

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('BaoCaoKhachHang');

    if (viewType === 'CustomerByProfit') {
      sheet.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã KH', key: 'code', width: 14 },
        { header: 'Khách hàng', key: 'name', width: 32 },
        { header: 'Doanh thu', key: 'revenue', width: 16 },
        { header: 'Giá vốn', key: 'cost', width: 16 },
        { header: 'Lợi nhuận', key: 'profit', width: 16 },
      ];
    } else if (viewType === 'CustomerDebt') {
      sheet.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Nhóm khách hàng', key: 'name', width: 32 },
        { header: 'Nợ đầu kỳ', key: 'opening', width: 16 },
        { header: 'Ghi nợ', key: 'debit', width: 16 },
        { header: 'Ghi có', key: 'credit', width: 16 },
        { header: 'Nợ cuối kỳ', key: 'closing', width: 16 },
      ];
    } else {
      sheet.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã KH', key: 'code', width: 14 },
        { header: 'Khách hàng', key: 'name', width: 32 },
        { header: 'Doanh thu', key: 'value', width: 18 },
      ];
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    rows.forEach((r, idx) => {
      if (viewType === 'CustomerByProfit') {
        sheet
          .addRow({
            stt: idx + 1,
            code: r.extra1 || '',
            name: r.subject,
            revenue: r.revenue || 0,
            cost: r.totalCost || 0,
            profit: r.profit || 0,
          })
          .commit();
      } else if (viewType === 'CustomerDebt') {
        sheet
          .addRow({
            stt: idx + 1,
            name: r.subject,
            opening: r.opening || 0,
            debit: r.debit || 0,
            credit: r.credit || 0,
            closing: r.closing || 0,
          })
          .commit();
      } else {
        sheet
          .addRow({
            stt: idx + 1,
            code: r.extra1 || '',
            name: r.subject,
            value: r.value || 0,
          })
          .commit();
      }
    });

    sheet.commit();
    await workbook.commit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT EXCEL — chi tiết dòng hóa đơn (Sale/Profit/Product)
  // ═══════════════════════════════════════════════════════════════════════════
  async exportCustomerInvoices(query: CustomerReportQueryDto, res: Response) {
    const result = await this.getCustomerInvoices({
      ...query,
      page: 1,
      limit: 1000000,
    });
    const isProfit = (query.viewType || 'CustomerBySale') === 'CustomerByProfit';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('ChiTietKhachHang');

    const cols: Partial<ExcelJS.Column>[] = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã GD', key: 'invoiceCode', width: 16 },
      { header: 'Thời gian', key: 'purchaseDate', width: 18 },
      { header: 'Khách hàng', key: 'customerName', width: 28 },
      { header: 'Mã SP', key: 'productCode', width: 14 },
      { header: 'Sản phẩm', key: 'productName', width: 32 },
      { header: 'SL', key: 'quantity', width: 10 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Giảm giá', key: 'discount', width: 12 },
      { header: 'Thành tiền', key: 'totalPrice', width: 16 },
    ];
    if (isProfit) {
      cols.push(
        { header: 'Giá vốn', key: 'cost', width: 14 },
        { header: 'Lợi nhuận', key: 'profit', width: 14 },
      );
    }
    sheet.columns = cols;

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    (result.data as any[]).forEach((r, idx) => {
      const row: any = {
        stt: idx + 1,
        invoiceCode: r.invoiceCode,
        purchaseDate: new Date(r.purchaseDate),
        customerName: r.customerName,
        productCode: r.productCode,
        productName: r.productName,
        quantity: r.quantity,
        price: r.price,
        discount: r.discount,
        totalPrice: r.totalPrice,
      };
      if (isProfit) {
        row.cost = r.cost;
        row.profit = r.profit;
      }
      sheet.addRow(row).commit();
    });

    sheet.commit();
    await workbook.commit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT EXCEL — chi tiết công nợ 1 KH (Debt Lv3)
  // ═══════════════════════════════════════════════════════════════════════════
  async exportDebtDocuments(query: CustomerReportQueryDto, res: Response) {
    const result = await this.getDebtDocuments(query);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('ChiTietCongNo');
    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Thời gian', key: 'date', width: 18 },
      { header: 'Mã chứng từ', key: 'code', width: 18 },
      { header: 'Loại', key: 'type', width: 16 },
      { header: 'Ghi nợ', key: 'debit', width: 16 },
      { header: 'Ghi có', key: 'credit', width: 16 },
      { header: 'Dư nợ', key: 'balance', width: 16 },
    ];
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    sheet
      .addRow({
        stt: '',
        date: '',
        code: '---',
        type: 'Dư nợ đầu kỳ',
        debit: 0,
        credit: 0,
        balance: result.summary.openingDebt,
      })
      .commit();

    (result.data as any[]).forEach((r, idx) => {
      sheet
        .addRow({
          stt: idx + 1,
          date: new Date(r.date),
          code: r.code,
          type: r.type,
          debit: r.debit,
          credit: r.credit,
          balance: r.balance,
        })
        .commit();
    });

    sheet.commit();
    await workbook.commit();
  }
}
