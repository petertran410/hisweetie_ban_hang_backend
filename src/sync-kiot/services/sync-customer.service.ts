import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

interface CustomerLookupContext {
  branchByKiotId: Map<string, number>;
  customerByCode: Map<string, number>;
  customerGroupByKiotId: Map<string, number>;
}

@Injectable()
export class SyncCustomerService extends BaseSyncService {
  protected readonly entityName = 'customer';
  protected readonly endpoint = 'customers';
  protected concurrency = 8;

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('customers', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async preloadLookups(
    records: any[],
  ): Promise<CustomerLookupContext> {
    const branchKiotIds = new Set<number>();
    const customerCodes = new Set<string>();
    const groupKiotIds = new Set<number>();

    for (const r of records) {
      if (r?.code) customerCodes.add(r.code);
      const branchKiot = r?.branch?.kiotVietId ?? r?.branchId;
      if (branchKiot) branchKiotIds.add(Number(branchKiot));
      for (const rel of r?.CustomerGroupRelation ?? []) {
        if (rel?.customerGroupId) groupKiotIds.add(Number(rel.customerGroupId));
      }
    }

    const [branches, customers, groups] = await Promise.all([
      branchKiotIds.size > 0
        ? this.prisma.branch.findMany({
            where: { kiotVietId: { in: [...branchKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      customerCodes.size > 0
        ? this.prisma.customer.findMany({
            where: { code: { in: [...customerCodes] } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
      groupKiotIds.size > 0
        ? this.prisma.customerGroup.findMany({
            where: { kiotVietId: { in: [...groupKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
    ]);

    const branchByKiotId = new Map<string, number>();
    for (const b of branches as any[]) {
      if (b.kiotVietId != null)
        branchByKiotId.set(String(b.kiotVietId), b.id);
    }

    const customerByCode = new Map<string, number>();
    for (const c of customers) if (c.code) customerByCode.set(c.code, c.id);

    const customerGroupByKiotId = new Map<string, number>();
    for (const g of groups as any[]) {
      if (g.kiotVietId != null)
        customerGroupByKiotId.set(String(g.kiotVietId), g.id);
    }

    return { branchByKiotId, customerByCode, customerGroupByKiotId };
  }

  protected async upsertRecordWithContext(
    record: any,
    context: CustomerLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    return this.upsertWithCtx(record, context);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const context = await this.preloadLookups([record]);
    return this.upsertWithCtx(record, context);
  }

  private async upsertWithCtx(
    record: any,
    ctx: CustomerLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existingId = ctx.customerByCode.get(record.code);

    const branchKiot = record.branch?.kiotVietId ?? record.branchId ?? null;
    const branchId = branchKiot
      ? (ctx.branchByKiotId.get(String(branchKiot)) ?? null)
      : null;

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

    if (existingId) {
      await this.prisma.customer.update({
        where: { id: existingId },
        data: kiotOwnedData,
      });

      if (record.CustomerGroupRelation?.length) {
        await this.syncCustomerGroupsBulk(
          existingId,
          record.CustomerGroupRelation,
          ctx,
        );
      }
      return 'updated';
    }

    const created = await this.prisma.customer.create({
      data: { code: record.code, ...kiotOwnedData },
    });

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
      await this.syncCustomerGroupsBulk(
        created.id,
        record.CustomerGroupRelation,
        ctx,
      );
    }

    return 'created';
  }

  private async syncCustomerGroupsBulk(
    customerId: number,
    relations: any[],
    ctx: CustomerLookupContext,
  ) {
    const data = relations
      .map((rel) => ctx.customerGroupByKiotId.get(String(rel.customerGroupId)))
      .filter((id): id is number => !!id)
      .map((customerGroupId) => ({ customerId, customerGroupId }));

    if (data.length === 0) return;

    await this.prisma.customerGroupDetail.createMany({
      data,
      skipDuplicates: true,
    });
  }
}
