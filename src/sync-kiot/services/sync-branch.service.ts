import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncBranchService extends BaseSyncService {
  protected readonly entityName = 'branch';
  protected readonly endpoint = 'branches';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Bước 1: ưu tiên match bằng kiotVietId (chính xác nhất)
    let existing = await this.prisma.branch.findFirst({
      where: { kiotVietId: record.kiotVietId },
    });

    // Bước 2: fallback match bằng name, nhưng CHỈ khi branch đó chưa được gắn kiotVietId
    // → tránh trường hợp overwrite kiotVietId của branch khác
    if (!existing) {
      existing = await this.prisma.branch.findFirst({
        where: {
          name: record.name,
          kiotVietId: null,
        },
      });
    }

    const data = {
      name: record.name,
      contactNumber: record.contactNumber || null,
      subContactNumber: record.subContactNumber || null,
      email: record.email || null,
      address: record.address || null,
      wardName: record.wardName || null,
      // isActive: record.isActive ?? true,
      isLock: record.isLock ?? false,
      kiotVietId: record.kiotVietId,
      createdAt: record.createdDate ? new Date(record.createdDate) : new Date(),
      updatedAt: record.modifiedDate
        ? new Date(record.modifiedDate)
        : new Date(),
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.branch.update({
        where: { id: existing.id },
        data,
      });
      return 'updated';
    }

    await this.prisma.branch.create({
      data: { ...data, code: `BR-${record.kiotVietId}` },
    });
    return 'created';
  }
}
