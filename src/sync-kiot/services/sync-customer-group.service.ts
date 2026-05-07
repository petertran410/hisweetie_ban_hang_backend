import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncCustomerGroupService extends BaseSyncService {
  protected readonly entityName = 'customer_group';
  protected readonly endpoint = 'customer-groups';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // sync_kiot CustomerGroup: kiotVietId (Int unique), name, description, discount
    // hisweetie CustomerGroup: name, description, discount, allowedUserIds, autoAddConditions...
    // Match bằng kiotVietId hoặc name
    const existing = await this.prisma.customerGroup.findFirst({
      where: {
        OR: [{ kiotVietId: record.kiotVietId }, { name: record.name }],
      },
    });

    // Chỉ update kiot-owned fields, KHÔNG ghi đè allowedUserIds, autoAddConditions, autoUpdateMode
    const kiotOwnedData = {
      name: record.name,
      description: record.description || null,
      discount: record.discount || null,
      kiotVietId: record.kiotVietId,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.customerGroup.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    await this.prisma.customerGroup.create({ data: kiotOwnedData });
    return 'created';
  }
}
