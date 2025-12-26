import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoiceDto, UpdateInvoiceDto, InvoiceQueryDto } from './dto';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: InvoiceQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      customerIds,
      branchIds,
      statusIds,
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

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (statusIds && statusIds.length > 0) {
      where.status = { in: statusIds };
    }

    if (fromPurchaseDate || toPurchaseDate) {
      where.purchaseDate = {};
      if (fromPurchaseDate) where.purchaseDate.gte = new Date(fromPurchaseDate);
      if (toPurchaseDate) where.purchaseDate.lte = new Date(toPurchaseDate);
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data: invoices, total, page, limit };
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
    const invoiceCount = await this.prisma.invoice.count();
    const code = `INV${String(invoiceCount + 1).padStart(6, '0')}`;

    const totalAmount = dto.items.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );
    const discountAmount = dto.discountAmount || 0;
    const discountFromRatio = (totalAmount * (dto.discountRatio || 0)) / 100;
    const grandTotal = totalAmount - discountAmount - discountFromRatio;
    const paidAmount = dto.paidAmount || 0;
    const debtAmount = grandTotal - paidAmount;

    const invoice = await this.prisma.invoice.create({
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
        usingCod: dto.usingCod || false,
        description: dto.description,
        createdBy: userId,
        details: {
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
            },
          },
        }),
      },
      include: {
        details: true,
        delivery: true,
      },
    });

    for (const item of dto.items) {
      await this.prisma.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: dto.branchId,
        },
        data: {
          onHand: { decrement: item.quantity },
        },
      });
    }

    return invoice;
  }

  async update(id: number, dto: UpdateInvoiceDto) {
    await this.findOne(id);

    const updateData: any = {};

    if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
    if (dto.branchId !== undefined) updateData.branchId = dto.branchId;
    if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
    if (dto.description !== undefined) updateData.description = dto.description;

    if (dto.items) {
      await this.prisma.invoiceDetail.deleteMany({ where: { invoiceId: id } });

      const totalAmount = dto.items.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );
      const discountAmount = dto.discountAmount || 0;
      const discountFromRatio = (totalAmount * (dto.discountRatio || 0)) / 100;
      const grandTotal = totalAmount - discountAmount - discountFromRatio;

      updateData.totalAmount = totalAmount;
      updateData.discount = discountAmount;
      updateData.discountRatio = dto.discountRatio || 0;
      updateData.grandTotal = grandTotal;
      updateData.debtAmount = grandTotal - (dto.paidAmount || 0);

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
    }

    if (dto.delivery) {
      await this.prisma.invoiceDelivery.deleteMany({
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
        },
      };
    }

    return this.prisma.invoice.update({
      where: { id },
      data: updateData,
      include: {
        details: true,
        delivery: true,
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.invoice.delete({ where: { id } });
  }
}
