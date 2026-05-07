import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncSaleChannelService extends BaseSyncService {
  protected readonly entityName = 'sale_channel';
  protected readonly endpoint = 'sale-channels';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // sync_kiot SaleChannel không có code → match bằng name hoặc kiotVietId
    const existing = await this.prisma.saleChannel.findFirst({
      where: {
        OR: [{ kiotVietId: record.kiotVietId }, { name: record.name }],
      },
    });

    const data = {
      name: record.name,
      isActivate: record.isActive ?? true,
      position: record.position ?? 0,
      kiotVietId: record.kiotVietId,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.saleChannel.update({
        where: { id: existing.id },
        data,
      });
      return 'updated';
    }

    await this.prisma.saleChannel.create({ data });
    return 'created';
  }
}
