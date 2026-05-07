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

    // Resolve tradeMarkId
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
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.product.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    await this.prisma.product.create({
      data: { code: record.code, ...kiotOwnedData },
    });
    return 'created';
  }
}
