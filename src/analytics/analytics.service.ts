import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getRevenueChart(months: number = 12) {
    const data: number[] = [];
    const labels: string[] = [];

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

      data.push(Number(revenue._sum.grandTotal || 0));
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
      },
      orderBy: {
        totalPurchased: 'desc',
      },
      take: limit,
    });

    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      totalPurchased: customer.totalPurchased,
      totalDebt: customer.totalDebt,
    }));
  }

  async getLowStockProducts() {
    const lowStock = await this.prisma.$queryRaw<any[]>`
    SELECT * FROM products 
    WHERE "isActive" = true 
    AND "stockQuantity" <= "minStockAlert"
    ORDER BY "stockQuantity" ASC
  `;

    return lowStock;
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
      supplierDebt: Number(supplierDebt._sum.debtAmount || 0),
      overdueOrders,
    };
  }

  async getDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      todayRevenue,
      monthRevenue,
      totalCustomers,
      totalProducts,
      lowStockCount,
      pendingOrders,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          orderDate: { gte: today },
          orderStatus: { not: 'cancelled' },
        },
        _sum: { grandTotal: true },
      }),
      this.prisma.order.aggregate({
        where: {
          orderDate: {
            gte: new Date(today.getFullYear(), today.getMonth(), 1),
          },
          orderStatus: { not: 'cancelled' },
        },
        _sum: { grandTotal: true },
      }),
      this.prisma.customer.count({
        where: { isActive: true },
      }),
      this.prisma.product.count({
        where: { isActive: true },
      }),
      this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count 
      FROM products 
      WHERE "isActive" = true 
      AND "stockQuantity" <= "minStockAlert"
    `,
      this.prisma.order.count({
        where: { orderStatus: 'pending' },
      }),
    ]);

    return {
      todayRevenue: Number(todayRevenue._sum.grandTotal || 0),
      monthRevenue: Number(monthRevenue._sum.grandTotal || 0),
      totalCustomers,
      totalProducts,
      lowStockCount: Number(lowStockCount[0].count),
      pendingOrders,
    };
  }

  async getRecentActivities() {
    const recentOrders = await this.prisma.order.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { name: true } },
      },
    });

    return recentOrders.map((order) => ({
      id: order.id,
      type: 'order',
      description: `Đơn hàng ${order.code} - ${order.customer?.name || 'Khách vãng lai'}`,
      amount: Number(order.grandTotal),
      createdAt: order.createdAt,
    }));
  }
}
