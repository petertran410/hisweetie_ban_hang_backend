import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncTradeMarkService extends BaseSyncService {
  protected readonly entityName = 'trade_mark';
  protected readonly endpoint = 'trademarks';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.tradeMark.findFirst({
      where: {
        OR: [{ kiotVietId: record.kiotVietId }, { name: record.name }],
      },
    });

    const data = {
      name: record.name,
      kiotVietId: record.kiotVietId,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.tradeMark.update({
        where: { id: existing.id },
        data,
      });
      return 'updated';
    }

    await this.prisma.tradeMark.create({ data });
    return 'created';
  }
}
