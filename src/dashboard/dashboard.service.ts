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
        lowStockResult,
        outOfStockResult,
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
        this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT i."productId") as count
        FROM inventories i
        INNER JOIN products p ON i."productId" = p.id
        WHERE p."isActive" = true
        AND i."onHand" > 0
        AND i."onHand" <= i."minQuality"
      `,
        this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT i."productId") as count
        FROM inventories i
        INNER JOIN products p ON i."productId" = p.id
        WHERE p."isActive" = true
        AND i."onHand" = 0
      `,
      ]);

      const currentRevenueNum = Number(currentRevenue._sum.grandTotal || 0);
      const lastRevenueNum = Number(lastRevenue._sum.grandTotal || 0);
      const revenueChange =
        lastRevenueNum > 0
          ? ((currentRevenueNum - lastRevenueNum) / lastRevenueNum) * 100
          : 0;

      return {
        currentRevenue: currentRevenueNum,
        lastRevenue: lastRevenueNum,
        revenueChange: Number(revenueChange.toFixed(2)),
        currentMonthOrders,
        totalCustomerDebt: Number(totalCustomerDebt._sum.totalDebt || 0),
        totalSupplierDebt: Number(totalSupplierDebt._sum.totalDebt || 0),
        lowStockProducts: Number(lowStockResult[0].count),
        outOfStockProducts: Number(outOfStockResult[0].count),
      };
    } catch (error) {
      throw error;
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
    const inventories = await this.prisma.$queryRaw<any[]>`
    SELECT 
      i.id,
      i."productId",
      i."branchId",
      i."onHand",
      i."minQuality",
      i."maxQuality",
      p.code as "productCode",
      p.name as "productName",
      p."basePrice",
      p.unit,
      b.name as "branchName"
    FROM inventories i
    INNER JOIN products p ON i."productId" = p.id
    INNER JOIN branches b ON i."branchId" = b.id
    WHERE p."isActive" = true
    AND i."onHand" <= i."minQuality"
    ORDER BY i."onHand" ASC
    LIMIT ${limit}
  `;

    return inventories.map((inv) => ({
      id: inv.id,
      productId: inv.productId,
      productCode: inv.productCode,
      productName: inv.productName,
      branchId: inv.branchId,
      branchName: inv.branchName,
      onHand: Number(inv.onHand),
      minQuality: Number(inv.minQuality),
      maxQuality: Number(inv.maxQuality),
      basePrice: Number(inv.basePrice),
      unit: inv.unit,
    }));
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
