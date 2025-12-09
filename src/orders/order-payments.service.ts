import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderPaymentDto } from './dto';

@Injectable()
export class OrderPaymentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderPayment.create({
        data: {
          orderId: dto.orderId,
          paymentDate: dto.paymentDate || new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          notes: dto.notes,
          createdBy: userId,
        },
      });

      await this.calculateOrderTotals(dto.orderId, tx);

      const order = await tx.order.findUnique({ where: { id: dto.orderId } });
      if (order && order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return tx.orderPayment.findUnique({
        where: { id: payment.id },
        include: { order: true },
      });
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

      await tx.orderPayment.delete({ where: { id } });
      await this.calculateOrderTotals(payment.orderId, tx);

      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
      });
      if (order && order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }
    });
  }

  private async calculateOrderTotals(orderId: number, tx: any) {
    const payments = await tx.orderPayment.findMany({ where: { orderId } });
    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + p.amount,
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const debtAmount = order.grandTotal - paidAmount;
    let paymentStatus = 'unpaid';
    if (paidAmount >= order.grandTotal) paymentStatus = 'paid';
    else if (paidAmount > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount, debtAmount, paymentStatus },
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const orders = await tx.order.findMany({
      where: {
        customerId,
        orderStatus: { not: 'cancelled' },
      },
    });

    const totalPurchased = orders.reduce(
      (sum: number, o: any) => sum + o.grandTotal,
      0,
    );
    const totalDebt = orders.reduce(
      (sum: number, o: any) => sum + o.debtAmount,
      0,
    );

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }
}
