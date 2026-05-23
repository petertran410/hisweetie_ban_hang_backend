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

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existingByCode = await this.prisma.cashFlow.findFirst({
      where: { code: record.code },
    });

    const branch = record.branchKiotVietId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.branchKiotVietId },
          select: { id: true },
        })
      : null;

    // Resolve partnerId → customerId/supplierId trong hisweetie
    let partnerId: number | null = null;
    const normalizedPartnerType = this.normalizePartnerType(record.partnerType);

    if (record.partnerId && normalizedPartnerType) {
      if (normalizedPartnerType === 'C') {
        const customer = await this.prisma.customer.findFirst({
          where: { kiotVietId: BigInt(record.partnerId) },
          select: { id: true },
        });
        partnerId = customer?.id || null;
      } else if (normalizedPartnerType === 'S') {
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

    // Dữ liệu KiotViet là nguồn chính xác → luôn ghi đè
    const kiotOwnedData = {
      branchId: branch?.id || 1,
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

    if (existingByCode) {
      // ── GHI ĐÈ toàn bộ từ Cashflow table (nguồn chính xác từ KiotViet) ──
      // amount ở đây là tổng thực tế, không phải phần phân bổ từng hóa đơn
      await this.prisma.cashFlow.update({
        where: { id: existingByCode.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    // Record mới — tạo mới
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
