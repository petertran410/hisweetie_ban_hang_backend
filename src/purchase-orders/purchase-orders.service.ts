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
    const {
      pageSize = 10,
      currentItem = 0,
      search,
      supplierId,
      status,
    } = query;
    const skip = currentItem;
    const take = pageSize;

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
        take,
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
        orderBy: { purchaseDate: 'desc' },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { data, total, pageSize, currentItem };
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

    let paymentStatus = 'Draft';
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

  async createFromOrderSupplier(
    orderSupplierId: number,
    dto: CreatePurchaseOrderFromOrderSupplierDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id: orderSupplierId },
        include: {
          supplier: true,
          branch: true,
          items: {
            include: {
              product: true,
            },
          },
        },
      });

      if (!orderSupplier) {
        throw new NotFoundException('OrderSupplier not found');
      }

      if (orderSupplier.status === 4) {
        throw new BadRequestException(
          'Không thể tạo phiếu nhập từ đặt hàng nhập đã hủy',
        );
      }

      if (orderSupplier.status === 3) {
        throw new BadRequestException(
          'Đặt hàng nhập đã được chuyển thành phiếu nhập hàng',
        );
      }

      if (!orderSupplier.branchId) {
        throw new BadRequestException(
          'Đặt hàng nhập không có thông tin chi nhánh',
        );
      }

      const code = await this.generateSafePurchaseOrderCode(tx);

      const totalPaidFromOrderSupplier = Number(orderSupplier.paidAmount);
      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = totalPaidFromOrderSupplier + additionalPayment;

      const totalAmount = orderSupplier.items.reduce(
        (sum, item) => sum + Number(item.subTotal),
        0,
      );
      const discountAmount = Number(orderSupplier.discount) || 0;
      const discountFromRatio =
        (totalAmount * (Number(orderSupplier.discountRatio) || 0)) / 100;
      const grandTotal = totalAmount - discountAmount - discountFromRatio;
      const debtAmount = grandTotal - totalPaid;

      let status: number = 0;
      if (debtAmount <= 0) {
        status = 1;
      }

      const currentSupplierDebt = Number(orderSupplier.supplier?.debt || 0);
      const supplierDebtSnapshot =
        currentSupplierDebt + grandTotal - additionalPayment;

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          supplierId: orderSupplier.supplierId,
          branchId: orderSupplier.branchId,
          purchaseById: orderSupplier.userId,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountAmount,
          discountRatio: Number(orderSupplier.discountRatio) || 0,
          grandTotal,
          paidAmount: totalPaid,
          debtAmount,
          status,
          statusValue: this.getStatusLabel(status),
          isDraft: false,
          description: orderSupplier.description,
          createdBy: userId,
          supplierDebtSnapshot,
          items: {
            create: orderSupplier.items.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: Number(item.quantity),
              price: Number(item.price),
              discount: Number(item.discount) || 0,
              discountRatio: 0,
              totalPrice: Number(item.subTotal),
              description: item.description,
            })),
          },
        },
        include: {
          items: true,
        },
      });

      if (additionalPayment > 0) {
        const paymentCode = `TT${purchaseOrder.code}-1`;
        await tx.purchaseOrderPayment.create({
          data: {
            code: paymentCode,
            purchaseOrderId: purchaseOrder.id,
            amount: additionalPayment,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thanh toán bổ sung từ đặt hàng nhập ${orderSupplier.code}`,
          },
        });
      }

      await this.updateProductStock(purchaseOrder.id, tx);
      await this.updateSupplierDebt(orderSupplier.supplierId, tx);

      await tx.orderSupplier.update({
        where: { id: orderSupplierId },
        data: {
          purchaseOrderId: purchaseOrder.id,
          status: 3,
          statusValue: 'Hoàn thành',
          purchaseOrderCodes: purchaseOrder.code,
        },
      });

      return tx.purchaseOrder.findUnique({
        where: { id: purchaseOrder.id },
        include: {
          supplier: true,
          branch: true,
          items: { include: { product: true } },
          payments: true,
        },
      });
    });
  }

  private getStatusLabel(status: number): string {
    const labels: Record<number, string> = {
      0: 'Phiếu tạm',
      1: 'Đã nhập hàng',
      2: 'Đã hủy',
    };
    return labels[status] || 'Không xác định';
  }

  private async generateSafePurchaseOrderCode(tx: any): Promise<string> {
    const prefix = 'PN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPurchaseOrders = await tx.purchaseOrder.findMany({
        where: {
          code: { startsWith: prefix },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allPurchaseOrders
        .map((po: any) => po.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
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

      const exists = await tx.purchaseOrder.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu nhập hàng duy nhất');
  }
}
