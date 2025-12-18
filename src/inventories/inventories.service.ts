import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InventoriesService {
  constructor(private prisma: PrismaService) {}

  async getInventoryByBranch(branchId: number, productIds?: number[]) {
    const where: any = { branchId };

    if (productIds && productIds.length > 0) {
      where.productId = { in: productIds };
    }

    return this.prisma.inventory.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
            unit: true,
            isActive: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ productCode: 'asc' }],
    });
  }

  async getProductInventoryAcrossBranches(productId: number) {
    return this.prisma.inventory.findMany({
      where: { productId },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
            unit: true,
          },
        },
      },
      orderBy: [{ branchName: 'asc' }],
    });
  }

  async updateInventory(
    productId: number,
    branchId: number,
    data: {
      cost?: number;
      onHand?: number;
      reserved?: number;
      onOrder?: number;
      minQuality?: number;
      maxQuality?: number;
    },
  ) {
    const inventory = await this.prisma.inventory.findUnique({
      where: {
        productId_branchId: {
          productId,
          branchId,
        },
      },
    });

    if (!inventory) {
      throw new Error(
        `Inventory not found for product ${productId} at branch ${branchId}`,
      );
    }

    return this.prisma.inventory.update({
      where: {
        productId_branchId: {
          productId,
          branchId,
        },
      },
      data,
    });
  }

  async createInventory(data: {
    productId: number;
    productCode: string;
    productName: string;
    branchId: number;
    branchName: string;
    cost?: number;
    onHand?: number;
    minQuality?: number;
    maxQuality?: number;
  }) {
    return this.prisma.inventory.create({
      data: {
        productId: data.productId,
        productCode: data.productCode,
        productName: data.productName,
        branchId: data.branchId,
        branchName: data.branchName,
        cost: data.cost || 0,
        onHand: data.onHand || 0,
        reserved: 0,
        onOrder: 0,
        minQuality: data.minQuality || 0,
        maxQuality: data.maxQuality || 0,
      },
    });
  }

  async getLowStockProducts(branchId?: number) {
    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    const allInventories = await this.prisma.inventory.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return allInventories.filter(
      (inv) => Number(inv.onHand) <= Number(inv.minQuality),
    );
  }
}
