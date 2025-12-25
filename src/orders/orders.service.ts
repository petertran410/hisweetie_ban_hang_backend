import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
  ORDER_STATUS,
} from './dto/order-status.constants';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const warnings: any[] = [];
      const code = await this.generateCode();

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            include: { inventories: true },
          });

          if (!product) {
            throw new Error(`Product ${item.productId} not found`);
          }

          const inventory = product.inventories?.find(
            (inv) => inv.branchId === dto.branchId,
          );

          if (!inventory || Number(inventory.onHand) < item.quantity) {
            warnings.push({
              productId: item.productId,
              productName: product.name,
              message: `Insufficient stock for ${product.name}`,
            });
          }

          const itemDiscount = item.discount || 0;
          const itemDiscountRatio = item.discountRatio || 0;
          const totalPrice =
            item.quantity * item.unitPrice -
            itemDiscount -
            (item.quantity * item.unitPrice * itemDiscountRatio) / 100;

          return {
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

      const orderStatusString = dto.orderStatus || 'pending';
      const orderStatusNumber = convertStatusStringToNumber(orderStatusString);

      const order = await tx.order.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId: dto.branchId,
          saleChannelId: dto.saleChannelId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          discount: dto.discountAmount || 0,
          discountRatio: dto.discountRatio || 0,
          depositAmount: dto.depositAmount || 0,
          description: dto.notes || null,
          orderStatus: orderStatusString,
          status: orderStatusNumber,
          statusValue: getStatusLabel(orderStatusNumber),
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

      if (order.status === ORDER_STATUS.COMPLETED) {
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

  async update(id: number, dto: UpdateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findUnique({
        where: { id },
        include: { items: true, delivery: true },
      });

      if (!existingOrder) {
        throw new Error('Order not found');
      }

      if (existingOrder.status === ORDER_STATUS.COMPLETED) {
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

      const updateData: any = {
        customerId: dto.customerId,
        branchId: dto.branchId,
        orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
        discount: dto.discountAmount,
        discountRatio: dto.discountRatio,
        depositAmount: dto.depositAmount,
        description: dto.notes,
      };

      if (dto.orderStatus) {
        const statusNumber = convertStatusStringToNumber(dto.orderStatus);
        updateData.orderStatus = dto.orderStatus;
        updateData.status = statusNumber;
        updateData.statusValue = getStatusLabel(statusNumber);
      }

      await tx.order.update({
        where: { id },
        data: updateData,
      });

      if (dto.delivery) {
        if (existingOrder.delivery) {
          await tx.orderDelivery.update({
            where: { orderId: id },
            data: {
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
          });
        } else {
          await tx.orderDelivery.create({
            data: {
              orderId: id,
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
          });
        }
      }

      await this.calculateTotals(id, tx);

      const order = await tx.order.findUnique({ where: { id } });
      if (order && order.status === ORDER_STATUS.COMPLETED) {
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
          delivery: true,
        },
      });
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
    if (status) {
      const statusNumber = convertStatusStringToNumber(status);
      where.status = statusNumber;
    }
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
        branch: true,
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
        payments: {
          include: { creator: { select: { id: true, name: true } } },
        },
        delivery: true,
      },
    });
  }

  private async calculateTotals(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const grandTotal =
      totalAmount -
      Number(order.discount) -
      (totalAmount * Number(order.discountRatio)) / 100;
    const debtAmount = grandTotal - Number(order.paidAmount);

    let paymentStatus = 'Draft';
    if (Number(order.paidAmount) >= grandTotal) paymentStatus = 'paid';
    else if (Number(order.paidAmount) > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: { totalAmount, grandTotal, debtAmount, paymentStatus },
    });
  }

  private async updateProductStock(orderId: number, tx: any) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || !order.branchId) return;

    for (const item of order.items) {
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: order.branchId,
        },
        data: {
          onHand: {
            decrement: Number(item.quantity),
          },
        },
      });
    }
  }

  private async restoreProductStock(orderId: number, tx: any) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || !order.branchId) return;

    for (const item of order.items) {
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: order.branchId,
        },
        data: {
          onHand: {
            increment: Number(item.quantity),
          },
        },
      });
    }
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const orders = await tx.order.findMany({
      where: { customerId },
    });

    const totalDebt = orders.reduce(
      (sum: number, order: any) => sum + Number(order.debtAmount),
      0,
    );

    await tx.customer.update({
      where: { id: customerId },
      data: { totalDebt },
    });
  }

  private async generateCode(): Promise<string> {
    const lastOrder = await this.prisma.order.findFirst({
      orderBy: { id: 'desc' },
    });

    const nextId = lastOrder ? lastOrder.id + 1 : 1;
    return `DH${nextId.toString().padStart(6, '0')}`;
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

      if (order.status === ORDER_STATUS.COMPLETED) {
        await this.restoreProductStock(id, tx);
      }

      await tx.order.delete({ where: { id } });

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }
    });
  }
}
