import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getRevenueChart(months: number = 12) {
    const data = [];
    const labels = [];

    for (let i = months - 1; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);

      const revenue = await this.prisma.order.aggregate({
        where: {
          orderDate: {
            gte: new Date(date.getFullYear(), date.getMonth(), 1),
            lt: new Date(date.getFullYear(), date.getMonth() + 1, 1),
          },
          orderStatus: { not: 'cancelled' },
        },
        _sum: {
          grandTotal: true,
        },
      });

      data.push(revenue._sum.grandTotal || 0);
      labels.push(
        date.toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' }),
      );
    }

    return { data, labels };
  }

  async getTopCustomers(limit: number = 10) {
    const customers = await this.prisma.customer.findMany({
      where: {
        isActive: true,
        isWalkIn: false,
      },
      orderBy: {
        totalPurchased: 'desc',
      },
      take: limit,
      include: {
        customerType: true,
      },
    });

    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      type: customer.customerType?.name,
      totalPurchased: customer.totalPurchased,
      totalDebt: customer.totalDebt,
    }));
  }

  async getLowStockProducts() {
    return this.prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { stockQuantity: { lte: this.prisma.product.fields.minStockAlert } },
          { stockQuantity: 0 },
        ],
      },
      include: {
        category: true,
        variant: true,
      },
      orderBy: {
        stockQuantity: 'asc',
      },
    });
  }

  async getDebtSummary() {
    const [customerDebt, supplierDebt, overdueOrders] = await Promise.all([
      this.prisma.customer.aggregate({
        where: { isActive: true },
        _sum: { totalDebt: true },
      }),
      this.prisma.purchaseOrder.aggregate({
        _sum: { debtAmount: true },
      }),
      this.prisma.order.count({
        where: {
          debtAmount: { gt: 0 },
          orderDate: {
            lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    return {
      customerDebt: customerDebt._sum.totalDebt || 0,
      supplierDebt: supplierDebt._sum.debtAmount || 0,
      overdueOrders,
    };
  }

  async getRecentActivities() {
    const [recentOrders, recentPayments] = await Promise.all([
      this.prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: true,
          creator: true,
        },
      }),
      this.prisma.orderPayment.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          order: true,
          creator: true,
        },
      }),
    ]);

    const activities = [
      ...recentOrders.map((order) => ({
        type: 'order',
        description: `Đơn hàng ${order.code} - ${order.customer?.name || 'Khách vãng lai'}`,
        amount: order.grandTotal,
        user: order.creator?.name,
        createdAt: order.createdAt,
      })),
      ...recentPayments.map((payment) => ({
        type: 'payment',
        description: `Thanh toán ${payment.order.code}`,
        amount: payment.amount,
        user: payment.creator?.name,
        createdAt: payment.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return activities.slice(0, 20);
  }
}
