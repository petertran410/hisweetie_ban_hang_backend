import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode();

      const order = await tx.order.create({
        data: {
          code,
          customerId: dto.customerId,
          orderDate: dto.orderDate || new Date(),
          discountAmount: dto.discountAmount || 0,
          depositAmount: dto.depositAmount || 0,
          notes: dto.notes,
          orderStatus: dto.orderStatus || 'pending',
          createdBy: userId,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.quantity * item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      await this.calculateTotals(order.id, tx);

      if (order.orderStatus === 'completed') {
        await this.updateProductStock(order.id, tx);
      }

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return tx.order.findUnique({
        where: { id: order.id },
        include: {
          customer: true,
          items: { include: { product: true } },
          payments: true,
        },
      });
    });
  }

  async calculateTotals(orderId: number, tx: any) {
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

  async updateProductStock(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQuantity: { decrement: item.quantity } },
      });
    }
  }

  async updateCustomerTotals(customerId: number, tx: any) {
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

  private async generateCode(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.order.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
          lt: new Date(today.setHours(23, 59, 59, 999)),
        },
      },
    });
    return `ORD-${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  async findAll(query: OrderQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      customerId,
      orderStatus,
      paymentStatus,
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) where.code = { contains: search, mode: 'insensitive' };
    if (customerId) where.customerId = customerId;
    if (orderStatus) where.orderStatus = orderStatus;
    if (paymentStatus) where.paymentStatus = paymentStatus;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: true,
          items: { include: { product: true } },
          payments: true,
          creator: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { product: true } },
        payments: { include: { creator: { select: { name: true } } } },
        creator: { select: { id: true, name: true } },
      },
    });
  }

  async update(id: number, dto: UpdateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          orderDate: dto.orderDate,
          discountAmount: dto.discountAmount,
          depositAmount: dto.depositAmount,
          orderStatus: dto.orderStatus,
          notes: dto.notes,
        },
      });

      await this.calculateTotals(id, tx);

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return tx.order.findUnique({
        where: { id },
        include: {
          customer: true,
          items: { include: { product: true } },
          payments: true,
        },
      });
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });

      if (order.orderStatus === 'completed') {
        const items = await tx.orderItem.findMany({ where: { orderId: id } });
        for (const item of items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stockQuantity: { increment: item.quantity } },
          });
        }
      }

      await tx.order.delete({ where: { id } });

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }
    });
  }

  async completeOrder(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: { orderStatus: 'completed' },
      });

      await this.updateProductStock(id, tx);

      return tx.order.findUnique({
        where: { id },
        include: { customer: true, items: { include: { product: true } } },
      });
    });
  }

  async cancelOrder(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });

      if (order.orderStatus === 'completed') {
        const items = await tx.orderItem.findMany({ where: { orderId: id } });
        for (const item of items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stockQuantity: { increment: item.quantity } },
          });
        }
      }

      const cancelledOrder = await tx.order.update({
        where: { id },
        data: { orderStatus: 'cancelled' },
      });

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return tx.order.findUnique({
        where: { id },
        include: { customer: true, items: { include: { product: true } } },
      });
    });
  }
}
