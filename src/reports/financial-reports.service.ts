import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinancialReportQueryDto, FinancialViewType } from './dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

export interface FinancialChartRow {
  subject: string;
  value: number;
  total: number;
  extra1?: string | null;
  // thu/chi
  receipt?: number;
  payment?: number;
  net?: number;
  // SalePerformance
  revenue?: number;
  cost?: number;
  profit?: number;
}

@Injectable()
export class FinancialReportsService {
  constructor(private prisma: PrismaService) {}

  // WHERE cho cash_flows (status 0 hợp lệ; loại 2 hủy)
  private buildCashWhereSql(query: FinancialReportQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`cf.status <> 2`];
    if (query.fromDate)
      conds.push(Prisma.sql`cf."transDate" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`cf."transDate" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`cf."branchId" = ${query.branchId}`);
    if (query.cashFlowGroupId)
      conds.push(Prisma.sql`cf."cashFlowGroupId" = ${query.cashFlowGroupId}`);
    if (query.direction === 'receipt')
      conds.push(Prisma.sql`cf."isReceipt" = true`);
    if (query.direction === 'payment')
      conds.push(Prisma.sql`cf."isReceipt" = false`);
    return Prisma.join(conds, ' AND ');
  }

  async getChart(query: FinancialReportQueryDto): Promise<FinancialChartRow[]> {
    const viewType: FinancialViewType = query.viewType || 'CashByGroup';
    switch (viewType) {
      case 'CashByTime':
        return this.chartByTime(query);
      case 'CashFlowSummary':
        return this.chartSummary(query);
      case 'SalePerformance':
        return this.chartSalePerformance(query);
      case 'CashByGroup':
      default:
        return this.chartByGroup(query);
    }
  }

  // ── CashByGroup: thu/chi theo nhóm ──
  private async chartByGroup(
    query: FinancialReportQueryDto,
  ): Promise<FinancialChartRow[]> {
    const where = this.buildCashWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        g.id AS group_id,
        COALESCE(g.name, 'Chưa phân nhóm') AS name,
        SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS receipt,
        SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS payment
      FROM cash_flows cf
      LEFT JOIN cash_flow_groups g ON g.id = cf."cashFlowGroupId"
      WHERE ${where}
      GROUP BY g.id, g.name
      ORDER BY (SUM(cf.amount)) DESC
    `;
    return rows.map((r) => {
      const receipt = Number(r.receipt) || 0;
      const payment = Number(r.payment) || 0;
      return {
        subject: r.name,
        value: receipt + payment,
        total: receipt + payment,
        receipt,
        payment,
        net: receipt - payment,
        extra1: r.group_id ? String(r.group_id) : null,
      };
    });
  }

  // ── CashByTime: thu/chi theo ngày ──
  private async chartByTime(
    query: FinancialReportQueryDto,
  ): Promise<FinancialChartRow[]> {
    const where = this.buildCashWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', cf."transDate") AS bucket,
        SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS receipt,
        SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS payment
      FROM cash_flows cf
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => {
      const d = new Date(r.bucket);
      const receipt = Number(r.receipt) || 0;
      const payment = Number(r.payment) || 0;
      return {
        subject: `${String(d.getDate()).padStart(2, '0')}/${String(
          d.getMonth() + 1,
        ).padStart(2, '0')}`,
        value: receipt - payment,
        total: receipt + payment,
        receipt,
        payment,
        net: receipt - payment,
        extra1: d.toISOString(),
      };
    });
  }

  // ── CashFlowSummary: tồn đầu kỳ + thu + chi + tồn cuối ──
  private async chartSummary(
    query: FinancialReportQueryDto,
  ): Promise<FinancialChartRow[]> {
    // Tồn đầu kỳ: tổng thu - chi trước fromDate (cùng branch, status hợp lệ)
    const openingConds: Prisma.Sql[] = [Prisma.sql`cf.status <> 2`];
    if (query.fromDate)
      openingConds.push(
        Prisma.sql`cf."transDate" < ${new Date(query.fromDate)}`,
      );
    if (query.branchId)
      openingConds.push(Prisma.sql`cf."branchId" = ${query.branchId}`);
    const openingWhere = Prisma.join(openingConds, ' AND ');

    const openingRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE -cf.amount END), 0)::float8 AS opening
      FROM cash_flows cf
      WHERE ${openingWhere}
    `;
    const opening = Number(openingRows[0]?.opening) || 0;

    const where = this.buildCashWhereSql(query);
    const periodRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS receipt,
        SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS payment
      FROM cash_flows cf
      WHERE ${where}
    `;
    const receipt = Number(periodRows[0]?.receipt) || 0;
    const payment = Number(periodRows[0]?.payment) || 0;
    const closing = opening + receipt - payment;

    return [
      {
        subject: 'Tồn đầu kỳ',
        value: opening,
        total: opening,
        receipt: 0,
        payment: 0,
        net: opening,
        extra1: null,
      },
      {
        subject: 'Tổng thu',
        value: receipt,
        total: receipt,
        receipt,
        payment: 0,
        net: receipt,
        extra1: 'receipt',
      },
      {
        subject: 'Tổng chi',
        value: payment,
        total: payment,
        receipt: 0,
        payment,
        net: -payment,
        extra1: 'payment',
      },
      {
        subject: 'Tồn cuối kỳ',
        value: closing,
        total: closing,
        receipt: 0,
        payment: 0,
        net: closing,
        extra1: null,
      },
    ];
  }

  // ── SalePerformance: doanh thu/giá vốn/lợi nhuận theo ngày (từ invoices) ──
  private async chartSalePerformance(
    query: FinancialReportQueryDto,
  ): Promise<FinancialChartRow[]> {
    const conds: Prisma.Sql[] = [Prisma.sql`i.status NOT IN (2, 8)`];
    if (query.fromDate)
      conds.push(Prisma.sql`i."purchaseDate" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`i."purchaseDate" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc('day', i."purchaseDate") AS bucket,
        SUM(i."grandTotal")::float8 AS revenue,
        COALESCE(SUM(li.cogs), 0)::float8 AS cogs
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT SUM(d.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM invoice_details d
        LEFT JOIN inventories inv
          ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
        WHERE d."invoiceId" = i.id
      ) li ON true
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => {
      const d = new Date(r.bucket);
      const revenue = Number(r.revenue) || 0;
      const cost = Number(r.cogs) || 0;
      return {
        subject: `${String(d.getDate()).padStart(2, '0')}/${String(
          d.getMonth() + 1,
        ).padStart(2, '0')}`,
        value: revenue - cost,
        total: revenue,
        revenue,
        cost,
        profit: revenue - cost,
        extra1: d.toISOString(),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: FinancialReportQueryDto) {
    const viewType: FinancialViewType = query.viewType || 'CashByGroup';
    const rows = await this.getChart(query);
    const summary = rows.reduce(
      (acc, r) => {
        acc.totalReceipt += r.receipt || 0;
        acc.totalPayment += r.payment || 0;
        acc.totalRevenue += r.revenue || 0;
        acc.totalCost += r.cost || 0;
        return acc;
      },
      {
        totalRows: rows.length,
        totalReceipt: 0,
        totalPayment: 0,
        totalRevenue: 0,
        totalCost: 0,
      },
    );
    return { viewType, data: rows, total: rows.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRILLDOWN: phiếu thu/chi (theo nhóm hoặc ngày)
  // ═══════════════════════════════════════════════════════════════════════════
  async getCashFlows(query: FinancialReportQueryDto) {
    const where = this.buildCashWhereSql(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        cf.id,
        cf.code,
        cf."transDate" AS trans_date,
        cf."isReceipt" AS is_receipt,
        cf.amount::float8 AS amount,
        cf.method,
        cf."partnerName" AS partner_name,
        cf.description,
        g.name AS group_name,
        b.name AS branch_name
      FROM cash_flows cf
      LEFT JOIN cash_flow_groups g ON g.id = cf."cashFlowGroupId"
      LEFT JOIN branches b ON b.id = cf."branchId"
      WHERE ${where}
      ORDER BY cf."transDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total FROM cash_flows cf WHERE ${where}
    `;
    const sumRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS receipt,
        SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END)::float8 AS payment
      FROM cash_flows cf WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;
    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        transDate: r.trans_date,
        isReceipt: !!r.is_receipt,
        amount: Number(r.amount) || 0,
        method: r.method || null,
        partnerName: r.partner_name || null,
        groupName: r.group_name || null,
        branchName: r.branch_name || null,
        description: r.description || null,
      })),
      total,
      page,
      limit,
      summary: {
        totalDocuments: total,
        totalReceipt: Number(sumRows[0]?.receipt) || 0,
        totalPayment: Number(sumRows[0]?.payment) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: FinancialReportQueryDto, res: Response) {
    const viewType: FinancialViewType = query.viewType || 'CashByGroup';
    const rows = await this.getChart(query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bao cao tai chinh');
    const money = (n?: number) => Number(n) || 0;

    if (viewType === 'SalePerformance') {
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Thời gian', key: 'subject', width: 16 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
        { header: 'Giá vốn', key: 'cost', width: 18 },
        { header: 'Lợi nhuận', key: 'profit', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          revenue: money(r.revenue),
          cost: money(r.cost),
          profit: money(r.profit),
        }),
      );
    } else {
      const subjHeader =
        viewType === 'CashByGroup'
          ? 'Nhóm thu chi'
          : viewType === 'CashFlowSummary'
            ? 'Mục'
            : 'Thời gian';
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: subjHeader, key: 'subject', width: 28 },
        { header: 'Thu', key: 'receipt', width: 18 },
        { header: 'Chi', key: 'payment', width: 18 },
        { header: 'Chênh lệch', key: 'net', width: 18 },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          receipt: money(r.receipt),
          payment: money(r.payment),
          net: money(r.net),
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
      `attachment; filename=bao-cao-tai-chinh_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }

  // ── EXPORT CHI TIẾT: toàn bộ phiếu thu/chi theo bộ lọc ──
  async exportCashFlowsDetail(query: FinancialReportQueryDto, res: Response) {
    const result = await this.getCashFlows({ ...query, limit: 100000 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Chi tiet thu chi');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Loại', key: 'type', width: 8 },
      { header: 'Nhóm', key: 'group', width: 24 },
      { header: 'Đối tượng', key: 'partner', width: 24 },
      { header: 'Số tiền', key: 'amount', width: 18 },
    ];
    result.data.forEach((r, i) =>
      ws.addRow({
        stt: i + 1,
        code: r.code,
        date: new Date(r.transDate).toLocaleString('vi-VN'),
        type: r.isReceipt ? 'Thu' : 'Chi',
        group: r.groupName || '',
        partner: r.partnerName || '',
        amount: r.amount,
      }),
    );
    ws.getRow(1).font = { bold: true };
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=chi-tiet-thu-chi_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }
}
