import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
} from './dto';

@Injectable()
export class PurchaseOrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePurchaseOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode();

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          supplierId: dto.supplierId,
          purchaseDate: dto.purchaseDate,
          shippingFee: dto.shippingFee || 0,
          otherFees: dto.otherFees || 0,
          paidAmount: dto.paidAmount || 0,
          notes: dto.notes,
          createdBy: userId,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.quantity * item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      await this.calculateTotals(purchaseOrder.id, tx);
      await this.updateProductStock(purchaseOrder.id, tx);
      await this.updateSupplierDebt(dto.supplierId, tx);

      return tx.purchaseOrder.findUnique({
        where: { id: purchaseOrder.id },
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
      });
    });
  }

  async findAll(query: PurchaseOrderQueryDto) {
    const { page = 1, limit = 10, search, supplierId, paymentStatus } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) where.code = { contains: search, mode: 'insensitive' };
    if (supplierId) where.supplierId = supplierId;
    if (paymentStatus) where.paymentStatus = paymentStatus;

    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        include: {
          supplier: true,
          items: { include: { product: true } },
          creator: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        items: { include: { product: true } },
        creator: { select: { id: true, name: true } },
      },
    });
  }

  async update(id: number, dto: UpdatePurchaseOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          purchaseDate: dto.purchaseDate,
          shippingFee: dto.shippingFee,
          otherFees: dto.otherFees,
          paidAmount: dto.paidAmount,
          notes: dto.notes,
        },
      });

      await this.calculateTotals(id, tx);
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      return tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
      });
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });

      for (const item of purchaseOrder.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stockQuantity: { decrement: item.quantity } },
        });
      }

      await tx.purchaseOrder.delete({ where: { id } });
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);
    });
  }

  private async calculateTotals(purchaseOrderId: number, tx: any) {
    const items = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId },
    });
    const totalAmount = items.reduce((sum, item) => sum + item.totalPrice, 0);

    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    const grandTotal =
      totalAmount + purchaseOrder.shippingFee + purchaseOrder.otherFees;
    const debtAmount = grandTotal - purchaseOrder.paidAmount;

    let paymentStatus = 'unpaid';
    if (purchaseOrder.paidAmount === 0) paymentStatus = 'unpaid';
    else if (purchaseOrder.paidAmount >= grandTotal) paymentStatus = 'paid';
    else paymentStatus = 'partial';

    return tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { totalAmount, grandTotal, debtAmount, paymentStatus },
    });
  }

  private async updateProductStock(purchaseOrderId: number, tx: any) {
    const items = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId },
    });
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQuantity: { increment: item.quantity } },
      });
    }
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId },
    });

    const totalDebt = purchaseOrders.reduce(
      (sum, po) => sum + po.debtAmount,
      0,
    );

    await tx.supplier.update({
      where: { id: supplierId },
      data: { totalDebt },
    });
  }

  private async generateCode(): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().slice(2, 10).replace(/-/g, '');
    const count = await this.prisma.purchaseOrder.count({
      where: {
        createdAt: {
          gte: new Date(date.setHours(0, 0, 0, 0)),
          lt: new Date(date.setHours(23, 59, 59, 999)),
        },
      },
    });
    return `PN${dateStr}${String(count + 1).padStart(4, '0')}`;
  }
}
