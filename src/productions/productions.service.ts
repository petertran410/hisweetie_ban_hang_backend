import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
} from './dto';

@Injectable()
export class ProductionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: ProductionQueryDto) {
    const {
      branchIds,
      status,
      fromManufacturedDate,
      toManufacturedDate,
      pageSize = 15,
      currentItem = 0,
      search,
    } = query;

    const where: any = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (fromManufacturedDate || toManufacturedDate) {
      where.manufacturedDate = {};
      if (fromManufacturedDate) {
        where.manufacturedDate.gte = new Date(fromManufacturedDate);
      }
      if (toManufacturedDate) {
        where.manufacturedDate.lte = new Date(toManufacturedDate);
      }
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { productName: { contains: search, mode: 'insensitive' } },
        { productCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, data] = await Promise.all([
      this.prisma.production.count({ where }),
      this.prisma.production.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      pageSize,
      data,
    };
  }

  async findOne(id: number) {
    const production = await this.prisma.production.findUnique({
      where: { id },
    });

    if (!production) {
      throw new NotFoundException(`Production with ID ${id} not found`);
    }

    return production;
  }

  async create(dto: CreateProductionDto, userId: number) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
    });

    if (!branch) {
      throw new NotFoundException('Branch not found');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    const lastProduction = await this.prisma.production.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastProduction?.code) {
      const match = lastProduction.code.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0]) + 1;
      }
    }

    const code = dto.code || `SX${String(nextNumber).padStart(6, '0')}`;

    const inventory = await this.prisma.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: dto.productId,
          branchId: dto.branchId,
        },
      },
    });

    const totalCost = inventory
      ? Number(inventory.cost) * Number(dto.quantity)
      : 0;

    return this.prisma.production.create({
      data: {
        code,
        branchId: dto.branchId,
        branchName: branch.name,
        productId: dto.productId,
        productCode: product.code,
        productName: product.name,
        quantity: dto.quantity,
        totalCost,
        note: dto.note,
        status: dto.status || 1,
        createdById: userId,
        createdByName: user?.name || '',
        manufacturedDate: dto.manufacturedDate
          ? new Date(dto.manufacturedDate)
          : null,
      },
    });
  }

  async update(id: number, dto: UpdateProductionDto) {
    const production = await this.findOne(id);

    const updateData: any = {};

    if (dto.quantity !== undefined) {
      updateData.quantity = dto.quantity;

      const branchId =
        dto.branchId !== undefined ? dto.branchId : production.branchId;
      const productId =
        dto.productId !== undefined ? dto.productId : production.productId;

      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: productId,
            branchId: branchId,
          },
        },
      });

      updateData.totalCost = inventory
        ? Number(inventory.cost) * Number(dto.quantity)
        : 0;
    }

    if (dto.note !== undefined) updateData.note = dto.note;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.manufacturedDate !== undefined) {
      updateData.manufacturedDate = new Date(dto.manufacturedDate);
    }

    return this.prisma.production.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.production.delete({
      where: { id },
    });
  }
}
