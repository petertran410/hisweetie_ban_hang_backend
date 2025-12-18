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

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product) throw new Error(`Product ${item.productId} not found`);

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.unitPrice,
            totalPrice: item.quantity * item.unitPrice,
          };
        }),
      );

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          supplierId: dto.supplierId,
          purchaseDate: dto.purchaseDate || new Date(),
          shippingFee: dto.shippingFee || 0,
          otherFees: dto.otherFees || 0,
          description: dto.notes,
          createdBy: userId,
          items: {
            create: itemsData,
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
    const { page = 1, limit = 10, search, supplierId, status } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [{ code: { contains: search, mode: 'insensitive' } }];
    }
    if (supplierId) where.supplierId = supplierId;
    if (status) where.paymentStatus = status;

    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
        orderBy: { purchaseDate: 'desc' },
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
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
      },
    });
  }

  async update(id: number, dto: UpdatePurchaseOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!existing) {
        throw new Error('Purchase order not found');
      }

      await this.restoreProductStock(id, tx);

      if (dto.items) {
        await tx.purchaseOrderItem.deleteMany({
          where: { purchaseOrderId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new Error(`Product ${item.productId} not found`);

            return {
              purchaseOrderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.unitPrice,
              totalPrice: item.quantity * item.unitPrice,
            };
          }),
        );

        await tx.purchaseOrderItem.createMany({
          data: itemsData,
        });
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          purchaseDate: dto.purchaseDate,
          shippingFee: dto.shippingFee,
          otherFees: dto.otherFees,
          description: dto.notes,
        },
      });

      await this.calculateTotals(id, tx);
      await this.updateProductStock(id, tx);
      await this.updateSupplierDebt(existing.supplierId, tx);
      if (dto.supplierId && dto.supplierId !== existing.supplierId) {
        await this.updateSupplierDebt(dto.supplierId, tx);
      }

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

      if (!purchaseOrder) {
        throw new Error('Purchase order not found');
      }

      await this.restoreProductStock(id, tx);

      if (purchaseOrder.branchId) {
        for (const item of purchaseOrder.items) {
          await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              branchId: purchaseOrder.branchId,
            },
            data: {
              onHand: {
                decrement: Number(item.quantity),
              },
            },
          });
        }
      }

      await tx.purchaseOrder.delete({ where: { id } });
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);
    });
  }

  private async generateCode(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.purchaseOrder.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
        },
      },
    });
    return `PO-${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async calculateTotals(purchaseOrderId: number, tx: any) {
    const items = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId },
    });
    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );

    const po = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    if (!po) return;

    const grandTotal =
      totalAmount + Number(po.shippingFee) + Number(po.otherFees);
    const debtAmount = grandTotal - Number(po.paidAmount);

    let paymentStatus = 'unpaid';
    if (Number(po.paidAmount) >= grandTotal) paymentStatus = 'paid';
    else if (Number(po.paidAmount) > 0) paymentStatus = 'partial';

    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { totalAmount, grandTotal, debtAmount, paymentStatus },
    });
  }

  private async updateProductStock(purchaseOrderId: number, tx: any) {
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return;

    for (const item of purchaseOrder.items) {
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          onHand: {
            increment: Number(item.quantity),
          },
        },
      });
    }
  }

  private async restoreProductStock(purchaseOrderId: number, tx: any) {
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return;

    for (const item of purchaseOrder.items) {
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          onHand: {
            decrement: Number(item.quantity),
          },
        },
      });
    }
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId },
    });

    const totalDebt = purchaseOrders.reduce(
      (sum: number, po: any) => sum + Number(po.debtAmount),
      0,
    );

    await tx.supplier.update({
      where: { id: supplierId },
      data: { totalDebt },
    });
  }
}
