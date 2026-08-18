import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import {
  CreateReturnOrderDto,
  ConfirmStockReceivedDto,
  ConfirmRefundDto,
  ReturnOrderQueryDto,
  RETURN_ORDER_STATUS,
  RETURN_ORDER_STATUS_LABELS,
  UpdateStep1Dto,
} from './dto';
import { INVOICE_STATUS, INVOICE_STATUS_LABELS } from 'src/invoices/dto';
import { recalcCustomerDebt } from 'src/common/customer-debt.util';
import { recalcOnHandForPairs } from 'src/common/inventory-onhand.util';
import {
  writeConditionLogs,
  recalcConditionBucketsForPairs,
} from 'src/common/stock-condition-onhand.util';
import { searchCustomerIds } from '../common/customer-search.util';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
} from '../common/inventory-log.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

@Injectable()
export class ReturnOrdersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  private async generateCode(tx: any): Promise<string> {
    const lastReturn = await tx.returnOrder.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = lastReturn ? lastReturn.id + 1 : 1;
    return `TH${nextId.toString().padStart(6, '0')}`;
  }

  /**
   * Dựng điều kiện `where` cho phiếu trả hàng. Async vì cần tra cứu khách hàng
   * theo từ khóa (searchCustomerIds). Tách riêng để dùng chung giữa findAll
   * (danh sách) và export/export-detail, đảm bảo bộ lọc xuất file khớp hoàn
   * toàn với bộ lọc đang hiển thị.
   */
  private async buildReturnOrderWhere(
    query: ReturnOrderQueryDto,
  ): Promise<any> {
    const where: any = {};

    if (query.search) {
      const matchedIds = await searchCustomerIds(this.prisma, query.search);
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { invoice: { code: { contains: query.search, mode: 'insensitive' } } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    if (query.branchIds && query.branchIds.length > 0) {
      where.branchId = { in: query.branchIds };
    } else if (query.branchId) {
      where.branchId = query.branchId;
    }
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.createdByIds && query.createdByIds.length > 0) {
      where.createdBy = { in: query.createdByIds };
    } else if (query.createdBy) {
      where.createdBy = query.createdBy;
    }
    // Người bán nằm trên hóa đơn gốc (Invoice.soldById), không nằm trên phiếu
    // trả hàng → lọc qua quan hệ invoice. Bọc trong AND để không ghi đè
    // where.OR của search.
    if (query.soldByIds && query.soldByIds.length > 0) {
      where.AND = [
        ...(where.AND || []),
        { invoice: { soldById: { in: query.soldByIds } } },
      ];
    }
    if (query.invoiceId) where.invoiceId = query.invoiceId;
    if (query.refundType) {
      if (query.refundType === 'debt_offsets') {
        where.refundType = { in: ['debt_offset', 'manual_offset'] };
      } else if (query.refundType === 'returns_only') {
        // Trang trả hàng: loại CTN (manual_offset), giữ phiếu TH gồm cả
        // refundType null (đang xử lý dở), cash_refund và debt_offset.
        // Dùng OR-null vì SQL `<> 'manual_offset'` loại luôn hàng NULL.
        // Bọc trong AND để không ghi đè where.OR của search.
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { refundType: null },
              { refundType: { not: 'manual_offset' } },
            ],
          },
        ];
      } else {
        where.refundType = query.refundType;
      }
    }

    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    return where;
  }

  async findAll(query: ReturnOrderQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = await this.buildReturnOrderWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.returnOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          invoice: {
            select: {
              id: true,
              code: true,
              purchaseDate: true,
              totalAmount: true,
              grandTotal: true,
              soldBy: { select: { id: true, name: true } },
            },
          },
          customer: {
            select: { id: true, code: true, name: true },
          },
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: { id: true, code: true, name: true },
              },
              invoice: {
                select: { id: true, code: true },
              },
            },
          },
        },
      }),
      this.prisma.returnOrder.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu trả hàng = 1 dòng Excel. Bộ lọc dùng chung
   * buildReturnOrderWhere với danh sách.
   */
  async exportReturnOrders(
    query: ReturnOrderQueryDto,
    res: Response,
  ): Promise<void> {
    const where = await this.buildReturnOrderWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Trả hàng');

    sheet.columns = [
      { header: 'Mã trả hàng', key: 'code', width: 18 },
      { header: 'Mã hóa đơn', key: 'invoiceCode', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Người bán (HĐ)', key: 'invoiceSeller', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Mã KH', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 24 },
      { header: 'Nhóm khách hàng', key: 'customerGroupName', width: 20 },
      { header: 'Chi nhánh nhận', key: 'branch', width: 20 },
      { header: 'Số mặt hàng', key: 'totalGoods', width: 12 },
      { header: 'Tổng SL trả', key: 'totalQuantity', width: 14 },
      { header: 'Tiền cần trả KH', key: 'refundAmount', width: 16 },
      { header: 'Đã trả cho KH', key: 'refundedAmount', width: 16 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Trạng thái', key: 'status', width: 18 },
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

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.returnOrder.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          invoice: {
            select: {
              code: true,
              soldBy: { select: { name: true } },
            },
          },
          customer: {
            select: {
              code: true,
              name: true,
              customerGroupDetails: {
                select: { customerGroup: { select: { name: true } } },
              },
            },
          },
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: {
            select: { requestQuantity: true },
          },
        },
      });

      if (batch.length === 0) break;

      for (const r of batch) {
        const totalQuantity = r.details.reduce(
          (s, d) => s + Number(d.requestQuantity),
          0,
        );
        const row = sheet.addRow({
          code: r.code,
          invoiceCode: r.invoice?.code || '',
          createdAt: fmtDateTime(r.createdAt),
          invoiceSeller: r.invoice?.soldBy?.name || '',
          createdBy: r.creator?.name || r.createdByName || '',
          customerCode: r.customer?.code || '',
          customerName: r.customer?.name || '',
          customerGroupName: ((r.customer as any)?.customerGroupDetails ?? [])
            .map((d: any) => d.customerGroup?.name)
            .filter(Boolean)
            .join(', '),
          branch: r.branch?.name || '',
          totalGoods: r.details.length,
          totalQuantity,
          refundAmount: Number(r.refundAmount || r.totalReturnAmount) || 0,
          refundedAmount: Number(r.refundedAmount) || 0,
          note: r.note || '',
          status: RETURN_ORDER_STATUS_LABELS[r.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildReturnOrderWhere với export tổng quan.
   */
  async exportReturnOrdersDetail(
    query: ReturnOrderQueryDto,
    res: Response,
  ): Promise<void> {
    const where = await this.buildReturnOrderWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết trả hàng');

    sheet.columns = [
      { header: 'Mã trả hàng', key: 'code', width: 18 },
      { header: 'Mã hóa đơn', key: 'invoiceCode', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Mã KH', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 24 },
      { header: 'Nhóm khách hàng', key: 'customerGroupName', width: 20 },
      { header: 'Chi nhánh nhận', key: 'branch', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 18 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'SL trên HĐ', key: 'invoiceQuantity', width: 12 },
      { header: 'SL yêu cầu trả', key: 'requestQuantity', width: 14 },
      { header: 'SL xác nhận', key: 'confirmedQuantity', width: 12 },
      { header: 'Đơn giá trả', key: 'returnPrice', width: 14 },
      { header: 'Thành tiền', key: 'totalAmount', width: 16 },
      { header: 'Ghi chú', key: 'note', width: 30 },
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

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.returnOrder.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          invoice: { select: { code: true } },
          customer: {
            select: {
              code: true,
              name: true,
              customerGroupDetails: {
                select: { customerGroup: { select: { name: true } } },
              },
            },
          },
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });

      if (batch.length === 0) break;

      for (const r of batch) {
        const base = {
          code: r.code,
          invoiceCode: r.invoice?.code || '',
          createdAt: fmtDateTime(r.createdAt),
          customerCode: r.customer?.code || '',
          customerName: r.customer?.name || '',
          customerGroupName: ((r.customer as any)?.customerGroupDetails ?? [])
            .map((d: any) => d.customerGroup?.name)
            .filter(Boolean)
            .join(', '),
          branch: r.branch?.name || '',
          createdBy: r.creator?.name || r.createdByName || '',
          status: RETURN_ORDER_STATUS_LABELS[r.status] || '',
        };

        if (!r.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            invoiceQuantity: 0,
            requestQuantity: 0,
            confirmedQuantity: 0,
            returnPrice: 0,
            totalAmount: 0,
            note: '',
          });
          row.commit();
          continue;
        }

        for (const d of r.details) {
          const row = sheet.addRow({
            ...base,
            // Mỗi dòng chi tiết có mã HĐ riêng (phiếu trả nhiều HĐ), ưu tiên
            // mã HĐ của dòng nếu có.
            invoiceCode: d.invoiceCode || base.invoiceCode,
            productCode: d.productCode || '',
            productName: d.productName || '',
            invoiceQuantity: Number(d.invoiceQuantity) || 0,
            requestQuantity: Number(d.requestQuantity) || 0,
            confirmedQuantity: Number(d.confirmedQuantity) || 0,
            returnPrice: Number(d.returnPrice) || 0,
            totalAmount: Number(d.totalAmount) || 0,
            note: d.note || '',
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const returnOrder = await this.prisma.returnOrder.findUnique({
      where: { id },
      include: {
        invoice: {
          include: {
            details: { include: { product: true } },
            soldBy: { select: { id: true, name: true } },
            creator: { select: { id: true, name: true } },
            customer: true,
            branch: true,
          },
        },
        customer: true,
        parentCustomer: true,
        branch: true,
        creator: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        confirmedByUser: { select: { id: true, name: true } },
        refundConfirmedByUser: { select: { id: true, name: true } },
        details: {
          include: {
            product: {
              select: { id: true, code: true, name: true, images: true },
            },
          },
        },
      },
    });

    if (!returnOrder) {
      throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    }

    return returnOrder;
  }

  async create(dto: CreateReturnOrderDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { id: { in: dto.invoiceIds } },
        include: {
          details: true,
          customer: { select: { id: true, name: true } },
        },
      });

      if (invoices.length === 0) {
        throw new NotFoundException('Không tìm thấy hóa đơn');
      }

      const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));

      const existingReturns = await tx.returnOrder.findMany({
        where: {
          status: { notIn: [RETURN_ORDER_STATUS.CANCELLED] },
          details: {
            some: {
              invoiceId: { in: dto.invoiceIds },
            },
          },
        },
        include: { details: true },
      });

      // ── Số đã trả trước đó, gom theo 2 cấp:
      //    (a) cấp SẢN PHẨM  — gồm TẤT CẢ phiếu cũ (kể cả phiếu chưa có
      //        invoiceDetailId) → dùng cho ràng buộc tổng, không bao giờ hụt.
      //    (b) cấp DÒNG HÓA ĐƠN — chỉ những phiếu đã có invoiceDetailId
      //        → dùng cho ràng buộc chi tiết theo từng dòng.
      const returnedQuantities: Record<string, number> = {};
      const returnedByDetail: Record<number, number> = {};
      existingReturns.forEach((ro) => {
        ro.details.forEach((d) => {
          const key = `${d.invoiceId}-${d.productId}`;
          returnedQuantities[key] =
            (returnedQuantities[key] || 0) + Number(d.requestQuantity);

          if (d.invoiceDetailId) {
            returnedByDetail[d.invoiceDetailId] =
              (returnedByDetail[d.invoiceDetailId] || 0) +
              Number(d.requestQuantity);
          }
        });
      });

      // Cộng dồn số lượng yêu cầu trả trong CÙNG payload — hóa đơn có thể có
      // nhiều dòng cùng sản phẩm (khác lô / giá / hàng tặng), nên phải cộng
      // dồn ở cả 2 cấp trước khi so sánh.
      const requestedByKey: Record<string, number> = {};
      const requestedByDetail: Record<number, number> = {};
      for (const detail of dto.details) {
        const key = `${detail.invoiceId}-${detail.productId}`;
        requestedByKey[key] =
          (requestedByKey[key] || 0) + Number(detail.requestQuantity);

        if (detail.invoiceDetailId) {
          requestedByDetail[detail.invoiceDetailId] =
            (requestedByDetail[detail.invoiceDetailId] || 0) +
            Number(detail.requestQuantity);
        }
      }

      const checkedKeys = new Set<string>();
      const checkedDetailIds = new Set<number>();
      for (const detail of dto.details) {
        const invoice = invoiceMap.get(detail.invoiceId);
        if (!invoice) {
          throw new BadRequestException(
            `Hóa đơn ${detail.invoiceCode} không tồn tại`,
          );
        }

        const matchedDetails = invoice.details.filter(
          (d) => d.productId === detail.productId,
        );
        if (matchedDetails.length === 0) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productCode} không có trong hóa đơn ${detail.invoiceCode}`,
          );
        }

        // ── (b) Ràng buộc theo ĐÚNG dòng hóa đơn (khi client gửi lên id dòng)
        if (detail.invoiceDetailId) {
          const invoiceLine = matchedDetails.find(
            (d) => d.id === detail.invoiceDetailId,
          );
          if (!invoiceLine) {
            throw new BadRequestException(
              `Dòng hóa đơn #${detail.invoiceDetailId} không thuộc sản phẩm ${detail.productCode} trong hóa đơn ${detail.invoiceCode}`,
            );
          }

          if (!checkedDetailIds.has(detail.invoiceDetailId)) {
            checkedDetailIds.add(detail.invoiceDetailId);

            const lineReturned = returnedByDetail[detail.invoiceDetailId] || 0;
            const lineMax = Number(invoiceLine.quantity) - lineReturned;
            const lineRequested =
              requestedByDetail[detail.invoiceDetailId] || 0;

            if (lineRequested > lineMax) {
              throw new BadRequestException(
                `Sản phẩm ${detail.productName} (HĐ ${detail.invoiceCode}): Số lượng trả (${lineRequested}) vượt quá còn lại của dòng (${lineMax})`,
              );
            }
          }
        }

        // ── (a) Ràng buộc TỔNG theo sản phẩm — luôn chạy, phủ cả phiếu cũ
        const key = `${detail.invoiceId}-${detail.productId}`;
        if (checkedKeys.has(key)) continue;
        checkedKeys.add(key);

        const totalQuantity = matchedDetails.reduce(
          (sum, d) => sum + Number(d.quantity),
          0,
        );
        const alreadyReturned = returnedQuantities[key] || 0;
        const maxReturnable = totalQuantity - alreadyReturned;
        const totalRequested = requestedByKey[key] || 0;

        if (totalRequested > maxReturnable) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName} (HĐ ${detail.invoiceCode}): Số lượng trả (${totalRequested}) vượt quá còn lại (${maxReturnable})`,
          );
        }
      }

      const code = await this.generateCode(tx);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      const firstInvoice = invoices[0];
      const customerId = dto.customerId || firstInvoice.customerId;
      const parentCustomerId = customerId;

      const detailsData = dto.details.map((d) => {
        const returnPrice =
          d.returnPrice !== undefined && d.returnPrice !== null
            ? d.returnPrice
            : d.invoicePrice;
        return {
          invoiceId: d.invoiceId,
          invoiceDetailId: d.invoiceDetailId ?? null,
          invoiceCode: d.invoiceCode,
          productId: d.productId,
          productCode: d.productCode,
          productName: d.productName,
          invoiceQuantity: d.invoiceQuantity,
          invoicePrice: d.invoicePrice,
          requestQuantity: d.requestQuantity,
          confirmedQuantity: 0,
          returnPrice,
          totalAmount: returnPrice * d.requestQuantity,
          note: d.note,
          saleGoodQuantity: d.saleGoodQuantity || 0,
          saleDamagedQuantity: d.saleDamagedQuantity || 0,
          saleNearExpiryQuantity: d.saleNearExpiryQuantity || 0,
        };
      });

      const totalReturnAmount = detailsData.reduce(
        (sum, d) => sum + d.totalAmount,
        0,
      );

      const status = dto.isDraft
        ? RETURN_ORDER_STATUS.REQUEST_DRAFT
        : RETURN_ORDER_STATUS.REQUEST;

      const returnOrder = await tx.returnOrder.create({
        data: {
          code,
          invoiceId: dto.invoiceIds.length === 1 ? dto.invoiceIds[0] : null,
          customerId,
          parentCustomerId,
          branchId: dto.branchId,
          status,
          statusValue: RETURN_ORDER_STATUS_LABELS[status],
          totalReturnAmount,
          note: dto.note,
          createdBy: userId,
          createdByName: user?.name || 'System',
          images: dto.images ? JSON.stringify(dto.images) : null,
          details: {
            create: detailsData,
          },
        },
        include: {
          invoice: {
            select: { id: true, code: true },
          },
          customer: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: true,
        },
      });

      const invoiceCodes = invoices.map((inv) => inv.code).join(', ');

      // Cảnh báo (non-blocking) nếu việc trả hàng phá vỡ điều kiện mua-thưởng của KM
      const promotionWarnings = await this.detectBrokenPromotions(
        tx,
        dto,
        invoices,
        returnedQuantities,
      );

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'RETURN_ORDER_CREATE',
        entityType: 'return_orders',
        entityId: returnOrder.id.toString(),
        entityCode: returnOrder.code,
        category: 'return_order',
        severity: 'info',
        snapshot: {
          code: returnOrder.code,
          invoiceCodes,
          customerName: returnOrder.customer?.name || 'N/A',
          branchName: returnOrder.branch.name,
          totalReturnAmount: Number(returnOrder.totalReturnAmount),
          status: returnOrder.statusValue,
        },
        message: `Tạo phiếu trả hàng ${returnOrder.code} từ hóa đơn ${invoiceCodes}`,
        messageTemplate: 'RETURN_ORDER_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.branchId,
      });

      return { ...returnOrder, _promotionWarnings: promotionWarnings };
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  /**
   * Phát hiện KM bị phá vỡ điều kiện khi trả hàng (non-blocking).
   * Logic: với mỗi log KM dạng mua-thưởng (BUY_*) còn 'applied' trên hóa đơn,
   * nếu số lượng SP mua sau khi trả < buyQuantity của CT → cảnh báo cần xử lý hàng tặng.
   */
  private async detectBrokenPromotions(
    tx: any,
    dto: CreateReturnOrderDto,
    invoices: any[],
    returnedQuantities: Record<string, number>,
  ): Promise<
    {
      invoiceId: number;
      invoiceCode: string;
      promotionCode: string;
      promotionName: string;
      message: string;
      giftLines: any[];
    }[]
  > {
    const warnings: any[] = [];
    const invoiceIds = invoices.map((inv) => inv.id);
    const logs = await tx.invoicePromotionLog.findMany({
      where: {
        invoiceId: { in: invoiceIds },
        status: 'applied',
        type: { in: ['BUY_X_GET_Y', 'BUY_N_GET_M_SAME', 'BUY_X_BUY_Y_PRICE'] },
      },
      include: { promotion: { include: { rewards: true } } },
    });

    // Tổng số lượng trả mới (theo invoice-product) cộng dồn với đã trả trước đó
    const newReturned: Record<string, number> = { ...returnedQuantities };
    for (const d of dto.details) {
      const key = `${d.invoiceId}-${d.productId}`;
      newReturned[key] = (newReturned[key] || 0) + Number(d.requestQuantity);
    }

    // Resolve danh mục → productIds (parent/middle/child name) cho các CT dùng buyCategoryName
    const categoryNames = new Set<string>();
    for (const log of logs) {
      for (const rw of log.promotion?.rewards ?? []) {
        if (rw.buyCategoryName) categoryNames.add(rw.buyCategoryName);
      }
    }
    const categoryProductMap: Record<string, number[]> = {};
    if (categoryNames.size > 0) {
      const catList = [...categoryNames];
      const catProducts = await tx.product.findMany({
        where: {
          OR: [
            { parentName: { in: catList } },
            { middleName: { in: catList } },
            { childName: { in: catList } },
          ],
        },
        select: {
          id: true,
          parentName: true,
          middleName: true,
          childName: true,
        },
      });
      for (const cp of catProducts) {
        for (const name of catList) {
          if (
            cp.parentName === name ||
            cp.middleName === name ||
            cp.childName === name
          ) {
            (categoryProductMap[name] ||= []).push(cp.id);
          }
        }
      }
    }

    for (const log of logs) {
      const invoice = invoices.find((inv) => inv.id === log.invoiceId);
      if (!invoice) continue;

      // Duyệt MỌI reward của CT (không chỉ rewards[0])
      for (const rw of log.promotion?.rewards ?? []) {
        // Tập SP "mua" (X): theo buyProductId hoặc theo danh mục buyCategoryName
        const buyProductIds: number[] = rw.buyProductId
          ? [rw.buyProductId]
          : rw.buyCategoryName
            ? categoryProductMap[rw.buyCategoryName] || []
            : [];
        if (buyProductIds.length === 0) continue;

        // Tổng SL còn lại sau khi trả (cộng dồn các SP thuộc nhóm mua)
        let remainingBought = 0;
        for (const pid of buyProductIds) {
          const boughtDetail = invoice.details.find(
            (de: any) => de.productId === pid && !de.isGift,
          );
          if (!boughtDetail) continue;
          const key = `${log.invoiceId}-${pid}`;
          remainingBought +=
            Number(boughtDetail.quantity) - (newReturned[key] || 0);
        }

        if (remainingBought < Number(rw.buyQuantity)) {
          const snapshot = log.rewardSnapshot || {};
          warnings.push({
            invoiceId: log.invoiceId,
            invoiceCode: invoice.code,
            promotionCode: log.promotionCode,
            promotionName: log.promotionName,
            message: `PROMOTION_BROKEN_ON_RETURN: Trả hàng làm số lượng mua (${remainingBought}) không còn đủ điều kiện "${log.promotionName}" (cần ${Number(
              rw.buyQuantity,
            )}). Vui lòng xử lý hàng tặng: thu hồi hoặc ghi nhận giá trị vào khoản hoàn tiền.`,
            giftLines: snapshot.giftLines || [],
          });
        }
      }
    }

    return warnings;
  }

  async confirmStockReceived(
    id: number,
    dto: ConfirmStockReceivedDto,
    userId: number,
  ) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          details: true,
          invoice: { include: { details: true } },
          customer: {
            select: { id: true, name: true, totalDebt: true },
          },
        },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      // CHO PHÉP cả status REQUEST (1) và STOCK_DRAFT (6)
      if (
        returnOrder.status !== RETURN_ORDER_STATUS.REQUEST &&
        returnOrder.status !== RETURN_ORDER_STATUS.STOCK_DRAFT
      ) {
        throw new BadRequestException(
          'Phiếu trả hàng không ở trạng thái cho phép nhập hàng',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      // Actor cho InventoryLog (truy vết ai nhập hàng trả lại vào kho).
      const returnLogActor = buildInventoryLogActor(
        userId,
        user?.name || user?.email,
      );

      const branch = await tx.branch.findUnique({
        where: { id: returnOrder.branchId },
        select: { id: true, name: true },
      });

      for (const confirmDetail of dto.details) {
        const detail = returnOrder.details.find(
          (d) => d.id === confirmDetail.detailId,
        );
        if (!detail) {
          throw new BadRequestException(
            `Không tìm thấy chi tiết trả hàng ID ${confirmDetail.detailId}`,
          );
        }

        const goodQty = confirmDetail.goodQuantity || 0;
        const damagedQty = confirmDetail.damagedQuantity || 0;
        const nearExpiryQty = confirmDetail.nearExpiryQuantity || 0;
        const totalConfirmed = goodQty + damagedQty + nearExpiryQty;

        if (totalConfirmed > Number(detail.requestQuantity)) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Tổng thực nhận (${totalConfirmed}) vượt quá số lượng yêu cầu (${detail.requestQuantity})`,
          );
        }

        await tx.returnOrderDetail.update({
          where: { id: confirmDetail.detailId },
          data: {
            confirmedQuantity: totalConfirmed,
            goodQuantity: goodQty,
            damagedQuantity: damagedQty,
            nearExpiryQuantity: nearExpiryQty,
            totalAmount: totalConfirmed * Number(detail.returnPrice),
          },
        });
      }

      // Lưu stockImages + note
      const updateData: any = {
        note: dto.note ?? returnOrder.note,
        stockImages: dto.stockImages
          ? JSON.stringify(dto.stockImages)
          : returnOrder.stockImages,
      };

      // ===== NẾU LÀ PHIẾU TẠM =====
      if (dto.isDraft) {
        updateData.status = RETURN_ORDER_STATUS.STOCK_DRAFT;
        updateData.statusValue =
          RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.STOCK_DRAFT];

        await tx.returnOrder.update({
          where: { id },
          data: updateData,
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'RETURN_ORDER_STOCK_DRAFT',
          entityType: 'return_orders',
          entityId: id.toString(),
          entityCode: returnOrder.code,
          category: 'return_order',
          severity: 'info',
          snapshot: { code: returnOrder.code },
          message: `Lưu phiếu tạm nhập hàng trả ${returnOrder.code}`,
          messageTemplate: 'RETURN_ORDER_STOCK_DRAFT',
          userId,
          userName: user?.name || 'System',
          branchId: returnOrder.branchId,
        });

        return this.findOne(id);
      }

      // ===== HOÀN THÀNH NHẬP HÀNG =====
      // Cộng kho + phân loại damaged/nearExpiry
      for (const confirmDetail of dto.details) {
        const detail = returnOrder.details.find(
          (d) => d.id === confirmDetail.detailId,
        );
        if (!detail) continue;

        const goodQty = confirmDetail.goodQuantity || 0;
        const damagedQty = confirmDetail.damagedQuantity || 0;
        const nearExpiryQty = confirmDetail.nearExpiryQuantity || 0;
        const totalConfirmed = goodQty + damagedQty + nearExpiryQty;

        if (totalConfirmed > 0) {
          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: returnOrder.branchId,
              },
            },
            update: {
              onHand: { increment: totalConfirmed },
            },
            create: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: returnOrder.branchId,
              branchName: branch?.name || '',
              onHand: totalConfirmed,
            },
          });
          touchedProductIds.add(detail.productId);

          // Bucket đi qua SỔ CÁI (không ghi trực tiếp cột cache nữa) để tồn
          // loại tồn luôn = Σ log active. Cache được recalc ở cuối luồng.
          await writeConditionLogs(tx, {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: returnOrder.branchId,
            branchName: branch?.name || '',
            refCode: returnOrder.code,
            refType: 'return_order',
            refId: returnOrder.id,
            transactionType: 'RETURN_IN',
            createdByName: user?.name || null,
            note: 'Nhập hàng trả từ khách',
            damaged: damagedQty,
            nearExpiry: nearExpiryQty,
            nearExpiryDate: (detail as any).manufactureDate ?? null,
          });

          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: returnOrder.branchId,
              branchName: branch?.name || '',
              transactionType: 'RETURN',
              refCode: returnOrder.code,
              refType: 'return_order',
              refId: returnOrder.id,
              quantity: Number(totalConfirmed),
              costPrice: 0,
              transactionPrice: Number(detail.returnPrice),
              partnerId: returnOrder.customerId || null,
              partnerName: returnOrder.customer?.name || null,
              ...buildInventoryLogBase(returnLogActor),
            },
          });
        }
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi ghi log RETURN cho mọi
      // item, recalc lại onHand (đè increment rời rạc).
      const touchedPairs = dto.details.map((d) => {
        const detail = returnOrder.details.find((rd) => rd.id === d.detailId);
        return {
          productId: detail?.productId,
          branchId: returnOrder.branchId,
        };
      });
      await recalcOnHandForPairs(tx, touchedPairs);

      // Tồn bucket cũng là giá trị DẪN XUẤT từ sổ cái StockConditionLog (đã ghi
      // ở trên). Recalc cache để khớp sổ cái, thay cho việc increment rời rạc.
      await recalcConditionBucketsForPairs(tx, touchedPairs);

      const updatedDetails = await tx.returnOrderDetail.findMany({
        where: { returnOrderId: id },
      });

      const newTotalReturnAmount = updatedDetails.reduce(
        (sum, d) => sum + Number(d.totalAmount),
        0,
      );

      const refundAmount = updatedDetails.reduce(
        (sum, d) => sum + Number(d.confirmedQuantity) * Number(d.returnPrice),
        0,
      );

      if (returnOrder.invoiceId && refundAmount > 0) {
        const inv = await tx.invoice.findUnique({
          where: { id: returnOrder.invoiceId },
          select: { debtAmount: true },
        });

        if (inv) {
          const newDebtAmount = Math.max(
            0,
            Number(inv.debtAmount) - refundAmount,
          );

          // Trả hàng KHÔNG được đổi trạng thái giao vận vốn có của hóa đơn.
          // Chỉ cập nhật công nợ; và chỉ nâng lên "Hoàn thành" khi công nợ về 0.
          const invoiceUpdate: {
            debtAmount: number;
            status?: number;
            statusValue?: string;
          } = {
            debtAmount: newDebtAmount,
          };
          if (newDebtAmount <= 0) {
            invoiceUpdate.status = INVOICE_STATUS.COMPLETED;
            invoiceUpdate.statusValue =
              INVOICE_STATUS_LABELS[INVOICE_STATUS.COMPLETED];
          }

          await tx.invoice.update({
            where: { id: returnOrder.invoiceId },
            data: invoiceUpdate,
          });
        }
      }

      if (returnOrder.customerId && refundAmount > 0) {
        // Dùng Formula A canonical thay vì decrement thủ công
        // RO hiện tại chưa được update sang STOCK_RECEIVED (status=2) → exclude + extraDebtOffset
        // để mô phỏng RO đã được tính trong debtOffsets
        await recalcCustomerDebt(tx, returnOrder.customerId, {
          excludeReturnOrderId: id,
          extraDebtOffset: refundAmount,
        });
      }

      updateData.status = RETURN_ORDER_STATUS.STOCK_RECEIVED;
      updateData.statusValue =
        RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.STOCK_RECEIVED];
      updateData.totalReturnAmount = newTotalReturnAmount;
      updateData.refundAmount = refundAmount;
      updateData.receivedById = userId;
      updateData.receivedByName = user?.name || 'System';
      updateData.confirmedBy = userId;
      updateData.confirmedByName = user?.name || 'System';
      updateData.confirmedAt = new Date();

      await tx.returnOrder.update({
        where: { id },
        data: updateData,
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'RETURN_ORDER_STOCK_RECEIVED',
        entityType: 'return_orders',
        entityId: id.toString(),
        entityCode: returnOrder.code,
        category: 'return_order',
        severity: 'info',
        snapshot: {
          code: returnOrder.code,
          refundAmount,
          totalReturnAmount: newTotalReturnAmount,
          // Bổ sung danh sách sản phẩm + số lượng nhập trả để truy vết trực tiếp
          // trên audit log (trước đây chỉ có refundAmount → không biết SP nào).
          items: returnOrder.details.map((d: any) => ({
            productCode: d.productCode,
            productName: d.productName,
            returnQuantity: d.returnQuantity,
            confirmedQuantity: d.confirmedQuantity,
            goodQuantity: d.goodQuantity,
            damagedQuantity: d.damagedQuantity,
            nearExpiryQuantity: d.nearExpiryQuantity,
          })),
        },
        message: `Xác nhận nhập hàng trả ${returnOrder.code}`,
        messageTemplate: 'RETURN_ORDER_STOCK_RECEIVED',
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async confirmRefund(id: number, dto: ConfirmRefundDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          details: true,
          invoice: true,
          customer: {
            include: {
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
        },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      if (returnOrder.status !== RETURN_ORDER_STATUS.STOCK_RECEIVED) {
        throw new BadRequestException(
          'Phiếu trả hàng chưa được xác nhận nhập hàng',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      const refundAmount = Number(returnOrder.refundAmount);
      const dtoRefundType = dto.refundType || 'debt_offset';

      // ── Tính originalDebt (nợ còn lại của hóa đơn trước khi trả hàng)
      // invoice.paidAmount KHÔNG thay đổi ở bước 2 → phản ánh đúng trạng thái trước khi trả hàng
      let originalDebt = 0;
      if (returnOrder.invoice) {
        originalDebt = Math.max(
          0,
          Number(returnOrder.invoice.grandTotal) -
            Number(returnOrder.invoice.paidAmount),
        );
      } else if (returnOrder.details.length > 0) {
        const invoiceIds = [
          ...new Set(
            returnOrder.details
              .map((d) => d.invoiceId)
              .filter((id): id is number => id !== null),
          ),
        ];
        const invoices = await tx.invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { grandTotal: true, paidAmount: true },
        });
        originalDebt = invoices.reduce(
          (sum, inv) =>
            sum + Math.max(0, Number(inv.grandTotal) - Number(inv.paidAmount)),
          0,
        );
      }

      // effectiveRefundAmount = phần dư vượt quá nợ → cần hoàn lại cho khách
      const effectiveRefundAmount = Math.max(0, refundAmount - originalDebt);

      // refundType thực tế: nếu không có khoản dư thì bắt buộc debt_offset
      const refundType =
        effectiveRefundAmount === 0 ? 'debt_offset' : dtoRefundType;

      let actualCashRefund = 0;
      let finalDebtSnapshot: number | null = null;
      let refundCashFlowId: number | null = null;

      const debtHolderId = returnOrder.customerId!;

      const recalculateDebt = async (): Promise<number> => {
        return recalcCustomerDebt(tx, debtHolderId, {
          excludeReturnOrderId: id,
          extraDebtOffset: refundAmount,
        });
      };

      if (effectiveRefundAmount === 0) {
        const recalculated = await recalculateDebt();
        await tx.customer.update({
          where: { id: debtHolderId },
          data: { totalDebt: recalculated },
        });
        finalDebtSnapshot = recalculated;
      } else {
        // Case 2 (return > debt): refundAmount > originalDebt
        // Bước 2 đã giảm totalDebt bằng toàn bộ refundAmount → có thể đã âm
        // effectiveRefundAmount = phần dư vượt quá debt (cửa hàng nợ khách)

        if (refundType === 'cash_refund') {
          // Hoàn tiền mặt: cộng lại effectiveRefundAmount vì cửa hàng đã chi tiền thật
          // Ví dụ: totalDebt = -20k, chi 20k tiền mặt → debt = 0 (đã giải quyết xong)
          actualCashRefund = effectiveRefundAmount;

          await tx.customer.update({
            where: { id: debtHolderId },
            data: { totalDebt: { increment: effectiveRefundAmount } },
          });

          const updatedDebtHolder = await tx.customer.findUnique({
            where: { id: debtHolderId },
            select: { totalDebt: true },
          });
          finalDebtSnapshot = Number(updatedDebtHolder?.totalDebt || 0);

          const cashFlowCode = await this.generateSafePCCode(tx);
          const createdCashFlow = await tx.cashFlow.create({
            data: {
              code: cashFlowCode,
              branchId: returnOrder.branchId,
              isReceipt: false,
              amount: actualCashRefund,
              transDate: new Date(),
              method: dto.method || 'cash',
              accountId: dto.accountId || null,
              partnerType: 'C',
              cashFlowGroupId: 7,
              contactNumber: returnOrder.customer?.contactNumber,
              address: returnOrder.customer?.addresses?.[0]?.address || null,
              partnerId: returnOrder.customerId,
              partnerName: returnOrder.customer?.name,
              description: `Chi hoàn tiền trả hàng ${returnOrder.code}`,
              status: 0,
              statusValue: 'Đã chi',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: finalDebtSnapshot,
            },
          });
          // Đối xứng `supplier-returns.service.ts:734-754`: lưu cashFlowId
          // vào ReturnOrder để cancel/audit có thể tra cứu chính xác
          // CashFlow gốc thay vì phải match qua `code` (schema có FK).
          refundCashFlowId = createdCashFlow.id;
        } else {
          // debt_offset: cửa hàng CHƯA chi tiền thật
          // Không increment totalDebt → giữ nguyên mức âm (cửa hàng vẫn nợ khách)
          // Ví dụ: totalDebt = -20k sau bước 2, chọn debt_offset → vẫn = -20k
          const debtHolder = await tx.customer.findUnique({
            where: { id: debtHolderId },
            select: { totalDebt: true },
          });
          finalDebtSnapshot = Number(debtHolder?.totalDebt || 0);
          // totalDebt KHÔNG thay đổi
        }
      }

      await tx.returnOrder.update({
        where: { id },
        data: {
          status: RETURN_ORDER_STATUS.COMPLETED,
          statusValue:
            RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.COMPLETED],
          refundedAmount: actualCashRefund,
          refundType,
          refundConfirmedBy: userId,
          refundConfirmedByName: user?.name || 'System',
          refundConfirmedAt: new Date(),
          customerDebtSnapshot: finalDebtSnapshot,
          note: dto.note || returnOrder.note,
          ...(refundCashFlowId ? { cashFlowId: refundCashFlowId } : {}),
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'RETURN_ORDER_REFUND_CONFIRMED',
        entityType: 'return_orders',
        entityId: id.toString(),
        entityCode: returnOrder.code,
        category: 'return_order',
        severity: 'info',
        snapshot: {
          code: returnOrder.code,
          refundAmount,
          effectiveRefundAmount,
          refundType,
          actualCashRefund,
          customerName: returnOrder.customer?.name || 'N/A',
        },
        message: `${refundType === 'debt_offset' ? 'Cấn trừ công nợ' : 'Xác nhận hoàn tiền'} trả hàng ${returnOrder.code}`,
        messageTemplate: 'RETURN_ORDER_REFUND_CONFIRMED',
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });
  }

  async cancel(id: number, userId: number, roles: string[] = []) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          details: true,
          invoice: { select: { id: true, debtAmount: true, grandTotal: true } },
          branch: { select: { name: true } },
          customer: {
            select: { id: true, totalDebt: true, name: true },
          },
        },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      // Fetch người thực hiện sớm để ghi userId/createdByName vào InventoryLog
      // đảo chiều khi hủy (truy vết ai rollback kho).
      const cancelUser = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const returnCancelLogActor = buildInventoryLogActor(
        userId,
        cancelUser?.name || cancelUser?.email,
      );

      // Chỉ Admin/Super Admin mới được hủy phiếu đã hoàn thành (status 4).
      // Các role khác vẫn bị chặn như cũ.
      const isAdmin = roles.some((r) => r === 'Super Admin' || r === 'Admin');
      const wasCompleted = returnOrder.status === RETURN_ORDER_STATUS.COMPLETED;

      if (wasCompleted && !isAdmin) {
        throw new BadRequestException(
          'Không thể hủy phiếu trả hàng đã hoàn thành',
        );
      }

      if (returnOrder.status === RETURN_ORDER_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu trả hàng đã bị hủy');
      }

      // Rollback tồn kho: kho được cộng từ bước 2 (confirm-stock) nên cả phiếu ở
      // STOCK_RECEIVED (2) lẫn COMPLETED (4) đều cần trừ lại đúng số đã cộng.
      const stockWasIncreased =
        returnOrder.status === RETURN_ORDER_STATUS.STOCK_RECEIVED ||
        wasCompleted;

      if (stockWasIncreased) {
        for (const detail of returnOrder.details) {
          const confirmedQty = Number(detail.confirmedQuantity);
          if (confirmedQty > 0) {
            // KHÔNG trừ tay cột bucket ở đây. Phiếu chuyển sang CANCELLED nên
            // active-finder 'return_order' (status != 5) tự loại mọi
            // StockConditionLog của phiếu → recalcConditionBucketsForPairs bên
            // dưới đưa bucket về đúng Σ log active. Trừ tay sẽ trừ hai lần.
            const rollbackData: any = {
              onHand: { decrement: confirmedQty },
            };

            await tx.inventory.update({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: returnOrder.branchId,
                },
              },
              data: rollbackData,
            });
            touchedProductIds.add(detail.productId);

            // Ghi InventoryLog đảo chiều để thẻ kho khớp với việc rollback.
            await tx.inventoryLog.create({
              data: {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: detail.productName,
                branchId: returnOrder.branchId,
                branchName: returnOrder.branch?.name || '',
                transactionType: 'RETURN_CANCEL',
                refCode: returnOrder.code,
                refType: 'return_order',
                refId: returnOrder.id,
                quantity: -confirmedQty,
                costPrice: 0,
                transactionPrice: Number(detail.returnPrice),
                partnerId: returnOrder.customerId || null,
                partnerName: returnOrder.customer?.name || null,
                note: 'Hủy phiếu trả hàng',
                ...buildInventoryLogBase(returnCancelLogActor),
              },
            });
          }
        }

        // Khôi phục công nợ hóa đơn: bước 2 đã giảm debtAmount bằng refundAmount.
        // Cộng lại (cap theo grandTotal) và set lại trạng thái hóa đơn.
        const refundAmount = Number(returnOrder.refundAmount || 0);
        if (returnOrder.invoice && refundAmount > 0) {
          const restoredDebt = Math.min(
            Number(returnOrder.invoice.grandTotal),
            Number(returnOrder.invoice.debtAmount) + refundAmount,
          );

          // Hủy trả hàng KHÔNG được đổi trạng thái giao vận vốn có của hóa đơn.
          // Chỉ khôi phục công nợ; và chỉ nâng lên "Hoàn thành" khi công nợ về 0.
          const invoiceUpdate: {
            debtAmount: number;
            status?: number;
            statusValue?: string;
          } = {
            debtAmount: restoredDebt,
          };
          if (restoredDebt <= 0) {
            invoiceUpdate.status = INVOICE_STATUS.COMPLETED;
            invoiceUpdate.statusValue =
              INVOICE_STATUS_LABELS[INVOICE_STATUS.COMPLETED];
          }

          await tx.invoice.update({
            where: { id: returnOrder.invoice.id },
            data: invoiceUpdate,
          });
        }
      }

      // Hủy mềm phiếu chi hoàn tiền (chỉ có khi refundType = cash_refund ở bước 4).
      // Giữ bản ghi để lưu vết, đánh dấu Đã hủy + loại khỏi báo cáo tài chính.
      // Formula A lọc cashFlow status != 2 nên recalc bên dưới sẽ ra số đúng.
      if (wasCompleted && returnOrder.cashFlowId) {
        await tx.cashFlow.update({
          where: { id: returnOrder.cashFlowId },
          data: {
            status: 2,
            statusValue: 'Đã hủy',
            usedForFinancialReporting: 0,
          },
        });
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      await tx.returnOrder.update({
        where: { id },
        data: {
          status: RETURN_ORDER_STATUS.CANCELLED,
          statusValue:
            RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.CANCELLED],
        },
      });

      // NGUỒN CHÂN LÝ: RO đã CANCELLED (status=5) → mọi log RETURN/RETURN_CANCEL
      // trỏ refId này thành inactive → recalc đưa onHand về Σ log active.
      if (stockWasIncreased && returnOrder.branchId) {
        await recalcOnHandForPairs(
          tx,
          returnOrder.details.map((d) => ({
            productId: d.productId,
            branchId: returnOrder.branchId,
          })),
        );
        // Tương tự cho 3 bucket: log điều kiện của phiếu đã inactive →
        // recalc kéo cache về đúng sổ cái.
        await recalcConditionBucketsForPairs(
          tx,
          returnOrder.details.map((d) => ({
            productId: d.productId,
            branchId: returnOrder.branchId,
          })),
        );
      }

      // RO chuyển sang status 5 → tự loại khỏi debtOffsets của Formula A.
      // CashFlow chi đã status=2 → loại khỏi totalCashFlowPaidOut. Recalc khôi phục đúng nợ.
      if (returnOrder.customerId) {
        await recalcCustomerDebt(tx, returnOrder.customerId);
      }

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'RETURN_ORDER_CANCEL',
        entityType: 'return_orders',
        entityId: id.toString(),
        entityCode: returnOrder.code,
        category: 'return_order',
        severity: 'warning',
        snapshot: {
          code: returnOrder.code,
          previousStatus: returnOrder.status,
          cancelledAfterCompleted: wasCompleted,
          refundType: returnOrder.refundType,
          cashFlowId: returnOrder.cashFlowId,
        },
        message: wasCompleted
          ? `Hủy phiếu trả hàng đã hoàn thành ${returnOrder.code}`
          : `Hủy phiếu trả hàng ${returnOrder.code}`,
        messageTemplate: 'RETURN_ORDER_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async updateStep1(id: number, dto: UpdateStep1Dto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: { details: true },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      if (
        returnOrder.status !== RETURN_ORDER_STATUS.REQUEST_DRAFT &&
        returnOrder.status !== RETURN_ORDER_STATUS.REQUEST
      ) {
        throw new BadRequestException(
          'Phiếu trả hàng không ở trạng thái cho phép chỉnh sửa bước 1',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      // Cập nhật từng detail
      for (const d of dto.details) {
        const detail = returnOrder.details.find((x) => x.id === d.detailId);
        if (!detail) {
          throw new BadRequestException(
            `Không tìm thấy chi tiết trả hàng ID ${d.detailId}`,
          );
        }

        const saleGood = d.saleGoodQuantity || 0;
        const saleDamaged = d.saleDamagedQuantity || 0;
        const saleNearExpiry = d.saleNearExpiryQuantity || 0;
        const saleTotal = saleGood + saleDamaged + saleNearExpiry;

        if (saleTotal > d.requestQuantity) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Tổng phân loại (${saleTotal}) vượt quá SL trả (${d.requestQuantity})`,
          );
        }

        const returnPrice =
          d.returnPrice !== undefined && d.returnPrice !== null
            ? d.returnPrice
            : Number(detail.returnPrice);

        await tx.returnOrderDetail.update({
          where: { id: d.detailId },
          data: {
            requestQuantity: d.requestQuantity,
            returnPrice,
            totalAmount: returnPrice * d.requestQuantity,
            saleGoodQuantity: saleGood,
            saleDamagedQuantity: saleDamaged,
            saleNearExpiryQuantity: saleNearExpiry,
            note: d.note ?? detail.note,
          },
        });
      }

      // Tính lại totalReturnAmount
      const updatedDetails = await tx.returnOrderDetail.findMany({
        where: { returnOrderId: id },
      });
      const totalReturnAmount = updatedDetails.reduce(
        (sum, d) => sum + Number(d.totalAmount),
        0,
      );

      const newStatus = dto.isDraft
        ? RETURN_ORDER_STATUS.REQUEST_DRAFT
        : RETURN_ORDER_STATUS.REQUEST;

      await tx.returnOrder.update({
        where: { id },
        data: {
          status: newStatus,
          statusValue: RETURN_ORDER_STATUS_LABELS[newStatus],
          totalReturnAmount,
          note: dto.note ?? returnOrder.note,
          images: dto.images ? JSON.stringify(dto.images) : returnOrder.images,
        },
      });

      const actionCode = dto.isDraft
        ? 'RETURN_ORDER_REQUEST_DRAFT'
        : 'RETURN_ORDER_REQUEST_COMPLETE';

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode,
        entityType: 'return_orders',
        entityId: id.toString(),
        entityCode: returnOrder.code,
        category: 'return_order',
        severity: 'info',
        snapshot: { code: returnOrder.code, totalReturnAmount },
        message: dto.isDraft
          ? `Lưu phiếu tạm bước 1 trả hàng ${returnOrder.code}`
          : `Hoàn thành bước 1 trả hàng ${returnOrder.code}`,
        messageTemplate: actionCode,
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });
  }

  private async generateSafePCCode(tx: any): Promise<string> {
    const prefix = 'PC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);

    const allCashFlows = await tx.cashFlow.findMany({
      where: { code: { startsWith: prefix }, isReceipt: false },
      select: { code: true },
    });

    const numbers = allCashFlows
      .map((cf: any) => cf.code)
      .filter((code: string) => regex.test(code))
      .map((code: string) => parseInt(code.replace(prefix, ''), 10));

    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    const code = `${prefix}${String(maxNumber + 1).padStart(6, '0')}`;

    const exists = await tx.cashFlow.findFirst({ where: { code } });
    if (exists) throw new Error('Không thể tạo mã phiếu chi duy nhất');

    return code;
  }
}
