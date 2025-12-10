import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getSalesReport(dateFrom: Date, dateTo: Date) {
    const orders = await this.prisma.order.findMany({
      where: {
        orderDate: {
          gte: dateFrom,
          lte: dateTo,
        },
        orderStatus: { not: 'cancelled' },
      },
      include: {
        customer: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    const totalRevenue = orders.reduce(
      (sum, o) => sum + Number(o.grandTotal),
      0,
    );
    const totalProfit = orders.reduce((sum, o) => {
      const profit = o.items.reduce((itemSum, item) => {
        const productProfit =
          (Number(item.price) - Number(item.product.purchasePrice || 0)) *
          Number(item.quantity);
        return itemSum + productProfit;
      }, 0);
      return sum + profit;
    }, 0);

    return {
      dateFrom,
      dateTo,
      totalOrders: orders.length,
      totalRevenue,
      totalProfit,
      orders,
    };
  }

  async getProductReport(dateFrom?: Date, dateTo?: Date) {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: {
        category: true,
        variant: true,
      },
    });

    const lowStockProducts = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM products 
      WHERE is_active = true 
      AND stock_quantity <= min_stock_alert
    `;

    const outOfStockProducts = products.filter((p) => p.stockQuantity === 0);

    let soldProducts: any[] = [];
    if (dateFrom && dateTo) {
      soldProducts = await this.prisma.$queryRaw<any[]>`
        SELECT 
          p.id,
          p.code,
          p.name,
          SUM(oi.quantity) as total_sold,
          SUM(oi.total_price) as total_revenue
        FROM products p
        INNER JOIN order_items oi ON p.id = oi.product_id
        INNER JOIN orders o ON oi.order_id = o.id
        WHERE o.order_date >= ${dateFrom}
        AND o.order_date <= ${dateTo}
        AND o.order_status != 'cancelled'
        GROUP BY p.id, p.code, p.name
        ORDER BY total_sold DESC
        LIMIT 20
      `;
    }

    return {
      totalProducts: products.length,
      lowStockCount: lowStockProducts.length,
      outOfStockCount: outOfStockProducts.length,
      products,
      lowStockProducts,
      outOfStockProducts,
      soldProducts,
    };
  }

  async getCustomerReport(dateFrom?: Date, dateTo?: Date) {
    const customers = await this.prisma.customer.findMany({
      where: { isActive: true, isWalkIn: false },
      include: {
        customerType: true,
        orders: {
          where: { orderStatus: { not: 'cancelled' } },
        },
      },
    });

    const topCustomers = customers
      .sort((a, b) => b.totalPurchased - a.totalPurchased)
      .slice(0, 10);

    const customersWithDebt = customers.filter((c) => c.totalDebt > 0);

    let newCustomers: any[] = [];
    if (dateFrom && dateTo) {
      newCustomers = await this.prisma.customer.findMany({
        where: {
          isActive: true,
          isWalkIn: false,
          createdAt: {
            gte: dateFrom,
            lte: dateTo,
          },
        },
        include: {
          customerType: true,
        },
      });
    }

    return {
      totalCustomers: customers.length,
      totalCustomersWithDebt: customersWithDebt.length,
      topCustomers,
      customersWithDebt,
      newCustomers,
    };
  }

  async getInventoryReport() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: {
        category: true,
        variant: true,
      },
    });

    const totalValue = products.reduce(
      (sum, p) => sum + Number(p.purchasePrice) * p.stockQuantity,
      0,
    );

    const lowStockProducts = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM products 
      WHERE is_active = true 
      AND stock_quantity <= min_stock_alert
    `;

    return {
      totalProducts: products.length,
      totalStockValue: totalValue,
      lowStockCount: lowStockProducts.length,
      products,
    };
  }

  async getFinancialReport(dateFrom: Date, dateTo: Date) {
    const [orders, purchaseOrders, customers, suppliers] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          orderDate: { gte: dateFrom, lte: dateTo },
          orderStatus: { not: 'cancelled' },
        },
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          purchaseDate: { gte: dateFrom, lte: dateTo },
        },
      }),
      this.prisma.customer.findMany({
        where: { isActive: true },
      }),
      this.prisma.supplier.findMany({
        where: { isActive: true },
      }),
    ]);

    const totalRevenue = orders.reduce(
      (sum, o) => sum + Number(o.grandTotal),
      0,
    );
    const totalPurchases = purchaseOrders.reduce(
      (sum, po) => sum + Number(po.grandTotal),
      0,
    );
    const customerDebt = customers.reduce((sum, c) => sum + c.totalDebt, 0);
    const supplierDebt = suppliers.reduce((sum, s) => sum + s.totalDebt, 0);

    return {
      dateFrom,
      dateTo,
      totalRevenue,
      totalPurchases,
      profit: totalRevenue - totalPurchases,
      customerDebt,
      supplierDebt,
      netDebt: customerDebt - supplierDebt,
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
        where: { isActive: true, isWalkIn: false },
      }),
      this.prisma.product.count({
        where: { isActive: true },
      }),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) as count 
        FROM products 
        WHERE is_active = true 
        AND stock_quantity <= min_stock_alert
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
}
