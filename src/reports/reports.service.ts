import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportQueryDto } from './dto';
import { INVOICE_STATUS } from '../invoices/dto';
import { RETURN_ORDER_STATUS } from '../return-orders/dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

// Giới hạn tối đa (ms)
const BATCH_SIZE = 1000;

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: Build where clause từ filters
  // ═══════════════════════════════════════════════════════════════════════════
  private buildInvoiceWhere(query: ReportQueryDto) {
    const where: any = {
      status: { not: INVOICE_STATUS.CANCELLED },
    };

    if (query.fromDate || query.toDate) {
      where.purchaseDate = {};
      if (query.fromDate) where.purchaseDate.gte = new Date(query.fromDate);
      if (query.toDate) where.purchaseDate.lte = new Date(query.toDate);
    }

    if (query.branchId) where.branchId = query.branchId;
    if (query.customerId) where.customerId = query.customerId;
    if (query.soldById) where.soldById = query.soldById;
    if (query.saleChannelId) where.saleChannelId = query.saleChannelId;

    if (query.customerGroupId) {
      where.customer = {
        customerGroupDetails: {
          some: { customerGroupId: query.customerGroupId },
        },
      };
    }

    return where;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: Build return amount map — query 1 lần duy nhất
  // ═══════════════════════════════════════════════════════════════════════════
  private async buildReturnAmountMap(where: any): Promise<Map<number, number>> {
    // Dùng nested relation filter thay vì IN(...ids)
    // Prisma sẽ sinh subquery: WHERE "invoiceId" IN (SELECT id FROM invoices WHERE ...)
    const results = await this.prisma.returnOrderDetail.groupBy({
      by: ['invoiceId'],
      where: {
        invoice: where,
        returnOrder: {
          status: {
            in: [
              RETURN_ORDER_STATUS.STOCK_RECEIVED,
              RETURN_ORDER_STATUS.COMPLETED,
            ],
          },
        },
      },
      _sum: { totalAmount: true },
    });

    const map = new Map<number, number>();
    for (const r of results) {
      if (r.invoiceId) {
        map.set(r.invoiceId, Number(r._sum.totalAmount) || 0);
      }
    }
    return map;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 1: Bán hàng — Preview (phân trang)
  // ═══════════════════════════════════════════════════════════════════════════
  async getCustomerSalesPreview(query: ReportQueryDto) {
    const where = this.buildInvoiceWhere(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
          status: true,
          statusValue: true,
          description: true,
          customer: {
            select: { id: true, code: true, name: true, contactNumber: true },
          },
          branch: { select: { name: true } },
          soldBy: { select: { name: true } },
          saleChannel: { select: { name: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    // Return map chỉ cho page hiện tại
    const pageInvoiceIds = data.map((inv) => inv.id);
    const returnResults =
      pageInvoiceIds.length > 0
        ? await this.prisma.returnOrderDetail.groupBy({
            by: ['invoiceId'],
            where: {
              invoiceId: { in: pageInvoiceIds },
              returnOrder: {
                status: {
                  in: [
                    RETURN_ORDER_STATUS.STOCK_RECEIVED,
                    RETURN_ORDER_STATUS.COMPLETED,
                  ],
                },
              },
            },
            _sum: { totalAmount: true },
          })
        : [];

    const returnMap = new Map<number, number>();
    for (const r of returnResults) {
      if (r.invoiceId !== null) {
        returnMap.set(r.invoiceId, Number(r._sum.totalAmount) || 0);
      }
    }

    // Summary aggregate cho toàn bộ filter (không phân trang)
    const summary = await this.prisma.invoice.aggregate({
      where,
      _sum: {
        totalAmount: true,
        discount: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
      },
      _count: true,
    });

    // Tổng trả hàng toàn bộ — dùng nested filter, không truyền mảng IDs
    const returnAgg = await this.prisma.returnOrderDetail.aggregate({
      where: {
        invoice: where,
        returnOrder: {
          status: {
            in: [
              RETURN_ORDER_STATUS.STOCK_RECEIVED,
              RETURN_ORDER_STATUS.COMPLETED,
            ],
          },
        },
      },
      _sum: { totalAmount: true },
    });
    const totalReturn = Number(returnAgg._sum.totalAmount) || 0;

    return {
      data: data.map((inv) => ({
        ...inv,
        totalAmount: Number(inv.totalAmount),
        discount: Number(inv.discount),
        grandTotal: Number(inv.grandTotal),
        paidAmount: Number(inv.paidAmount),
        debtAmount: Number(inv.debtAmount),
        returnAmount: returnMap.get(inv.id) || 0,
      })),
      total,
      page,
      limit,
      summary: {
        totalInvoices: summary._count,
        totalAmount: Number(summary._sum.totalAmount) || 0,
        totalDiscount: Number(summary._sum.discount) || 0,
        totalGrandTotal: Number(summary._sum.grandTotal) || 0,
        totalPaidAmount: Number(summary._sum.paidAmount) || 0,
        totalDebtAmount: Number(summary._sum.debtAmount) || 0,
        totalReturn,
        netRevenue: (Number(summary._sum.grandTotal) || 0) - totalReturn,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 1: Bán hàng — Export Excel (streaming)
  // ═══════════════════════════════════════════════════════════════════════════
  async exportCustomerSales(query: ReportQueryDto, res: Response) {
    const where = this.buildInvoiceWhere(query);

    // Query 1: Aggregate tổng kết
    const [summary, returnMap] = await Promise.all([
      this.prisma.invoice.aggregate({
        where,
        _sum: {
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
        },
        _count: true,
      }),
      this.buildReturnAmountMap(where),
    ]);

    const totalReturn = Array.from(returnMap.values()).reduce(
      (sum, v) => sum + v,
      0,
    );

    // Setup streaming Excel
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Báo cáo bán hàng');

    // Header columns
    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã HĐ', key: 'code', width: 14 },
      { header: 'Ngày bán', key: 'purchaseDate', width: 14 },
      { header: 'Mã KH', key: 'customerCode', width: 12 },
      { header: 'Tên KH', key: 'customerName', width: 25 },
      { header: 'SĐT', key: 'contactNumber', width: 14 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'NV bán', key: 'sellerName', width: 18 },
      { header: 'Kênh bán', key: 'channelName', width: 15 },
      { header: 'Tổng tiền hàng', key: 'totalAmount', width: 16 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Thành tiền', key: 'grandTotal', width: 16 },
      { header: 'Đã thanh toán', key: 'paidAmount', width: 16 },
      { header: 'Còn nợ HĐ', key: 'debtAmount', width: 14 },
      { header: 'Giá trị trả hàng', key: 'returnAmount', width: 16 },
      { header: 'Trạng thái', key: 'statusValue', width: 15 },
      { header: 'Ghi chú', key: 'description', width: 25 },
    ];

    // Style header
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    // Stream batches
    let stt = 0;
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.prisma.invoice.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
          statusValue: true,
          description: true,
          customer: {
            select: { code: true, name: true, contactNumber: true },
          },
          branch: { select: { name: true } },
          soldBy: { select: { name: true } },
          saleChannel: { select: { name: true } },
        },
      });

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const inv of batch) {
        stt++;
        sheet
          .addRow({
            stt,
            code: inv.code,
            purchaseDate: new Date(inv.purchaseDate),
            customerCode: inv.customer?.code || 'Khách vãng lai',
            customerName: inv.customer?.name || 'Khách vãng lai',
            contactNumber: inv.customer?.contactNumber || '',
            branchName: inv.branch?.name || '',
            sellerName: inv.soldBy?.name || '',
            channelName: inv.saleChannel?.name || '',
            totalAmount: Number(inv.totalAmount),
            discount: Number(inv.discount),
            grandTotal: Number(inv.grandTotal),
            paidAmount: Number(inv.paidAmount),
            debtAmount: Number(inv.debtAmount),
            returnAmount: returnMap.get(inv.id) || 0,
            statusValue: inv.statusValue || '',
            description: inv.description || '',
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) hasMore = false;
    }

    // Dòng tổng kết
    const summaryRow = sheet.addRow({
      stt: '',
      code: 'TỔNG CỘNG',
      purchaseDate: '',
      customerCode: '',
      customerName: '',
      contactNumber: '',
      branchName: '',
      sellerName: '',
      channelName: `${summary._count} hóa đơn`,
      totalAmount: Number(summary._sum.totalAmount) || 0,
      discount: Number(summary._sum.discount) || 0,
      grandTotal: Number(summary._sum.grandTotal) || 0,
      paidAmount: Number(summary._sum.paidAmount) || 0,
      debtAmount: Number(summary._sum.debtAmount) || 0,
      returnAmount: totalReturn,
      statusValue: '',
      description: '',
    });
    summaryRow.font = { bold: true, size: 11 };
    summaryRow.commit();

    // Dòng doanh thu thuần
    const netRow = sheet.addRow({
      stt: '',
      code: 'DOANH THU THUẦN',
      purchaseDate: '',
      customerCode: '',
      customerName: '',
      contactNumber: '',
      branchName: '',
      sellerName: '',
      channelName: '',
      totalAmount: '',
      discount: '',
      grandTotal: (Number(summary._sum.grandTotal) || 0) - totalReturn,
      paidAmount: '',
      debtAmount: '',
      returnAmount: '',
      statusValue: '',
      description: '',
    });
    netRow.font = { bold: true, size: 11, color: { argb: 'FF2E7D32' } };
    netRow.commit();

    sheet.commit();
    await workbook.commit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 2: Hàng bán theo khách — Preview (phân trang)
  // ═══════════════════════════════════════════════════════════════════════════
  async getProductByCustomerPreview(query: ReportQueryDto) {
    const where = this.buildInvoiceWhere(query);
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    // Query InvoiceDetail qua invoice filter
    const detailWhere: any = {
      invoice: where,
    };

    const [data, total] = await Promise.all([
      this.prisma.invoiceDetail.findMany({
        where: detailWhere,
        skip,
        take: limit,
        orderBy: { invoice: { purchaseDate: 'desc' } },
        select: {
          id: true,
          productCode: true,
          productName: true,
          quantity: true,
          price: true,
          discount: true,
          discountRatio: true,
          totalPrice: true,
          conditionType: true,
          product: { select: { unit: true } },
          invoice: {
            select: {
              id: true,
              code: true,
              purchaseDate: true,
              customer: {
                select: {
                  code: true,
                  name: true,
                  contactNumber: true,
                },
              },
              branch: { select: { name: true } },
              soldBy: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.invoiceDetail.count({ where: detailWhere }),
    ]);

    // Summary
    const summaryAgg = await this.prisma.invoiceDetail.aggregate({
      where: detailWhere,
      _sum: { quantity: true, totalPrice: true },
      _count: true,
    });

    return {
      data: data.map((d) => ({
        id: d.id,
        customerCode: d.invoice.customer?.code || 'KVL',
        customerName: d.invoice.customer?.name || 'Khách vãng lai',
        contactNumber: d.invoice.customer?.contactNumber || '',
        invoiceCode: d.invoice.code,
        purchaseDate: d.invoice.purchaseDate,
        branchName: d.invoice.branch?.name || '',
        sellerName: d.invoice.soldBy?.name || '',
        productCode: d.productCode,
        productName: d.productName,
        unit: d.product?.unit || '',
        quantity: Number(d.quantity),
        sellingPrice: Number(d.price) - Number(d.discount),
        totalPrice: Number(d.totalPrice),
        conditionType: d.conditionType,
      })),
      total,
      page,
      limit,
      summary: {
        totalRows: summaryAgg._count,
        totalQuantity: Number(summaryAgg._sum.quantity) || 0,
        totalPrice: Number(summaryAgg._sum.totalPrice) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 2: Hàng bán theo khách — Export Excel (streaming)
  // ═══════════════════════════════════════════════════════════════════════════
  async exportProductByCustomer(query: ReportQueryDto, res: Response) {
    const where = this.buildInvoiceWhere(query);
    const detailWhere: any = { invoice: where };

    // Query aggregate trước
    const summaryAgg = await this.prisma.invoiceDetail.aggregate({
      where: detailWhere,
      _sum: { quantity: true, totalPrice: true },
      _count: true,
    });

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Hàng bán theo khách');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã KH', key: 'customerCode', width: 12 },
      { header: 'Tên KH', key: 'customerName', width: 25 },
      { header: 'SĐT', key: 'contactNumber', width: 14 },
      { header: 'Mã HĐ', key: 'invoiceCode', width: 14 },
      { header: 'Ngày bán', key: 'purchaseDate', width: 14 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'NV bán', key: 'sellerName', width: 18 },
      { header: 'Mã SP', key: 'productCode', width: 14 },
      { header: 'Tên SP', key: 'productName', width: 30 },
      { header: 'ĐVT', key: 'unit', width: 8 },
      { header: 'Số lượng', key: 'quantity', width: 10 },
      { header: 'Giá bán', key: 'sellingPrice', width: 14 },
      { header: 'Thành tiền', key: 'totalPrice', width: 16 },
      { header: 'Tình trạng SP', key: 'conditionType', width: 14 },
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

    let stt = 0;
    let cursor = 0;
    let hasMore = true;

    const conditionLabels: Record<string, string> = {
      normal: 'Bình thường',
      damaged: 'Lỗi/Hỏng',
      near_expiry: 'Gần hết hạn',
    };

    while (hasMore) {
      const batch = await this.prisma.invoiceDetail.findMany({
        where: detailWhere,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { invoice: { purchaseDate: 'desc' } },
        select: {
          productCode: true,
          productName: true,
          quantity: true,
          price: true,
          discount: true,
          totalPrice: true,
          conditionType: true,
          product: { select: { unit: true } },
          invoice: {
            select: {
              code: true,
              purchaseDate: true,
              customer: {
                select: { code: true, name: true, contactNumber: true },
              },
              branch: { select: { name: true } },
              soldBy: { select: { name: true } },
            },
          },
        },
      });

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const d of batch) {
        stt++;
        sheet
          .addRow({
            stt,
            customerCode: d.invoice.customer?.code || 'KVL',
            customerName: d.invoice.customer?.name || 'Khách vãng lai',
            contactNumber: d.invoice.customer?.contactNumber || '',
            invoiceCode: d.invoice.code,
            purchaseDate: new Date(d.invoice.purchaseDate),
            branchName: d.invoice.branch?.name || '',
            sellerName: d.invoice.soldBy?.name || '',
            productCode: d.productCode,
            productName: d.productName,
            unit: d.product?.unit || '',
            quantity: Number(d.quantity),
            sellingPrice: Number(d.price) - Number(d.discount),
            totalPrice: Number(d.totalPrice),
            conditionType: conditionLabels[d.conditionType] || d.conditionType,
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) hasMore = false;
    }

    // Dòng tổng kết
    const summaryRow = sheet.addRow({
      stt: '',
      customerCode: 'TỔNG CỘNG',
      customerName: '',
      contactNumber: '',
      invoiceCode: '',
      purchaseDate: '',
      branchName: '',
      sellerName: '',
      productCode: '',
      productName: `${summaryAgg._count} dòng`,
      unit: '',
      quantity: Number(summaryAgg._sum.quantity) || 0,
      sellingPrice: '',
      totalPrice: Number(summaryAgg._sum.totalPrice) || 0,
      conditionType: '',
    });
    summaryRow.font = { bold: true, size: 11 };
    summaryRow.commit();

    sheet.commit();
    await workbook.commit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 3: Công nợ — Aggregate helper (theo công thức recalcCustomerDebt)
  // ═══════════════════════════════════════════════════════════════════════════
  private async aggregateCustomerDebt(query: ReportQueryDto) {
    const fromDate = query.fromDate ? new Date(query.fromDate) : new Date(0);
    const toDate = query.toDate ? new Date(query.toDate) : new Date();

    let allowedCustomerIds: number[] | null = null;
    if (query.customerGroupId) {
      const inGroup = await this.prisma.customerGroupDetail.findMany({
        where: { customerGroupId: query.customerGroupId },
        select: { customerId: true },
      });
      allowedCustomerIds = inGroup.map((g) => g.customerId);
      if (allowedCustomerIds.length === 0) return [];
    }
    if (query.customerId) {
      allowedCustomerIds = allowedCustomerIds
        ? allowedCustomerIds.filter((id) => id === query.customerId)
        : [query.customerId];
      if (allowedCustomerIds.length === 0) return [];
    }

    const invoiceBaseWhere: any = {
      status: { not: INVOICE_STATUS.CANCELLED },
      customerId: { not: null },
    };
    if (query.branchId) invoiceBaseWhere.branchId = query.branchId;
    if (allowedCustomerIds)
      invoiceBaseWhere.customerId = { in: allowedCustomerIds };

    const cashFlowBaseWhere: any = {
      partnerType: 'C',
      status: { not: 2 },
      partnerId: { not: null },
    };
    if (query.branchId) cashFlowBaseWhere.branchId = query.branchId;
    if (allowedCustomerIds)
      cashFlowBaseWhere.partnerId = { in: allowedCustomerIds };

    const roBaseWhere: any = {
      customerId: { not: null },
      OR: [
        { status: 2 },
        { status: 4, refundType: 'debt_offset' },
        { status: 4, refundType: 'cash_refund' },
      ],
    };
    if (query.branchId) roBaseWhere.branchId = query.branchId;
    if (allowedCustomerIds) roBaseWhere.customerId = { in: allowedCustomerIds };

    const sumInvoice = (extra: any) =>
      this.prisma.invoice.groupBy({
        by: ['customerId'],
        where: { ...invoiceBaseWhere, ...extra },
        _sum: { grandTotal: true },
      });

    const sumCashFlow = (extra: any) =>
      this.prisma.cashFlow.groupBy({
        by: ['partnerId'],
        where: { ...cashFlowBaseWhere, ...extra },
        _sum: { amount: true },
      });

    const sumReturnOrder = (extra: any) =>
      this.prisma.returnOrder.groupBy({
        by: ['customerId'],
        where: { ...roBaseWhere, ...extra },
        _sum: { refundAmount: true },
      });

    const [
      invBefore,
      invIn,
      cfReceiptBefore,
      cfReceiptIn,
      cfPaidBefore,
      cfPaidIn,
      roBefore,
      roIn,
    ] = await Promise.all([
      sumInvoice({ purchaseDate: { lt: fromDate } }),
      sumInvoice({ purchaseDate: { gte: fromDate, lte: toDate } }),
      sumCashFlow({
        isReceipt: true,
        NOT: { code: { startsWith: 'TTTUHD' } },
        transDate: { lt: fromDate },
      }),
      sumCashFlow({
        isReceipt: true,
        NOT: { code: { startsWith: 'TTTUHD' } },
        transDate: { gte: fromDate, lte: toDate },
      }),
      sumCashFlow({ isReceipt: false, transDate: { lt: fromDate } }),
      sumCashFlow({
        isReceipt: false,
        transDate: { gte: fromDate, lte: toDate },
      }),
      sumReturnOrder({ createdAt: { lt: fromDate } }),
      sumReturnOrder({ createdAt: { gte: fromDate, lte: toDate } }),
    ]);

    type Row = {
      openingDebt: number;
      debit: number;
      credit: number;
      closingDebt: number;
    };
    const map = new Map<number, Row>();
    const ensure = (id: number) => {
      if (!map.has(id))
        map.set(id, { openingDebt: 0, debit: 0, credit: 0, closingDebt: 0 });
      return map.get(id)!;
    };

    for (const r of invBefore)
      if (r.customerId != null)
        ensure(r.customerId).openingDebt += Number(r._sum.grandTotal) || 0;
    for (const r of cfReceiptBefore)
      if (r.partnerId != null)
        ensure(r.partnerId).openingDebt -= Number(r._sum.amount) || 0;
    for (const r of cfPaidBefore)
      if (r.partnerId != null)
        ensure(r.partnerId).openingDebt += Number(r._sum.amount) || 0;
    for (const r of roBefore)
      if (r.customerId != null)
        ensure(r.customerId).openingDebt -= Number(r._sum.refundAmount) || 0;

    for (const r of invIn)
      if (r.customerId != null)
        ensure(r.customerId).debit += Number(r._sum.grandTotal) || 0;
    for (const r of cfReceiptIn)
      if (r.partnerId != null)
        ensure(r.partnerId).credit += Number(r._sum.amount) || 0;
    for (const r of cfPaidIn)
      if (r.partnerId != null)
        ensure(r.partnerId).credit -= Number(r._sum.amount) || 0;
    for (const r of roIn)
      if (r.customerId != null)
        ensure(r.customerId).credit += Number(r._sum.refundAmount) || 0;

    const result: Array<{ customerId: number } & Row> = [];
    for (const [customerId, row] of map.entries()) {
      row.closingDebt = row.openingDebt + row.debit - row.credit;
      const hasActivity = row.debit !== 0 || row.credit !== 0;
      if (hasActivity) {
        result.push({ customerId, ...row });
      }
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 3: Công nợ — Preview (phân trang)
  // ═══════════════════════════════════════════════════════════════════════════
  async getCustomerDebtPreview(query: ReportQueryDto) {
    const aggregates = await this.aggregateCustomerDebt(query);
    aggregates.sort((a, b) => b.closingDebt - a.closingDebt);

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;
    const total = aggregates.length;
    const paged = aggregates.slice(skip, skip + limit);
    const customerIds = paged.map((a) => a.customerId);

    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: {
            id: true,
            code: true,
            name: true,
            contactNumber: true,
            groups: true,
          },
        })
      : [];
    const cmap = new Map(customers.map((c) => [c.id, c]));

    const summary = aggregates.reduce(
      (acc, a) => {
        acc.totalOpening += a.openingDebt;
        acc.totalDebit += a.debit;
        acc.totalCredit += a.credit;
        acc.totalClosing += a.closingDebt;
        return acc;
      },
      {
        totalCustomers: aggregates.length,
        totalOpening: 0,
        totalDebit: 0,
        totalCredit: 0,
        totalClosing: 0,
      },
    );

    return {
      data: paged.map((a) => {
        const c = cmap.get(a.customerId);
        return {
          customerId: a.customerId,
          customerCode: c?.code || '',
          customerName: c?.name || '',
          contactNumber: c?.contactNumber || '',
          customerGroups: c?.groups || '',
          openingDebt: a.openingDebt,
          debit: a.debit,
          credit: a.credit,
          closingDebt: a.closingDebt,
        };
      }),
      total,
      page,
      limit,
      summary,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BÁO CÁO 3: Công nợ — Export Excel hierarchical (streaming)
  // ═══════════════════════════════════════════════════════════════════════════
  async exportCustomerDebt(query: ReportQueryDto, res: Response) {
    const aggregates = await this.aggregateCustomerDebt(query);
    aggregates.sort((a, b) => b.closingDebt - a.closingDebt);
    const customerIds = aggregates.map((a) => a.customerId);

    const fromDate = query.fromDate ? new Date(query.fromDate) : new Date(0);
    const toDate = query.toDate ? new Date(query.toDate) : new Date();

    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: {
            id: true,
            code: true,
            name: true,
            contactNumber: true,
            groups: true,
          },
        })
      : [];
    const cmap = new Map(customers.map((c) => [c.id, c]));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('BaoCaoCongNoTheoKhachHang');

    sheet.columns = [
      { header: 'Mã KH', key: 'customerCode', width: 14 },
      { header: 'Khách hàng', key: 'customerName', width: 32 },
      { header: 'Số điện thoại', key: 'contactNumber', width: 14 },
      { header: 'Nhóm khách hàng', key: 'customerGroups', width: 28 },
      { header: 'Nợ đầu kỳ', key: 'openingDebt', width: 16 },
      { header: 'Ghi nợ', key: 'debit', width: 14 },
      { header: 'Ghi có', key: 'credit', width: 14 },
      { header: 'Nợ cuối kỳ', key: 'closingDebt', width: 16 },
      { header: 'Mã giao dịch', key: 'transCode', width: 14 },
      { header: 'Thời gian', key: 'transTime', width: 18 },
      { header: 'Loại giao dịch', key: 'transType', width: 14 },
      { header: 'Giá trị', key: 'transValue', width: 16 },
      { header: 'Dư nợ cuối', key: 'runningDebt', width: 16 },
      { header: 'Mã hàng', key: 'productCode', width: 14 },
      { header: 'Mã vạch', key: 'productBarcode', width: 14 },
      { header: 'Tên hàng', key: 'productName', width: 40 },
      { header: 'Thương hiệu', key: 'tradeMark', width: 14 },
      { header: 'Nhóm hàng(3 Cấp)', key: 'productGroup', width: 30 },
      { header: 'Đơn giá', key: 'unitPrice', width: 12 },
      { header: 'SL sản phẩm', key: 'productQty', width: 10 },
      { header: 'Thành tiền', key: 'productAmount', width: 14 },
      { header: 'Chiết khấu', key: 'productDiscount', width: 12 },
      { header: 'VAT bán hàng', key: 'vatSale', width: 12 },
      { header: 'VAT hoàn lại', key: 'vatReturn', width: 12 },
      { header: 'Thu khác', key: 'otherFee', width: 12 },
      { header: 'Tổng cộng', key: 'grandTotal', width: 14 },
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

    for (const agg of aggregates) {
      const c = cmap.get(agg.customerId);
      if (!c) continue;

      const hasActivity = agg.debit !== 0 || agg.credit !== 0;

      // Khách không có giao dịch trong kỳ: chỉ in 1 dòng tổng khách (A-H)
      if (!hasActivity) {
        const summaryRow = sheet.addRow({
          customerCode: c.code || '',
          customerName: c.name,
          contactNumber: c.contactNumber || '',
          customerGroups: c.groups || '',
          openingDebt: agg.openingDebt,
          debit: agg.debit,
          credit: agg.credit,
          closingDebt: agg.closingDebt,
        });
        summaryRow.font = { bold: true, size: 11 };
        summaryRow.commit();
        continue;
      }

      // Lấy chi tiết giao dịch trong kỳ của customer
      const branchFilter = query.branchId ? { branchId: query.branchId } : {};

      const [invoices, cashFlowsRaw, returnOrders] = await Promise.all([
        this.prisma.invoice.findMany({
          where: {
            customerId: agg.customerId,
            status: { not: INVOICE_STATUS.CANCELLED },
            purchaseDate: { gte: fromDate, lte: toDate },
            ...branchFilter,
          },
          orderBy: { purchaseDate: 'asc' },
          select: {
            id: true,
            code: true,
            purchaseDate: true,
            grandTotal: true,
            details: {
              select: {
                productCode: true,
                productName: true,
                quantity: true,
                price: true,
                discount: true,
                totalPrice: true,
                product: {
                  select: {
                    unit: true,
                    parentName: true,
                    middleName: true,
                    childName: true,
                    tradeMark: { select: { name: true } },
                  },
                },
              },
            },
          },
        }),
        this.prisma.cashFlow.findMany({
          where: {
            partnerId: agg.customerId,
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
            customerId: agg.customerId,
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

      type Tx =
        | { kind: 'invoice'; time: Date; data: (typeof invoices)[number] }
        | {
            kind: 'cashflow_in';
            time: Date;
            data: (typeof cashFlows)[number];
          }
        | {
            kind: 'cashflow_out';
            time: Date;
            data: (typeof cashFlows)[number];
          }
        | { kind: 'return'; time: Date; data: (typeof returnOrders)[number] };

      const txs: Tx[] = [];
      for (const inv of invoices)
        txs.push({ kind: 'invoice', time: inv.purchaseDate, data: inv });
      for (const cf of cashFlows) {
        if (cf.isReceipt)
          txs.push({ kind: 'cashflow_in', time: cf.transDate, data: cf });
        else txs.push({ kind: 'cashflow_out', time: cf.transDate, data: cf });
      }
      for (const ro of returnOrders)
        txs.push({ kind: 'return', time: ro.createdAt, data: ro });

      txs.sort((a, b) => a.time.getTime() - b.time.getTime());

      // Helper ghép "Nhóm hàng (3 Cấp)": parentName>>middleName>>childName
      const productGroupOf = (
        p?: {
          parentName?: string | null;
          middleName?: string | null;
          childName?: string | null;
        } | null,
      ) => {
        if (!p) return '';
        const parts = [p.parentName, p.middleName, p.childName].filter(
          (x): x is string => !!x && x.trim().length > 0,
        );
        return parts.join('>>');
      };

      // Dòng đầu = MERGE: tổng khách (A-H) + "Dư nợ đầu kỳ" (I-M)
      const firstRow = sheet.addRow({
        customerCode: c.code || '',
        customerName: c.name,
        contactNumber: c.contactNumber || '',
        customerGroups: c.groups || '',
        openingDebt: agg.openingDebt,
        debit: agg.debit,
        credit: agg.credit,
        closingDebt: agg.closingDebt,
        transCode: '---',
        transTime: fromDate,
        transType: 'Dư nợ đầu kỳ',
        transValue: 0,
        runningDebt: agg.openingDebt,
      });
      firstRow.font = { bold: true, size: 11 };
      firstRow.commit();

      let running = agg.openingDebt;

      for (const tx of txs) {
        if (tx.kind === 'invoice') {
          const inv = tx.data;
          running += Number(inv.grandTotal);
          const details = inv.details;
          const head = details[0];
          sheet
            .addRow({
              contactNumber: c.contactNumber || '',
              transCode: inv.code,
              transTime: new Date(inv.purchaseDate),
              transType: 'Bán hàng',
              transValue: Number(inv.grandTotal),
              runningDebt: running,
              productCode: head?.productCode || '',
              productName: head?.productName || '',
              tradeMark: head?.product?.tradeMark?.name || '',
              productGroup: productGroupOf(head?.product),
              unitPrice: head ? Number(head.price) : 0,
              productQty: head ? Number(head.quantity) : 0,
              productAmount: head ? Number(head.totalPrice) : 0,
              productDiscount: head ? Number(head.discount) : 0,
              vatSale: 0,
              vatReturn: 0,
              otherFee: 0,
              grandTotal: Number(inv.grandTotal),
            })
            .commit();
          for (let i = 1; i < details.length; i++) {
            const d = details[i];
            sheet
              .addRow({
                contactNumber: c.contactNumber || '',
                productCode: d.productCode,
                productName: d.productName,
                tradeMark: d.product?.tradeMark?.name || '',
                productGroup: productGroupOf(d.product),
                unitPrice: Number(d.price),
                productQty: Number(d.quantity),
                productAmount: Number(d.totalPrice),
                productDiscount: Number(d.discount),
                vatSale: 0,
                vatReturn: 0,
                otherFee: 0,
                grandTotal: Number(inv.grandTotal),
              })
              .commit();
          }
        } else if (tx.kind === 'cashflow_in') {
          const cf = tx.data;
          running -= Number(cf.amount);
          sheet
            .addRow({
              contactNumber: c.contactNumber || '',
              transCode: cf.code,
              transTime: new Date(cf.transDate),
              transType: 'Thanh toán',
              transValue: -Number(cf.amount),
              runningDebt: running,
            })
            .commit();
        } else if (tx.kind === 'cashflow_out') {
          const cf = tx.data;
          running += Number(cf.amount);
          sheet
            .addRow({
              contactNumber: c.contactNumber || '',
              transCode: cf.code,
              transTime: new Date(cf.transDate),
              transType: 'Chi tiền cho KH',
              transValue: Number(cf.amount),
              runningDebt: running,
            })
            .commit();
        } else {
          const ro = tx.data;
          running -= Number(ro.refundAmount);
          sheet
            .addRow({
              contactNumber: c.contactNumber || '',
              transCode: ro.code,
              transTime: new Date(ro.createdAt),
              transType: 'Trả hàng',
              transValue: -Number(ro.refundAmount),
              runningDebt: running,
            })
            .commit();
        }
      }
    }

    sheet.commit();
    await workbook.commit();
  }
}
