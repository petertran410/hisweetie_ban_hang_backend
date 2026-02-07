import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
      const code = await this.generateSafePurchaseOrderCode(tx);

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product)
            throw new NotFoundException(`Product ${item.productId} not found`);

          const totalPrice =
            Number(item.quantity) * Number(item.price) -
            (Number(item.discount) || 0);

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            discountRatio: item.discountRatio || 0,
            totalPrice,
            description: item.description,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );

      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : Number(dto.discount || 0);

      const subTotal = total - discountAmount;
      const paidAmount = Number(dto.paidAmount || 0);
      const debtAmount = subTotal - paidAmount;

      const supplier = await tx.supplier.findUnique({
        where: { id: dto.supplierId },
        select: { debt: true },
      });
      const supplierOldDebt = Number(supplier?.debt || 0);

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          orderSupplierId: dto.orderSupplierId,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          total,
          totalAmount: total,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          subTotal,
          paidAmount,
          debtAmount,
          status: dto.isDraft ? 0 : 1,
          statusValue: dto.isDraft ? 'Phiếu tạm' : 'Đã nhập hàng',
          supplierOldDebt,
          supplierDebt: debtAmount,
          isDraft: dto.isDraft || false,
          partnerType: dto.partnerType,
          description: dto.description,
          purchaseById: dto.purchaseById,
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
        },
      });

      if (dto.branchId) {
        await this.updateInventory(purchaseOrder.id, tx);
      }

      await this.updateSupplierDebt(dto.supplierId, tx);

      if (dto.orderSupplierId) {
        await this.updateOrderSupplierStatus(dto.orderSupplierId, tx);
      }

      return tx.purchaseOrder.findUnique({
        where: { id: purchaseOrder.id },
        include: {
          orderSupplier: true,
          supplier: true,
          branch: true,
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          surcharges: true,
        },
      });
    });
  }

  async findAll(query: PurchaseOrderQueryDto) {
    const {
      pageSize = 15,
      orderSupplierId,
      currentItem = 0,
      search,
      supplierId,
      branchId,
      createdById,
      purchaseById,
      createdDateFrom,
      createdDateTo,
    } = query;

    const where: any = {};

    const orderSupplier = await this.prisma.orderSupplier.findMany({
      where: { id: orderSupplierId },
      select: { code: true },
    });

    console.log(orderSupplier);

    if (search) {
      where.OR = [{ code: { contains: search, mode: 'insensitive' } }];
    }
    if (supplierId) where.supplierId = supplierId;
    if (branchId) where.branchId = branchId;
    if (createdById) where.createdBy = createdById;
    if (purchaseById) where.purchaseById = purchaseById;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) where.createdAt.gte = new Date(createdDateFrom);
      if (createdDateTo) where.createdAt.lte = new Date(createdDateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          supplier: {
            select: { id: true, code: true, name: true, contactNumber: true },
          },
          branch: { select: { id: true, name: true } },
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { data, total, pageSize, currentItem, orderSupplier };
  }

  async findOne(id: number) {
    const purchaseOrder = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        branch: true,
        purchaseBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
        payments: true,
        surcharges: true,
      },
    });

    if (!purchaseOrder) {
      throw new NotFoundException('Purchase order not found');
    }

    return purchaseOrder;
  }

  async update(id: number, dto: UpdatePurchaseOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!existing) {
        throw new NotFoundException('Purchase order not found');
      }

      if (existing.branchId) {
        await this.restoreInventory(id, tx);
      }

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
              throw new NotFoundException(
                `Product ${item.productId} not found`,
              );

            const totalPrice =
              Number(item.quantity) * Number(item.price) -
              (Number(item.discount) || 0);

            return {
              purchaseOrderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount || 0,
              discountRatio: item.discountRatio || 0,
              totalPrice,
              description: item.description,
            };
          }),
        );

        await tx.purchaseOrderItem.createMany({ data: itemsData });
      }

      if (dto.surcharges) {
        await tx.purchaseOrderSurcharge.deleteMany({
          where: { purchaseOrderId: id },
        });
        if (dto.surcharges.length > 0) {
          await tx.purchaseOrderSurcharge.createMany({
            data: dto.surcharges.map((s) => ({
              purchaseOrderId: id,
              code: s.code,
              name: s.name,
              value: s.value,
              valueRatio: s.valueRatio,
              isSupplierExpense: s.isSupplierExpense || false,
              type: s.type || 0,
            })),
          });
        }
      }

      const items = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: id },
      });
      const total = items.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );

      await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : undefined,
          total,
          discount: dto.discount,
          discountRatio: dto.discountRatio,
          paidAmount: dto.paidAmount,
          isDraft: dto.isDraft,
          partnerType: dto.partnerType,
          description: dto.description,
          purchaseById: dto.purchaseById,
        },
      });

      const branchId = dto.branchId || existing.branchId;
      if (branchId) {
        await this.updateInventory(id, tx);
      }

      await this.updateSupplierDebt(dto.supplierId || existing.supplierId, tx);
      if (dto.supplierId && dto.supplierId !== existing.supplierId) {
        await this.updateSupplierDebt(existing.supplierId, tx);
      }

      return tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: true,
          branch: true,
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          surcharges: true,
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
        throw new NotFoundException('Purchase order not found');
      }

      if (purchaseOrder.branchId) {
        await this.restoreInventory(id, tx);
      }

      await tx.purchaseOrder.delete({ where: { id } });
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      return { message: 'Xóa phiếu nhập hàng thành công' };
    });
  }

  private async updateOrderSupplierStatus(orderSupplierId: number, tx: any) {
    const orderSupplier = await tx.orderSupplier.findUnique({
      where: { id: orderSupplierId },
      include: { items: true },
    });

    if (!orderSupplier) return;

    // Tính tổng số lượng đã nhập từ tất cả phiếu nhập hàng
    const allPurchaseOrders = await tx.purchaseOrder.findMany({
      where: { orderSupplierId: orderSupplierId },
      include: { items: true },
    });

    // Tính tổng số lượng từng sản phẩm đã nhập
    const receivedQuantities: { [productId: number]: number } = {};
    allPurchaseOrders.forEach((po) => {
      po.items.forEach((item) => {
        if (!receivedQuantities[item.productId]) {
          receivedQuantities[item.productId] = 0;
        }
        receivedQuantities[item.productId] += Number(item.quantity);
      });
    });

    // So sánh với số lượng đặt hàng
    let isFullyReceived = true;
    let hasPartialReceived = false;

    orderSupplier.items.forEach((orderItem) => {
      const receivedQty = receivedQuantities[orderItem.productId] || 0;
      const orderedQty = Number(orderItem.quantity);

      if (receivedQty < orderedQty) {
        isFullyReceived = false;
      }
      if (receivedQty > 0) {
        hasPartialReceived = true;
      }
    });

    // Update status
    let newStatus = orderSupplier.status;
    let newStatusValue = orderSupplier.statusValue;

    if (isFullyReceived && hasPartialReceived) {
      newStatus = 3; // Hoàn thành
      newStatusValue = 'Hoàn thành';
    } else if (hasPartialReceived) {
      newStatus = 2; // Nhập một phần
      newStatusValue = 'Nhập một phần';
    }

    await tx.orderSupplier.update({
      where: { id: orderSupplierId },
      data: {
        status: newStatus,
        statusValue: newStatusValue,
      },
    });
  }

  private async updateInventory(purchaseOrderId: number, tx: any) {
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
          onHand: { increment: Number(item.quantity) },
        },
      });
    }
  }

  private async restoreInventory(purchaseOrderId: number, tx: any) {
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
          onHand: { decrement: Number(item.quantity) },
        },
      });
    }
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    const purchaseOrders = await tx.purchaseOrder.findMany({
      where: { supplierId },
    });

    const totalDebt = purchaseOrders.reduce((sum, po) => {
      const total = Number(po.total);
      const discount = Number(po.discount);
      const paid = Number(po.paidAmount);
      return sum + (total - discount - paid);
    }, 0);

    await tx.supplier.update({
      where: { id: supplierId },
      data: { debt: totalDebt },
    });
  }

  private async generateSafePurchaseOrderCode(tx: any): Promise<string> {
    const prefix = 'PN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPurchaseOrders = await tx.purchaseOrder.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
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
