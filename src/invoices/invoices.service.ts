import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoiceDto, UpdateInvoiceDto, InvoiceQueryDto } from './dto';
import { Prisma } from '@prisma/client';

const INVOICE_STATUS = {
  PROCESSING: 3,
  COMPLETED: 1,
  CANCELLED: 2,
  NOT_DELIVERED: 5,
};

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: InvoiceQueryDto) {
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
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (branchId) where.branchId = branchId;
    if (soldById) where.soldById = soldById;
    if (saleChannelId) where.saleChannelId = saleChannelId;

    if (fromDate && toDate) {
      where.purchaseDate = {
        gte: new Date(fromDate),
        lte: new Date(toDate),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: true,
          branch: true,
          soldBy: true,
          creator: true,
          saleChannel: true,
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
        saleChannel: true,
        details: {
          include: { product: true },
        },
        payments: true,
        surcharges: true,
        delivery: {
          include: {
            location: true,
            partnerDelivery: true,
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Không tìm thấy hóa đơn');
    }

    return invoice;
  }

  async create(dto: CreateInvoiceDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const lastInvoice = await tx.invoice.findFirst({
        orderBy: { id: 'desc' },
      });
      const code = `HD${String((lastInvoice?.id || 0) + 1).padStart(6, '0')}`;

      const invoice = await tx.invoice.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId: dto.branchId,
          soldById: userId,
          saleChannelId: dto.saleChannelId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          discount: dto.discountAmount || 0,
          discountRatio: dto.discountRatio || 0,
          usingCod: dto.usingCod || false,
          description: dto.notes,
          status: INVOICE_STATUS.PROCESSING,
          statusValue: 'Đang xử lý',
          createdBy: userId,
        },
      });

      if (dto.items && dto.items.length > 0) {
        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!product) {
              throw new NotFoundException(
                `Không tìm thấy sản phẩm với ID ${item.productId}`,
              );
            }

            const itemDiscount = item.discount || 0;
            const itemDiscountRatio = item.discountRatio || 0;
            const totalPrice =
              item.quantity * item.unitPrice -
              itemDiscount -
              (item.quantity * item.unitPrice * itemDiscountRatio) / 100;

            return {
              invoiceId: invoice.id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.unitPrice,
              discount: itemDiscount,
              discountRatio: itemDiscountRatio,
              totalPrice: totalPrice,
              note: item.note || null,
              serialNumbers: item.serialNumbers || null,
            };
          }),
        );

        await tx.invoiceDetail.createMany({
          data: itemsData,
        });
      }

      if (dto.delivery) {
        await tx.invoiceDelivery.create({
          data: {
            invoiceId: invoice.id,
            receiver: dto.delivery.receiver || '',
            contactNumber: dto.delivery.contactNumber || '',
            address: dto.delivery.address || '',
            locationName: dto.delivery.locationName,
            wardName: dto.delivery.wardName,
            weight: dto.delivery.weight,
            length: dto.delivery.length || 10,
            width: dto.delivery.width || 10,
            height: dto.delivery.height || 10,
            partnerDeliveryId: dto.delivery.partnerDeliveryId,
            usingPriceCod: dto.usingCod || false,
            priceCodPayment: dto.usingCod ? dto.totalPayment : 0,
          },
        });
      }

      await this.calculateTotals(invoice.id, tx);

      if (dto.customerId) {
        await this.updateCustomerTotals(dto.customerId, tx);
      }

      return this.findOne(invoice.id);
    });
  }

  async update(id: number, dto: UpdateInvoiceDto) {
    const existingInvoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { delivery: true },
    });

    if (!existingInvoice) {
      throw new NotFoundException('Không tìm thấy hóa đơn');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.items && dto.items.length > 0) {
        await tx.invoiceDetail.deleteMany({
          where: { invoiceId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!product) {
              throw new NotFoundException(
                `Không tìm thấy sản phẩm với ID ${item.productId}`,
              );
            }

            const itemDiscount = item.discount || 0;
            const itemDiscountRatio = item.discountRatio || 0;
            const totalPrice =
              item.quantity * item.unitPrice -
              itemDiscount -
              (item.quantity * item.unitPrice * itemDiscountRatio) / 100;

            return {
              invoiceId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.unitPrice,
              discount: itemDiscount,
              discountRatio: itemDiscountRatio,
              totalPrice: totalPrice,
              note: item.note || null,
              serialNumbers: item.serialNumbers || null,
            };
          }),
        );

        await tx.invoiceDetail.createMany({
          data: itemsData,
        });
      }

      const updateData: any = {
        customerId: dto.customerId,
        branchId: dto.branchId,
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        discount: dto.discountAmount,
        discountRatio: dto.discountRatio,
        paidAmount: dto.totalPayment,
        description: dto.notes,
      };

      if (dto.invoiceStatus !== undefined) {
        updateData.status = dto.invoiceStatus;
        updateData.statusValue = this.getStatusLabel(dto.invoiceStatus);
      }

      await tx.invoice.update({
        where: { id },
        data: updateData,
      });

      if (dto.delivery) {
        if (existingInvoice.delivery) {
          await tx.invoiceDelivery.update({
            where: { invoiceId: id },
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
            },
          });
        } else {
          await tx.invoiceDelivery.create({
            data: {
              invoiceId: id,
              receiver: dto.delivery.receiver || '',
              contactNumber: dto.delivery.contactNumber || '',
              address: dto.delivery.address || '',
              locationName: dto.delivery.locationName,
              wardName: dto.delivery.wardName,
              weight: dto.delivery.weight,
              length: dto.delivery.length || 10,
              width: dto.delivery.width || 10,
              height: dto.delivery.height || 10,
            },
          });
        }
      }

      await this.calculateTotals(id, tx);

      if (existingInvoice.customerId) {
        await this.updateCustomerTotals(existingInvoice.customerId, tx);
      }

      return tx.invoice.findUnique({
        where: { id },
        include: {
          customer: true,
          details: { include: { product: true } },
          payments: true,
          delivery: true,
        },
      });
    });
  }

  async remove(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { customer: true },
    });

    if (!invoice) {
      throw new NotFoundException('Không tìm thấy hóa đơn');
    }

    await this.prisma.invoice.delete({ where: { id } });

    if (invoice.customerId) {
      await this.updateCustomerTotals(invoice.customerId);
    }

    return { message: 'Xóa hóa đơn thành công' };
  }

  private async calculateTotals(
    invoiceId: number,
    tx?: Prisma.TransactionClient,
  ) {
    const prisma = tx || this.prisma;

    const items = await prisma.invoiceDetail.findMany({
      where: { invoiceId },
    });

    const totalAmount = items.reduce(
      (sum, item) => sum + Number(item.totalPrice),
      0,
    );

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new NotFoundException('Không tìm thấy hóa đơn');
    }

    const discount = Number(invoice.discount || 0);
    const discountRatio = Number(invoice.discountRatio || 0);
    const discountAmount = discount + (totalAmount * discountRatio) / 100;
    const grandTotal = totalAmount - discountAmount;

    const payments = await prisma.invoicePayment.findMany({
      where: { invoiceId },
    });

    const paidAmount = payments.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0,
    );

    const debtAmount = grandTotal - paidAmount;

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        totalAmount,
        grandTotal,
        paidAmount,
        debtAmount,
      },
    });
  }

  private async updateCustomerTotals(
    customerId: number,
    tx?: Prisma.TransactionClient,
  ) {
    const prisma = tx || this.prisma;

    const invoices = await prisma.invoice.findMany({
      where: { customerId, status: { not: INVOICE_STATUS.CANCELLED } },
    });

    const totalInvoiced = invoices.reduce(
      (sum, inv) => sum + Number(inv.grandTotal),
      0,
    );
    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + Number(inv.paidAmount),
      0,
    );
    const totalDebt = invoices.reduce(
      (sum, inv) => sum + Number(inv.debtAmount),
      0,
    );

    await prisma.customer.update({
      where: { id: customerId },
      data: {
        totalInvoiced,
        totalRevenue,
        totalDebt,
      },
    });
  }

  private getStatusLabel(status: number): string {
    switch (status) {
      case INVOICE_STATUS.PROCESSING:
        return 'Đang xử lý';
      case INVOICE_STATUS.COMPLETED:
        return 'Hoàn thành';
      case INVOICE_STATUS.CANCELLED:
        return 'Đã hủy';
      case INVOICE_STATUS.NOT_DELIVERED:
        return 'Không giao được';
      default:
        return 'Không xác định';
    }
  }
}
