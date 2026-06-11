import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EodReportQueryDto, EodViewType } from './dto';
import { RETURN_ORDER_STATUS } from '../return-orders/dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

@Injectable()
export class EodReportsService {
  constructor(private prisma: PrismaService) {}

  // Khoảng trọn 1 ngày (mặc định hôm nay)
  private dayWindow(date?: string): { start: Date; end: Date; label: string } {
    const base = date ? new Date(date + 'T00:00:00') : new Date();
    const start = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      0,
      0,
      0,
      0,
    );
    const end = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      23,
      59,
      59,
      999,
    );
    const label = `${String(start.getDate()).padStart(2, '0')}/${String(
      start.getMonth() + 1,
    ).padStart(2, '0')}/${start.getFullYear()}`;
    return { start, end, label };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNTHETIC: tổng hợp cuối ngày (doanh thu, trả hàng, thu/chi, nhập hàng)
  // ═══════════════════════════════════════════════════════════════════════════
  async getSynthetic(query: EodReportQueryDto) {
    const { start, end, label } = this.dayWindow(query.date);
    const branch = query.branchId;

    const invWhere: Prisma.Sql[] = [
      Prisma.sql`i.status NOT IN (2, 8)`,
      Prisma.sql`i."purchaseDate" >= ${start}`,
      Prisma.sql`i."purchaseDate" <= ${end}`,
    ];
    if (branch) invWhere.push(Prisma.sql`i."branchId" = ${branch}`);
    const invW = Prisma.join(invWhere, ' AND ');

    const invRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(i."grandTotal"),0)::float8 AS revenue
      FROM invoices i WHERE ${invW}
    `;

    const retWhere: Prisma.Sql[] = [
      Prisma.sql`ro.status IN (${RETURN_ORDER_STATUS.STOCK_RECEIVED}, ${RETURN_ORDER_STATUS.COMPLETED})`,
      Prisma.sql`ro."createdAt" >= ${start}`,
      Prisma.sql`ro."createdAt" <= ${end}`,
    ];
    if (branch) retWhere.push(Prisma.sql`ro."branchId" = ${branch}`);
    const retW = Prisma.join(retWhere, ' AND ');
    const retRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(ro."totalReturnAmount"),0)::float8 AS amount
      FROM return_orders ro WHERE ${retW}
    `;

    const cashWhere: Prisma.Sql[] = [
      Prisma.sql`cf.status <> 2`,
      Prisma.sql`cf."transDate" >= ${start}`,
      Prisma.sql`cf."transDate" <= ${end}`,
    ];
    if (branch) cashWhere.push(Prisma.sql`cf."branchId" = ${branch}`);
    const cashW = Prisma.join(cashWhere, ' AND ');
    const cashRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END),0)::float8 AS receipt,
        COALESCE(SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END),0)::float8 AS payment
      FROM cash_flows cf WHERE ${cashW}
    `;

    const poWhere: Prisma.Sql[] = [
      Prisma.sql`po.status <> 2`,
      Prisma.sql`po."purchaseDate" >= ${start}`,
      Prisma.sql`po."purchaseDate" <= ${end}`,
    ];
    if (branch) poWhere.push(Prisma.sql`po."branchId" = ${branch}`);
    const poW = Prisma.join(poWhere, ' AND ');
    const poRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(po."subTotal"),0)::float8 AS total
      FROM purchase_orders po WHERE ${poW}
    `;

    const revenue = Number(invRows[0]?.revenue) || 0;
    const returnAmount = Number(retRows[0]?.amount) || 0;
    const receipt = Number(cashRows[0]?.receipt) || 0;
    const payment = Number(cashRows[0]?.payment) || 0;
    const purchase = Number(poRows[0]?.total) || 0;

    return {
      viewType: 'Synthetic' as const,
      date: label,
      metrics: {
        invoiceCount: Number(invRows[0]?.cnt) || 0,
        revenue,
        returnCount: Number(retRows[0]?.cnt) || 0,
        returnAmount,
        netRevenue: revenue - returnAmount,
        cashReceipt: receipt,
        cashPayment: payment,
        cashNet: receipt - payment,
        purchaseCount: Number(poRows[0]?.cnt) || 0,
        purchaseTotal: purchase,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCUMENT: danh sách hóa đơn trong ngày
  // ═══════════════════════════════════════════════════════════════════════════
  async getDocuments(query: EodReportQueryDto) {
    const { start, end } = this.dayWindow(query.date);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;
    const conds: Prisma.Sql[] = [
      Prisma.sql`i.status NOT IN (2, 8)`,
      Prisma.sql`i."purchaseDate" >= ${start}`,
      Prisma.sql`i."purchaseDate" <= ${end}`,
    ];
    if (query.branchId) conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT i.id, i.code, i."purchaseDate" AS purchase_date,
        u.name AS sold_by_name, c.name AS customer_name,
        i."grandTotal"::float8 AS grand_total
      FROM invoices i
      LEFT JOIN users u ON u.id = i."soldById"
      LEFT JOIN customers c ON c.id = i."customerId"
      WHERE ${where}
      ORDER BY i."purchaseDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total, COALESCE(SUM(i."grandTotal"),0)::float8 AS revenue
      FROM invoices i WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;
    return {
      viewType: 'Document' as const,
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        purchaseDate: r.purchase_date,
        soldByName: r.sold_by_name || null,
        customerName: r.customer_name || 'Khách lẻ',
        grandTotal: Number(r.grand_total) || 0,
      })),
      total,
      page,
      limit,
      summary: {
        totalInvoices: total,
        totalRevenue: Number(countRows[0]?.revenue) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CASHFLOW: phiếu thu/chi trong ngày
  // ═══════════════════════════════════════════════════════════════════════════
  async getCashFlows(query: EodReportQueryDto) {
    const { start, end } = this.dayWindow(query.date);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;
    const conds: Prisma.Sql[] = [
      Prisma.sql`cf.status <> 2`,
      Prisma.sql`cf."transDate" >= ${start}`,
      Prisma.sql`cf."transDate" <= ${end}`,
    ];
    if (query.branchId)
      conds.push(Prisma.sql`cf."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT cf.id, cf.code, cf."transDate" AS trans_date, cf."isReceipt" AS is_receipt,
        cf.amount::float8 AS amount, cf."partnerName" AS partner_name,
        g.name AS group_name
      FROM cash_flows cf
      LEFT JOIN cash_flow_groups g ON g.id = cf."cashFlowGroupId"
      WHERE ${where}
      ORDER BY cf."transDate" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countRows = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN cf."isReceipt" THEN cf.amount ELSE 0 END),0)::float8 AS receipt,
        COALESCE(SUM(CASE WHEN NOT cf."isReceipt" THEN cf.amount ELSE 0 END),0)::float8 AS payment
      FROM cash_flows cf WHERE ${where}
    `;
    const total = Number(countRows[0]?.total) || 0;
    return {
      viewType: 'CashFlow' as const,
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        transDate: r.trans_date,
        isReceipt: !!r.is_receipt,
        amount: Number(r.amount) || 0,
        partnerName: r.partner_name || null,
        groupName: r.group_name || null,
      })),
      total,
      page,
      limit,
      summary: {
        totalDocuments: total,
        totalReceipt: Number(countRows[0]?.receipt) || 0,
        totalPayment: Number(countRows[0]?.payment) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCT: hàng bán trong ngày
  // ═══════════════════════════════════════════════════════════════════════════
  async getProducts(query: EodReportQueryDto) {
    const { start, end } = this.dayWindow(query.date);
    const conds: Prisma.Sql[] = [
      Prisma.sql`i.status NOT IN (2, 8)`,
      Prisma.sql`i."purchaseDate" >= ${start}`,
      Prisma.sql`i."purchaseDate" <= ${end}`,
    ];
    if (query.branchId) conds.push(Prisma.sql`i."branchId" = ${query.branchId}`);
    const where = Prisma.join(conds, ' AND ');

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT d."productCode" AS code, d."productName" AS name,
        SUM(d.quantity)::float8 AS qty, SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      JOIN invoices i ON i.id = d."invoiceId"
      WHERE ${where}
      GROUP BY d."productCode", d."productName"
      ORDER BY revenue DESC
      LIMIT 500
    `;
    const data = rows.map((r) => ({
      code: r.code,
      name: r.name,
      quantity: Number(r.qty) || 0,
      revenue: Number(r.revenue) || 0,
    }));
    const summary = data.reduce(
      (acc, r) => {
        acc.totalQuantity += r.quantity;
        acc.totalRevenue += r.revenue;
        return acc;
      },
      { totalRows: data.length, totalQuantity: 0, totalRevenue: 0 },
    );
    return { viewType: 'Product' as const, data, total: data.length, summary };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Router preview
  // ═══════════════════════════════════════════════════════════════════════════
  async getPreview(query: EodReportQueryDto) {
    const viewType: EodViewType = query.viewType || 'Synthetic';
    switch (viewType) {
      case 'Document':
        return this.getDocuments(query);
      case 'CashFlow':
        return this.getCashFlows(query);
      case 'Product':
        return this.getProducts(query);
      case 'Synthetic':
      default:
        return this.getSynthetic(query);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  async exportExcel(query: EodReportQueryDto, res: Response) {
    const viewType: EodViewType = query.viewType || 'Synthetic';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bao cao cuoi ngay');
    const money = (n?: number) => Number(n) || 0;

    if (viewType === 'Synthetic') {
      const s = await this.getSynthetic(query);
      const m = s.metrics;
      ws.columns = [
        { header: 'Chỉ tiêu', key: 'label', width: 30 },
        { header: 'Giá trị', key: 'value', width: 20 },
      ];
      ws.addRow({ label: 'Số hóa đơn', value: m.invoiceCount });
      ws.addRow({ label: 'Doanh thu', value: m.revenue });
      ws.addRow({ label: 'Số phiếu trả', value: m.returnCount });
      ws.addRow({ label: 'Giá trị trả hàng', value: m.returnAmount });
      ws.addRow({ label: 'Doanh thu thuần', value: m.netRevenue });
      ws.addRow({ label: 'Tiền thu', value: m.cashReceipt });
      ws.addRow({ label: 'Tiền chi', value: m.cashPayment });
      ws.addRow({ label: 'Quỹ ròng', value: m.cashNet });
      ws.addRow({ label: 'Số phiếu nhập', value: m.purchaseCount });
      ws.addRow({ label: 'Giá trị nhập hàng', value: m.purchaseTotal });
    } else if (viewType === 'Product') {
      const p = await this.getProducts(query);
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Sản phẩm', key: 'name', width: 36 },
        { header: 'SL bán', key: 'qty', width: 12 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
      ];
      p.data.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          name: r.name,
          qty: money(r.quantity),
          revenue: money(r.revenue),
        }),
      );
    } else if (viewType === 'CashFlow') {
      const c = await this.getCashFlows({ ...query, limit: 100000 });
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã phiếu', key: 'code', width: 18 },
        { header: 'Loại', key: 'type', width: 8 },
        { header: 'Nhóm', key: 'group', width: 24 },
        { header: 'Đối tượng', key: 'partner', width: 24 },
        { header: 'Số tiền', key: 'amount', width: 18 },
      ];
      c.data.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          code: r.code,
          type: r.isReceipt ? 'Thu' : 'Chi',
          group: r.groupName || '',
          partner: r.partnerName || '',
          amount: money(r.amount),
        }),
      );
    } else {
      const d = await this.getDocuments({ ...query, limit: 100000 });
      ws.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã HĐ', key: 'code', width: 18 },
        { header: 'Nhân viên', key: 'seller', width: 24 },
        { header: 'Khách hàng', key: 'customer', width: 28 },
        { header: 'Doanh thu', key: 'revenue', width: 18 },
      ];
      d.data.forEach((r, i) =>
        ws.addRow({
          stt: i + 1,
          code: r.code,
          seller: r.soldByName || '',
          customer: r.customerName,
          revenue: money(r.grandTotal),
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
      `attachment; filename=bao-cao-cuoi-ngay_${Date.now()}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  }
}
