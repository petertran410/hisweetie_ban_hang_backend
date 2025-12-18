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
            retailPrice: true,
          },
        },
      },
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
          },
        },
      },
    });
  }
}
