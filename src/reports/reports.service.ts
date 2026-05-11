import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportQueryDto } from './dto';
import { INVOICE_STATUS } from '../invoices/dto';
import { RETURN_ORDER_STATUS } from '../return-orders/dto';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

// Giới hạn tối đa (ms)
const MAX_RANGE_SALES = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 tháng
const MAX_RANGE_PRODUCT = 3 * 30 * 24 * 60 * 60 * 1000; // ~3 tháng
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

  private validateDateRange(query: ReportQueryDto, maxRange: number) {
    if (query.fromDate && query.toDate) {
      const diff =
        new Date(query.toDate).getTime() - new Date(query.fromDate).getTime();
      const maxMonths = Math.round(maxRange / (30 * 24 * 60 * 60 * 1000));
      if (diff > maxRange) {
        throw new BadRequestException(
          `Khoảng thời gian tối đa là ${maxMonths} tháng. Vui lòng thu hẹp khoảng thời gian.`,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: Build return amount map — query 1 lần duy nhất
  // ═══════════════════════════════════════════════════════════════════════════
  private async buildReturnAmountMap(where: any): Promise<Map<number, number>> {
    // Lấy tất cả invoiceId matching filter
    const invoiceIds = await this.prisma.invoice.findMany({
      where,
      select: { id: true },
    });

    const ids = invoiceIds.map((i) => i.id);
    if (ids.length === 0) return new Map();

    // Query ReturnOrderDetail group by invoiceId
    // Chỉ lấy return orders đã hoàn thành (STOCK_RECEIVED, COMPLETED)
    const results = await this.prisma.returnOrderDetail.groupBy({
      by: ['invoiceId'],
      where: {
        invoiceId: { in: ids },
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
      map.set(r.invoiceId, Number(r._sum.totalAmount) || 0);
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
      returnMap.set(r.invoiceId, Number(r._sum.totalAmount) || 0);
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

    // Tổng trả hàng toàn bộ
    const allInvoiceIds = await this.prisma.invoice.findMany({
      where,
      select: { id: true },
    });
    const allIds = allInvoiceIds.map((i) => i.id);

    let totalReturn = 0;
    if (allIds.length > 0) {
      const returnAgg = await this.prisma.returnOrderDetail.aggregate({
        where: {
          invoiceId: { in: allIds },
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
      totalReturn = Number(returnAgg._sum.totalAmount) || 0;
    }

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
    this.validateDateRange(query, MAX_RANGE_SALES);
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
        price: Number(d.price),
        discount: Number(d.discount),
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
    this.validateDateRange(query, MAX_RANGE_PRODUCT);
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
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Thành tiền SP', key: 'totalPrice', width: 16 },
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
            price: Number(d.price),
            discount: Number(d.discount),
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
      price: '',
      discount: '',
      totalPrice: Number(summaryAgg._sum.totalPrice) || 0,
      conditionType: '',
    });
    summaryRow.font = { bold: true, size: 11 };
    summaryRow.commit();

    sheet.commit();
    await workbook.commit();
  }
}
