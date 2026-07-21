import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

export class CreatePurchaseOrderPaymentDto {
  purchaseOrderId: number;
  amount: number;
  paymentMethod?: string;
  accountId?: number;
  paymentDate?: string;
  notes?: string;
  exchangeRate?: number;
  foreignAmount?: number;
}

@Injectable()
export class PurchaseOrderPaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreatePurchaseOrderPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id: dto.purchaseOrderId },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
              debt: true,
            },
          },
        },
      });

      if (!purchaseOrder) {
        throw new Error('Không tìm thấy phiếu nhập hàng');
      }

      // Đối xứng `invoice-payments.service.ts:71-73`: bắt buộc PO phải có
      // chi nhánh trước khi tạo CashFlow. Tránh fallback `branchId ?? 1`
      // ghi sai chi nhánh tiền chi.
      if (!purchaseOrder.branchId) {
        throw new Error('Phiếu nhập hàng chưa có chi nhánh');
      }

      const isCNY = purchaseOrder.currency === 'CNY';
      if (isCNY) {
        if (
          dto.exchangeRate == null ||
          Number(dto.exchangeRate) <= 0 ||
          dto.foreignAmount == null ||
          Number(dto.foreignAmount) <= 0
        ) {
          throw new Error(
            'Phiếu nhập dùng CNY, vui lòng nhập đủ tỉ giá và số tiền CNY',
          );
        }
        if (
          Math.round(Number(dto.foreignAmount) * Number(dto.exchangeRate)) !==
          dto.amount
        ) {
          throw new Error('Số tiền CNY quy đổi không khớp số tiền VND');
        }
      } else if (dto.exchangeRate != null || dto.foreignAmount != null) {
        throw new Error('Phiếu nhập dùng VND, không được gửi số tiền CNY');
      }

      // Generate payment code PCPN
      const code = await this.generatePaymentCode(tx);

      // Tạo CashFlow TRƯỚC để có id gán vào PurchaseOrderPayment.cashFlowId.
      // Đối xứng `invoice-payments.service.ts:78-117`.
      let cashFlowMethod = 'cash';
      if (dto.paymentMethod === 'transfer') {
        cashFlowMethod = 'transfer';
      } else if (dto.paymentMethod === 'card') {
        cashFlowMethod = 'card';
      }

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: purchaseOrder.branchId,
          cashFlowGroupId: 9,
          isReceipt: false,
          amount: dto.amount,
          currency: isCNY ? 'CNY' : 'VND',
          exchangeRate: isCNY ? Number(dto.exchangeRate) : 1,
          foreignAmount: isCNY ? Number(dto.foreignAmount) : null,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: cashFlowMethod,
          accountId: dto.accountId,
          partnerType: 'S',
          partnerId: purchaseOrder.supplierId,
          partnerName: purchaseOrder.supplier?.name,
          contactNumber: purchaseOrder.supplier?.contactNumber,
          address: purchaseOrder.supplier?.address,
          description:
            dto.notes || `Chi tiền nhập hàng ${purchaseOrder.code} - PCPN`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          supplierDebtSnapshot: null,
        },
      });

      const payment = await tx.purchaseOrderPayment.create({
        data: {
          code,
          purchaseOrderId: dto.purchaseOrderId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.notes || `Trả tiền nhập hàng ${purchaseOrder.code} - PCPN`,
          status: 1,
          statusValue: 'Đã thanh toán',
          cashFlowId: cashFlow.id,
          exchangeRate:
            dto.exchangeRate != null ? Number(dto.exchangeRate) : null,
          foreignAmount:
            dto.foreignAmount != null ? Number(dto.foreignAmount) : null,
        },
      });

      // Recalc cached field paidAmount + debtAmount của PO. Filter status≠2
      // để khi sau này soft-cancel payment, recalc tự đồng bộ.
      await this.recomputePurchaseOrderTotals(dto.purchaseOrderId, tx);

      // Update supplier debt
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      // Snapshot supplier debt vào CashFlow vừa tạo, đối xứng phía bán.
      const updatedSupplier = await tx.supplier.findUnique({
        where: { id: purchaseOrder.supplierId },
        select: { debt: true },
      });
      await tx.cashFlow.update({
        where: { id: cashFlow.id },
        data: {
          supplierDebtSnapshot: updatedSupplier
            ? Number(updatedSupplier.debt)
            : null,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PURCHASE_ORDER_PAYMENT_CREATE',
        entityType: 'purchase_order_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('PURCHASE_ORDER_PAYMENT_CREATE'),
        severity: getSeverityFromActionCode('PURCHASE_ORDER_PAYMENT_CREATE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          purchaseOrder: {
            code: purchaseOrder.code,
            supplier: purchaseOrder.supplier?.name,
          },
        },
        message: renderAuditMessage('PURCHASE_ORDER_PAYMENT_CREATE', {
          paymentCode: payment.code,
          purchaseOrderCode: purchaseOrder.code,
          amount: Number(payment.amount),
        }),
        messageTemplate: 'PURCHASE_ORDER_PAYMENT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: purchaseOrder.branchId || undefined,
      });

      return {
        payment,
        cashFlow,
      };
    });
  }

  async findAllByPurchaseOrder(
    purchaseOrderId: number,
    supplierScope?: number | null,
  ) {
    // Scope NCC: chặn nhân viên NCC xem thanh toán của phiếu NCC khác.
    if (supplierScope != null) {
      const po = await this.prisma.purchaseOrder.findUnique({
        where: { id: purchaseOrderId },
        select: { supplierId: true },
      });
      if (!po || po.supplierId !== supplierScope) {
        throw new ForbiddenException(
          'Không có quyền xem dữ liệu của nhà cung cấp khác',
        );
      }
    }
    return this.prisma.purchaseOrderPayment.findMany({
      where: { purchaseOrderId },
      orderBy: { paymentDate: 'desc' },
    });
  }

  async remove(id: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.purchaseOrderPayment.findUnique({
        where: { id },
        include: {
          purchaseOrder: {
            include: {
              supplier: {
                select: { id: true, name: true, contactNumber: true },
              },
            },
          },
        },
      });

      if (!payment) {
        throw new Error('Không tìm thấy thanh toán');
      }

      // Đối xứng `invoice-payments.service.ts:185-208`: SOFT-cancel CashFlow +
      // Payment, KHÔNG hard-delete. Giữ audit trail và cho phép Formula B
      // recalc đúng (filter status≠2). Ưu tiên match qua FK `cashFlowId`,
      // fallback theo `code`.
      const orConditions: any[] = [];
      if (payment.cashFlowId != null) {
        orConditions.push({ id: payment.cashFlowId });
      }
      if (payment.code) {
        orConditions.push({ code: payment.code });
      }
      if (orConditions.length > 0) {
        await tx.cashFlow.updateMany({
          where: {
            OR: orConditions,
            partnerType: 'S',
            partnerId: payment.purchaseOrder.supplierId,
            status: { not: 2 },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      await tx.purchaseOrderPayment.update({
        where: { id },
        data: { status: 2, statusValue: 'Đã hủy' },
      });

      await this.recomputePurchaseOrderTotals(payment.purchaseOrderId, tx);
      await this.updateSupplierDebt(payment.purchaseOrder.supplierId, tx);

      const auditUserId = userId || 1;
      const user = await tx.user.findUnique({
        where: { id: auditUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PURCHASE_ORDER_PAYMENT_DELETE',
        entityType: 'purchase_order_payment',
        entityId: id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('PURCHASE_ORDER_PAYMENT_DELETE'),
        severity: getSeverityFromActionCode('PURCHASE_ORDER_PAYMENT_DELETE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          purchaseOrder: {
            code: payment.purchaseOrder.code,
            supplier: payment.purchaseOrder.supplier
              ? {
                  name: payment.purchaseOrder.supplier.name,
                }
              : null,
          },
        },
        message: renderAuditMessage('PURCHASE_ORDER_PAYMENT_DELETE', {
          paymentCode: payment.code,
          purchaseOrderCode: payment.purchaseOrder.code,
        }),
        messageTemplate: 'PURCHASE_ORDER_PAYMENT_DELETE',
        userId: auditUserId,
        userName: user?.name || user?.email || 'System',
        branchId: payment.purchaseOrder.branchId || undefined,
      });

      return { message: 'Xóa thanh toán thành công' };
    });
  }

  /**
   * Recalc cached fields `paidAmount` + `debtAmount` trên PurchaseOrder từ
   * danh sách `purchaseOrderPayment` ACTIVE (status ≠ 2). Đối xứng
   * `invoice-payments.service.ts:calculateInvoiceTotals`.
   */
  private async recomputePurchaseOrderTotals(purchaseOrderId: number, tx: any) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { subTotal: true },
    });
    if (!po) return;

    const activePayments = await tx.purchaseOrderPayment.findMany({
      where: { purchaseOrderId, status: { not: 2 } },
      select: { amount: true },
    });
    const paymentAmount = activePayments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const manualOffsets = await tx.supplierReturn.findMany({
      where: {
        purchaseOrderId,
        status: 3,
        refundType: 'manual_offset',
      },
      select: { refundedAmount: true },
    });
    const offsetAmount = manualOffsets.reduce(
      (sum: number, offset: any) => sum + Number(offset.refundedAmount),
      0,
    );
    const paidAmount = paymentAmount + offsetAmount;
    const debtAmount = Number(po.subTotal) - paidAmount;

    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        paidAmount,
        debtAmount,
        supplierDebt: debtAmount,
      },
    });
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PCPN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPayments = await tx.purchaseOrderPayment.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
      });

      const validCodes = allPayments
        .map((p: any) => p.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;
      const exists = await tx.purchaseOrderPayment.findFirst({
        where: { code },
      });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán duy nhất');
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }
}
