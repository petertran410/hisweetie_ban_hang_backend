import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncProductService extends BaseSyncService {
  protected readonly entityName = 'product';
  protected readonly endpoint = 'products';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('products', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.product.findFirst({
      where: { code: record.code },
    });

    let tradeMarkId: number | null = null;
    if (record.tradeMarkId) {
      const tm = await this.prisma.tradeMark.findFirst({
        where: { kiotVietId: record.tradeMarkId },
        select: { id: true },
      });
      tradeMarkId = tm?.id || null;
    }

    const kiotOwnedData = {
      name: record.name,
      fullName: record.fullName || null,
      basePrice: record.basePrice || 0,
      unit: record.unit || null,
      weight: record.weight || null,
      conversionValue: record.conversionValue || 1,
      hasVariants: record.hasVariants ?? false,
      isActive: record.isActive ?? true,
      allowsSale: record.allowsSale ?? true,
      type: record.type ?? 2,
      isRewardPoint: record.isRewardPoint ?? true,
      tradeMarkId,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      createdAt: record.createdDate ? new Date(record.createdDate) : new Date(),
      updatedAt: record.modifiedDate
        ? new Date(record.modifiedDate)
        : new Date(),
      lastSyncedAt: new Date(),
    };

    let productId: number;

    if (existing) {
      await this.prisma.product.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      productId = existing.id;

      // Sync inventory cho product đã tồn tại
      if (record.inventories?.length) {
        await this.syncInventories(
          productId,
          record.code,
          record.name,
          record.inventories,
        );
      }

      return 'updated';
    }

    const created = await this.prisma.product.create({
      data: { code: record.code, ...kiotOwnedData },
    });
    productId = created.id;

    // Sync inventory cho product mới
    if (record.inventories?.length) {
      await this.syncInventories(
        productId,
        record.code,
        record.name,
        record.inventories,
      );
    }

    return 'created';
  }

  private async syncInventories(
    productId: number,
    productCode: string,
    productName: string,
    inventories: any[],
  ) {
    for (const inv of inventories) {
      // inv.branchId là kiotVietId của Branch trong sync_kiot_data
      const branch = await this.prisma.branch.findFirst({
        where: { kiotVietId: inv.branchId },
        select: { id: true, name: true },
      });
      if (!branch) continue;

      await this.prisma.inventory.upsert({
        where: {
          productId_branchId: {
            productId,
            branchId: branch.id,
          },
        },
        update: {
          cost: inv.cost || 0,
          onHand: inv.onHand || 0,
          reserved: inv.reserved || 0,
          onOrder: inv.onOrder || 0,
        },
        create: {
          productId,
          productCode,
          productName,
          branchId: branch.id,
          branchName: branch.name,
          cost: inv.cost || 0,
          onHand: inv.onHand || 0,
          reserved: inv.reserved || 0,
          onOrder: inv.onOrder || 0,
        },
      });
    }
  }
}
