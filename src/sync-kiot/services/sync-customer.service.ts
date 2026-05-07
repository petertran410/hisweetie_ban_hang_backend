import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncCustomerService extends BaseSyncService {
  protected readonly entityName = 'customer';
  protected readonly endpoint = 'customers';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('customers', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Match bằng code (unique ở cả 2 hệ thống)
    const existing = await this.prisma.customer.findFirst({
      where: { code: record.code },
    });

    let branchId: number | null = null;
    if (record.branch?.kiotVietId) {
      const branch = await this.prisma.branch.findFirst({
        where: { kiotVietId: record.branch.kiotVietId },
        select: { id: true },
      });
      branchId = branch?.id || null;
    }

    // Kiot-owned fields (KHÔNG ghi đè invoice*, customerTypeId, addresses)
    const kiotOwnedData = {
      name: record.name,
      gender: record.gender,
      birthDate: record.birthDate ? new Date(record.birthDate) : null,
      contactNumber: record.contactNumber || null,
      email: record.email || null,
      type: record.type ?? 0,
      organization: record.organization || null,
      taxCode: record.taxCode || null,
      groups: record.groups || null,
      comments: record.comments || null,
      totalDebt: record.debt || 0,
      totalInvoiced: record.totalInvoiced || 0,
      totalRevenue: record.totalRevenue || 0,
      totalPoint: record.totalPoint || 0,
      rewardPoint: record.rewardPoint ? Number(record.rewardPoint) : 0,
      isActive: record.isActive ?? true,
      branchId,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      createdAt: record.createdDate ? new Date(record.createdDate) : new Date(),
      updatedAt: record.modifiedDate
        ? new Date(record.modifiedDate)
        : new Date(),
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.customer.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });

      // Sync CustomerGroupRelation nếu có
      if (record.CustomerGroupRelation?.length) {
        await this.syncCustomerGroups(
          existing.id,
          record.CustomerGroupRelation,
        );
      }

      return 'updated';
    }

    const created = await this.prisma.customer.create({
      data: { code: record.code, ...kiotOwnedData },
    });

    // Tạo CustomerAddress từ address/locationName/wardName
    if (record.address || record.locationName) {
      await this.prisma.customerAddress.create({
        data: {
          customerId: created.id,
          label: 'Địa chỉ mặc định',
          address: record.address || null,
          locationName: record.locationName || null,
          wardName: record.wardName || null,
          isDefault: true,
        },
      });
    }

    if (record.CustomerGroupRelation?.length) {
      await this.syncCustomerGroups(created.id, record.CustomerGroupRelation);
    }

    return 'created';
  }

  private async syncCustomerGroups(customerId: number, relations: any[]) {
    for (const rel of relations) {
      const group = await this.prisma.customerGroup.findFirst({
        where: { kiotVietId: rel.customerGroupId },
        select: { id: true },
      });
      if (!group) continue;

      await this.prisma.customerGroupDetail.upsert({
        where: {
          customerId_customerGroupId: {
            customerId,
            customerGroupId: group.id,
          },
        },
        update: {},
        create: { customerId, customerGroupId: group.id },
      });
    }
  }
}
