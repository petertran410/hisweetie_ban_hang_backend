import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private prisma: PrismaService) {}

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

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.purchaseOrderPayment.findUnique({
        where: { id },
        include: { purchaseOrder: true },
      });

      if (!payment) {
        throw new Error('Không tìm thấy thanh toán');
      }

      // Xóa CashFlow
      await tx.cashFlow.deleteMany({
        where: { code: payment.code },
      });

      // Xóa payment
      await tx.purchaseOrderPayment.delete({ where: { id } });

      // Recalculate paidAmount
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

      // Update supplier debt
      await this.updateSupplierDebt(payment.purchaseOrder.supplierId, tx);
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
    // Tính debt từ OrderSupplier payments
    const orderSuppliers = await tx.orderSupplier.findMany({
      where: { supplierId },
      include: { payments: true },
    });

    let debtFromOrders = 0;
    for (const os of orderSuppliers) {
      const totalPaid = os.payments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );
      debtFromOrders += totalPaid;
    }

    // Tính debt từ PurchaseOrder
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId },
    });

    const debtFromPurchases = purchaseOrders.reduce((sum, po) => {
      const total = Number(po.total);
      const discount = Number(po.discount);
      const paid = Number(po.paidAmount);
      return sum + (total - discount - paid);
    }, 0);

    // Debt = Mình nợ NCC - NCC nợ mình
    const totalDebt = debtFromPurchases - debtFromOrders;

    await tx.supplier.update({
      where: { id: supplierId },
      data: { debt: totalDebt },
    });
  }
}
