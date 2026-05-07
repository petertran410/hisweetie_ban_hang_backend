import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncUserService extends BaseSyncService {
  protected readonly entityName = 'user';
  protected readonly endpoint = 'users';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const kiotVietId = BigInt(record.kiotVietId);

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { kiotVietId },
          { email: record.email || undefined },
          { name: record.givenName || record.userName },
        ],
      },
    });

    // Chỉ update kiot-owned fields, KHÔNG ghi đè password/roles/permissions
    const kiotOwnedData = {
      kiotVietId,
      phone: record.mobilePhone || undefined,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    // Tạo user shell — không có password, cần setup sau
    await this.prisma.user.create({
      data: {
        name: record.givenName || record.userName,
        email: record.email || `kiot_${record.kiotVietId}@placeholder.local`,
        password: '', // cần setup sau
        ...kiotOwnedData,
      },
    });
    return 'created';
  }
}
