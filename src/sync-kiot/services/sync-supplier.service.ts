import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncSupplierService extends BaseSyncService {
  protected readonly entityName = 'supplier';
  protected readonly endpoint = 'suppliers';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('suppliers', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.supplier.findFirst({
      where: { code: record.code?.trim() },
    });

    let branchId: number | null = null;
    if (record.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { kiotVietId: record.branchId },
        select: { id: true },
      });
      branchId = branch?.id || null;
    }

    const kiotOwnedData = {
      name: record.name?.trim(),
      contactNumber: record.contactNumber || null,
      email: record.email || null,
      address: record.address || null,
      location: record.locationName || null,
      wardName: record.wardName || null,
      organization: record.organization || null,
      taxCode: record.taxCode || null,
      comments: record.comments || null,
      groups: record.groups || null,
      isActive: record.isActive ?? true,
      debt: record.debt || 0,
      totalInvoiced: record.totalInvoiced || 0,
      totalInvoicedWithoutReturn: record.totalInvoicedWithoutReturn || 0,
      branchId,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      createdAt: record.createdDate ? new Date(record.createdDate) : new Date(),
      updatedAt: record.modifiedDate
        ? new Date(record.modifiedDate)
        : new Date(),
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.supplier.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    await this.prisma.supplier.create({
      data: { code: record.code?.trim(), ...kiotOwnedData },
    });
    return 'created';
  }
}
