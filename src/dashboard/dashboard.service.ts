import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getStatsOverview() {
    try {
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

      const [
        currentMonthRevenue,
        lastMonthRevenue,
        currentMonthOrders,
        totalCustomerDebt,
        totalSupplierDebt,
        lowStockProducts,
        outOfStockProducts,
      ] = await Promise.all([
        this.prisma.order
          .aggregate({
            where: {
              orderDate: {
                gte: new Date(currentYear, currentMonth, 1),
                lt: new Date(currentYear, currentMonth + 1, 1),
              },
              orderStatus: { not: 'cancelled' },
            },
            _sum: { grandTotal: true },
          })
          .catch(() => ({ _sum: { grandTotal: 0 } })),

        this.prisma.order
          .aggregate({
            where: {
              orderDate: {
                gte: new Date(lastMonthYear, lastMonth, 1),
                lt: new Date(lastMonthYear, lastMonth + 1, 1),
              },
              orderStatus: { not: 'cancelled' },
            },
            _sum: { grandTotal: true },
          })
          .catch(() => ({ _sum: { grandTotal: 0 } })),

        this.prisma.order
          .count({
            where: {
              orderDate: {
                gte: new Date(currentYear, currentMonth, 1),
                lt: new Date(currentYear, currentMonth + 1, 1),
              },
            },
          })
          .catch(() => 0),

        this.prisma.customer
          .aggregate({
            where: { isActive: true },
            _sum: { totalDebt: true },
          })
          .catch(() => ({ _sum: { totalDebt: 0 } })),

        this.prisma.supplier
          .aggregate({
            where: { isActive: true },
            _sum: { totalDebt: true },
          })
          .catch(() => ({ _sum: { totalDebt: 0 } })),

        this.prisma.$queryRaw<any[]>`
          SELECT COUNT(*) as count 
          FROM products 
          WHERE is_active = true 
          AND stock_quantity <= min_stock_alert 
          AND stock_quantity > 0
        `.catch(() => [{ count: '0' }]),

        this.prisma.product
          .count({
            where: {
              isActive: true,
              stockQuantity: 0,
            },
          })
          .catch(() => 0),
      ]);

      const currentRevenue = currentMonthRevenue._sum.grandTotal || 0;
      const lastRevenue = lastMonthRevenue._sum.grandTotal || 0;
      const revenueChange =
        lastRevenue > 0
          ? ((currentRevenue - lastRevenue) / lastRevenue) * 100
          : 0;

      return {
        currentMonthRevenue: currentRevenue,
        lastMonthRevenue: lastRevenue,
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
        revenue: revenue._sum.grandTotal || 0,
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
      ordersCount: customer._count.orders,
      customerType: customer.customerType?.name || null,
    }));
  }

  async getLowStockProducts(limit: number = 20) {
    const products = await this.prisma.$queryRaw<any[]>`
      SELECT p.id, p.code, p.name, p.stock_quantity, p.min_stock_alert,
             c.name as category_name, v.name as variant_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_variants v ON p.variant_id = v.id
      WHERE p.is_active = true 
      AND p.stock_quantity <= p.min_stock_alert
      ORDER BY p.stock_quantity ASC
      LIMIT ${limit}
    `.catch(() => []);

    return products;
  }

  async getRecentOrders(limit: number = 10) {
    return this.prisma.order
      .findMany({
        take: limit,
        orderBy: { orderDate: 'desc' },
        include: {
          customer: {
            select: { id: true, name: true, phone: true },
          },
          creator: {
            select: { id: true, name: true },
          },
          _count: {
            select: { items: true },
          },
        },
      })
      .catch(() => []);
  }
}
