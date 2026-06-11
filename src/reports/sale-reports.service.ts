import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SaleReportQueryDto, SaleViewType } from './dto';
import { RETURN_ORDER_STATUS } from '../return-orders/dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

// Dòng dữ liệu chuẩn cho biểu đồ (theo schema KiotViet §8):
// { subject, value, total, extra1?, group?, extraOrderBy? }
export interface SaleChartRow {
  subject: string;
  value: number;
  total: number;
  extra1?: string | null;
  group?: string | null;
  extraOrderBy?: string | null;
  // Riêng view Profit: server trả sẵn revenue/cost/profit
  revenue?: number;
  totalCost?: number;
  profit?: number;
}

@Injectable()
export class SaleReportsService {
  constructor(private prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: build điều kiện WHERE (raw SQL) từ filter
  // Doanh thu loại hóa đơn Đã hủy (2) + Trả hàng (8) — đồng bộ dashboard.
  // ═══════════════════════════════════════════════════════════════════════════
  private buildInvoiceWhereSql(query: SaleReportQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`i.status NOT IN (2, 8)`];

    if (query.fromDate) {
      conds.push(Prisma.sql`i."purchaseDate" >= ${new Date(query.fromDate)}`);
    }
    if (query.toDate) {
      conds.push(Prisma.sql`i."purchaseDate" <= ${new Date(query.toDate)}`);
    }
    if (query.branchId) {
      conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    }
    if (query.soldById) {
      conds.push(Prisma.sql`i."soldById" = ${query.soldById}`);
    }
    if (query.saleChannelId) {
      conds.push(Prisma.sql`i."saleChannelId" = ${query.saleChannelId}`);
    }
    if (query.priceBookId) {
      conds.push(Prisma.sql`i."priceBookId" = ${query.priceBookId}`);
    }

    return Prisma.join(conds, ' AND ');
  }

  // Tổng giá vốn (COGS) theo từng hóa đơn — dùng cho view Profit.
  private cogsLateral(): Prisma.Sql {
    return Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT SUM(d.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM invoice_details d
        LEFT JOIN inventories inv
          ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
        WHERE d."invoiceId" = i.id
      ) li ON true`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART: trả mảng SaleChartRow theo từng ViewType
  // ═══════════════════════════════════════════════════════════════════════════
  async getChart(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const viewType: SaleViewType = query.viewType || 'PurchaseDate';
    switch (viewType) {
      case 'Profit':
        return this.chartProfit(query);
      case 'SoldBy':
        return this.chartSoldBy(query);
      case 'Branch':
        return this.chartBranch(query);
      case 'Refund':
        return this.chartRefund(query);
      case 'PurchaseDate':
      default:
        return this.chartByDate(query);
    }
  }

  // ── PurchaseDate: doanh thu theo ngày, stacked theo chi nhánh ──
  private async chartByDate(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const where = this.buildInvoiceWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', i."purchaseDate") AS bucket,
        b.name AS branch_name,
        SUM(i."grandTotal")::float8 AS revenue
      FROM invoices i
      LEFT JOIN branches b ON b.id = i."branchId"
      WHERE ${where}
      GROUP BY bucket, b.name
      ORDER BY bucket ASC
    `;
    return rows.map((r) => {
      const d = new Date(r.bucket);
      const subject = `${String(d.getDate()).padStart(2, '0')}/${String(
        d.getMonth() + 1,
      ).padStart(2, '0')}`;
      const value = Number(r.revenue) || 0;
      return {
        subject,
        value,
        total: value,
        group: r.branch_name || 'Chưa rõ',
        extraOrderBy: d.toISOString(),
      };
    });
  }

  // ── Profit: revenue/cost/profit theo ngày ──
  private async chartProfit(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const where = this.buildInvoiceWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', i."purchaseDate") AS bucket,
        SUM(i."grandTotal")::float8 AS revenue,
        COALESCE(SUM(li.cogs), 0)::float8 AS cogs
      FROM invoices i
      ${this.cogsLateral()}
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => {
      const d = new Date(r.bucket);
      const subject = `${String(d.getDate()).padStart(2, '0')}/${String(
        d.getMonth() + 1,
      ).padStart(2, '0')}`;
      const revenue = Number(r.revenue) || 0;
      const totalCost = Number(r.cogs) || 0;
      const profit = revenue - totalCost;
      return {
        subject,
        value: profit,
        total: revenue,
        revenue,
        totalCost,
        profit,
        extraOrderBy: d.toISOString(),
      };
    });
  }

  // ── SoldBy: doanh thu theo nhân viên bán ──
  private async chartSoldBy(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const where = this.buildInvoiceWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        u.id AS user_id,
        COALESCE(u.name, 'Chưa xác định') AS name,
        SUM(i."grandTotal")::float8 AS revenue
      FROM invoices i
      LEFT JOIN users u ON u.id = i."soldById"
      WHERE ${where}
      GROUP BY u.id, u.name
      ORDER BY revenue DESC
    `;
    return rows.map((r) => {
      const value = Number(r.revenue) || 0;
      return {
        subject: r.name,
        value,
        total: value,
        extra1: r.user_id ? String(r.user_id) : null,
      };
    });
  }

  // ── Branch: doanh thu theo chi nhánh ──
  private async chartBranch(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const where = this.buildInvoiceWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        b.id AS branch_id,
        COALESCE(b.name, 'Chưa rõ') AS name,
        SUM(i."grandTotal")::float8 AS revenue
      FROM invoices i
      LEFT JOIN branches b ON b.id = i."branchId"
      WHERE ${where}
      GROUP BY b.id, b.name
      ORDER BY revenue DESC
    `;
    return rows.map((r) => {
      const value = Number(r.revenue) || 0;
      return {
        subject: r.name,
        value,
        total: value,
        extra1: r.branch_id ? String(r.branch_id) : null,
      };
    });
  }

  // ── Refund: giá trị trả hàng theo ngày ──
  private async chartRefund(query: SaleReportQueryDto): Promise<SaleChartRow[]> {
    const conds: Prisma.Sql[] = [
      Prisma.sql`ro.status IN (${RETURN_ORDER_STATUS.STOCK_RECEIVED}, ${RETURN_ORDER_STATUS.COMPLETED})`,
    ];
    if (query.fromDate)
      conds.push(Prisma.sql`ro."createdAt" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`ro."createdAt" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`ro."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', ro."createdAt") AS bucket,
        SUM(ro."totalReturnAmount")::float8 AS amount
      FROM return_orders ro
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => {
      const d = new Date(r.bucket);
      const subject = `${String(d.getDate()).padStart(2, '0')}/${String(
        d.getMonth() + 1,
      ).padStart(2, '0')}`;
      const value = Number(r.amount) || 0;
      return { subject, value, total: value, extraOrderBy: d.toISOString() };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW: bảng tổng hợp theo NGÀY (đủ cột như KiotViet) + dòng tổng
  // ═══════════════════════════════════════════════════════════════════════════
  private async aggregateByDate(query: SaleReportQueryDto) {
    const where = this.buildInvoiceWhereSql(query);

    // Aggregate hóa đơn bán theo ngày
    const saleRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', i."purchaseDate") AS bucket,
        COUNT(*)::int AS order_count,
        SUM(i."totalAmount")::float8 AS total_amount,
        SUM(i.discount)::float8 AS discount,
        SUM(i."grandTotal")::float8 AS revenue
      FROM invoices i
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket DESC
    `;

    // Aggregate trả hàng theo ngày (cùng filter chi nhánh + khoảng ngày)
    const refundConds: Prisma.Sql[] = [
      Prisma.sql`ro.status IN (${RETURN_ORDER_STATUS.STOCK_RECEIVED}, ${RETURN_ORDER_STATUS.COMPLETED})`,
    ];
    if (query.fromDate)
      refundConds.push(
        Prisma.sql`ro."createdAt" >= ${new Date(query.fromDate)}`,
      );
    if (query.toDate)
      refundConds.push(Prisma.sql`ro."createdAt" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      refundConds.push(Prisma.sql`ro."branchId" = ${query.branchId}`);
    const refundWhere = Prisma.join(refundConds, ' AND ');

    const refundRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', ro."createdAt") AS bucket,
        COUNT(*)::int AS return_count,
        SUM(ro."totalReturnAmount")::float8 AS return_amount
      FROM return_orders ro
      WHERE ${refundWhere}
      GROUP BY bucket
      ORDER BY bucket DESC
    `;

    const refundMap = new Map<string, { count: number; amount: number }>();
    for (const r of refundRows) {
      refundMap.set(new Date(r.bucket).toISOString().slice(0, 10), {
        count: Number(r.return_count) || 0,
        amount: Number(r.return_amount) || 0,
      });
    }

    return saleRows.map((r) => {
      const d = new Date(r.bucket);
      const dayKey = d.toISOString().slice(0, 10);
      const refund = refundMap.get(dayKey) || { count: 0, amount: 0 };
      const totalAmount = Number(r.total_amount) || 0;
      const discount = Number(r.discount) || 0;
      const revenue = Number(r.revenue) || 0;
      return {
        dateIso: d.toISOString(),
        label: `${String(d.getDate()).padStart(2, '0')}/${String(
          d.getMonth() + 1,
        ).padStart(2, '0')}/${d.getFullYear()}`,
        orderCount: Number(r.order_count) || 0,
        totalAmount,
        discount,
        revenue,
        returnCount: refund.count,
        returnAmount: refund.amount,
        netRevenue: revenue - refund.amount,
      };
    });
  }

  private async previewByDate(query: SaleReportQueryDto) {
    const rows = await this.aggregateByDate(query);
    const summary = rows.reduce(
      (acc, r) => {
        acc.totalRows += 1;
        acc.totalOrderCount += r.orderCount;
        acc.totalAmount += r.totalAmount;
        acc.totalDiscount += r.discount;
        acc.totalRevenue += r.revenue;
        acc.totalReturnCount += r.returnCount;
        acc.totalReturnAmount += r.returnAmount;
        acc.totalNetRevenue += r.netRevenue;
        return acc;
      },
      {
        totalRows: 0,
        totalOrderCount: 0,
        totalAmount: 0,
        totalDiscount: 0,
        totalRevenue: 0,
        totalReturnCount: 0,
        totalReturnAmount: 0,
        totalNetRevenue: 0,
      },
    );
    return {
      viewType: 'PurchaseDate' as const,
      data: rows,
      total: rows.length,
      summary,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRILLDOWN: danh sách hóa đơn (kèm giá vốn + lợi nhuận từng HĐ)
  // Dùng chung cho click ngày (PurchaseDate/Profit), nhân viên (SoldBy),
  // chi nhánh (Branch). Filter override truyền qua query (fromDate/toDate/
  // soldById/branchId/priceBookId) — buildInvoiceWhereSql xử lý sẵn.
  // ═══════════════════════════════════════════════════════════════════════════
  async previewProfitInvoices(query: SaleReportQueryDto) {
    const where = this.buildInvoiceWhereSql(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        i.id,
        i.code,
        i."purchaseDate" AS purchase_date,
        u.name AS sold_by_name,
        c.name AS customer_name,
        b.name AS branch_name,
        i."grandTotal"::float8 AS revenue,
        COALESCE(li.cogs, 0)::float8 AS cost
      FROM invoices i
      ${this.cogsLateral()}
      LEFT JOIN users u ON u.id = i."soldById"
      LEFT JOIN customers c ON c.id = i."customerId"
      LEFT JOIN branches b ON b.id = i."branchId"
      WHERE ${where}
      ORDER BY i."purchaseDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total
      FROM invoices i
      WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;

    const summaryRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        SUM(i."grandTotal")::float8 AS revenue,
        COALESCE(SUM(li.cogs), 0)::float8 AS cost
      FROM invoices i
      ${this.cogsLateral()}
      WHERE ${where}
    `;
    const sumRevenue = Number(summaryRows[0]?.revenue) || 0;
    const sumCost = Number(summaryRows[0]?.cost) || 0;

    return {
      data: rows.map((r) => {
        const revenue = Number(r.revenue) || 0;
        const cost = Number(r.cost) || 0;
        return {
          id: r.id,
          code: r.code,
          purchaseDate: r.purchase_date,
          soldByName: r.sold_by_name || null,
          customerName: r.customer_name || 'Khách lẻ',
          branchName: r.branch_name || null,
          revenue,
          cost,
          profit: revenue - cost,
        };
      }),
      total,
      page,
      limit,
      summary: {
        totalInvoices: total,
        totalRevenue: sumRevenue,
        totalCost: sumCost,
        totalProfit: sumRevenue - sumCost,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW: bảng chi tiết (phân trang) + summary theo ViewType
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: SaleReportQueryDto) {
    const viewType: SaleViewType = query.viewType || 'PurchaseDate';
    if (viewType === 'Refund') return this.previewRefund(query);
    if (viewType === 'PurchaseDate') return this.previewByDate(query);
    // Các view còn lại đều là bảng tổng hợp theo nhóm của chart →
    // dùng chính dữ liệu chart làm bảng (đúng tinh thần KiotViet: chart & data
    // cùng nguồn group). Phân trang phía client trên tập nhỏ này.
    const chart = await this.getChart(query);
    const summary = chart.reduce(
      (acc, r) => {
        acc.totalValue += r.value;
        if (viewType === 'Profit') {
          acc.totalRevenue += r.revenue || 0;
          acc.totalCost += r.totalCost || 0;
        }
        return acc;
      },
      { totalValue: 0, totalRevenue: 0, totalCost: 0, totalRows: chart.length },
    );
    return { viewType, data: chart, total: chart.length, summary };
  }

  // ── Refund preview: danh sách phiếu trả hàng ──
  private async previewRefund(query: SaleReportQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = {
      status: {
        in: [RETURN_ORDER_STATUS.STOCK_RECEIVED, RETURN_ORDER_STATUS.COMPLETED],
      },
    };
    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }
    if (query.branchId) where.branchId = query.branchId;

    const [data, total, agg] = await Promise.all([
      this.prisma.returnOrder.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          code: true,
          createdAt: true,
          totalReturnAmount: true,
          refundAmount: true,
          statusValue: true,
          invoice: { select: { code: true } },
          customer: { select: { code: true, name: true } },
          branch: { select: { name: true } },
        },
      }),
      this.prisma.returnOrder.count({ where }),
      this.prisma.returnOrder.aggregate({
        where,
        _sum: { totalReturnAmount: true, refundAmount: true },
      }),
    ]);

    return {
      viewType: 'Refund' as const,
      data: data.map((r) => ({
        id: r.id,
        code: r.code,
        createdAt: r.createdAt,
        invoiceCode: r.invoice?.code || null,
        customerName: r.customer?.name || 'Khách lẻ',
        customerCode: r.customer?.code || null,
        branchName: r.branch?.name || null,
        totalReturnAmount: Number(r.totalReturnAmount) || 0,
        refundAmount: Number(r.refundAmount) || 0,
        statusValue: r.statusValue || '',
      })),
      total,
      page,
      limit,
      summary: {
        totalRows: total,
        totalReturnAmount: Number(agg._sum.totalReturnAmount) || 0,
        totalRefundAmount: Number(agg._sum.refundAmount) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT: xuất Excel theo ViewType
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: SaleReportQueryDto, res: Response) {
    const viewType: SaleViewType = query.viewType || 'PurchaseDate';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bao cao ban hang');

    const money = (n: number) => Number(n) || 0;

    if (viewType === 'Refund') {
      const preview = await this.previewRefund({ ...query, limit: 100000 });
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã trả hàng', key: 'code', width: 18 },
        { header: 'Ngày', key: 'date', width: 14 },
        { header: 'Hóa đơn', key: 'invoiceCode', width: 18 },
        { header: 'Khách hàng', key: 'customerName', width: 28 },
        { header: 'Chi nhánh', key: 'branchName', width: 20 },
        { header: 'Giá trị trả', key: 'totalReturnAmount', width: 16 },
        { header: 'Đã hoàn tiền', key: 'refundAmount', width: 16 },
      ];
      preview.data.forEach((r: any, i: number) =>
        ws.addRow({
          stt: i + 1,
          code: r.code,
          date: new Date(r.createdAt).toLocaleDateString('vi-VN'),
          invoiceCode: r.invoiceCode,
          customerName: r.customerName,
          branchName: r.branchName,
          totalReturnAmount: money(r.totalReturnAmount),
          refundAmount: money(r.refundAmount),
        }),
      );
    } else if (viewType === 'PurchaseDate') {
      const rows = await this.aggregateByDate(query);
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Thời gian', key: 'label', width: 16 },
        { header: 'SL đơn bán', key: 'orderCount', width: 12 },
        { header: 'Tổng tiền hàng', key: 'totalAmount', width: 18 },
        { header: 'Giảm giá', key: 'discount', width: 16 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
        { header: 'SL đơn trả', key: 'returnCount', width: 12 },
        { header: 'Giá trị trả', key: 'returnAmount', width: 16 },
        { header: 'Doanh thu thuần', key: 'netRevenue', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          label: r.label,
          orderCount: r.orderCount,
          totalAmount: money(r.totalAmount),
          discount: money(r.discount),
          revenue: money(r.revenue),
          returnCount: r.returnCount,
          returnAmount: money(r.returnAmount),
          netRevenue: money(r.netRevenue),
        }),
      );
    } else if (viewType === 'Profit') {
      const rows = await this.chartProfit(query);
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Thời gian', key: 'subject', width: 16 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
        { header: 'Giá vốn', key: 'totalCost', width: 18 },
        { header: 'Lợi nhuận', key: 'profit', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          revenue: money(r.revenue || 0),
          totalCost: money(r.totalCost || 0),
          profit: money(r.profit || 0),
        }),
      );
    } else {
      const rows = await this.getChart(query);
      const subjectHeader =
        viewType === 'SoldBy'
          ? 'Nhân viên'
          : viewType === 'Branch'
            ? 'Chi nhánh'
            : 'Thời gian';
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: subjectHeader, key: 'subject', width: 28 },
        { header: 'Chi nhánh', key: 'group', width: 20 },
        { header: 'Doanh thu', key: 'value', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          group: r.group || '',
          value: money(r.value),
        }),
      );
    }

    ws.getRow(1).font = { bold: true };
    await wb.xlsx.write(res);
    res.end();
  }

  // ── EXPORT CHI TIẾT: toàn bộ hóa đơn (kèm lợi nhuận) theo bộ lọc ──
  async exportProfitInvoices(query: SaleReportQueryDto, res: Response) {
    const result = await this.previewProfitInvoices({ ...query, limit: 100000 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Chi tiet ban hang');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã giao dịch', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Nhân viên', key: 'soldBy', width: 24 },
      { header: 'Khách hàng', key: 'customer', width: 28 },
      { header: 'Doanh thu', key: 'revenue', width: 18 },
      { header: 'Giá vốn', key: 'cost', width: 18 },
      { header: 'Lợi nhuận', key: 'profit', width: 18 },
    ];
    result.data.forEach((r, i) =>
      ws.addRow({
        stt: i + 1,
        code: r.code,
        date: new Date(r.purchaseDate).toLocaleString('vi-VN'),
        soldBy: r.soldByName || '',
        customer: r.customerName,
        revenue: r.revenue,
        cost: r.cost,
        profit: r.profit,
      }),
    );
    ws.getRow(1).font = { bold: true };
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=chi-tiet-ban-hang_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }
}
