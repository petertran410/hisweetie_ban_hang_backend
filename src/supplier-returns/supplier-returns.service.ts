import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  CreateSupplierReturnDto,
  ConfirmExportDto,
  ConfirmRefundDto,
  SupplierReturnQueryDto,
  SUPPLIER_RETURN_STATUS,
  SUPPLIER_RETURN_STATUS_LABELS,
} from './dto';

@Injectable()
export class SupplierReturnsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async generateCode(tx: any): Promise<string> {
    const last = await tx.supplierReturn.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = last ? last.id + 1 : 1;
    return `THN${nextId.toString().padStart(6, '0')}`;
  }

  private async generateCashFlowCode(
    isReceipt: boolean,
    tx: any,
  ): Promise<string> {
    const prefix = isReceipt ? 'TT' : 'PC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);

    const allCF = await tx.cashFlow.findMany({
      where: { code: { startsWith: prefix }, isReceipt },
      select: { code: true },
    });

    const numbers = allCF
      .map((cf: any) => cf.code)
      .filter((code: string) => regex.test(code))
      .map((code: string) => parseInt(code.replace(prefix, ''), 10));

    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    return `${prefix}${String(maxNumber + 1).padStart(6, '0')}`;
  }

  /**
   * Tái tính Supplier.debt — bao gồm cả supplier returns theo mode by_product.
   * Formula:
   *   debt = SUM(po.total - po.discount - po.paidAmount)   [phiếu nhập không draft]
   *        - SUM(orderSupplierPayment.amount)               [đặt hàng đã ứng trước]
   *        - SUM(supplierReturn.refundedAmount)              [trả hàng by_product đã hoàn thành]
   */
  private async updateSupplierDebt(supplierId: number, tx: any) {
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId, isDraft: false },
    });

    const debtFromPurchases = purchaseOrders.reduce((sum: number, po: any) => {
      return (
        sum + (Number(po.total) - Number(po.discount) - Number(po.paidAmount))
      );
    }, 0);

    const orderSuppliers = await tx.orderSupplier.findMany({
      where: { supplierId },
      include: { payments: true },
    });

    const debtFromOrders = orderSuppliers.reduce((sum: number, os: any) => {
      const paid = os.payments.reduce(
        (s: number, p: any) => s + Number(p.amount),
        0,
      );
      return sum + paid;
    }, 0);

    // Trả hàng nhập theo sản phẩm lẻ (by_product) đã hoàn thành
    // → cả debt_offset lẫn cash_refund đều giảm nợ NCC
    const byProductReturns = await tx.supplierReturn.aggregate({
      where: {
        supplierId,
        mode: 'by_product',
        status: SUPPLIER_RETURN_STATUS.COMPLETED,
      },
      _sum: { refundedAmount: true },
    });

    const debtFromByProductReturns = Number(
      byProductReturns._sum.refundedAmount || 0,
    );

    const totalDebt =
      debtFromPurchases - debtFromOrders - debtFromByProductReturns;

    await tx.supplier.update({
      where: { id: supplierId },
      data: { debt: totalDebt },
    });
  }

  // ─── findAll ─────────────────────────────────────────────────────────────────

  async findAll(query: SupplierReturnQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        {
          supplier: { name: { contains: query.search, mode: 'insensitive' } },
        },
      ];
    }

    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.branchId) where.branchId = query.branchId;
    if (query.status) where.status = query.status;
    if (query.mode) where.mode = query.mode;
    if (query.refundType) where.refundType = query.refundType;
    if (query.createdBy) where.createdBy = query.createdBy;

    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    const [data, total] = await Promise.all([
      this.prisma.supplierReturn.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, code: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.supplierReturn.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  // ─── findOne ─────────────────────────────────────────────────────────────────

  async findOne(id: number) {
    const record = await this.prisma.supplierReturn.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, code: true } },
        creator: { select: { id: true, name: true } },
        exporter: { select: { id: true, name: true } },
        refundConfirmer: { select: { id: true, name: true } },
        cashFlow: { select: { id: true, code: true, amount: true } },
        details: {
          include: {
            product: {
              select: { id: true, code: true, name: true, images: true },
            },
          },
        },
      },
    });

    if (!record)
      throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');
    return record;
  }

  // ─── create (Bước 1) ─────────────────────────────────────────────────────────

  async create(dto: CreateSupplierReturnDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      // ── Validate nhà cung cấp ────────────────────────────────────────────
      const supplier = await tx.supplier.findUnique({
        where: { id: dto.supplierId },
      });
      if (!supplier) throw new NotFoundException('Không tìm thấy nhà cung cấp');

      // ── Validate theo mode ───────────────────────────────────────────────
      if (dto.mode === 'by_purchase_order') {
        if (!dto.purchaseOrderId) {
          throw new BadRequestException(
            'Mode by_purchase_order yêu cầu purchaseOrderId',
          );
        }

        const po = await tx.purchaseOrder.findUnique({
          where: { id: dto.purchaseOrderId },
          include: { items: true },
        });

        if (!po) throw new NotFoundException('Không tìm thấy phiếu nhập hàng');
        if (po.isDraft || po.status === 0) {
          throw new BadRequestException(
            'Phiếu nhập hàng phải ở trạng thái hoàn thành',
          );
        }
        if (po.supplierId !== dto.supplierId) {
          throw new BadRequestException(
            'Phiếu nhập hàng không thuộc nhà cung cấp này',
          );
        }

        // Lấy số lượng đã trả trước đó (không tính phiếu bị hủy)
        const existingReturns = await tx.supplierReturn.findMany({
          where: {
            purchaseOrderId: dto.purchaseOrderId,
            status: { not: SUPPLIER_RETURN_STATUS.CANCELLED },
          },
          include: { details: true },
        });

        const returnedQtyMap = new Map<number, number>();
        existingReturns.forEach((sr) => {
          sr.details.forEach((d) => {
            const prev = returnedQtyMap.get(d.productId) || 0;
            returnedQtyMap.set(d.productId, prev + Number(d.requestQuantity));
          });
        });

        const poItemMap = new Map(po.items.map((i: any) => [i.productId, i]));

        for (const detail of dto.details) {
          const poItem = poItemMap.get(detail.productId);
          if (!poItem) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productCode} không có trong phiếu nhập`,
            );
          }

          const alreadyReturned = returnedQtyMap.get(detail.productId) || 0;
          const maxReturnable = Number(poItem.quantity) - alreadyReturned;

          if (detail.requestQuantity > maxReturnable) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá có thể trả (${maxReturnable})`,
            );
          }
        }
      } else {
        // by_product — validate theo onHand
        for (const detail of dto.details) {
          const inv = await tx.inventory.findFirst({
            where: { productId: detail.productId, branchId: dto.branchId },
          });

          const onHand = Number(inv?.onHand || 0);
          if (detail.requestQuantity > onHand) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá tồn kho (${onHand})`,
            );
          }
        }
      }

      // ── Tạo phiếu ───────────────────────────────────────────────────────
      const code = await this.generateCode(tx);

      const detailsData = dto.details.map((d) => ({
        purchaseOrderId: d.purchaseOrderId || dto.purchaseOrderId || null,
        purchaseOrderCode: d.purchaseOrderCode || null,
        productId: d.productId,
        productCode: d.productCode,
        productName: d.productName,
        purchaseQuantity: d.purchaseQuantity,
        purchasePrice: d.purchasePrice,
        requestQuantity: d.requestQuantity,
        confirmedQuantity: 0,
        returnPrice: d.returnPrice,
        totalAmount: d.returnPrice * d.requestQuantity,
        note: d.note,
      }));

      const totalReturnAmount = detailsData.reduce(
        (sum, d) => sum + d.totalAmount,
        0,
      );

      const status = dto.isDraft
        ? SUPPLIER_RETURN_STATUS.DRAFT
        : SUPPLIER_RETURN_STATUS.REQUEST;

      const supplierReturn = await tx.supplierReturn.create({
        data: {
          code,
          mode: dto.mode,
          purchaseOrderId: dto.purchaseOrderId || null,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          status,
          statusValue: SUPPLIER_RETURN_STATUS_LABELS[status],
          totalReturnAmount,
          note: dto.note,
          createdBy: userId,
          createdByName: user?.name || 'System',
          images: dto.images ? JSON.stringify(dto.images) : null,
          details: { create: detailsData },
        },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
          details: true,
        },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'SUPPLIER_RETURN_CREATE',
        entityType: 'supplier_returns',
        entityId: supplierReturn.id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: {
          code: supplierReturn.code,
          mode: dto.mode,
          supplierName: supplier.name,
          totalReturnAmount,
          status: SUPPLIER_RETURN_STATUS_LABELS[status],
        },
        message: `Tạo phiếu trả hàng nhập ${supplierReturn.code} cho NCC ${supplier.name}`,
        messageTemplate: 'SUPPLIER_RETURN_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.branchId,
      });

      return supplierReturn;
    });
  }

  // ─── confirmExport (Bước 2) ──────────────────────────────────────────────────

  async confirmExport(id: number, dto: ConfirmExportDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: {
          details: true,
          supplier: { select: { id: true, name: true, contactNumber: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (
        supplierReturn.status !== SUPPLIER_RETURN_STATUS.REQUEST &&
        supplierReturn.status !== SUPPLIER_RETURN_STATUS.DRAFT
      ) {
        throw new BadRequestException(
          'Phiếu trả hàng không ở trạng thái cho phép xuất kho',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      if (dto.isDraft) {
        await tx.supplierReturn.update({
          where: { id },
          data: {
            status: SUPPLIER_RETURN_STATUS.DRAFT,
            statusValue:
              SUPPLIER_RETURN_STATUS_LABELS[SUPPLIER_RETURN_STATUS.DRAFT],
          },
        });
        return this.findOne(id);
      }

      // ── Xử lý từng detail ────────────────────────────────────────────────
      for (const confirmDetail of dto.details) {
        const detail = supplierReturn.details.find(
          (d) => d.id === confirmDetail.detailId,
        );
        if (!detail) continue;

        const confirmedQty = confirmDetail.confirmedQuantity;
        if (confirmedQty <= 0) continue;

        // Validate tồn kho đủ để xuất
        const inv = await tx.inventory.findFirst({
          where: {
            productId: detail.productId,
            branchId: supplierReturn.branchId,
          },
        });

        if (!inv || Number(inv.onHand) < confirmedQty) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Tồn kho không đủ để xuất (cần ${confirmedQty}, còn ${inv ? Number(inv.onHand) : 0})`,
          );
        }

        // Giảm tồn kho
        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: supplierReturn.branchId,
            },
          },
          data: { onHand: { decrement: confirmedQty } },
        });

        // Ghi InventoryLog
        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: supplierReturn.branchId,
            branchName: supplierReturn.branch?.name || '',
            transactionType: 'SUPPLIER_RETURN',
            refCode: supplierReturn.code,
            refType: 'supplier_return',
            refId: supplierReturn.id,
            quantity: -confirmedQty,
            costPrice: Number(inv.cost || 0),
            transactionPrice: Number(detail.returnPrice),
            partnerId: supplierReturn.supplierId,
            partnerName: supplierReturn.supplier?.name || null,
          },
        });

        // Cập nhật confirmedQuantity trên detail
        await tx.supplierReturnDetail.update({
          where: { id: detail.id },
          data: { confirmedQuantity: confirmedQty },
        });
      }

      // ── Tính refundAmount ─────────────────────────────────────────────────
      const updatedDetails = await tx.supplierReturnDetail.findMany({
        where: { supplierReturnId: id },
      });

      const refundAmount = updatedDetails.reduce(
        (sum, d) => sum + Number(d.confirmedQuantity) * Number(d.returnPrice),
        0,
      );

      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.STOCK_EXPORTED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[
              SUPPLIER_RETURN_STATUS.STOCK_EXPORTED
            ],
          refundAmount,
          exportedById: userId,
          exportedByName: user?.name || 'System',
          exportedAt: new Date(),
          note: dto.note ?? supplierReturn.note,
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_STOCK_EXPORTED',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: { code: supplierReturn.code, refundAmount },
        message: `Xác nhận xuất kho phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_STOCK_EXPORTED',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });
  }

  // ─── confirmRefund (Bước 3) ──────────────────────────────────────────────────

  async confirmRefund(id: number, dto: ConfirmRefundDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: {
          details: true,
          supplier: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
            },
          },
          branch: { select: { id: true, name: true } },
          purchaseOrder: {
            select: {
              id: true,
              code: true,
              paidAmount: true,
              total: true,
              discount: true,
            },
          },
        },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (supplierReturn.status !== SUPPLIER_RETURN_STATUS.STOCK_EXPORTED) {
        throw new BadRequestException(
          'Phiếu trả hàng phải ở trạng thái Đã xuất kho',
        );
      }

      if (
        supplierReturn.mode === 'by_product' &&
        dto.refundType === 'debt_offset' &&
        false // bỏ block này vì by_product + debt_offset đã được cho phép
      ) {
        throw new BadRequestException(
          'Trả hàng theo sản phẩm lẻ không hỗ trợ cấn trừ nợ theo phiếu nhập',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      const refundAmount = Number(supplierReturn.refundAmount);
      let cashFlowId: number | null = null;

      // ── Nhánh debt_offset ────────────────────────────────────────────────
      if (dto.refundType === 'debt_offset') {
        if (
          supplierReturn.mode === 'by_purchase_order' &&
          supplierReturn.purchaseOrder
        ) {
          // Tăng paidAmount trên PO gốc → updateSupplierDebt tự recalculate
          const po = supplierReturn.purchaseOrder;
          const newPaidAmount = Number(po.paidAmount) + refundAmount;
          const subTotal = Number(po.total) - Number(po.discount);
          const newDebtAmount = Math.max(0, subTotal - newPaidAmount);

          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: {
              paidAmount: newPaidAmount,
              debtAmount: newDebtAmount,
            },
          });
        }
        // by_product: updateSupplierDebt sẽ tự tính qua supplierReturn.refundedAmount

        // ── Nhánh cash_refund ────────────────────────────────────────────────
      } else if (dto.refundType === 'cash_refund') {
        const cfCode = await this.generateCashFlowCode(true, tx);

        const cashFlow = await tx.cashFlow.create({
          data: {
            code: cfCode,
            branchId: supplierReturn.branchId,
            isReceipt: true,
            amount: refundAmount,
            transDate: new Date(),
            method: dto.method || 'cash',
            accountId: dto.accountId || null,
            partnerType: 'S',
            partnerId: supplierReturn.supplierId,
            partnerName: supplierReturn.supplier?.name,
            contactNumber: supplierReturn.supplier?.contactNumber,
            address: supplierReturn.supplier?.address,
            cashFlowGroupId: dto.cashFlowGroupId || 8,
            description: `Thu tiền trả hàng nhập ${supplierReturn.code}`,
            status: 0,
            statusValue: 'Đã thu',
            createdBy: userId,
            usedForFinancialReporting: 1,
          },
        });
        cashFlowId = cashFlow.id;
      }

      // ── Cập nhật Supplier.debt ────────────────────────────────────────────
      await this.updateSupplierDebt(supplierReturn.supplierId, tx);

      // ── Cập nhật trạng thái phiếu ─────────────────────────────────────────
      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.COMPLETED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[SUPPLIER_RETURN_STATUS.COMPLETED],
          refundType: dto.refundType,
          refundedAmount: refundAmount,
          refundConfirmedBy: userId,
          refundConfirmedByName: user?.name || 'System',
          refundConfirmedAt: new Date(),
          ...(cashFlowId && { cashFlowId }),
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_REFUND_CONFIRMED',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: {
          code: supplierReturn.code,
          refundType: dto.refundType,
          refundAmount,
        },
        message: `${dto.refundType === 'cash_refund' ? 'Thu tiền' : 'Cấn trừ nợ'} phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_REFUND_CONFIRMED',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });
  }

  // ─── cancel ──────────────────────────────────────────────────────────────────

  async cancel(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: { details: true },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.COMPLETED) {
        throw new BadRequestException(
          'Không thể hủy phiếu trả hàng nhập đã hoàn thành',
        );
      }

      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu trả hàng nhập đã bị hủy');
      }

      // Rollback tồn kho nếu đã xuất kho
      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.STOCK_EXPORTED) {
        for (const detail of supplierReturn.details) {
          const confirmedQty = Number(detail.confirmedQuantity);
          if (confirmedQty <= 0) continue;

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: supplierReturn.branchId,
              },
            },
            data: { onHand: { increment: confirmedQty } },
          });
        }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.CANCELLED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[SUPPLIER_RETURN_STATUS.CANCELLED],
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_CANCEL',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'warning',
        snapshot: { code: supplierReturn.code },
        message: `Hủy phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });
  }
}
