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

    const totalRevenue = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalProfit = orders.reduce((sum, o) => {
      const profit = o.items.reduce((itemSum, item) => {
        const productProfit =
          (item.unitPrice - (item.product.purchasePrice || 0)) * item.quantity;
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

  async getProductReport() {
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

    return {
      totalProducts: products.length,
      lowStockCount: lowStockProducts.length,
      outOfStockCount: outOfStockProducts.length,
      products,
      lowStockProducts,
      outOfStockProducts,
    };
  }

  async getCustomerReport() {
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

    return {
      totalCustomers: customers.length,
      customersWithDebt: customersWithDebt.length,
      topCustomers,
      customersWithDebt,
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
      (sum, p) => sum + p.purchasePrice * p.stockQuantity,
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

    const totalRevenue = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalPurchases = purchaseOrders.reduce(
      (sum, po) => sum + po.grandTotal,
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
}
