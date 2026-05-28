import { Injectable } from '@nestjs/common';
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

      // Generate payment code PNPC
      const code = await this.generatePaymentCode(tx);

      const payment = await tx.purchaseOrderPayment.create({
        data: {
          code,
          purchaseOrderId: dto.purchaseOrderId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.notes || `Trả tiền nhập hàng ${purchaseOrder.code} - PNPC`,
          status: 1,
          statusValue: 'Đã thanh toán',
        },
      });

      // Tính tổng đã trả cho PurchaseOrder
      const allPayments = await tx.purchaseOrderPayment.findMany({
        where: { purchaseOrderId: dto.purchaseOrderId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      await tx.purchaseOrder.update({
        where: { id: dto.purchaseOrderId },
        data: { paidAmount },
      });

      // Map payment method
      let cashFlowMethod = 'cash';
      if (dto.paymentMethod === 'transfer') {
        cashFlowMethod = 'transfer';
      } else if (dto.paymentMethod === 'card') {
        cashFlowMethod = 'card';
      }

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: purchaseOrder.branchId ?? 1,
          cashFlowGroupId: 4,
          isReceipt: false,
          amount: dto.amount,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: cashFlowMethod,
          accountId: dto.accountId,
          partnerType: 'S',
          partnerId: purchaseOrder.supplierId,
          partnerName: purchaseOrder.supplier?.name,
          contactNumber: purchaseOrder.supplier?.contactNumber,
          address: purchaseOrder.supplier?.address,
          description:
            dto.notes || `Chi tiền nhập hàng ${purchaseOrder.code} - PNPC`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
        },
      });

      // Update supplier debt
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

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

  async findAllByPurchaseOrder(purchaseOrderId: number) {
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

      await tx.cashFlow.deleteMany({
        where: { code: payment.code },
      });

      await tx.purchaseOrderPayment.delete({ where: { id } });

      const allPayments = await tx.purchaseOrderPayment.findMany({
        where: { purchaseOrderId: payment.purchaseOrderId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      await tx.purchaseOrder.update({
        where: { id: payment.purchaseOrderId },
        data: { paidAmount },
      });

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

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PNPC';
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
