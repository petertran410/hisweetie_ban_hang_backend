import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderSupplierPaymentDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';

@Injectable()
export class OrderSupplierPaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreateOrderSupplierPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id: dto.orderSupplierId },
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

      if (!orderSupplier) {
        throw new Error('Không tìm thấy phiếu đặt hàng nhập');
      }

      // Generate payment code PDNPC
      const code = await this.generatePaymentCode(tx);

      const payment = await tx.orderSupplierPayment.create({
        data: {
          code,
          orderSupplierId: dto.orderSupplierId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.notes || `Trả tiền đặt hàng nhập ${orderSupplier.code} - PDNPC`,
          status: 1,
          statusValue: 'Đã thanh toán',
        },
      });

      // Tính tổng đã trả cho OrderSupplier
      const allPayments = await tx.orderSupplierPayment.findMany({
        where: { orderSupplierId: dto.orderSupplierId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      await tx.orderSupplier.update({
        where: { id: dto.orderSupplierId },
        data: {
          paidAmount,
        },
      });

      // Map payment method to cashflow method
      let cashFlowMethod = 'cash';
      if (dto.paymentMethod === 'transfer') {
        cashFlowMethod = 'transfer';
      } else if (dto.paymentMethod === 'card') {
        cashFlowMethod = 'card';
      }

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: orderSupplier.branchId ?? 1,
          cashFlowGroupId: 4,
          isReceipt: false,
          amount: dto.amount,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: cashFlowMethod,
          accountId: dto.accountId,
          partnerType: 'S',
          partnerId: orderSupplier.supplierId,
          partnerName: orderSupplier.supplier?.name,
          contactNumber: orderSupplier.supplier?.contactNumber,
          address: orderSupplier.supplier?.address,
          description:
            dto.notes || `Chi tiền đặt hàng nhập ${orderSupplier.code} - PDNPC`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
        },
      });

      // Update supplier debt: Trừ vào debt (NCC nợ mình nếu số âm)
      await this.updateSupplierDebt(orderSupplier.supplierId, tx);

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_SUPPLIER_PAYMENT_CREATE',
        entityType: 'order_supplier_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_PAYMENT_CREATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_PAYMENT_CREATE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          orderSupplier: {
            code: orderSupplier.code,
            supplier: orderSupplier.supplier?.name,
          },
        },
        message: renderAuditMessage('ORDER_SUPPLIER_PAYMENT_CREATE', {
          paymentCode: payment.code,
          orderSupplierCode: orderSupplier.code,
          amount: Number(payment.amount),
        }),
        messageTemplate: 'ORDER_SUPPLIER_PAYMENT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || undefined,
      });

      return {
        payment,
        cashFlow,
      };
    });
  }

  async findAllByOrderSupplier(orderSupplierId: number) {
    return this.prisma.orderSupplierPayment.findMany({
      where: { orderSupplierId },
      orderBy: { paymentDate: 'desc' },
    });
  }

  async remove(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderSupplierPayment.findUnique({
        where: { id },
        include: { orderSupplier: true },
      });

      if (!payment) {
        throw new Error('Không tìm thấy thanh toán');
      }

      // Xóa CashFlow
      await tx.cashFlow.deleteMany({
        where: { code: payment.code },
      });

      // Xóa payment
      await tx.orderSupplierPayment.delete({ where: { id } });

      // Recalculate paidAmount
      const allPayments = await tx.orderSupplierPayment.findMany({
        where: { orderSupplierId: payment.orderSupplierId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      await tx.orderSupplier.update({
        where: { id: payment.orderSupplierId },
        data: { paidAmount },
      });

      if (userId) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const supplierName = await this.prisma.supplier.findUnique({
          where: { id: payment.orderSupplier.supplierId },
          select: { name: true },
        });

        await this.auditLogsService.create({
          actionType: 'DELETE',
          actionCode: 'ORDER_SUPPLIER_DELETE',
          entityType: 'order_suppliers',
          entityId: id.toString(),
          entityCode: payment.code,
          category: getCategoryFromActionCode('ORDER_SUPPLIER_DELETE'),
          severity: getSeverityFromActionCode('ORDER_SUPPLIER_DELETE'),
          snapshot: {
            code: payment.code,
            amount: Number(payment.amount),
            paymentMethod: payment.paymentMethod,
            paymentDate: payment.paymentDate,
            purchaseOrder: {
              code: payment.orderSupplier.code,
              supplier: supplierName?.name
                ? {
                    name: supplierName?.name,
                  }
                : null,
            },
          },
          message: renderAuditMessage('ORDER_SUPPLIER_DELETE', {
            orderSupplierCode: payment.code,
          }),
          messageTemplate: 'ORDER_SUPPLIER_DELETE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId:
            payment.orderSupplier.branchId || user?.branchId || undefined,
        });
      }

      // Update supplier debt
      await this.updateSupplierDebt(payment.orderSupplier.supplierId, tx);
    });
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PDNPC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPayments = await tx.orderSupplierPayment.findMany({
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
      const exists = await tx.orderSupplierPayment.findFirst({
        where: { code },
      });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán duy nhất');
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    // Tính debt từ OrderSupplier: tổng tiền - đã trả (số âm = NCC nợ mình)
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
      // Nếu trả nhiều hơn total thì là NCC nợ mình (số âm)
      debtFromOrders += totalPaid;
    }

    // Tính debt từ PurchaseOrder: tổng tiền - discount - đã trả (số dương = mình nợ NCC)
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId },
    });

    const debtFromPurchases = purchaseOrders.reduce((sum, po) => {
      const total = Number(po.total);
      const discount = Number(po.discount);
      const paid = Number(po.paidAmount);
      return sum + (total - discount - paid);
    }, 0);

    // Debt tổng = Mình nợ NCC (PurchaseOrder) - NCC nợ mình (OrderSupplier payment)
    const totalDebt = debtFromPurchases - debtFromOrders;

    await tx.supplier.update({
      where: { id: supplierId },
      data: { debt: totalDebt },
    });
  }
}
