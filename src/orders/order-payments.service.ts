import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderPaymentDto } from './dto';

@Injectable()
export class OrderPaymentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: dto.orderId },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
              totalDebt: true,
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
            dto.notes ||
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
          branchId: order.branchId,
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
          address: order.customer?.address,
          description:
            dto.notes ||
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
      const payment = await tx.orderPayment.findUnique({ where: { id } });
      if (!payment) {
        throw new Error('Payment not found');
      }

      await tx.cashFlow.deleteMany({
        where: { code: payment.code },
      });

      await tx.orderPayment.delete({ where: { id } });
      await this.calculateOrderTotals(payment.orderId, tx);
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
      where: { customerId, invoiceId: null, orderStatus: { not: 'cancelled' } },
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
