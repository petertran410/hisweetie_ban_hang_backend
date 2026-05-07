import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncBankAccountService extends BaseSyncService {
  protected readonly entityName = 'bank_account';
  protected readonly endpoint = 'bank-accounts';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.bankAccount.findFirst({
      where: {
        OR: [
          { kiotVietId: record.kiotVietId },
          ...(record.accountNumber
            ? [{ accountNumber: record.accountNumber }]
            : []),
        ],
      },
    });

    if (existing) {
      await this.prisma.bankAccount.update({
        where: { id: existing.id },
        data: {
          bankName: record.bankName,
          kiotVietId: record.kiotVietId,
          lastSyncedAt: new Date(),
        },
      });
      return 'updated';
    }

    await this.prisma.bankAccount.create({
      data: {
        accountNumber: record.accountNumber || `KIOT-${record.kiotVietId}`,
        bankCode: '',
        bankName: record.bankName,
        accountHolder: '',
        scope: 'all',
        kiotVietId: record.kiotVietId,
        lastSyncedAt: new Date(),
      },
    });
    return 'created';
  }
}
