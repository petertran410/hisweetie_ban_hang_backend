import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupplierReportQueryDto, SupplierViewType } from './dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

export interface SupplierChartRow {
  subject: string;
  value: number;
  total: number;
  extra1?: string | null;
  group?: string | null;
  quantity?: number;
  // SupplierDebt / SupplierInfo
  opening?: number;
  debit?: number;
  credit?: number;
  closing?: number;
}

@Injectable()
export class SupplierReportsService {
  constructor(private prisma: PrismaService) {}

  // WHERE cho purchase_orders (loại phiếu hủy status=2)
  private buildPoWhereSql(query: SupplierReportQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`po.status <> 2`];
    if (query.fromDate)
      conds.push(Prisma.sql`po."purchaseDate" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`po."purchaseDate" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`po."branchId" = ${query.branchId}`);
    if (query.supplierId)
      conds.push(Prisma.sql`po."supplierId" = ${query.supplierId}`);
    return Prisma.join(conds, ' AND ');
  }

  async getChart(query: SupplierReportQueryDto): Promise<SupplierChartRow[]> {
    const viewType: SupplierViewType = query.viewType || 'PurchaseBySupplier';
    switch (viewType) {
      case 'PurchaseByProduct':
        return this.chartByProduct(query);
      case 'SupplierDebt':
        return this.chartDebt(query);
      case 'SupplierReturn':
        return this.chartReturn(query);
      case 'SupplierInfo':
        return this.chartInfo(query);
      case 'PurchaseBySupplier':
      default:
        return this.chartBySupplier(query);
    }
  }

  // ── PurchaseBySupplier: giá trị nhập theo NCC ──
  private async chartBySupplier(
    query: SupplierReportQueryDto,
  ): Promise<SupplierChartRow[]> {
    const where = this.buildPoWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        s.id AS supplier_id,
        s.code AS code,
        COALESCE(s.name, 'Chưa rõ') AS name,
        COUNT(po.id)::int AS po_count,
        SUM(po."subTotal")::float8 AS total
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po."supplierId"
      WHERE ${where}
      GROUP BY s.id, s.code, s.name
      ORDER BY total DESC
      LIMIT 200
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.total) || 0,
      total: Number(r.total) || 0,
      quantity: Number(r.po_count) || 0,
      extra1: r.supplier_id ? String(r.supplier_id) : null,
    }));
  }

  // ── PurchaseByProduct: giá trị nhập theo sản phẩm ──
  private async chartByProduct(
    query: SupplierReportQueryDto,
  ): Promise<SupplierChartRow[]> {
    const where = this.buildPoWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        poi."productCode" AS code,
        poi."productName" AS name,
        SUM(poi.quantity)::float8 AS qty,
        SUM(poi."totalPrice")::float8 AS total
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi."purchaseOrderId"
      WHERE ${where}
      GROUP BY poi."productCode", poi."productName"
      ORDER BY total DESC
      LIMIT 200
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.total) || 0,
      total: Number(r.total) || 0,
      quantity: Number(r.qty) || 0,
      extra1: r.code || null,
    }));
  }

  // ── SupplierDebt: phát sinh nợ (nhập) − đã trả trong kỳ theo NCC ──
  private async chartDebt(
    query: SupplierReportQueryDto,
  ): Promise<SupplierChartRow[]> {
    const where = this.buildPoWhereSql(query);
    // Phát sinh nợ = subTotal phiếu nhập; đã trả = paidAmount
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        s.id AS supplier_id,
        s.code AS code,
        COALESCE(s.name, 'Chưa rõ') AS name,
        SUM(po."subTotal")::float8 AS debit,
        SUM(po."paidAmount")::float8 AS credit
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po."supplierId"
      WHERE ${where}
      GROUP BY s.id, s.code, s.name
      ORDER BY debit DESC
      LIMIT 200
    `;
    return rows.map((r) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      return {
        subject: r.name,
        value: debit - credit,
        total: debit,
        debit,
        credit,
        closing: debit - credit,
        extra1: r.supplier_id ? String(r.supplier_id) : null,
      };
    });
  }

  // ── SupplierReturn: trả hàng nhập theo NCC ──
  private async chartReturn(
    query: SupplierReportQueryDto,
  ): Promise<SupplierChartRow[]> {
    const conds: Prisma.Sql[] = [Prisma.sql`sr.status <> 4`];
    if (query.fromDate)
      conds.push(Prisma.sql`sr."createdAt" >= ${new Date(query.fromDate)}`);
    if (query.toDate)
      conds.push(Prisma.sql`sr."createdAt" <= ${new Date(query.toDate)}`);
    if (query.branchId)
      conds.push(Prisma.sql`sr."branchId" = ${query.branchId}`);
    if (query.supplierId)
      conds.push(Prisma.sql`sr."supplierId" = ${query.supplierId}`);
    const where = Prisma.join(conds, ' AND ');
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        s.code AS code,
        COALESCE(s.name, 'Chưa rõ') AS name,
        COUNT(sr.id)::int AS cnt,
        SUM(sr."totalReturnAmount")::float8 AS total
      FROM supplier_returns sr
      JOIN suppliers s ON s.id = sr."supplierId"
      WHERE ${where}
      GROUP BY s.code, s.name
      ORDER BY total DESC
      LIMIT 200
    `;
    return rows.map((r) => ({
      subject: r.name,
      value: Number(r.total) || 0,
      total: Number(r.total) || 0,
      quantity: Number(r.cnt) || 0,
      extra1: r.code || null,
    }));
  }

  // ── SupplierInfo: tổng hợp NCC (tổng nhập, đã trả, còn nợ hiện tại) ──
  private async chartInfo(
    query: SupplierReportQueryDto,
  ): Promise<SupplierChartRow[]> {
    const where = this.buildPoWhereSql(query);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        s.id AS supplier_id,
        s.code AS code,
        COALESCE(s.name, 'Chưa rõ') AS name,
        s.debt::float8 AS debt,
        COALESCE(SUM(po."subTotal"), 0)::float8 AS total_purchase,
        COALESCE(SUM(po."paidAmount"), 0)::float8 AS total_paid
      FROM suppliers s
      LEFT JOIN purchase_orders po ON po."supplierId" = s.id AND ${where}
      WHERE s."isActive" = true
      GROUP BY s.id, s.code, s.name, s.debt
      HAVING COALESCE(SUM(po."subTotal"), 0) > 0 OR s.debt <> 0
      ORDER BY total_purchase DESC
      LIMIT 300
    `;
    return rows.map((r) => {
      const purchase = Number(r.total_purchase) || 0;
      const paid = Number(r.total_paid) || 0;
      return {
        subject: r.name,
        value: purchase,
        total: purchase,
        debit: purchase,
        credit: paid,
        closing: Number(r.debt) || 0,
        extra1: r.code || null,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: SupplierReportQueryDto) {
    const viewType: SupplierViewType = query.viewType || 'PurchaseBySupplier';
    const rows = await this.getChart(query);
    const summary = rows.reduce(
      (acc, r) => {
        acc.totalValue += r.value || 0;
        acc.totalQuantity += r.quantity || 0;
        acc.totalDebit += r.debit || 0;
        acc.totalCredit += r.credit || 0;
        acc.totalClosing += r.closing || 0;
        return acc;
      },
      {
        totalRows: rows.length,
        totalValue: 0,
        totalQuantity: 0,
        totalDebit: 0,
        totalCredit: 0,
        totalClosing: 0,
      },
    );
    return { viewType, data: rows, total: rows.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRILLDOWN: phiếu nhập của 1 NCC
  // ═══════════════════════════════════════════════════════════════════════════
  async getSupplierPurchases(query: SupplierReportQueryDto) {
    const where = this.buildPoWhereSql(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        po.id,
        po.code,
        po."purchaseDate" AS purchase_date,
        s.name AS supplier_name,
        b.name AS branch_name,
        po."subTotal"::float8 AS sub_total,
        po."paidAmount"::float8 AS paid_amount,
        po."debtAmount"::float8 AS debt_amount,
        po."statusValue" AS status_value
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po."supplierId"
      LEFT JOIN branches b ON b.id = po."branchId"
      WHERE ${where}
      ORDER BY po."purchaseDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total
      FROM purchase_orders po
      WHERE ${where}
    `;
    const sumRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(SUM(po."subTotal"), 0)::float8 AS sub_total,
        COALESCE(SUM(po."paidAmount"), 0)::float8 AS paid,
        COALESCE(SUM(po."debtAmount"), 0)::float8 AS debt
      FROM purchase_orders po
      WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;
    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        purchaseDate: r.purchase_date,
        supplierName: r.supplier_name,
        branchName: r.branch_name || null,
        subTotal: Number(r.sub_total) || 0,
        paidAmount: Number(r.paid_amount) || 0,
        debtAmount: Number(r.debt_amount) || 0,
        statusValue: r.status_value || '',
      })),
      total,
      page,
      limit,
      summary: {
        totalDocuments: total,
        totalSubTotal: Number(sumRows[0]?.sub_total) || 0,
        totalPaid: Number(sumRows[0]?.paid) || 0,
        totalDebt: Number(sumRows[0]?.debt) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: SupplierReportQueryDto, res: Response) {
    const viewType: SupplierViewType = query.viewType || 'PurchaseBySupplier';
    const rows = await this.getChart(query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bao cao NCC');
    const money = (n?: number) => Number(n) || 0;

    if (viewType === 'SupplierDebt' || viewType === 'SupplierInfo') {
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Nhà cung cấp', key: 'subject', width: 32 },
        { header: 'Tổng nhập', key: 'debit', width: 18 },
        { header: 'Đã trả', key: 'credit', width: 18 },
        {
          header: viewType === 'SupplierInfo' ? 'Còn nợ' : 'Còn lại kỳ',
          key: 'closing',
          width: 18,
        },
      ];
      rows.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          subject: r.subject,
          debit: money(r.debit),
          credit: money(r.credit),
          closing: money(r.closing),
        }),
      );
    } else {
      const subjHeader =
        viewType === 'PurchaseByProduct' ? 'Sản phẩm' : 'Nhà cung cấp';
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: subjHeader, key: 'subject', width: 32 },
        { header: 'SL', key: 'qty', width: 12 },
        { header: 'Giá trị', key: 'value', width: 18 },
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
      `attachment; filename=bao-cao-ncc_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }

  // ── EXPORT CHI TIẾT: toàn bộ phiếu nhập theo bộ lọc ──
  async exportPurchases(query: SupplierReportQueryDto, res: Response) {
    const result = await this.getSupplierPurchases({ ...query, limit: 100000 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Chi tiet nhap hang');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Giá trị', key: 'subTotal', width: 18 },
      { header: 'Đã trả', key: 'paid', width: 18 },
      { header: 'Còn nợ', key: 'debt', width: 18 },
    ];
    result.data.forEach((r, i) =>
      ws.addRow({
        stt: i + 1,
        code: r.code,
        date: new Date(r.purchaseDate).toLocaleString('vi-VN'),
        branch: r.branchName || '',
        subTotal: r.subTotal,
        paid: r.paidAmount,
        debt: r.debtAmount,
      }),
    );
    ws.getRow(1).font = { bold: true };
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=chi-tiet-nhap-hang_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }
}
