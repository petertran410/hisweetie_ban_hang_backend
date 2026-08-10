import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const PURCHASING_BRANCH_NAMES = ['Kho Hà Nội', 'Kho Sài Gòn'] as const;

export type PurchasingBranchScope = {
  branches: Array<{
    id: number;
    name: (typeof PURCHASING_BRANCH_NAMES)[number];
    code: string | null;
  }>;
};

export function resolvePurchasingBranchScope(
  rows: Array<{ id: number; name: string; code: string | null }>,
): PurchasingBranchScope {
  const branches = PURCHASING_BRANCH_NAMES.map((name) => {
    const matches = rows.filter((row) => row.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Purchasing branch scope requires exactly one active branch named "${name}"; found ${matches.length}`,
      );
    }
    return { id: matches[0].id, name, code: matches[0].code };
  });
  return { branches };
}

@Injectable()
export class PurchasingPlanningRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getPurchasingBranchScope(): Promise<PurchasingBranchScope> {
    return resolvePurchasingBranchScope(
      await this.prisma.branch.findMany({
        where: {
          isActive: true,
          name: { in: [...PURCHASING_BRANCH_NAMES] },
        },
        select: { id: true, name: true, code: true },
      }),
    );
  }

  findRecommendation(date?: Date) {
    return this.prisma.purchaseRecommendation.findFirst({
      where: {
        ...(date
          ? { snapshotDate: date, status: { in: ['ACTIVE', 'SUPERSEDED'] } }
          : { status: 'ACTIVE' }),
      },
      orderBy: [{ snapshotDate: 'desc' }, { id: 'desc' }],
      include: {
        run: true,
        items: true,
      },
    });
  }

  findItem(itemId: number) {
    return this.prisma.recommendationItem.findUnique({
      where: { id: itemId },
      include: {
        recommendation: { include: { run: true } },
      },
    });
  }

  findCategory(categoryId: number) {
    return this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { name: true, type: true },
    });
  }

  findActiveConfigs() {
    return this.prisma.planningConfig.findMany({
      where: { isActive: true },
      orderBy: [{ scopeType: 'asc' }, { scopeId: 'asc' }, { paramKey: 'asc' }],
    });
  }

  findActiveConfigGroup(scopeType: string, scopeId: number | null) {
    return this.prisma.planningConfig.findMany({
      where: { scopeType, scopeId, isActive: true },
      orderBy: { paramKey: 'asc' },
    });
  }

  findProductParameters(productId: number) {
    return this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, code: true, name: true, conversionValue: true },
    });
  }

  async findResolvedConfigContext(productId: number) {
    const branchScope = await this.getPurchasingBranchScope();
    const branchIds = branchScope.branches.map((branch) => branch.id);
    const [product, latestSupplierLine] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          code: true,
          name: true,
          childName: true,
          conversionValue: true,
        },
      }),
      this.prisma.orderSupplierItem.findFirst({
        where: {
          productId,
          orderSupplier: {
            branchId: { in: branchIds },
            status: { not: 4 },
          },
        },
        orderBy: { orderSupplier: { orderDate: 'desc' } },
        select: { orderSupplier: { select: { supplierId: true } } },
      }),
    ]);
    if (!product) return null;
    const category = product.childName
      ? await this.prisma.category.findFirst({
          where: { type: 'child', name: product.childName },
          select: { id: true },
        })
      : null;
    return {
      product,
      supplierId: latestSupplierLine?.orderSupplier.supplierId ?? null,
      categoryId: category?.id ?? null,
    };
  }

  findSupplierEntity(supplierId: number) {
    return this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, code: true, name: true },
    });
  }

  async findConfigEntities(
    categoryIds: number[],
    supplierIds: number[],
    skuIds: number[],
  ) {
    const [categories, suppliers, products] = await Promise.all([
      categoryIds.length
        ? this.prisma.category.findMany({
            where: { id: { in: categoryIds }, type: 'child' },
            select: { id: true, name: true },
          })
        : [],
      supplierIds.length
        ? this.prisma.supplier.findMany({
            where: { id: { in: supplierIds } },
            select: { id: true, code: true, name: true },
          })
        : [],
      skuIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: skuIds } },
            select: { id: true, code: true, name: true },
          })
        : [],
    ]);
    return { categories, suppliers, products };
  }

  async upsertConfigGroup(
    scopeType: string,
    scopeId: number | null,
    values: Record<string, number | null | undefined>,
    userId?: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      for (const [paramKey, paramValue] of Object.entries(values)) {
        if (paramValue === undefined) continue;
        const active = await tx.planningConfig.findFirst({
          where: { scopeType, scopeId, paramKey, isActive: true },
        });
        if (paramValue === null) {
          if (active) {
            await tx.planningConfig.update({
              where: { id: active.id },
              data: { isActive: false, updatedBy: userId },
            });
          }
        } else if (active) {
          await tx.planningConfig.update({
            where: { id: active.id },
            data: { paramValue, updatedBy: userId },
          });
        } else {
          await tx.planningConfig.create({
            data: {
              scopeType,
              scopeId,
              paramKey,
              paramValue,
              createdBy: userId,
              updatedBy: userId,
            },
          });
        }
      }
      return tx.planningConfig.findMany({
        where: { scopeType, scopeId, isActive: true },
        orderBy: { paramKey: 'asc' },
      });
    });
  }

  deactivateConfigGroup(
    scopeType: string,
    scopeId: number | null,
    userId?: number,
  ) {
    return this.prisma.planningConfig.updateMany({
      where: { scopeType, scopeId, isActive: true },
      data: { isActive: false, updatedBy: userId },
    });
  }

  createRun(runType: string, snapshotDate: Date, triggeredBy?: number) {
    return this.prisma.calculationRun.create({
      data: {
        runType,
        status: 'RUNNING',
        snapshotDate,
        triggeredBy,
      },
    });
  }

  async loadCalculationData(
    windowStart: Date,
    snapshotEnd: Date,
    productId?: number,
  ) {
    const branchScope = await this.getPurchasingBranchScope();
    const branchIds = branchScope.branches.map((branch) => branch.id);
    const productWhere = {
      isActive: true,
      allowsSale: true,
      ...(productId ? { id: productId } : {}),
    };
    const [
      products,
      configs,
      inventories,
      invoiceDetails,
      inventoryLogs,
      orderSupplierItems,
      purchaseOrderItems,
      categories,
    ] = await Promise.all([
      this.prisma.product.findMany({
        where: productWhere,
        include: { tradeMark: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.planningConfig.findMany({
        where: { isActive: true },
        orderBy: { id: 'desc' },
      }),
      this.prisma.inventory.findMany({
        where: { product: productWhere, branchId: { in: branchIds } },
        select: {
          productId: true,
          branchId: true,
          branchName: true,
          branch: { select: { name: true, code: true } },
          onHand: true,
          reserved: true,
        },
      }),
      this.prisma.invoiceDetail.findMany({
        where: {
          product: productWhere,
          isGift: false,
          invoice: {
            branchId: { in: branchIds },
            status: { not: 2 },
            purchaseDate: { gte: windowStart, lt: snapshotEnd },
          },
        },
        select: {
          productId: true,
          quantity: true,
          invoice: { select: { purchaseDate: true } },
        },
      }),
      this.prisma.inventoryLog.findMany({
        where: {
          product: productWhere,
          branchId: { in: branchIds },
          transactionDate: { gte: windowStart, lt: snapshotEnd },
        },
        select: {
          productId: true,
          transactionDate: true,
          transactionType: true,
          quantity: true,
        },
      }),
      this.prisma.orderSupplierItem.findMany({
        where: {
          product: productWhere,
          orderSupplier: {
            branchId: { in: branchIds },
            status: { not: 4 },
          },
        },
        select: {
          productId: true,
          quantity: true,
          orderSupplier: {
            select: {
              id: true,
              code: true,
              status: true,
              orderDate: true,
              supplierId: true,
              supplier: { select: { name: true } },
              vehicleShipmentItems: {
                where: {
                  vehicleShipment: {
                    branchId: { in: branchIds },
                    status: { not: 3 },
                  },
                },
                select: {
                  productId: true,
                  vehicleShipment: {
                    select: { expectedArrivalDate: true },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.purchaseOrderItem.findMany({
        where: {
          product: productWhere,
          purchaseOrder: {
            branchId: { in: branchIds },
            isDraft: false,
            status: { not: 2 },
          },
        },
        select: {
          productId: true,
          quantity: true,
          price: true,
          createdAt: true,
          purchaseOrder: {
            select: {
              orderSupplierId: true,
              purchaseDate: true,
            },
          },
        },
        orderBy: [{ purchaseOrder: { purchaseDate: 'desc' } }, { id: 'desc' }],
      }),
      this.prisma.category.findMany({
        where: { type: 'child' },
        select: { id: true, name: true },
      }),
    ]);

    return {
      products,
      configs,
      inventories,
      invoiceDetails,
      inventoryLogs,
      orderSupplierItems,
      purchaseOrderItems,
      categories,
      branchScope,
    };
  }

  async completeRun(
    runId: number,
    snapshotDate: Date,
    startedAt: Date,
    items: Array<Record<string, unknown>>,
    configVersion: object,
  ) {
    const completedAt = new Date();
    const blocked = items.filter((item) => item.status === 'BLOCKED').length;
    const estimatedValue = items.reduce(
      (sum, item) => sum + Number(item.estimatedValue ?? 0),
      0,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await tx.purchaseRecommendation.updateMany({
          where: { status: 'ACTIVE' },
          data: { status: 'SUPERSEDED' },
        });
        const recommendation = await tx.purchaseRecommendation.create({
          data: {
            runId,
            snapshotDate,
            status: 'ACTIVE',
            totalSku: items.length,
            needOrderSku: items.filter((item) => item.needsOrder).length,
            criticalCount: items.filter((item) => item.priority === 'CRITICAL')
              .length,
            highCount: items.filter((item) => item.priority === 'HIGH').length,
            totalEstimatedValue: estimatedValue,
            items: {
              create: items.map((item) => ({
                ...(item as any),
                calculationTrace:
                  item.calculationTrace as Prisma.InputJsonValue,
              })),
            },
          },
        });
        await tx.calculationRun.update({
          where: { id: runId },
          data: {
            status: 'COMPLETED',
            completedAt,
            skuTotal: items.length,
            skuSuccess: items.length - blocked,
            skuBlocked: blocked,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            configVersion: configVersion as Prisma.InputJsonValue,
          },
        });
        return recommendation;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  }

  failRun(runId: number, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.prisma.calculationRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorSummary: { message } as Prisma.InputJsonValue,
      },
    });
  }
}
