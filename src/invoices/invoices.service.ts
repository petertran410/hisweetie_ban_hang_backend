import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  INVOICE_STATUS,
  getStatusLabel,
  CreateInvoiceFromOrderDto,
} from './dto';
import {
  ORDER_STATUS,
  getStatusLabel as getOrderStatusLabel,
} from '../orders/dto/order-status.constants';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
  ) {}

  async findAll(query: InvoiceQueryDto) {
    const {
      page = 1,
      limit = 15,
      pageSize,
      currentItem,
      search,
      customerIds,
      branchId,
      statusIds,
      fromDate,
      toDate,
      fromPurchaseDate,
      toPurchaseDate,
      fromCreatedDate,
      toCreatedDate,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where: any = {};

    if (search) {
      where.OR = [
        { code: { contains: search } },
        { customer: { name: { contains: search } } },
        { description: { contains: search } },
      ];
    }

    if (customerIds && customerIds.length > 0) {
      where.customerId = { in: customerIds };
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (statusIds && statusIds.length > 0) {
      where.status = { in: statusIds };
    }

    if (fromDate || toDate || fromPurchaseDate || toPurchaseDate) {
      where.purchaseDate = {};
      if (fromDate) where.purchaseDate.gte = new Date(fromDate);
      if (toDate) where.purchaseDate.lte = new Date(toDate);
      if (fromPurchaseDate) where.purchaseDate.gte = new Date(fromPurchaseDate);
      if (toPurchaseDate) where.purchaseDate.lte = new Date(toPurchaseDate);
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip: effectiveSkip,
        take: effectiveLimit,
        include: {
          customer: true,
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
          payments: true,
          delivery: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: true,
        branch: true,
        soldBy: true,
        creator: true,
        details: { include: { product: true } },
        payments: true,
        delivery: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found`);
    }

    return invoice;
  }

  async create(dto: CreateInvoiceDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateSafeInvoiceCode(tx);

      const totalAmount = dto.items.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );
      const discountAmount = dto.discountAmount || 0;
      const discountFromRatio = (totalAmount * (dto.discountRatio || 0)) / 100;
      const grandTotal = totalAmount - discountAmount - discountFromRatio;
      const paidAmount = dto.paidAmount || 0;
      const debtAmount = grandTotal - paidAmount;

      let status: number = INVOICE_STATUS.PROCESSING;
      if (debtAmount <= 0) {
        status = INVOICE_STATUS.COMPLETED;
      }

      const customer = dto.customerId
        ? await tx.customer.findUnique({
            where: { id: dto.customerId },
            select: { totalDebt: true },
          })
        : null;

      const currentCustomerDebt = Number(customer?.totalDebt || 0);
      const customerDebtSnapshot = currentCustomerDebt + debtAmount;

      const invoice = await tx.invoice.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId: dto.branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          totalAmount,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          grandTotal,
          paidAmount,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          usingCod: dto.usingCod || false,
          description: dto.description,
          createdBy: userId,
          customerDebtSnapshot,
          details: {
            createMany: {
              data: dto.items.map((item) => ({
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                discount: item.discount || 0,
                discountRatio: item.discountRatio || 0,
                totalPrice: item.totalPrice,
                note: item.note,
              })),
            },
          },
          ...(dto.delivery && {
            delivery: {
              create: {
                receiver: dto.delivery.receiver,
                contactNumber: dto.delivery.contactNumber,
                address: dto.delivery.address,
                locationName: dto.delivery.locationName,
                wardName: dto.delivery.wardName,
                weight: dto.delivery.weight,
                length: dto.delivery.length,
                width: dto.delivery.width,
                height: dto.delivery.height,
                noteForDriver: dto.delivery.noteForDriver,
              },
            },
          }),
        },
        include: {
          details: true,
          payments: true,
          delivery: true,
        },
      });

      if (paidAmount > 0) {
        const existingPayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invoice.id },
        });
        const paymentSequence = existingPayments.length + 1;
        const paymentCode = `TT${invoice.code}-${paymentSequence}`;

        const paymentCustomer = dto.customerId
          ? await tx.customer.findUnique({
              where: { id: dto.customerId },
              select: { id: true, name: true },
            })
          : null;

        await tx.invoicePayment.create({
          data: {
            code: paymentCode,
            invoiceId: invoice.id,
            status: 1,
            statusValue: 'Paid',
            amount: paidAmount,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          },
        });

        if (paidAmount > 0) {
          if (!dto.branchId) {
            throw new Error('Vui lòng chọn chi nhánh');
          }

          await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: dto.branchId,
              isReceipt: true,
              amount: paidAmount,
              transDate: new Date(),
              method: 'cash',
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: paymentCustomer?.name,
              description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot:
                currentCustomerDebt + grandTotal - paidAmount,
            },
          });
        }
      }

      for (const item of dto.items) {
        await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            branchId: dto.branchId,
          },
          data: {
            onHand: { decrement: item.quantity },
          },
        });
      }

      if (dto.customerId) {
        await this.updateCustomerTotals(dto.customerId, tx);
      }

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          branch: true,
          soldBy: true,
        },
      });
    });
  }

  async update(id: number, dto: UpdateInvoiceDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const updateData: any = {};
      const currentInvoice = await tx.invoice.findUnique({
        where: { id },
        include: {
          details: true,
          customer: { select: { totalDebt: true } },
          payments: true,
        },
      });

      if (!currentInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
      if (dto.branchId !== undefined) updateData.branchId = dto.branchId;
      if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
      if (dto.description !== undefined)
        updateData.description = dto.description;

      let shouldUpdateCustomerDebt = false;
      let newCustomerDebt = 0;

      if (dto.status !== undefined) {
        if (
          dto.status === INVOICE_STATUS.CANCELLED &&
          currentInvoice.status !== INVOICE_STATUS.CANCELLED
        ) {
          if (!currentInvoice.branchId) {
            throw new BadRequestException(
              'Không thể hủy hóa đơn vì không có thông tin chi nhánh',
            );
          }

          for (const detail of currentInvoice.details) {
            await tx.inventory.updateMany({
              where: {
                productId: detail.productId,
                branchId: currentInvoice.branchId,
              },
              data: {
                onHand: { increment: Number(detail.quantity) },
              },
            });
          }

          updateData.debtAmount = 0;

          if (currentInvoice.customerId && currentInvoice.customer) {
            const currentCustomerDebt = Number(
              currentInvoice.customer.totalDebt,
            );
            const grandTotal = Number(currentInvoice.grandTotal);
            const debtAmount = Number(currentInvoice.debtAmount);
            const paidAmount = Number(currentInvoice.paidAmount);

            if (dto.cancelPayments === true) {
              newCustomerDebt = currentCustomerDebt - debtAmount;

              if (paidAmount > 0 && currentInvoice.payments.length > 0) {
                for (const payment of currentInvoice.payments) {
                  await tx.cashFlow.updateMany({
                    where: { code: payment.code },
                    data: {
                      status: 2,
                      statusValue: 'Đã hủy',
                    },
                  });
                }

                await tx.invoicePayment.updateMany({
                  where: { invoiceId: id },
                  data: {
                    status: 2,
                    statusValue: 'Đã hủy',
                  },
                });

                updateData.paidAmount = 0;
              }
            } else {
              newCustomerDebt = currentCustomerDebt - grandTotal;
            }

            shouldUpdateCustomerDebt = true;
          }
        }

        updateData.status = dto.status;
        updateData.statusValue = getStatusLabel(dto.status);
      }

      if (dto.items) {
        if (!currentInvoice.branchId) {
          throw new BadRequestException(
            'Không thể cập nhật hóa đơn vì không có thông tin chi nhánh',
          );
        }

        for (const oldDetail of currentInvoice.details) {
          await tx.inventory.updateMany({
            where: {
              productId: oldDetail.productId,
              branchId: currentInvoice.branchId,
            },
            data: {
              onHand: { increment: Number(oldDetail.quantity) },
            },
          });
        }

        await tx.invoiceDetail.deleteMany({ where: { invoiceId: id } });

        const totalAmount = dto.items.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        const discountAmount = dto.discountAmount || 0;
        const discountFromRatio =
          (totalAmount * (dto.discountRatio || 0)) / 100;
        const grandTotal = totalAmount - discountAmount - discountFromRatio;

        const payments = await tx.invoicePayment.findMany({
          where: { invoiceId: id },
        });
        const paidAmount = payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
        const debtAmount = grandTotal - paidAmount;

        let status: number = currentInvoice.status;

        if (
          status !== INVOICE_STATUS.CANCELLED &&
          status !== INVOICE_STATUS.FAILED_DELIVERY
        ) {
          status =
            debtAmount <= 0
              ? INVOICE_STATUS.COMPLETED
              : INVOICE_STATUS.PROCESSING;
        }

        const currentCustomerDebt = Number(
          currentInvoice.customer?.totalDebt || 0,
        );
        const oldDebtAmount = Number(currentInvoice.debtAmount);
        const customerDebtSnapshot =
          currentCustomerDebt - oldDebtAmount + debtAmount;

        updateData.totalAmount = totalAmount;
        updateData.discount = discountAmount;
        updateData.discountRatio = dto.discountRatio || 0;
        updateData.grandTotal = grandTotal;
        updateData.debtAmount = debtAmount;
        updateData.paidAmount = paidAmount;
        updateData.status = status;
        updateData.statusValue = getStatusLabel(status);
        updateData.customerDebtSnapshot = customerDebtSnapshot;

        updateData.details = {
          create: dto.items.map((item) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: item.productName,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            discountRatio: item.discountRatio || 0,
            totalPrice: item.totalPrice,
            note: item.note,
          })),
        };

        for (const item of dto.items) {
          await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              branchId: currentInvoice.branchId,
            },
            data: {
              onHand: { decrement: item.quantity },
            },
          });
        }

        if (currentInvoice.customerId && currentInvoice.customer) {
          const currentCustomerDebtBeforeUpdate = Number(
            currentInvoice.customer.totalDebt,
          );
          const oldDebtAmountBeforeUpdate = Number(currentInvoice.debtAmount);
          newCustomerDebt =
            currentCustomerDebtBeforeUpdate -
            oldDebtAmountBeforeUpdate +
            debtAmount;
          shouldUpdateCustomerDebt = true;
        }
      }

      if (dto.delivery) {
        await tx.invoiceDelivery.deleteMany({
          where: { invoiceId: id },
        });
        updateData.delivery = {
          create: {
            receiver: dto.delivery.receiver,
            contactNumber: dto.delivery.contactNumber,
            address: dto.delivery.address,
            locationName: dto.delivery.locationName,
            wardName: dto.delivery.wardName,
            weight: dto.delivery.weight,
            length: dto.delivery.length,
            width: dto.delivery.width,
            height: dto.delivery.height,
            noteForDriver: dto.delivery.noteForDriver,
          },
        };
      }

      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: updateData,
        include: {
          customer: true,
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
          payments: true,
          delivery: true,
        },
      });

      if (shouldUpdateCustomerDebt && currentInvoice.customerId) {
        await tx.customer.update({
          where: { id: currentInvoice.customerId },
          data: { totalDebt: newCustomerDebt },
        });
      }

      if (currentInvoice.orderId) {
        await this.ordersService['updateOrderStatusByInvoices'](
          currentInvoice.orderId,
          tx,
        );
      }

      return updatedInvoice;
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      await tx.invoice.delete({ where: { id } });

      if (invoice.orderId) {
        await this.ordersService['updateOrderStatusByInvoices'](
          invoice.orderId,
          tx,
        );
      }

      return invoice;
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [INVOICE_STATUS.CANCELLED] } },
    });

    const debtFromInvoices = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.debtAmount),
      0,
    );
    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );

    const orders = await tx.order.findMany({
      where: {
        customerId,
        orderStatus: { not: 'cancelled' },
        invoices: { none: {} },
      },
      include: { payments: true },
    });

    const paidFromOrdersWithoutInvoice = orders.reduce(
      (sum: number, o: any) => {
        return (
          sum +
          o.payments.reduce((s: number, p: any) => s + Number(p.amount), 0)
        );
      },
      0,
    );

    const totalDebt = debtFromInvoices - paidFromOrdersWithoutInvoice;

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }

  async createFromOrder(
    orderId: number,
    dto: CreateInvoiceFromOrderDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          payments: true,
          delivery: true,
          invoices: {
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
            include: { details: true },
          },
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
              totalDebt: true,
            },
          },
        },
      });

      if (!order) throw new NotFoundException('Order not found');
      if (order.status === ORDER_STATUS.CANCELLED) {
        throw new BadRequestException(
          'Không thể tạo hóa đơn từ đơn hàng đã hủy',
        );
      }
      if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BadRequestException('Đơn hàng đã hoàn thành');
      }
      if (!order.branchId) {
        throw new BadRequestException('Đơn hàng không có thông tin chi nhánh');
      }

      const invoicedQuantities: Record<number, number> = {};
      order.invoices.forEach((inv) => {
        inv.details.forEach((d) => {
          invoicedQuantities[d.productId] =
            (invoicedQuantities[d.productId] || 0) + Number(d.quantity);
        });
      });

      const remainingItems = order.items
        .map((item) => {
          const invoiced = invoicedQuantities[item.productId] || 0;
          const remaining = Number(item.quantity) - invoiced;
          return { ...item, remainingQuantity: remaining };
        })
        .filter((item) => item.remainingQuantity > 0);

      if (remainingItems.length === 0) {
        throw new BadRequestException(
          'Tất cả sản phẩm trong đơn hàng đã được xuất hóa đơn',
        );
      }

      const usedDiscount = order.invoices.reduce(
        (sum, inv) => sum + Number(inv.discount),
        0,
      );
      const remainingDiscount = Number(order.discount) - usedDiscount;
      const discountForThisInvoice =
        remainingDiscount > 0 ? remainingDiscount : 0;

      const code = await this.generateSafeInvoiceCode(tx);

      const isFirstInvoice = order.invoices.length === 0;

      const totalPaidFromOrder = isFirstInvoice
        ? order.payments.reduce((sum, p) => sum + Number(p.amount), 0)
        : 0;
      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = totalPaidFromOrder + additionalPayment;

      const itemsToInvoice =
        dto.items && dto.items.length > 0
          ? dto.items
          : remainingItems.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.remainingQuantity,
              price: Number(item.price),
              discount: Number(item.discount),
              discountRatio: Number(item.discountRatio),
              totalPrice:
                (Number(item.price) - Number(item.discount)) *
                item.remainingQuantity,
              note: item.note,
            }));

      const totalAmount = itemsToInvoice.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );

      const grandTotal = totalAmount - discountForThisInvoice;
      const debtAmount = grandTotal - totalPaid;

      const status =
        debtAmount <= 0 ? INVOICE_STATUS.COMPLETED : INVOICE_STATUS.PROCESSING;

      const currentCustomerDebt = Number(order.customer?.totalDebt || 0);
      const customerDebtSnapshot = currentCustomerDebt + debtAmount;

      const invoice = await tx.invoice.create({
        data: {
          code,
          orderId: order.id,
          customerId: order.customerId,
          branchId: order.branchId,
          soldById: order.soldById,
          saleChannelId: order.saleChannelId,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountForThisInvoice,
          discountRatio: 0,
          grandTotal,
          paidAmount: totalPaid,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          usingCod: order.usingCod || false,
          description: order.description,
          createdBy: userId,
          customerDebtSnapshot,
          details: {
            create: itemsToInvoice.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount,
              discountRatio: item.discountRatio,
              totalPrice: item.totalPrice,
              note: item.note,
            })),
          },
          ...(order.delivery && {
            delivery: {
              create: {
                receiver: order.delivery.receiver,
                contactNumber: order.delivery.contactNumber,
                address: order.delivery.address,
                locationName: order.delivery.locationName,
                wardName: order.delivery.wardName,
                weight: order.delivery.weight,
                length: order.delivery.length,
                width: order.delivery.width,
                height: order.delivery.height,
              },
            },
          }),
        },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
        },
      });

      if (isFirstInvoice && totalPaidFromOrder > 0) {
        for (const orderPayment of order.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TTTUHD${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: orderPayment.amount,
              transDate: orderPayment.paymentDate,
              method: orderPayment.paymentMethod || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.address,
              description: `Thu tiền tạm ứng từ đơn hàng ${order.code} sang hóa đơn ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
            },
          });

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: orderPayment.amount,
              paymentDate: orderPayment.paymentDate,
              paymentMethod: orderPayment.paymentMethod,
              description: `Thanh toán từ đơn hàng ${order.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      if (additionalPayment > 0) {
        const seq = await tx.invoicePayment.count({
          where: { invoiceId: invoice.id },
        });
        const paymentCode = `TT${invoice.code}-${seq + 1}`;
        await tx.invoicePayment.create({
          data: {
            code: paymentCode,
            invoiceId: invoice.id,
            amount: additionalPayment,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
            status: 1,
          },
        });
      }

      for (const item of itemsToInvoice) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: order.branchId },
          data: { onHand: { decrement: item.quantity } },
        });
      }

      const allInvoicedQty: Record<number, number> = {};
      const updatedInvoices = await tx.invoice.findMany({
        where: { orderId: order.id, status: { not: INVOICE_STATUS.CANCELLED } },
        include: { details: true },
      });
      updatedInvoices.forEach((inv) => {
        inv.details.forEach((d) => {
          allInvoicedQty[d.productId] =
            (allInvoicedQty[d.productId] || 0) + Number(d.quantity);
        });
      });

      const allComplete = order.items.every(
        (item) =>
          (allInvoicedQty[item.productId] || 0) >= Number(item.quantity),
      );

      await this.ordersService['updateOrderStatusByInvoices'](order.id, tx);

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);
      }

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          branch: true,
          soldBy: true,
        },
      });
    });
  }

  private async generateSafeInvoiceCode(tx: any): Promise<string> {
    const prefix = 'HD';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allInvoices = await tx.invoice.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allInvoices
        .map((inv: any) => inv.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.invoice.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã hóa đơn duy nhất');
  }

  async findUnpaidByPartner(partnerId: number, partnerType: string) {
    if (partnerType !== 'C' && partnerType !== 'S') {
      return { data: [] };
    }

    const where: any = {
      status: {
        notIn: [INVOICE_STATUS.CANCELLED],
      },
      debtAmount: {
        gt: 0,
      },
    };

    if (partnerType === 'C') {
      where.customerId = partnerId;
    } else {
      return { data: [] };
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
        status: true,
        statusValue: true,
      },
      orderBy: {
        purchaseDate: 'desc',
      },
    });

    return { data: invoices };
  }
}
