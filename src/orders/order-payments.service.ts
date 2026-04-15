import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderPaymentDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class OrderPaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreateOrderPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: dto.orderId },
        include: {
          customer: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
              totalDebt: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
        },
      });

      if (!order) {
        throw new Error('Không tìm thấy đơn hàng');
      }

      const existingPayments = await tx.orderPayment.findMany({
        where: { orderId: dto.orderId },
      });
      const paymentSequence = existingPayments.length + 1;
      const code = `TT${order.code}-${paymentSequence}`;

      const payment = await tx.orderPayment.create({
        data: {
          code,
          orderId: dto.orderId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.description ||
            `Thu tiền đơn hàng ${order.code} - Lần ${paymentSequence}`,
          createdBy: userId,
        },
      });

      const allPayments = await tx.orderPayment.findMany({
        where: { orderId: dto.orderId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );
      const depositAmount = paidAmount;

      await tx.order.update({
        where: { id: dto.orderId },
        data: {
          paidAmount,
          depositAmount,
          debtAmount: Number(order.grandTotal) - paidAmount,
        },
      });

      if (order.customerId) {
        await this.recalculateCustomerDebt(order.customerId, tx);
      }

      const updatedCustomer = order.customerId
        ? await tx.customer.findUnique({
            where: { id: order.customerId },
            select: { totalDebt: true },
          })
        : null;

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: order.branchId ?? 1,
          cashFlowGroupId: 3,
          isReceipt: true,
          amount: dto.amount,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: order.customerId,
          partnerName: order.customer?.name,
          contactNumber: order.customer?.contactNumber,
          address: order.customer?.addresses?.[0]?.address || null,
          description:
            dto.description ||
            `Thu tiền đơn hàng ${order.code} - Lần ${paymentSequence}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          customerDebtSnapshot: updatedCustomer
            ? Number(updatedCustomer.totalDebt)
            : null,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_PAYMENT_CREATE',
        entityType: 'order_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('ORDER_PAYMENT_CREATE'),
        severity: getSeverityFromActionCode('ORDER_PAYMENT_CREATE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          order: {
            code: order.code,
            customer: order.customer
              ? { code: order.customer.code, name: order.customer.name }
              : null,
          },
          accountId: payment.accountId,
        },
        message: renderAuditMessage('ORDER_PAYMENT_CREATE', {
          paymentCode: payment.code,
          orderCode: order.code,
          amount: Number(payment.amount),
        }),
        messageTemplate: 'ORDER_PAYMENT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: order.branchId || undefined,
      });

      return {
        payment,
        cashFlow,
      };
    });
  }

  async findAllByOrder(orderId: number) {
    return this.prisma.orderPayment.findMany({
      where: { orderId },
      include: { creator: { select: { id: true, name: true } } },
      orderBy: { paymentDate: 'desc' },
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderPayment.findUnique({
        where: { id },
        include: {
          order: {
            include: { customer: { select: { code: true, name: true } } },
          },
          creator: { select: { id: true, name: true, email: true } },
        },
      });

      if (!payment) {
        throw new Error('Không tìm thấy thanh toán');
      }

      await tx.orderPayment.delete({ where: { id } });

      await tx.cashFlow.deleteMany({ where: { code: payment.code } });

      const allPayments = await tx.orderPayment.findMany({
        where: { orderId: payment.orderId },
      });
      const paidAmount = allPayments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
      });

      await tx.order.update({
        where: { id: payment.orderId },
        data: {
          paidAmount,
          depositAmount: paidAmount,
          debtAmount: Number(order?.grandTotal || 0) - paidAmount,
        },
      });

      if (order?.customerId) {
        await this.recalculateCustomerDebt(order.customerId, tx);
      }

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'ORDER_PAYMENT_DELETE',
        entityType: 'order_payment',
        entityId: id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('ORDER_PAYMENT_DELETE'),
        severity: getSeverityFromActionCode('ORDER_PAYMENT_DELETE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          order: {
            code: payment.order.code,
            customer: payment.order.customer,
          },
        },
        message: renderAuditMessage('ORDER_PAYMENT_DELETE', {
          paymentCode: payment.code,
          orderCode: payment.order.code,
        }),
        messageTemplate: 'ORDER_PAYMENT_DELETE',
        userId: payment.creator?.id || 1,
        userName: payment.creator?.name || 'System',
        branchId: order?.branchId || undefined,
      });

      return { message: 'Xóa thanh toán thành công' };
    });
  }

  private async calculateOrderTotals(orderId: number, tx: any) {
    const payments = await tx.orderPayment.findMany({ where: { orderId } });
    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const debtAmount = Number(order.grandTotal) - paidAmount;
    let paymentStatus = 'Draft';
    if (paidAmount >= Number(order.grandTotal)) paymentStatus = 'paid';
    else if (paidAmount > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: {
        paidAmount,
        depositAmount: paidAmount,
        debtAmount,
        paymentStatus,
      },
    });
  }

  private async recalculateCustomerDebt(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [2] } },
    });
    const debtFromInvoices = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.debtAmount),
      0,
    );

    const orders = await tx.order.findMany({
      where: {
        customerId,
        orderStatus: { not: 'cancelled' },
        invoices: { none: {} },
      },
      include: { payments: true },
    });
    const paidFromOrders = orders.reduce((sum: number, o: any) => {
      return (
        sum + o.payments.reduce((s: number, p: any) => s + Number(p.amount), 0)
      );
    }, 0);

    const totalDebt = debtFromInvoices - paidFromOrders;

    await tx.customer.update({
      where: { id: customerId },
      data: { totalDebt },
    });
  }
}
