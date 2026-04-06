import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
  ORDER_STATUS,
} from './dto/order-status.constants';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PriceBooksService } from '../price-books/price-books.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges, buildItemChanges } from '../audit-logs/audit-diff.utils';
import { INVOICE_STATUS } from 'src/invoices/dto';

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
          description: dto.description,
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
          creator: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          payments: true,
          delivery: true,
          priceBook: true,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_CREATE',
        entityType: 'orders',
        entityId: finalOrder?.id.toString(),
        entityCode: finalOrder?.code,
        category: getCategoryFromActionCode('ORDER_CREATE'),
        severity: getSeverityFromActionCode('ORDER_CREATE'),
        snapshot: this.buildOrderSnapshot(finalOrder),
        message: renderAuditMessage('ORDER_CREATE', {
          orderCode: finalOrder?.code,
          customerName: finalOrder?.customer?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: finalOrder?.branchId || undefined,
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
        description: dto.description,
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

      const fieldChanges = buildChanges(
        'orders',
        {
          statusValue: existingOrder.statusValue,
          grandTotal: Number(existingOrder.grandTotal),
          discount: Number(existingOrder.discount || 0),
          discountRatio: Number(existingOrder.discountRatio || 0),
          description: existingOrder.description,
          customerId: existingOrder.customerId,
        },
        {
          statusValue: updatedOrderBeforeCalc.statusValue,
          grandTotal: Number(updatedOrderBeforeCalc.grandTotal),
          discount: Number(updatedOrderBeforeCalc.discount || 0),
          discountRatio: Number(updatedOrderBeforeCalc.discountRatio || 0),
          description: updatedOrderBeforeCalc.description,
          customerId: updatedOrderBeforeCalc.customerId,
        },
      );

      const itemChanges = buildItemChanges(
        existingOrder.items.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
        updatedOrderBeforeCalc.items.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
      );

      const allChanges = [...fieldChanges, ...itemChanges];

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_UPDATE',
        entityType: 'orders',
        entityId: id.toString(),
        entityCode: updatedOrderBeforeCalc.code,
        category: getCategoryFromActionCode('ORDER_UPDATE'),
        severity: getSeverityFromActionCode('ORDER_UPDATE'),
        snapshot: this.buildOrderSnapshot(updatedOrderBeforeCalc),
        changes: allChanges.length > 0 ? allChanges : null,
        message: renderAuditMessage('ORDER_UPDATE', {
          orderCode: updatedOrderBeforeCalc.code,
          statusValue: updatedOrderBeforeCalc.statusValue || 'Phiếu tạm',
          customerName: updatedOrderBeforeCalc.customer?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_UPDATE',
        userId: user.id,
        userName: user.name || user.email,
        branchId: updatedOrderBeforeCalc.branchId || undefined,
      });

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
          priceBook: true,
        },
      });
    });
  }

  async findAll(query: OrderQueryDto, currentUser?: any) {
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

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    }

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

  async updateOrderStatusByInvoices(orderId: number, tx: any) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) return;

    if (order.status === 4) return;

    const invoices = await tx.invoice.findMany({
      where: {
        orderId,
        status: { not: 2 },
      },
      include: { details: true },
    });

    if (invoices.length === 0) {
      if (order.status === 6 || order.status === 3) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 1,
            statusValue: getStatusLabel(1),
            orderStatus: 'pending',
          },
        });
      }
      return;
    }

    const invoicedQty: Record<number, number> = {};
    invoices.forEach((inv: any) => {
      inv.details.forEach((d: any) => {
        invoicedQty[d.productId] =
          (invoicedQty[d.productId] || 0) + Number(d.quantity);
      });
    });

    let isFullyInvoiced = true;
    for (const item of order.items) {
      const orderedQty = Number(item.quantity);
      const invoiced = invoicedQty[item.productId] || 0;
      if (invoiced < orderedQty) {
        isFullyInvoiced = false;
        break;
      }
    }

    if (isFullyInvoiced) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 3,
          statusValue: getStatusLabel(3),
          orderStatus: 'completed',
        },
      });
    } else {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 6,
          statusValue: getStatusLabel(6),
          orderStatus: 'partially_invoiced',
        },
      });
    }
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

  async getProductPriceHistory(
    customerId: number,
    productId: number,
    type?: 'order' | 'invoice',
  ) {
    const results: Array<{
      code: string;
      date: string;
      price: number;
      discount: number;
      quantity: number;
      finalPrice: number;
      type: 'order' | 'invoice';
    }> = [];

    if (!type || type === 'order') {
      const orderHistory = await this.prisma.orderItem.findMany({
        where: {
          productId,
          order: {
            customerId,
            status: { notIn: [ORDER_STATUS.CANCELLED] },
          },
        },
        select: {
          price: true,
          discount: true,
          quantity: true,
          order: {
            select: {
              id: true,
              code: true,
              orderDate: true,
            },
          },
        },
        orderBy: {
          order: {
            orderDate: 'desc',
          },
        },
        take: 5,
      });

      results.push(
        ...orderHistory.map((item) => ({
          code: item.order.code,
          date: item.order.orderDate.toISOString(),
          price: Number(item.price),
          discount: Number(item.discount),
          quantity: Number(item.quantity),
          finalPrice: Number(item.price) - Number(item.discount),
          type: 'order' as const,
        })),
      );
    }

    if (!type || type === 'invoice') {
      const invoiceHistory = await this.prisma.invoiceDetail.findMany({
        where: {
          productId,
          invoice: {
            customerId,
            status: { notIn: [INVOICE_STATUS.CANCELLED] },
          },
        },
        select: {
          price: true,
          discount: true,
          quantity: true,
          invoice: {
            select: {
              id: true,
              code: true,
              purchaseDate: true,
            },
          },
        },
        orderBy: {
          invoice: {
            purchaseDate: 'desc',
          },
        },
        take: 5,
      });

      results.push(
        ...invoiceHistory.map((item) => ({
          code: item.invoice.code,
          date: item.invoice.purchaseDate.toISOString(),
          price: Number(item.price),
          discount: Number(item.discount),
          quantity: Number(item.quantity),
          finalPrice: Number(item.price) - Number(item.discount),
          type: 'invoice' as const,
        })),
      );
    }

    results.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return results.slice(0, 5);
  }

  private buildOrderSnapshot(order: any) {
    return {
      code: order.code,
      orderDate: order.orderDate,
      statusValue: order.statusValue,
      grandTotal: Number(order.grandTotal),
      totalAmount: Number(order.totalAmount || 0),
      discount: Number(order.discount || 0),
      discountRatio: Number(order.discountRatio || 0),
      paidAmount: Number(order.paidAmount || 0),
      depositAmount: Number(order.depositAmount || 0),
      debtAmount: Number(order.debtAmount || 0),
      description: order.description,
      priceBookName: order.priceBookName || order.priceBook?.name || null,
      customer: order.customer
        ? { code: order.customer.code, name: order.customer.name }
        : null,
      createdBy: order.creator ? { name: order.creator } : null,
      soldBy: order.soldBy ? { name: order.soldBy } : null,
      branch: order.branch ? { name: order.branch.name } : null,
      items: (order.items || []).map((i: any) => ({
        productId: i.productId,
        productCode: i.productCode || i.product?.code,
        productName: i.productName || i.product?.name,
        quantity: Number(i.quantity),
        price: Number(i.price),
        discount: Number(i.discount || 0),
      })),
      delivery: order.delivery
        ? {
            receiver: order.delivery.receiver,
            contactNumber: order.delivery.contactNumber,
            address: order.delivery.address,
            wardName: order.delivery.wardName,
            weight: order.delivery.weight,
            length: order.delivery.length,
            width: order.delivery.width,
            height: order.delivery.height,
            noteForDriver: order.delivery.noteForDriver,
            statusValue: order.delivery.statusValue,
          }
        : null,
    };
  }
}
