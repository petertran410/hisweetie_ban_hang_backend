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
    return this.upsertRecord(record, true);
  }

  protected async upsertRecord(
    record: any,
    withImages = false,
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

      if (record.inventories?.length) {
        await this.syncInventories(
          productId,
          record.code,
          record.name,
          record.inventories,
        );
      }

      if (withImages && record.images?.length) {
        await this.syncImages(productId, record.images);
      }

      return 'updated';
    }

    try {
      const created = await this.prisma.product.create({
        data: { code: record.code, ...kiotOwnedData },
      });
      productId = created.id;
    } catch (e) {
      if (e?.code === 'P2002') {
        // Race condition: webhook hoặc process khác đã create cùng lúc → fallback update
        this.logger.warn(
          `⚠️ Race condition on product ${record.code}, retrying as update...`,
        );
        const retryExisting = await this.prisma.product.findFirst({
          where: {
            OR: [
              { code: record.code },
              ...(record.kiotVietId
                ? [{ kiotVietId: BigInt(record.kiotVietId) }]
                : []),
            ],
          },
          select: { id: true },
        });
        if (!retryExisting) throw e;
        await this.prisma.product.update({
          where: { id: retryExisting.id },
          data: kiotOwnedData,
        });
        productId = retryExisting.id;
      } else {
        throw e;
      }
    }

    if (record.inventories?.length) {
      await this.syncInventories(
        productId,
        record.code,
        record.name,
        record.inventories,
      );
    }

    if (withImages && record.images?.length) {
      await this.syncImages(productId, record.images);
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
      const kiotVietId = inv.branchKiotVietId;
      if (!kiotVietId) {
        this.logger.warn(
          `⚠️ Inventory: branchKiotVietId missing for product ${productCode}, skipping`,
        );
        continue;
      }

      const branch = await this.prisma.branch.findFirst({
        where: { kiotVietId },
        select: { id: true, name: true },
      });
      if (!branch) continue;

      await this.prisma.inventory.upsert({
        where: {
          productId_branchId: { productId, branchId: branch.id },
        },
        update: {
          cost: inv.cost || 0,
          onHand: inv.onHand || 0,
          reserved: inv.reserved || 0,
          onOrder: inv.onOrder || 0,
          productCode,
          productName,
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

  private async syncImages(productId: number, images: any[]) {
    // Delete existing rồi recreate — images không có stable unique key ngoài productId+lineNumber
    await this.prisma.productImage.deleteMany({ where: { productId } });

    for (const img of images) {
      // sync_kiot_data imageUrl là Json? — handle nhiều case
      let imageUrl: string | null = null;

      if (typeof img.imageUrl === 'string') {
        imageUrl = img.imageUrl;
      } else if (img.imageUrl && typeof img.imageUrl === 'object') {
        // Thử các key phổ biến
        imageUrl =
          img.imageUrl.url ?? img.imageUrl.imageUrl ?? img.imageUrl.src ?? null;
      }

      if (!imageUrl) continue;

      await this.prisma.productImage.create({
        data: { productId, image: imageUrl },
      });
    }
  }
}
