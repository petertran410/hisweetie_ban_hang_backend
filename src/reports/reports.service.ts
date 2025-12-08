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
        items: { include: { product: true } },
        customer: true,
      },
    });

    const totalRevenue = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalPaid = orders.reduce((sum, o) => sum + o.paidAmount, 0);
    const totalDebt = orders.reduce((sum, o) => sum + o.debtAmount, 0);
    const totalOrders = orders.length;

    return {
      totalRevenue,
      totalPaid,
      totalDebt,
      totalOrders,
      orders,
    };
  }

  async getCustomerReport(dateFrom: Date, dateTo: Date) {
    const customers = await this.prisma.customer.findMany({
      where: {
        isActive: true,
        orders: {
          some: {
            orderDate: {
              gte: dateFrom,
              lte: dateTo,
            },
            orderStatus: { not: 'cancelled' },
          },
        },
      },
      include: {
        customerType: true,
        orders: {
          where: {
            orderDate: {
              gte: dateFrom,
              lte: dateTo,
            },
            orderStatus: { not: 'cancelled' },
          },
        },
      },
    });

    return customers
      .map((customer) => ({
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.phone,
        customerType: customer.customerType?.name,
        totalPurchased: customer.orders.reduce(
          (sum, o) => sum + o.grandTotal,
          0,
        ),
        totalDebt: customer.orders.reduce((sum, o) => sum + o.debtAmount, 0),
        orderCount: customer.orders.length,
      }))
      .sort((a, b) => b.totalPurchased - a.totalPurchased);
  }

  async getProductReport(dateFrom: Date, dateTo: Date) {
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        order: {
          orderDate: {
            gte: dateFrom,
            lte: dateTo,
          },
          orderStatus: { not: 'cancelled' },
        },
      },
      include: {
        product: {
          include: {
            category: true,
            variant: true,
          },
        },
      },
    });

    const productMap = new Map();

    orderItems.forEach((item) => {
      const productId = item.productId;
      if (!productMap.has(productId)) {
        productMap.set(productId, {
          id: item.product.id,
          code: item.product.code,
          name: item.product.name,
          category: item.product.category?.name,
          variant: item.product.variant?.name,
          totalQuantity: 0,
          totalRevenue: 0,
        });
      }

      const product = productMap.get(productId);
      product.totalQuantity += item.quantity;
      product.totalRevenue += item.totalPrice;
    });

    return Array.from(productMap.values()).sort(
      (a, b) => b.totalRevenue - a.totalRevenue,
    );
  }

  async getInventoryReport() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: {
        category: true,
        variant: true,
      },
    });

    const totalProducts = products.length;
    const inStock = products.filter(
      (p) => p.stockQuantity > p.minStockAlert,
    ).length;
    const lowStock = products.filter(
      (p) => p.stockQuantity <= p.minStockAlert && p.stockQuantity > 0,
    ).length;
    const outOfStock = products.filter((p) => p.stockQuantity === 0).length;

    const totalStockValue = products.reduce(
      (sum, p) => sum + p.stockQuantity * p.purchasePrice,
      0,
    );

    return {
      totalProducts,
      inStock,
      lowStock,
      outOfStock,
      totalStockValue,
      products: products.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        category: p.category?.name,
        variant: p.variant?.name,
        stockQuantity: p.stockQuantity,
        minStockAlert: p.minStockAlert,
        purchasePrice: p.purchasePrice,
        retailPrice: p.retailPrice,
        stockValue: p.stockQuantity * p.purchasePrice,
        status:
          p.stockQuantity === 0
            ? 'out_of_stock'
            : p.stockQuantity <= p.minStockAlert
              ? 'low_stock'
              : 'in_stock',
      })),
    };
  }

  async getDashboardStats() {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayOrders, monthOrders, totalCustomers, lowStockProducts] =
      await Promise.all([
        this.prisma.order.findMany({
          where: {
            orderDate: {
              gte: new Date(today.setHours(0, 0, 0, 0)),
            },
            orderStatus: { not: 'cancelled' },
          },
        }),
        this.prisma.order.findMany({
          where: {
            orderDate: { gte: startOfMonth },
            orderStatus: { not: 'cancelled' },
          },
        }),
        this.prisma.customer.count({ where: { isActive: true } }),
        this.prisma.product.count({
          where: {
            isActive: true,
            stockQuantity: { lte: this.prisma.product.fields.minStockAlert },
          },
        }),
      ]);

    const todayRevenue = todayOrders.reduce((sum, o) => sum + o.grandTotal, 0);
    const monthRevenue = monthOrders.reduce((sum, o) => sum + o.grandTotal, 0);
    const todayDebt = todayOrders.reduce((sum, o) => sum + o.debtAmount, 0);
    const monthDebt = monthOrders.reduce((sum, o) => sum + o.debtAmount, 0);

    return {
      today: {
        orders: todayOrders.length,
        revenue: todayRevenue,
        debt: todayDebt,
      },
      month: {
        orders: monthOrders.length,
        revenue: monthRevenue,
        debt: monthDebt,
      },
      totalCustomers,
      lowStockProducts,
    };
  }
}
