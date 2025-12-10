import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getStatsOverview() {
    try {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      const [
        currentRevenue,
        lastRevenue,
        currentMonthOrders,
        totalCustomerDebt,
        totalSupplierDebt,
        lowStockProducts,
        outOfStockProducts,
      ] = await Promise.all([
        this.prisma.order.aggregate({
          where: {
            orderDate: { gte: currentMonthStart },
            orderStatus: { not: 'cancelled' },
          },
          _sum: { grandTotal: true },
        }),
        this.prisma.order.aggregate({
          where: {
            orderDate: { gte: lastMonthStart, lt: currentMonthStart },
            orderStatus: { not: 'cancelled' },
          },
          _sum: { grandTotal: true },
        }),
        this.prisma.order.count({
          where: {
            orderDate: { gte: currentMonthStart },
            orderStatus: { not: 'cancelled' },
          },
        }),
        this.prisma.customer.aggregate({
          where: { isActive: true },
          _sum: { totalDebt: true },
        }),
        this.prisma.supplier.aggregate({
          where: { isActive: true },
          _sum: { totalDebt: true },
        }),
        this.prisma.$queryRaw<[{ count: string }]>`
          SELECT COUNT(*) as count 
          FROM products 
          WHERE is_active = true 
          AND stock_quantity > 0 
          AND stock_quantity <= min_stock_alert
        `,
        this.prisma.product.count({
          where: { isActive: true, stockQuantity: 0 },
        }),
      ]);

      const currentRevenueNum = Number(currentRevenue._sum.grandTotal || 0);
      const lastRevenueNum = Number(lastRevenue._sum.grandTotal || 0);
      const revenueChange =
        lastRevenueNum > 0
          ? ((currentRevenueNum - lastRevenueNum) / lastRevenueNum) * 100
          : 0;

      return {
        currentMonthRevenue: currentRevenueNum,
        lastMonthRevenue: lastRevenueNum,
        revenueChange,
        currentMonthOrders,
        totalCustomerDebt: totalCustomerDebt._sum.totalDebt || 0,
        totalSupplierDebt: totalSupplierDebt._sum.totalDebt || 0,
        lowStockProducts: parseInt(lowStockProducts[0]?.count || '0'),
        outOfStockProducts,
      };
    } catch (error) {
      console.error('Dashboard stats error:', error);
      return {
        currentMonthRevenue: 0,
        lastMonthRevenue: 0,
        revenueChange: 0,
        currentMonthOrders: 0,
        totalCustomerDebt: 0,
        totalSupplierDebt: 0,
        lowStockProducts: 0,
        outOfStockProducts: 0,
      };
    }
  }

  async getRevenueChart(months: number = 6) {
    const now = new Date();
    const chartData: any[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextMonthDate = new Date(
        now.getFullYear(),
        now.getMonth() - i + 1,
        1,
      );

      const revenue = await this.prisma.order
        .aggregate({
          where: {
            orderDate: {
              gte: monthDate,
              lt: nextMonthDate,
            },
            orderStatus: { not: 'cancelled' },
          },
          _sum: { grandTotal: true },
        })
        .catch(() => ({ _sum: { grandTotal: 0 } }));

      chartData.push({
        month: monthDate.toLocaleDateString('vi-VN', {
          month: '2-digit',
          year: 'numeric',
        }),
        revenue: Number(revenue._sum.grandTotal || 0),
      });
    }

    return chartData;
  }

  async getTopCustomers(limit: number = 10) {
    const customers = await this.prisma.customer
      .findMany({
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
          _count: {
            select: { orders: true },
          },
        },
      })
      .catch(() => []);

    return customers.map((customer) => ({
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: customer.phone,
      totalPurchased: customer.totalPurchased,
      totalDebt: customer.totalDebt,
      orderCount: customer._count.orders,
      customerType: customer.customerType?.name,
    }));
  }

  async getLowStockProducts(limit: number = 20) {
    const products = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM products 
      WHERE is_active = true 
      AND stock_quantity <= min_stock_alert
      ORDER BY stock_quantity ASC
      LIMIT ${limit}
    `;

    return products;
  }

  async getRecentOrders(limit: number = 10) {
    const orders = await this.prisma.order.findMany({
      where: { orderStatus: { not: 'cancelled' } },
      take: limit,
      orderBy: { orderDate: 'desc' },
      include: {
        customer: { select: { name: true, code: true } },
      },
    });

    return orders.map((order) => ({
      id: order.id,
      code: order.code,
      customerName: order.customer?.name || 'Khách vãng lai',
      orderDate: order.orderDate,
      grandTotal: Number(order.grandTotal),
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
    }));
  }
}
