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
} from './dto';

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
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { invoice: { code: { contains: query.search, mode: 'insensitive' } } },
        {
          customer: { name: { contains: query.search, mode: 'insensitive' } },
        },
      ];
    }

    if (query.branchId) where.branchId = query.branchId;
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.createdBy) where.createdBy = query.createdBy;
    if (query.invoiceId) where.invoiceId = query.invoiceId;

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
      const invoice = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: {
          details: true,
          customer: { select: { id: true, parentId: true, name: true } },
        },
      });

      if (!invoice) {
        throw new NotFoundException('Không tìm thấy hóa đơn');
      }

      const existingReturns = await tx.returnOrder.findMany({
        where: {
          invoiceId: dto.invoiceId,
          status: { notIn: [RETURN_ORDER_STATUS.CANCELLED] },
        },
        include: { details: true },
      });

      const returnedQuantities: Record<number, number> = {};
      existingReturns.forEach((ro) => {
        ro.details.forEach((d) => {
          returnedQuantities[d.productId] =
            (returnedQuantities[d.productId] || 0) + Number(d.requestQuantity);
        });
      });

      for (const detail of dto.details) {
        const invoiceDetail = invoice.details.find(
          (d) => d.productId === detail.productId,
        );
        if (!invoiceDetail) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productCode} không có trong hóa đơn`,
          );
        }

        const alreadyReturned = returnedQuantities[detail.productId] || 0;
        const maxReturnable = Number(invoiceDetail.quantity) - alreadyReturned;

        if (detail.requestQuantity > maxReturnable) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá số lượng còn lại (${maxReturnable})`,
          );
        }
      }

      const code = await this.generateCode(tx);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      const detailsData = dto.details.map((d) => {
        const returnPrice =
          d.returnPrice !== undefined && d.returnPrice !== null
            ? d.returnPrice
            : d.invoicePrice;
        return {
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
        };
      });

      const totalReturnAmount = detailsData.reduce(
        (sum, d) => sum + d.totalAmount,
        0,
      );

      const returnOrder = await tx.returnOrder.create({
        data: {
          code,
          invoiceId: dto.invoiceId,
          customerId: invoice.customerId,
          parentCustomerId: invoice.customer?.parentId || null,
          branchId: dto.branchId,
          status: RETURN_ORDER_STATUS.REQUEST,
          statusValue: RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.REQUEST],
          totalReturnAmount,
          note: dto.note,
          createdBy: userId,
          createdByName: user?.name || 'System',
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
          invoiceCode: returnOrder.invoice.code,
          customerName: returnOrder.customer?.name || 'N/A',
          branchName: returnOrder.branch.name,
          totalReturnAmount: Number(returnOrder.totalReturnAmount),
          status: returnOrder.statusValue,
          details: detailsData.map((d) => ({
            productCode: d.productCode,
            productName: d.productName,
            requestQuantity: d.requestQuantity,
            returnPrice: d.returnPrice,
            totalAmount: d.totalAmount,
          })),
        },
        message: `Tạo phiếu trả hàng ${returnOrder.code} từ hóa đơn ${returnOrder.invoice.code}`,
        messageTemplate: 'RETURN_ORDER_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.branchId,
      });

      return returnOrder;
    });
  }

  async confirmStockReceived(
    id: number,
    dto: ConfirmStockReceivedDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: { details: true, invoice: { include: { details: true } } },
      });

      if (!returnOrder) {
        throw new NotFoundException('Không tìm thấy phiếu trả hàng');
      }

      if (returnOrder.status !== RETURN_ORDER_STATUS.REQUEST) {
        throw new BadRequestException(
          'Phiếu trả hàng không ở trạng thái yêu cầu',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
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

        if (confirmDetail.confirmedQuantity > Number(detail.requestQuantity)) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Số lượng xác nhận (${confirmDetail.confirmedQuantity}) vượt quá số lượng yêu cầu (${detail.requestQuantity})`,
          );
        }

        await tx.returnOrderDetail.update({
          where: { id: confirmDetail.detailId },
          data: {
            confirmedQuantity: confirmDetail.confirmedQuantity,
            totalAmount:
              confirmDetail.confirmedQuantity * Number(detail.returnPrice),
          },
        });

        if (confirmDetail.confirmedQuantity > 0) {
          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: returnOrder.branchId,
              },
            },
            update: {
              onHand: {
                increment: confirmDetail.confirmedQuantity,
              },
            },
            create: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: returnOrder.branchId,
              branchName: '',
              onHand: confirmDetail.confirmedQuantity,
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

      await tx.returnOrder.update({
        where: { id },
        data: {
          status: RETURN_ORDER_STATUS.STOCK_RECEIVED,
          statusValue:
            RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.STOCK_RECEIVED],
          totalReturnAmount: newTotalReturnAmount,
          refundAmount,
          confirmedBy: userId,
          confirmedByName: user?.name || 'System',
          confirmedAt: new Date(),
          note: dto.note || returnOrder.note,
        },
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
          details: updatedDetails.map((d) => ({
            productCode: d.productCode,
            productName: d.productName,
            requestQuantity: Number(d.requestQuantity),
            confirmedQuantity: Number(d.confirmedQuantity),
            returnPrice: Number(d.returnPrice),
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
  }

  async confirmRefund(id: number, dto: ConfirmRefundDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const returnOrder = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          details: true,
          invoice: true,
          customer: {
            select: { id: true, parentId: true, name: true, totalDebt: true },
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

      if (returnOrder.customerId && refundAmount > 0) {
        const debtHolderId =
          returnOrder.customer?.parentId || returnOrder.customerId;

        const debtHolder = await tx.customer.findUnique({
          where: { id: debtHolderId },
          select: { totalDebt: true },
        });

        const newDebt = Number(debtHolder?.totalDebt || 0) - refundAmount;

        await tx.customer.update({
          where: { id: debtHolderId },
          data: { totalDebt: newDebt },
        });

        const cashFlowCode = `CHI-TH-${returnOrder.code}`;

        await tx.cashFlow.create({
          data: {
            code: cashFlowCode,
            branchId: returnOrder.branchId,
            isReceipt: false,
            amount: refundAmount,
            transDate: new Date(),
            method: dto.method || 'cash',
            accountId: dto.accountId || null,
            partnerType: 'C',
            partnerId: returnOrder.customerId,
            partnerName: returnOrder.customer?.name,
            description: `Chi hoàn tiền trả hàng ${returnOrder.code}`,
            status: 0,
            statusValue: 'Đã chi',
            createdBy: userId,
            usedForFinancialReporting: 1,
            customerDebtSnapshot: newDebt,
          },
        });

        await tx.returnOrder.update({
          where: { id },
          data: {
            status: RETURN_ORDER_STATUS.COMPLETED,
            statusValue:
              RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.COMPLETED],
            refundedAmount: refundAmount,
            refundConfirmedBy: userId,
            refundConfirmedByName: user?.name || 'System',
            refundConfirmedAt: new Date(),
            customerDebtSnapshot: newDebt,
            note: dto.note || returnOrder.note,
          },
        });
      } else {
        await tx.returnOrder.update({
          where: { id },
          data: {
            status: RETURN_ORDER_STATUS.COMPLETED,
            statusValue:
              RETURN_ORDER_STATUS_LABELS[RETURN_ORDER_STATUS.COMPLETED],
            refundedAmount: 0,
            refundConfirmedBy: userId,
            refundConfirmedByName: user?.name || 'System',
            refundConfirmedAt: new Date(),
            note: dto.note || returnOrder.note,
          },
        });
      }

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
          customerName: returnOrder.customer?.name || 'N/A',
        },
        message: `Xác nhận hoàn tiền trả hàng ${returnOrder.code}`,
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
        include: { details: true },
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
          if (Number(detail.confirmedQuantity) > 0) {
            await tx.inventory.update({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: returnOrder.branchId,
                },
              },
              data: {
                onHand: {
                  decrement: Number(detail.confirmedQuantity),
                },
              },
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
}
