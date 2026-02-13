import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
} from './dto/order-status.constants';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const warnings: string[] = [];
      const orderStatusString = dto.orderStatus || 'pending';
      const orderStatusNumber = convertStatusStringToNumber(orderStatusString);

      if (!dto.branchId) {
        throw new Error('Branch ID is required');
      }
      const branchId = dto.branchId;

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product) throw new Error(`Product ${item.productId} not found`);

          const inventory = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: item.productId,
                branchId: branchId,
              },
            },
          });

          if (!inventory || Number(inventory.onHand) < item.quantity) {
            warnings.push(
              `Sản phẩm ${product.name} không đủ tồn kho (Có: ${inventory?.onHand || 0}, Cần: ${item.quantity})`,
            );
          }

          const itemDiscount = item.discount || 0;
          const itemDiscountRatio = item.discountRatio || 0;
          const totalPrice =
            (item.unitPrice - itemDiscount) * item.quantity -
            (item.unitPrice * item.quantity * itemDiscountRatio) / 100;
          const appliedPrice =
            item.unitPrice -
            itemDiscount -
            (item.unitPrice * itemDiscountRatio) / 100;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.unitPrice,
            appliedPrice: appliedPrice,
            discount: itemDiscount,
            discountRatio: itemDiscountRatio,
            totalPrice: totalPrice,
            note: item.note || null,
            serialNumbers: item.serialNumbers || null,
          };
        }),
      );

      const orderCode = await this.generateCode();

      const order = await tx.order.create({
        data: {
          code: orderCode,
          customerId: dto.customerId,
          branchId: branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          status: orderStatusNumber,
          statusValue: getStatusLabel(orderStatusNumber),
          orderStatus: orderStatusString,
          depositAmount: dto.depositAmount || 0,
          discount: dto.discountAmount || 0,
          discountRatio: dto.discountRatio || 0,
          description: dto.notes,
          createdBy: userId,
          items: {
            createMany: {
              data: itemsData,
            },
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
              (item.unitPrice - itemDiscount) * item.quantity -
              (item.unitPrice * item.quantity * itemDiscountRatio) / 100;
            const appliedPrice =
              item.unitPrice -
              itemDiscount -
              (item.unitPrice * itemDiscountRatio) / 100;

            return {
              orderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.unitPrice,
              appliedPrice: appliedPrice,
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
        soldById: dto.soldById,
        saleChannelId: dto.saleChannelId,
        orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
        paidAmount: dto.paidAmount,
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

        if (
          dto.orderStatus === 'cancelled' &&
          existingOrder.orderStatus !== 'cancelled'
        ) {
          updateData.debtAmount = 0;
        }
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

      return tx.order.findUnique({
        where: { id },
        include: {
          customer: true,
          branch: true,
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          delivery: true,
          invoices: true,
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
          invoices: true,
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
        soldBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
        payments: true,
        delivery: true,
        invoices: {
          where: { status: { not: 5 } },
          include: {
            details: true,
          },
        },
      },
    });
  }

  private async calculateTotals(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const payments = await tx.orderPayment.findMany({ where: { orderId } });

    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const discountAmount = Number(order.discount) || 0;
    const discountFromRatio =
      (totalAmount * (Number(order.discountRatio) || 0)) / 100;
    const grandTotal = totalAmount - discountAmount - discountFromRatio;

    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const debtAmount = grandTotal - paidAmount;

    let paymentStatus = 'Draft';
    if (paidAmount >= grandTotal) paymentStatus = 'paid';
    else if (paidAmount > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: { totalAmount, grandTotal, paidAmount, debtAmount, paymentStatus },
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

      await tx.order.delete({ where: { id } });
    });
  }

  private async updateOrderStatusByInvoices(orderId: number, tx: any) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        invoices: {
          where: { status: { not: 5 } },
          include: { details: true },
        },
      },
    });

    console.log(order);

    if (!order) return;

    const invoicedQuantities: { [productId: number]: number } = {};
    order.invoices.forEach((inv) => {
      inv.details.forEach((detail) => {
        if (!invoicedQuantities[detail.productId]) {
          invoicedQuantities[detail.productId] = 0;
        }
        invoicedQuantities[detail.productId] += Number(detail.quantity);
      });
    });

    let isFullyInvoiced = true;
    let hasPartialInvoiced = false;

    order.items.forEach((orderItem) => {
      const invoicedQty = invoicedQuantities[orderItem.productId] || 0;
      const orderedQty = Number(orderItem.quantity);

      if (invoicedQty < orderedQty) {
        isFullyInvoiced = false;
      }
      if (invoicedQty > 0) {
        hasPartialInvoiced = true;
      }
    });

    if (!hasPartialInvoiced) return;

    let newStatus = order.status;
    let newStatusValue = order.statusValue;
    let newOrderStatus = order.orderStatus;

    if (isFullyInvoiced) {
      newStatus = 3;
      newStatusValue = 'Hoàn thành';
      newOrderStatus = 'completed';
    } else {
      newStatus = 6;
      newStatusValue = 'Đã ra 1 phần hóa đơn';
      newOrderStatus = 'partially_invoiced';
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        statusValue: newStatusValue,
        orderStatus: newOrderStatus,
      },
    });
  }
}
