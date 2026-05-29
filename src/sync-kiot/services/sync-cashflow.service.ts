import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

interface CashFlowLookupContext {
  branchByKiotId: Map<string, number>;
  customerByKiotId: Map<string, number>;
  supplierByKiotId: Map<string, number>;
  userByKiotId: Map<string, number>;
  cashFlowByCode: Map<string, number>;
}

@Injectable()
export class SyncCashFlowService extends BaseSyncService {
  protected readonly entityName = 'cash_flow';
  protected readonly endpoint = 'cashflows';
  protected concurrency = 8;

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('cashflows', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  /**
   * Normalize partnerType từ KiotViet sang format hisweetie
   * KiotViet: 'Customer' | '1' → 'C'
   * KiotViet: 'Supplier' | '2' → 'S'
   * Khác: giữ nguyên hoặc 'O'
   */
  private normalizePartnerType(raw?: string | null): string | null {
    if (!raw) return null;
    if (raw === 'Customer' || raw === '1') return 'C';
    if (raw === 'Supplier' || raw === '2') return 'S';
    return raw;
  }

  private mapKiotStatus(kiotStatus: number | null | undefined): number {
    if (kiotStatus === 1) return 2; // KiotViet hủy (1) → HiSweetie hủy (2)
    return kiotStatus ?? 0; // Còn lại giữ nguyên, fallback về 0
  }

  protected async preloadLookups(
    records: any[],
  ): Promise<CashFlowLookupContext> {
    const branchKiotIds = new Set<number>();
    const customerKiotIds = new Set<bigint>();
    const supplierKiotIds = new Set<bigint>();
    const userKiotIds = new Set<bigint>();
    const codes = new Set<string>();

    for (const r of records) {
      if (r?.code) codes.add(r.code);
      if (r?.branchKiotVietId) branchKiotIds.add(Number(r.branchKiotVietId));
      const partnerType = this.normalizePartnerType(r?.partnerType);
      if (r?.partnerId && partnerType === 'C')
        customerKiotIds.add(BigInt(r.partnerId));
      if (r?.partnerId && partnerType === 'S')
        supplierKiotIds.add(BigInt(r.partnerId));
      if (r?.createdBy) userKiotIds.add(BigInt(r.createdBy));
    }

    const [branches, customers, suppliers, users, cashFlows] =
      await Promise.all([
        branchKiotIds.size > 0
          ? this.prisma.branch.findMany({
              where: { kiotVietId: { in: [...branchKiotIds] } },
              select: { id: true, kiotVietId: true },
            })
          : Promise.resolve([]),
        customerKiotIds.size > 0
          ? this.prisma.customer.findMany({
              where: { kiotVietId: { in: [...customerKiotIds] } },
              select: { id: true, kiotVietId: true },
            })
          : Promise.resolve([]),
        supplierKiotIds.size > 0
          ? this.prisma.supplier.findMany({
              where: { kiotVietId: { in: [...supplierKiotIds] } },
              select: { id: true, kiotVietId: true },
            })
          : Promise.resolve([]),
        userKiotIds.size > 0
          ? this.prisma.user.findMany({
              where: { kiotVietId: { in: [...userKiotIds] } },
              select: { id: true, kiotVietId: true },
            })
          : Promise.resolve([]),
        codes.size > 0
          ? this.prisma.cashFlow.findMany({
              where: { code: { in: [...codes] } },
              select: { id: true, code: true },
            })
          : Promise.resolve([]),
      ]);

    const branchByKiotId = new Map<string, number>();
    for (const b of branches as any[]) {
      if (b.kiotVietId != null)
        branchByKiotId.set(String(b.kiotVietId), b.id);
    }

    const customerByKiotId = new Map<string, number>();
    for (const c of customers as any[]) {
      if (c.kiotVietId != null)
        customerByKiotId.set(String(c.kiotVietId), c.id);
    }

    const supplierByKiotId = new Map<string, number>();
    for (const s of suppliers as any[]) {
      if (s.kiotVietId != null)
        supplierByKiotId.set(String(s.kiotVietId), s.id);
    }

    const userByKiotId = new Map<string, number>();
    for (const u of users as any[]) {
      if (u.kiotVietId != null) userByKiotId.set(String(u.kiotVietId), u.id);
    }

    const cashFlowByCode = new Map<string, number>();
    for (const cf of cashFlows) cashFlowByCode.set(cf.code, cf.id);

    return {
      branchByKiotId,
      customerByKiotId,
      supplierByKiotId,
      userByKiotId,
      cashFlowByCode,
    };
  }

  protected async upsertRecordWithContext(
    record: any,
    context: CashFlowLookupContext,
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
    ctx: CashFlowLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existingId = ctx.cashFlowByCode.get(record.code);

    const branchId = record.branchKiotVietId
      ? (ctx.branchByKiotId.get(String(record.branchKiotVietId)) ?? null)
      : null;

    const normalizedPartnerType = this.normalizePartnerType(record.partnerType);

    let partnerId: number | null = null;
    if (record.partnerId && normalizedPartnerType === 'C') {
      partnerId = ctx.customerByKiotId.get(String(record.partnerId)) ?? null;
    } else if (record.partnerId && normalizedPartnerType === 'S') {
      partnerId = ctx.supplierByKiotId.get(String(record.partnerId)) ?? null;
    }

    const amount = Number(record.amount || 0);
    const isReceipt = amount >= 0;

    const createdBy = record.createdBy
      ? (ctx.userByKiotId.get(String(record.createdBy)) ?? 1)
      : 1;

    const kiotOwnedData = {
      branchId: branchId || 1,
      isReceipt,
      amount: Math.abs(amount),
      transDate: record.transDate ? new Date(record.transDate) : new Date(),
      method: record.method || null,
      partnerType: normalizedPartnerType,
      partnerId,
      partnerName: record.partnerName || null,
      contactNumber: record.contactNumber || null,
      address: record.address || null,
      wardName: record.wardName || null,
      description: record.description || null,
      status: this.mapKiotStatus(record.status),
      statusValue: record.statusValue || null,
      usedForFinancialReporting: record.usedForFinancialReporting || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existingId) {
      await this.prisma.cashFlow.update({
        where: { id: existingId },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    await this.prisma.cashFlow.create({
      data: {
        code: record.code,
        createdBy,
        ...kiotOwnedData,
        createdAt: record.transDate ? new Date(record.transDate) : new Date(),
      },
    });
    return 'created';
  }
}
