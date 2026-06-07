import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class InventoriesService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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
      include: {
        product: {
          select: {
            weight: true,
            weightUnit: true,
          },
        },
      },
    });

    if (!inventory) {
      throw new Error(
        `Inventory not found for product ${productId} at branch ${branchId}`,
      );
    }

    const updateData: any = { ...data };

    if (data.onHand !== undefined) {
      const weight = inventory.product.weight
        ? Number(inventory.product.weight)
        : 0;
      const onHand = Number(data.onHand);
      updateData.totalWeight = weight * onHand;
    }

    return this.prisma.inventory.update({
      where: {
        productId_branchId: {
          productId,
          branchId,
        },
      },
      data: updateData,
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
    const product = await this.prisma.product.findUnique({
      where: { id: data.productId },
      select: {
        weight: true,
        weightUnit: true,
      },
    });

    const weight = product?.weight ? Number(product.weight) : 0;
    const onHand = data.onHand || 0;
    const totalWeight = weight * onHand;

    return this.prisma.inventory.create({
      data: {
        productId: data.productId,
        productCode: data.productCode,
        productName: data.productName,
        branchId: data.branchId,
        branchName: data.branchName,
        cost: data.cost || 0,
        onHand: onHand,
        reserved: 0,
        onOrder: 0,
        minQuality: data.minQuality || 0,
        maxQuality: data.maxQuality || 0,
        totalWeight: totalWeight,
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

  async updateProductCondition(
    productId: number,
    branchId: number,
    data: { damagedQuantity?: number; nearExpiryQuantity?: number },
    userId?: number,
  ) {
    const inventory = await this.prisma.inventory.findUnique({
      where: {
        productId_branchId: { productId, branchId },
      },
    });

    if (!inventory) {
      throw new Error(
        `Inventory not found for product ${productId} at branch ${branchId}`,
      );
    }

    const onHand = Number(inventory.onHand);
    const newDamaged =
      data.damagedQuantity ?? Number(inventory.damagedQuantity);
    const newNearExpiry =
      data.nearExpiryQuantity ?? Number(inventory.nearExpiryQuantity);

    if (newDamaged + newNearExpiry > onHand) {
      throw new Error(
        `Tổng hàng bục rách (${newDamaged}) + cận date (${newNearExpiry}) = ${newDamaged + newNearExpiry} vượt quá tồn kho (${onHand})`,
      );
    }

    const oldDamaged = Number(inventory.damagedQuantity);
    const oldNearExpiry = Number(inventory.nearExpiryQuantity);

    const updated = await this.prisma.inventory.update({
      where: {
        productId_branchId: { productId, branchId },
      },
      data: {
        ...(data.damagedQuantity !== undefined && {
          damagedQuantity: data.damagedQuantity,
        }),
        ...(data.nearExpiryQuantity !== undefined && {
          nearExpiryQuantity: data.nearExpiryQuantity,
        }),
      },
    });

    // Audit log
    const [product, branch, actor] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId },
        select: { code: true, name: true },
      }),
      this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true },
      }),
      userId
        ? this.prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, email: true },
          })
        : Promise.resolve(null),
    ]);

    const changes: any[] = [];
    if (oldDamaged !== newDamaged) {
      changes.push({
        field: 'damagedQuantity',
        label: 'Hàng loại B',
        from: oldDamaged,
        to: newDamaged,
        type: 'field_changed',
      });
    }
    if (oldNearExpiry !== newNearExpiry) {
      changes.push({
        field: 'nearExpiryQuantity',
        label: 'Hàng cận date',
        from: oldNearExpiry,
        to: newNearExpiry,
        type: 'field_changed',
      });
    }

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INVENTORY_CONDITION_UPDATE',
      entityType: 'inventory_condition',
      entityId: `${productId}-${branchId}`,
      entityCode: product?.code,
      category: getCategoryFromActionCode('INVENTORY_CONDITION_UPDATE'),
      severity: getSeverityFromActionCode('INVENTORY_CONDITION_UPDATE'),
      snapshot: {
        productCode: product?.code,
        productName: product?.name,
        branchName: branch?.name,
        onHand,
        damagedQuantity: newDamaged,
        nearExpiryQuantity: newNearExpiry,
      },
      changes: changes.length > 0 ? changes : null,
      message: renderAuditMessage('INVENTORY_CONDITION_UPDATE', {
        productName: product?.name || `#${productId}`,
        branchName: branch?.name || `#${branchId}`,
      }),
      messageTemplate: 'INVENTORY_CONDITION_UPDATE',
      userId: userId || 1,
      userName: actor?.name || actor?.email || 'System',
      branchId,
    });

    return updated;
  }
}
