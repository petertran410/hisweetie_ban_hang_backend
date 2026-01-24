import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateOrderSupplierDto,
  UpdateOrderSupplierDto,
  OrderSupplierQueryDto,
} from './dto';

@Injectable()
export class OrderSuppliersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: OrderSupplierQueryDto) {
    const {
      branchId,
      supplierId,
      status,
      createdById,
      userId,
      createdDateFrom,
      createdDateTo,
      pageSize = 15,
      currentItem = 0,
    } = query;

    const where: any = {};

    if (branchId) where.branchId = branchId;
    if (supplierId) where.supplierId = supplierId;
    if (status !== undefined) where.status = status;
    if (createdById) where.createdBy = createdById;
    if (userId) where.userId = userId;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        where.createdAt.lte = new Date(createdDateTo);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.orderSupplier.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          supplier: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          items: true,
          expensesOthers: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.orderSupplier.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  async findOne(id: number) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: {
        supplier: {
          select: {
            id: true,
            code: true,
            name: true,
            contactNumber: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        expensesOthers: true,
      },
    });

    if (!orderSupplier) {
      throw new NotFoundException(`OrderSupplier with id ${id} not found`);
    }

    return orderSupplier;
  }

  async create(dto: CreateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });

          if (!product) {
            throw new NotFoundException(
              `Product with id ${item.productId} not found`,
            );
          }

          const subTotal = item.quantity * item.price - (item.discount || 0);

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            subTotal,
            description: item.description,
            orderQuantity: item.quantity,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.subTotal),
        0,
      );
      const discount = dto.discount || 0;
      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : discount;
      const subTotal = total - discountAmount;
      const totalQuantity = itemsData.reduce(
        (sum, item) => sum + Number(item.quantity),
        0,
      );

      const orderSupplier = await tx.orderSupplier.create({
        data: {
          code,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          userId: dto.userId,
          description: dto.description,
          status: dto.status || 0,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          total,
          subTotal,
          totalAmt: subTotal,
          totalQty: totalQuantity,
          totalQuantity,
          supplierDebt: subTotal,
          toComplete: dto.toComplete || false,
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: true,
        },
      });

      return orderSupplier;
    });
  }

  async update(id: number, dto: UpdateOrderSupplierDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.orderSupplier.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!existing) {
        throw new NotFoundException(`OrderSupplier with id ${id} not found`);
      }

      if (dto.items) {
        await tx.orderSupplierItem.deleteMany({
          where: { orderSupplierId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!product) {
              throw new NotFoundException(
                `Product with id ${item.productId} not found`,
              );
            }

            const subTotal = item.quantity * item.price - (item.discount || 0);

            return {
              orderSupplierId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount || 0,
              subTotal,
              description: item.description,
              orderQuantity: item.quantity,
            };
          }),
        );

        await tx.orderSupplierItem.createMany({
          data: itemsData,
        });

        const total = itemsData.reduce(
          (sum, item) => sum + Number(item.subTotal),
          0,
        );
        const discount = dto.discount || existing.discount;
        const discountAmount = dto.discountRatio
          ? (total * dto.discountRatio) / 100
          : Number(discount);
        const subTotal = total - discountAmount;
        const totalQuantity = itemsData.reduce(
          (sum, item) => sum + Number(item.quantity),
          0,
        );

        return tx.orderSupplier.update({
          where: { id },
          data: {
            supplierId: dto.supplierId,
            branchId: dto.branchId,
            userId: dto.userId,
            description: dto.description,
            status: dto.status,
            discount: discountAmount,
            discountRatio: dto.discountRatio || existing.discountRatio,
            total,
            subTotal,
            totalAmt: subTotal,
            totalQty: totalQuantity,
            totalQuantity,
            supplierDebt: subTotal - Number(existing.paidAmount),
          },
          include: {
            supplier: true,
            branch: true,
            user: true,
            creator: true,
            items: true,
          },
        });
      }

      return tx.orderSupplier.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          userId: dto.userId,
          description: dto.description,
          status: dto.status,
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: true,
        },
      });
    });
  }

  async remove(id: number) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
    });

    if (!orderSupplier) {
      throw new NotFoundException(`OrderSupplier with id ${id} not found`);
    }

    await this.prisma.orderSupplier.delete({
      where: { id },
    });

    return { message: 'Xóa phiếu đặt hàng nhập thành công' };
  }

  private async generateCode(tx?: any): Promise<string> {
    const prisma = tx || this.prisma;
    const prefix = 'PDN';
    const today = new Date();
    const year = today.getFullYear().toString().slice(-2);
    const month = String(today.getMonth() + 1).padStart(2, '0');

    const lastOrder = await prisma.orderSupplier.findFirst({
      where: {
        code: {
          startsWith: `${prefix}${year}${month}`,
        },
      },
      orderBy: {
        code: 'desc',
      },
    });

    let nextNumber = 1;
    if (lastOrder) {
      const lastNumber = parseInt(lastOrder.code.slice(-6));
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${year}${month}${String(nextNumber).padStart(6, '0')}`;
  }
}
