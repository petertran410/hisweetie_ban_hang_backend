import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
} from './dto/order-status.constants';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PriceBooksService } from '../price-books/price-books.service';
import { renderAuditMessage } from '../audit-logs/audit-templates';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private priceBooksService: PriceBooksService,
    private auditLogsService: AuditLogsService,
  ) {}

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

      const applicablePriceBooks = await this.prisma.priceBook.findMany({
        where: {
          isActive: true,
          OR: [
            { isGlobal: true },
            { priceBookBranches: { some: { branchId: branchId } } },
            ...(dto.customerId
              ? [
                  {
                    priceBookCustomerGroups: {
                      some: {
                        customerGroup: {
                          customerGroupDetails: {
                            some: { customerId: dto.customerId },
                          },
                        },
                      },
                    },
                  },
                  { forAllCusGroup: true },
                ]
              : []),
          ],
        },
        orderBy: { priority: 'desc' },
        take: 1,
      });

      const orderCode = await this.generateCode();
      const priceBook = applicablePriceBooks[0] || null;

      const order = await tx.order.create({
        data: {
          code: orderCode,
          customerId: dto.customerId,
          branchId: branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          priceBookId: priceBook?.id || null,
          priceBookName: priceBook?.name || null,
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

  async update(id: number, dto: UpdateOrderDto, user: any) {
    return this.prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findUnique({
        where: { id },
        include: {
          items: { include: { product: true } },
          delivery: true,
          customer: true,
        },
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

      const needRecalculatePriceBook =
        dto.customerId !== existingOrder.customerId ||
        dto.branchId !== existingOrder.branchId ||
        dto.soldById !== existingOrder.soldById;

      if (needRecalculatePriceBook) {
        const branchId = dto.branchId || existingOrder.branchId;
        const customerId = dto.customerId || existingOrder.customerId;

        const orConditions: any[] = [{ isGlobal: true }];

        if (branchId) {
          orConditions.push({
            priceBookBranches: {
              some: { branchId },
            },
          });
        }

        if (customerId) {
          orConditions.push(
            {
              priceBookCustomerGroups: {
                some: {
                  customerGroup: {
                    customerGroupDetails: {
                      some: { customerId },
                    },
                  },
                },
              },
            },
            { forAllCusGroup: true },
          );
        }

        const applicablePriceBooks = await tx.priceBook.findMany({
          where: {
            isActive: true,
            OR: orConditions,
          },
          orderBy: { priority: 'desc' },
          take: 1,
        });

        const priceBook = applicablePriceBooks[0] || null;
        updateData.priceBookId = priceBook?.id || null;
        updateData.priceBookName = priceBook?.name || null;

        console.log('Id: ', priceBook?.id);
        console.log('Name: ', priceBook?.name);
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

      const updatedOrderBeforeCalc = await tx.order.findUnique({
        where: { id },
        include: {
          items: { include: { product: true } },
          delivery: true,
          customer: true,
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!updatedOrderBeforeCalc) {
        throw new Error('Updated order not found');
      }

      const changes: string[] = [];

      if (existingOrder.statusValue !== updatedOrderBeforeCalc.statusValue) {
        changes.push(
          `${existingOrder.statusValue} → ${updatedOrderBeforeCalc.statusValue}`,
        );
      }

      const oldItemMap = new Map(
        existingOrder.items.map((i) => [i.productId, i]),
      );
      const newItemMap = new Map(
        updatedOrderBeforeCalc.items.map((i) => [i.productId, i]),
      );

      updatedOrderBeforeCalc.items.forEach((newItem) => {
        const oldItem = oldItemMap.get(newItem.productId);
        if (!oldItem) {
          changes.push(`Thêm ${newItem.product.name}`);
        } else if (Number(oldItem.quantity) !== Number(newItem.quantity)) {
          changes.push(
            `${newItem.product.name}: SL ${oldItem.quantity} → ${newItem.quantity}`,
          );
        }
      });

      existingOrder.items.forEach((oldItem) => {
        if (!newItemMap.has(oldItem.productId)) {
          changes.push(`Xóa ${oldItem.product.name}`);
        }
      });

      if (changes.length > 0) {
        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'ORDER_UPDATE',
          entityType: 'orders',
          entityId: id.toString(),
          entityCode: updatedOrderBeforeCalc.code,

          oldValues: {
            code: existingOrder.code,
            statusValue: existingOrder.statusValue,
            grandTotal: existingOrder.grandTotal,
            itemCount: existingOrder.items.length,
            items: existingOrder.items.map((i) => ({
              productId: i.productId,
              productName: i.product.name,
              quantity: Number(i.quantity),
              price: Number(i.price),
            })),
          },
          newValues: {
            order: {
              code: updatedOrderBeforeCalc.code,
              statusValue: updatedOrderBeforeCalc.statusValue,
              grandTotal: updatedOrderBeforeCalc.grandTotal,
              createdAt: updatedOrderBeforeCalc.createdAt,
              description: updatedOrderBeforeCalc.description,
              customer: updatedOrderBeforeCalc.customer,
              soldBy: updatedOrderBeforeCalc.soldBy,
              branch: updatedOrderBeforeCalc.branch,
              priceBook: updatedOrderBeforeCalc.priceBookName
                ? {
                    id: updatedOrderBeforeCalc.priceBookId,
                    name: updatedOrderBeforeCalc.priceBookName,
                  }
                : null,
              items: updatedOrderBeforeCalc.items.map((i) => ({
                productId: i.productId,
                productCode: i.productCode,
                productName: i.product.name,
                quantity: Number(i.quantity),
                price: Number(i.price),
              })),
              delivery: updatedOrderBeforeCalc.delivery,
            },
          },

          message: renderAuditMessage('ORDER_UPDATE', {
            orderCode: updatedOrderBeforeCalc.code,
            statusValue: updatedOrderBeforeCalc.statusValue || 'Phiếu tạm',
          }),
          messageTemplate: 'ORDER_UPDATE',
          messageParams: {
            orderCode: updatedOrderBeforeCalc.code,
            statusValue: updatedOrderBeforeCalc.statusValue || 'Phiếu tạm',
            changesSummary: changes.join(', '),
          },

          userId: user.id,
          userName: user.name || user.email,
          branchId: updatedOrderBeforeCalc.branchId || undefined,
        });
      }

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
