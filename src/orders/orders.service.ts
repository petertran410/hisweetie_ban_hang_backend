import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceBooksService } from '../price-books/price-books.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private priceBooksService: PriceBooksService,
  ) {}

  async create(dto: CreateOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode();
      const warnings: any[] = [];
      let primaryPriceBook: any = null;

      const applicablePriceBooks =
        await this.priceBooksService.getApplicablePriceBooks({
          branchId: dto.branchId,
          customerId: dto.customerId,
          userId,
        });

      if (applicablePriceBooks.length > 0) {
        primaryPriceBook = applicablePriceBooks[0];
      }

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });

          if (!product) {
            throw new Error(`Product ${item.productId} not found`);
          }

          // Get price from price book
          const priceInfo = await this.priceBooksService.getPriceForProduct({
            productId: item.productId,
            branchId: dto.branchId,
            customerId: dto.customerId,
            userId,
          });

          let finalPrice = item.unitPrice || priceInfo.price;

          // Check if product is in price book
          if (!priceInfo.priceBookId && primaryPriceBook) {
            if (!primaryPriceBook.allowNonListedProducts) {
              throw new Error(
                `Sản phẩm ${product.name} không có trong bảng giá ${primaryPriceBook.name}`,
              );
            }

            if (primaryPriceBook.warnNonListedProducts) {
              warnings.push({
                productId: product.id,
                productCode: product.code,
                productName: product.name,
                message: `Sản phẩm không có trong bảng giá ${primaryPriceBook.name}`,
              });
            }
          }

          const itemDiscount = item.discount || 0;
          const itemDiscountRatio = item.discountRatio || 0;
          const totalPrice =
            item.quantity * finalPrice -
            itemDiscount -
            (item.quantity * finalPrice * itemDiscountRatio) / 100;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: finalPrice,
            appliedPrice: finalPrice,
            discount: itemDiscount,
            discountRatio: itemDiscountRatio,
            totalPrice: totalPrice,
            note: item.note || null,
            serialNumbers: item.serialNumbers || null,
          };
        }),
      );

      // Create order
      const order = await tx.order.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId: dto.branchId,
          soldById: userId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          discount: dto.discountAmount || 0,
          discountRatio: dto.discountRatio || 0,
          depositAmount: dto.depositAmount || 0,
          description: dto.notes || null,
          orderStatus: dto.orderStatus || 'pending',
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
        },
      });

      await this.calculateTotals(order.id, tx);

      if (order.orderStatus === 'completed') {
        await this.updateProductStock(order.id, tx);
      }

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      const finalOrder = await tx.order.findUnique({
        where: { id: order.id },
        include: {
          customer: true,
          items: { include: { product: true } },
          payments: true,
        },
      });

      return { order: finalOrder, warnings };
    });
  }

  async findAll(query: OrderQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      customerId,
      branchId,
      fromDate,
      toDate,
      soldById,
      saleChannelId,
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [{ code: { contains: search, mode: 'insensitive' } }];
    }
    if (status) where.orderStatus = status;
    if (customerId) where.customerId = customerId;
    if (branchId) where.branchId = branchId;
    if (soldById) where.soldById = soldById;
    if (saleChannelId) where.saleChannelId = saleChannelId;

    if (fromDate && toDate) {
      where.orderDate = {
        gte: new Date(fromDate),
        lte: new Date(toDate),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: true,
          soldBy: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
        },
        orderBy: { orderDate: 'desc' },
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
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
        payments: {
          include: { creator: { select: { id: true, name: true } } },
        },
      },
    });
  }

  async update(id: number, dto: UpdateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!existingOrder) {
        throw new Error('Order not found');
      }

      if (existingOrder.orderStatus === 'completed') {
        await this.restoreProductStock(id, tx);
      }

      if (dto.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new Error(`Product ${item.productId} not found`);

            const itemDiscount = item.discount || 0;
            const itemDiscountRatio = item.discountRatio || 0;
            const totalPrice =
              item.quantity * item.unitPrice -
              itemDiscount -
              (item.quantity * item.unitPrice * itemDiscountRatio) / 100;

            return {
              orderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.unitPrice,
              appliedPrice: item.unitPrice,
              discount: itemDiscount,
              discountRatio: itemDiscountRatio,
              totalPrice: totalPrice,
              note: item.note || null,
              serialNumbers: item.serialNumbers || null,
            };
          }),
        );

        await tx.orderItem.createMany({
          data: itemsData,
        });
      }

      await tx.order.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          branchId: dto.branchId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
          discount: dto.discountAmount,
          discountRatio: dto.discountRatio,
          depositAmount: dto.depositAmount,
          description: dto.notes,
          orderStatus: dto.orderStatus,
        },
      });

      await this.calculateTotals(id, tx);

      const order = await tx.order.findUnique({ where: { id } });
      if (order && order.orderStatus === 'completed') {
        await this.updateProductStock(id, tx);
      }

      if (order && order.customerId) {
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
      const order = await tx.order.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!order) {
        throw new Error('Order not found');
      }

      if (order.orderStatus === 'completed') {
        await this.restoreProductStock(id, tx);
      }

      await tx.order.delete({ where: { id } });

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }
    });
  }

  private async generateCode(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.order.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
        },
      },
    });
    return `HD-${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async calculateTotals(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const grandTotal = totalAmount - Number(order.discount);
    const payments = await tx.orderPayment.findMany({ where: { orderId } });
    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const debtAmount = grandTotal - paidAmount;

    let paymentStatus = 'unpaid';
    if (paidAmount >= grandTotal) paymentStatus = 'paid';
    else if (paidAmount > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: { totalAmount, grandTotal, paidAmount, debtAmount, paymentStatus },
    });
  }

  private async updateProductStock(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQuantity: { decrement: Number(item.quantity) } },
      });
    }
  }

  private async restoreProductStock(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQuantity: { increment: Number(item.quantity) } },
      });
    }
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
