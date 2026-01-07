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
  convertStatusNumberToString,
} from '../orders/dto/order-status.constants';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: InvoiceQueryDto) {
    const {
      page = 1,
      limit = 15,
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
        skip: (page - 1) * limit,
        take: limit,
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

    return { data, total, page, limit };
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

      const customerDebtSnapshot = Number(customer?.totalDebt) + debtAmount;

      console.log(customerDebtSnapshot);

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
            amount: paidAmount,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          },
        });

        const cashFlowCustomerDebtSnapshot = customer
          ? Number(customer.totalDebt) + debtAmount - paidAmount
          : null;

        await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: invoice.branchId,
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
            customerDebtSnapshot: cashFlowCustomerDebtSnapshot,
          },
        });
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
        include: { details: true },
      });

      if (!currentInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
      if (dto.branchId !== undefined) updateData.branchId = dto.branchId;
      if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
      if (dto.description !== undefined)
        updateData.description = dto.description;

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
          updateData.paidAmount = 0;
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

        updateData.totalAmount = totalAmount;
        updateData.discount = discountAmount;
        updateData.discountRatio = dto.discountRatio || 0;
        updateData.grandTotal = grandTotal;
        updateData.debtAmount = debtAmount;
        updateData.paidAmount = paidAmount;
        updateData.status = status;
        updateData.statusValue = getStatusLabel(status);

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

      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (invoice && invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);
      }

      return updatedInvoice;
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.invoice.delete({ where: { id } });
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await tx.invoicePayment.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
        },
      },
    });
    return `PTHD-${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: {
        customerId,
        status: { notIn: [INVOICE_STATUS.CANCELLED] },
      },
    });

    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );
    const totalDebt = invoices.reduce(
      (sum: number, invoice: any) => sum + Number(invoice.debtAmount),
      0,
    );

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
          items: { include: { product: true } },
          payments: true,
          delivery: true,
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
        throw new BadRequestException(
          'Không thể tạo hóa đơn từ đơn hàng đã hủy',
        );
      }

      if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BadRequestException('Đơn hàng đã được chuyển thành hóa đơn');
      }

      if (!order.branchId) {
        throw new BadRequestException('Đơn hàng không có thông tin chi nhánh');
      }

      const code = await this.generateSafeInvoiceCode(tx);

      const totalPaidFromOrder = Number(order.paidAmount || 0);
      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = totalPaidFromOrder + additionalPayment;

      const totalAmount = order.items.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );
      const discountAmount = Number(order.discount) || 0;
      const discountFromRatio =
        (totalAmount * (Number(order.discountRatio) || 0)) / 100;
      const grandTotal = totalAmount - discountAmount - discountFromRatio;
      const debtAmount = grandTotal - totalPaid;

      const customer = order.customerId
        ? await tx.customer.findUnique({
            where: { id: order.customerId },
            select: { totalDebt: true },
          })
        : null;

      const customerDebtSnapshot = Number(customer?.totalDebt) + debtAmount;

      let status: number = INVOICE_STATUS.PROCESSING;
      if (debtAmount <= 0) {
        status = INVOICE_STATUS.COMPLETED;
      }

      const invoice = await tx.invoice.create({
        data: {
          code,
          customerId: order.customerId,
          branchId: order.branchId,
          soldById: order.soldById,
          saleChannelId: order.saleChannelId,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountAmount,
          discountRatio: Number(order.discountRatio) || 0,
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
            create: order.items.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: Number(item.quantity),
              price: Number(item.price),
              discount: Number(item.discount) || 0,
              discountRatio: Number(item.discountRatio) || 0,
              totalPrice: Number(item.totalPrice),
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
                weight: Number(order.delivery.weight),
                length: Number(order.delivery.length),
                width: Number(order.delivery.width),
                height: Number(order.delivery.height),
                noteForDriver: order.delivery.noteForDriver,
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

      if (totalPaidFromOrder > 0) {
        let paymentSequence = 1;
        const paymentCodeFromOrder = `TT${invoice.code}-${paymentSequence}`;

        await tx.invoicePayment.create({
          data: {
            code: paymentCodeFromOrder,
            invoiceId: invoice.id,
            amount: totalPaidFromOrder,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thanh toán từ đơn hàng ${order.code}`,
          },
        });

        await tx.cashFlow.create({
          data: {
            code: paymentCodeFromOrder,
            branchId: invoice.branchId,
            isReceipt: true,
            amount: totalPaidFromOrder,
            transDate: new Date(),
            method: 'cash',
            partnerType: 'C',
            partnerId: invoice.customerId,
            partnerName: order.customer?.name,
            contactNumber: order.customer?.contactNumber,
            address: order.customer?.address,
            description: `Thu tiền từ đơn hàng ${order.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            customerDebtSnapshot:
              Number(customer?.totalDebt) + debtAmount - totalPaidFromOrder,
          },
        });
      }

      if (additionalPayment > 0) {
        const existingPayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invoice.id },
        });
        const paymentSequence = existingPayments.length + 1;
        const paymentCode = `TT${invoice.code}-${paymentSequence}`;

        await tx.invoicePayment.create({
          data: {
            code: paymentCode,
            invoiceId: invoice.id,
            amount: additionalPayment,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thanh toán thêm khi tạo hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          },
        });

        await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: invoice.branchId,
            isReceipt: true,
            amount: additionalPayment,
            transDate: new Date(),
            method: 'cash',
            partnerType: 'C',
            partnerId: invoice.customerId,
            partnerName: order.customer?.name,
            contactNumber: order.customer?.contactNumber,
            address: order.customer?.address,
            description: `Thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            customerDebtSnapshot:
              Number(customer?.totalDebt) + debtAmount - totalPaid,
          },
        });
      }

      for (const item of order.items) {
        await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            branchId: order.branchId,
          },
          data: {
            onHand: { decrement: Number(item.quantity) },
          },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: ORDER_STATUS.COMPLETED,
          statusValue: getOrderStatusLabel(ORDER_STATUS.COMPLETED),
          orderStatus: convertStatusNumberToString(ORDER_STATUS.COMPLETED),
          invoiceId: invoice.id,
          invoiceCode: invoice.code,
        },
      });

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
}
