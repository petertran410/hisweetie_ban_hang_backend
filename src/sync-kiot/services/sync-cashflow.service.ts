import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncCashFlowService extends BaseSyncService {
  protected readonly entityName = 'cash_flow';
  protected readonly endpoint = 'cashflows';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('cashflows', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existingByCode = await this.prisma.cashFlow.findFirst({
      where: { code: record.code },
    });

    if (existingByCode) {
      // Chỉ update kiotVietId nếu chưa có
      if (!existingByCode.kiotVietId && record.kiotVietId) {
        await this.prisma.cashFlow.update({
          where: { id: existingByCode.id },
          data: {
            kiotVietId: BigInt(record.kiotVietId),
            lastSyncedAt: new Date(),
          },
        });
        return 'updated';
      }
      return 'skipped';
    }

    const existing = await this.prisma.cashFlow.findFirst({
      where: { code: record.code },
    });

    const branch = record.branchId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.branchId },
          select: { id: true },
        })
      : null;

    // Resolve partnerId → customerId/supplierId trong hisweetie
    let partnerId: number | null = null;
    if (record.partnerId && record.partnerType) {
      if (record.partnerType === 'Customer' || record.partnerType === '1') {
        const customer = await this.prisma.customer.findFirst({
          where: { kiotVietId: BigInt(record.partnerId) },
          select: { id: true },
        });
        partnerId = customer?.id || null;
      } else if (
        record.partnerType === 'Supplier' ||
        record.partnerType === '2'
      ) {
        const supplier = await this.prisma.supplier.findFirst({
          where: { kiotVietId: BigInt(record.partnerId) },
          select: { id: true },
        });
        partnerId = supplier?.id || null;
      }
    }

    const amount = Number(record.amount || 0);
    const isReceipt = amount >= 0;

    let createdBy = 1;
    if (record.createdBy) {
      const user = await this.prisma.user.findFirst({
        where: { kiotVietId: BigInt(record.createdBy) },
        select: { id: true },
      });
      if (user) createdBy = user.id;
    }

    const kiotOwnedData = {
      branchId: branch?.id || 1,
      isReceipt,
      amount: Math.abs(amount),
      transDate: record.transDate ? new Date(record.transDate) : new Date(),
      method: record.method || null,
      partnerType: record.partnerType || null,
      partnerId,
      partnerName: record.partnerName || null,
      contactNumber: record.contactNumber || null,
      address: record.address || null,
      wardName: record.wardName || null,
      description: record.description || null,
      status: record.status ?? 0,
      statusValue: record.statusValue || null,
      usedForFinancialReporting: record.usedForFinancialReporting || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.cashFlow.update({
        where: { id: existing.id },
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
