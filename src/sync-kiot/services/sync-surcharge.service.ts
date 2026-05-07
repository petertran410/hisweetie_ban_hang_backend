import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncSurchargeService extends BaseSyncService {
  protected readonly entityName = 'surcharge';
  protected readonly endpoint = 'surcharges';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // sync_kiot Surcharge: kiotVietId + name, không có code
    // hisweetie Surcharge: code (unique) + name
    // Tạo code từ kiotVietId nếu cần
    const surchargeCode = record.code || `SC-${record.kiotVietId}`;

    const existing = await this.prisma.surcharge.findFirst({
      where: {
        OR: [{ kiotVietId: record.kiotVietId }, { name: record.name }],
      },
    });

    const data = {
      name: record.name,
      valueRatio: record.valueRatio || null,
      value: record.value || null,
      kiotVietId: record.kiotVietId,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.surcharge.update({
        where: { id: existing.id },
        data,
      });
      return 'updated';
    }

    await this.prisma.surcharge.create({
      data: { code: surchargeCode, ...data },
    });
    return 'created';
  }
}
