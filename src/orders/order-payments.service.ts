import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderPaymentDto } from './dto';

@Injectable()
export class OrderPaymentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode();

      const payment = await tx.orderPayment.create({
        data: {
          code,
          orderId: dto.orderId,
          paymentDate: dto.paymentDate || new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          description: dto.notes,
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

  private async generateCode(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.orderPayment.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
        },
      },
    });
    return `PT-${dateStr}-${String(count + 1).padStart(4, '0')}`;
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
    let paymentStatus = 'unpaid';
    if (paidAmount >= Number(order.grandTotal)) paymentStatus = 'paid';
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
      (sum: number, o: any) => sum + Number(o.grandTotal),
      0,
    );
    const totalDebt = orders.reduce(
      (sum: number, o: any) => sum + Number(o.debtAmount),
      0,
    );

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }
}
