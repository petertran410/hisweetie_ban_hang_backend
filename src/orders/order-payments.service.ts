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
      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return payment;
    });
  }

  async findAllByOrder(orderId: number) {
    return this.prisma.orderPayment.findMany({
      where: { orderId },
      include: {
        creator: { select: { id: true, name: true } },
      },
      orderBy: { paymentDate: 'desc' },
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderPayment.findUnique({ where: { id } });
      await tx.orderPayment.delete({ where: { id } });

      await this.calculateOrderTotals(payment.orderId, tx);

      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
      });
      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }
    });
  }

  private async calculateOrderTotals(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const totalAmount = items.reduce((sum, item) => sum + item.totalPrice, 0);

    const order = await tx.order.findUnique({ where: { id: orderId } });
    const grandTotal = totalAmount - order.discountAmount;

    const payments = await tx.orderPayment.findMany({ where: { orderId } });
    const paidAmount = payments.reduce((sum, p) => sum + p.amount, 0);
    const debtAmount = grandTotal - paidAmount;

    let paymentStatus = 'unpaid';
    if (paidAmount === 0) paymentStatus = 'unpaid';
    else if (paidAmount >= grandTotal) paymentStatus = 'paid';
    else paymentStatus = 'partial';

    return tx.order.update({
      where: { id: orderId },
      data: { totalAmount, grandTotal, paidAmount, debtAmount, paymentStatus },
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const orders = await tx.order.findMany({
      where: { customerId, orderStatus: { not: 'cancelled' } },
    });

    const totalPurchased = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalDebt = orders.reduce((sum, o) => sum + o.debtAmount, 0);

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }
}
