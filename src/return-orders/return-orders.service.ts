import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
import { searchCustomerIds } from '../common/customer-search.util';

@Injectable()
export class ReturnOrdersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  private async generateCode(tx: any): Promise<string> {
    const lastReturn = await tx.returnOrder.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = lastReturn ? lastReturn.id + 1 : 1;
    return `TH${nextId.toString().padStart(6, '0')}`;
  }

  async findAll(query: ReturnOrderQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.search) {
      const matchedIds = await searchCustomerIds(this.prisma, query.search);
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { invoice: { code: { contains: query.search, mode: 'insensitive' } } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    if (query.branchId) where.branchId = query.branchId;
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.createdBy) where.createdBy = query.createdBy;
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
    return this.prisma.$transaction(async (tx) => {
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

      const returnedQuantities: Record<string, number> = {};
      existingReturns.forEach((ro) => {
        ro.details.forEach((d) => {
          const key = `${d.invoiceId}-${d.productId}`;
          returnedQuantities[key] =
            (returnedQuantities[key] || 0) + Number(d.requestQuantity);
        });
      });

      for (const detail of dto.details) {
        const invoice = invoiceMap.get(detail.invoiceId);
        if (!invoice) {
          throw new BadRequestException(
            `Hóa đơn ${detail.invoiceCode} không tồn tại`,
          );
        }

        const invoiceDetail = invoice.details.find(
          (d) => d.productId === detail.productId,
        );
        if (!invoiceDetail) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productCode} không có trong hóa đơn ${detail.invoiceCode}`,
          );
        }

        const key = `${detail.invoiceId}-${detail.productId}`;
        const alreadyReturned = returnedQuantities[key] || 0;
        const maxReturnable = Number(invoiceDetail.quantity) - alreadyReturned;

        if (detail.requestQuantity > maxReturnable) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName} (HĐ ${detail.invoiceCode}): Số lượng trả (${detail.requestQuantity}) vượt quá còn lại (${maxReturnable})`,
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
          const snapshot = (log.rewardSnapshot as any) || {};
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
    return this.prisma.$transaction(async (tx) => {
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
              ...(damagedQty > 0 && {
                damagedQuantity: { increment: damagedQty },
              }),
              ...(nearExpiryQty > 0 && {
                nearExpiryQuantity: { increment: nearExpiryQty },
              }),
            },
            create: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: returnOrder.branchId,
              branchName: branch?.name || '',
              onHand: totalConfirmed,
              damagedQuantity: damagedQty,
              nearExpiryQuantity: nearExpiryQty,
            },
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
            },
          });
        }
      }

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
          const invoiceStatus = newDebtAmount <= 0 ? 1 : 3;

          await tx.invoice.update({
            where: { id: returnOrder.invoiceId },
            data: {
              debtAmount: newDebtAmount,
              status: invoiceStatus,
              statusValue:
                invoiceStatus === 1 ? 'Hoàn thành' : 'Thanh toán một phần',
            },
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
        },
        message: `Xác nhận nhập hàng trả ${returnOrder.code}`,
        messageTemplate: 'RETURN_ORDER_STOCK_RECEIVED',
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });
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

  async cancel(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          details: true,
          customer: {
            select: { id: true, totalDebt: true },
          },
        },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      if (returnOrder.status === RETURN_ORDER_STATUS.COMPLETED) {
        throw new BadRequestException(
          'Không thể hủy phiếu trả hàng đã hoàn thành',
        );
      }

      if (returnOrder.status === RETURN_ORDER_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu trả hàng đã bị hủy');
      }

      if (returnOrder.status === RETURN_ORDER_STATUS.STOCK_RECEIVED) {
        for (const detail of returnOrder.details) {
          const confirmedQty = Number(detail.confirmedQuantity);
          if (confirmedQty > 0) {
            const rollbackData: any = {
              onHand: { decrement: confirmedQty },
            };

            const damagedQty = Number(detail.damagedQuantity || 0);
            const nearExpiryQty = Number(detail.nearExpiryQuantity || 0);

            if (damagedQty > 0) {
              rollbackData.damagedQuantity = { decrement: damagedQty };
            }
            if (nearExpiryQty > 0) {
              rollbackData.nearExpiryQuantity = { decrement: nearExpiryQty };
            }

            await tx.inventory.update({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: returnOrder.branchId,
                },
              },
              data: rollbackData,
            });
          }
        }
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
        snapshot: { code: returnOrder.code },
        message: `Hủy phiếu trả hàng ${returnOrder.code}`,
        messageTemplate: 'RETURN_ORDER_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: returnOrder.branchId,
      });

      return this.findOne(id);
    });
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
