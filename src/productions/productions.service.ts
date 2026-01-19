import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
} from './dto';
import { Decimal } from '@prisma/client/runtime';

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
      include: {
        comboComponents: {
          include: {
            componentProduct: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.type !== 4) {
      throw new BadRequestException(
        'Product must be a manufacturing product (type = 4)',
      );
    }

    if (!product.weight) {
      throw new BadRequestException(
        'Manufacturing product must have weight defined',
      );
    }

    const sourceBranch = await this.prisma.branch.findUnique({
      where: { id: dto.sourceBranchId },
    });

    if (!sourceBranch) {
      throw new NotFoundException('Source branch not found');
    }

    const destinationBranch = await this.prisma.branch.findUnique({
      where: { id: dto.destinationBranchId },
    });

    if (!destinationBranch) {
      throw new NotFoundException('Destination branch not found');
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

    const totalCost = this.calculateTotalCost(
      product.comboComponents,
      dto.sourceBranchId,
      dto.quantity,
    );

    return await this.prisma.$transaction(async (tx) => {
      const production = await tx.production.create({
        data: {
          code,
          sourceBranchId: dto.sourceBranchId,
          sourceBranchName: sourceBranch.name,
          destinationBranchId: dto.destinationBranchId,
          destinationBranchName: destinationBranch.name,
          productId: dto.productId,
          productCode: product.code,
          productName: product.name,
          quantity: dto.quantity,
          totalCost: await totalCost,
          note: dto.note,
          status: dto.status || 1,
          createdById: userId,
          createdByName: user?.name || '',
          autoDeductComponents: dto.autoDeductComponents ?? true,
          manufacturedDate: dto.manufacturedDate
            ? new Date(dto.manufacturedDate)
            : new Date(),
        },
      });

      if (dto.status === 2 && dto.autoDeductComponents) {
        await this.processInventoryChanges(
          tx,
          product,
          dto.sourceBranchId,
          dto.destinationBranchId,
          dto.quantity,
        );
      }

      return production;
    });
  }

  async update(id: number, dto: UpdateProductionDto) {
    const production = await this.findOne(id);

    const updateData: any = {};

    if (dto.quantity !== undefined) updateData.quantity = dto.quantity;
    if (dto.note !== undefined) updateData.note = dto.note;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.manufacturedDate !== undefined) {
      updateData.manufacturedDate = new Date(dto.manufacturedDate);
    }
    if (dto.autoDeductComponents !== undefined) {
      updateData.autoDeductComponents = dto.autoDeductComponents;
    }

    return await this.prisma.$transaction(async (tx) => {
      if (dto.status === 2 && production.status !== 2) {
        const product = await tx.product.findUnique({
          where: { id: production.productId },
          include: {
            comboComponents: {
              include: {
                componentProduct: true,
              },
            },
          },
        });

        if (product && updateData.autoDeductComponents !== false) {
          await this.processInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
            Number(production.quantity),
          );
        }
      }

      return tx.production.update({
        where: { id },
        data: updateData,
      });
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.production.delete({
      where: { id },
    });
  }

  private async calculateTotalCost(
    components: any[],
    branchId: number,
    quantity: number,
  ): Promise<number> {
    let totalCost = 0;

    for (const comp of components) {
      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: branchId,
          },
        },
      });

      if (inventory) {
        const componentWeight = comp.componentProduct.weight
          ? Number(comp.componentProduct.weight)
          : 0;
        const componentWeightUnit = comp.componentProduct.weightUnit || 'g';
        const weightInGrams =
          componentWeightUnit === 'kg'
            ? componentWeight * 1000
            : componentWeight;

        if (weightInGrams > 0) {
          const requiredGrams = Number(comp.quantity) * Number(quantity);
          const costPerGram = Number(inventory.cost) / weightInGrams;
          totalCost += costPerGram * requiredGrams;
        }
      }
    }

    return totalCost;
  }

  private async processInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
    quantity: number | Decimal,
  ) {
    const quantityNumber =
      typeof quantity === 'number' ? quantity : Number(quantity);

    for (const comp of product.comboComponents) {
      const componentProduct = comp.componentProduct;
      const componentWeight = componentProduct.weight
        ? Number(componentProduct.weight)
        : 0;
      const componentWeightUnit = componentProduct.weightUnit || 'g';
      const weightInGrams =
        componentWeightUnit === 'kg' ? componentWeight * 1000 : componentWeight;

      if (weightInGrams === 0) {
        throw new BadRequestException(
          `Component ${componentProduct.name} must have weight defined`,
        );
      }

      const requiredGrams = Number(comp.quantity) * quantityNumber;
      const unitsToDeduct = requiredGrams / weightInGrams;

      const sourceInventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
      });

      if (!sourceInventory) {
        throw new NotFoundException(
          `Inventory for component ${componentProduct.name} not found at source branch`,
        );
      }

      if (Number(sourceInventory.onHand) < unitsToDeduct) {
        throw new BadRequestException(
          `Insufficient inventory for component ${componentProduct.name}. Required: ${unitsToDeduct}, Available: ${sourceInventory.onHand}`,
        );
      }

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
        data: {
          onHand: Number(sourceInventory.onHand) - unitsToDeduct,
        },
      });
    }

    const destInventory = await tx.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
    });

    if (destInventory) {
      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: product.id,
            branchId: destinationBranchId,
          },
        },
        data: {
          onHand: Number(destInventory.onHand) + quantityNumber,
        },
      });
    } else {
      const destBranch = await tx.branch.findUnique({
        where: { id: destinationBranchId },
      });

      await tx.inventory.create({
        data: {
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          branchId: destinationBranchId,
          branchName: destBranch?.name || '',
          cost: 0,
          onHand: quantityNumber,
          reserved: 0,
          onOrder: 0,
          minQuality: 0,
          maxQuality: 0,
        },
      });
    }
  }
}
