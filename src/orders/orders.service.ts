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

          const priceInfo = await this.priceBooksService.getPriceForProduct({
            productId: item.productId,
            branchId: dto.branchId,
            customerId: dto.customerId,
            userId,
          });

          let finalPrice = item.unitPrice || priceInfo.price;

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
          delivery: dto.delivery
            ? {
                create: {
                  receiver: dto.delivery.receiver || '',
                  contactNumber: dto.delivery.contactNumber || '',
                  address: dto.delivery.address || '',
                  locationName: dto.delivery.locationName,
                  wardName: dto.delivery.wardName,
                  weight: dto.delivery.weight,
                  length: dto.delivery.length || 10,
                  width: dto.delivery.width || 10,
                  height: dto.delivery.height || 10,
                  noteForDriver: dto.delivery.noteForDriver,
                },
              }
            : undefined,
        },
        include: {
          items: true,
          delivery: true,
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
          delivery: true,
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
    const lastOrder = await this.prisma.order.findFirst({
      where: {
        code: {
          startsWith: 'DH',
        },
      },
      orderBy: {
        code: 'desc',
      },
    });

    let nextNumber = 1;
    if (lastOrder && lastOrder.code) {
      const currentNumber = parseInt(lastOrder.code.replace('DH', ''), 10);
      nextNumber = currentNumber + 1;
    }

    return `DH${String(nextNumber).padStart(6, '0')}`;
  }

  private async calculateTotals(orderId: number, tx: any) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true, payments: true },
    });

    if (!order) return;

    const totalAmount = order.items.reduce(
      (sum, item) => sum + Number(item.totalPrice),
      0,
    );

    const finalDiscount =
      Number(order.discount) +
      (totalAmount * Number(order.discountRatio)) / 100;

    const grandTotal = totalAmount - finalDiscount;

    const paidAmount =
      order.payments.reduce((sum, payment) => sum + Number(payment.amount), 0) +
      Number(order.depositAmount);

    const debtAmount = Math.max(0, grandTotal - paidAmount);

    let paymentStatus = 'Draft';
    if (paidAmount >= grandTotal) {
      paymentStatus = 'paid';
    } else if (paidAmount > 0) {
      paymentStatus = 'partial';
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        totalAmount,
        grandTotal,
        paidAmount,
        debtAmount,
        paymentStatus,
      },
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
