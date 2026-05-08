import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncReturnOrderService extends BaseSyncService {
  protected readonly entityName = 'return_order';
  protected readonly endpoint = 'returns';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.returnOrder.findFirst({
      where: { code: record.code },
    });

    // Resolve invoice bằng kiotVietId
    const invoice = record.invoiceId
      ? await this.prisma.invoice.findFirst({
          where: { kiotVietId: BigInt(record.invoiceId) },
          select: { id: true },
        })
      : null;

    // Resolve customer bằng code hoặc kiotVietId
    const customer = record.customerCode
      ? await this.prisma.customer.findFirst({
          where: { code: record.customerCode },
          select: { id: true },
        })
      : record.customerId
        ? await this.prisma.customer.findFirst({
            where: { kiotVietId: BigInt(record.customerId) },
            select: { id: true },
          })
        : null;

    const branch = record.branchId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.branchId },
          select: { id: true },
        })
      : null;

    let receivedById: number | null = null;
    if (record.receivedById) {
      const user = await this.prisma.user.findFirst({
        where: { kiotVietId: BigInt(record.receivedById) },
        select: { id: true },
      });
      receivedById = user?.id || null;
    }

    const kiotOwnedData = {
      status: record.status ?? 1,
      statusValue: record.statusValue || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.returnOrder.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    if (!branch) {
      this.logger.warn(`⚠️ ReturnOrder ${record.code}: branch not found`);
      return 'skipped';
    }

    // sync_kiot status mapping → hisweetie 3-step:
    // sync_kiot status 1 = đã trả → hisweetie status 5 (REFUND_CONFIRMED)
    // Vì data từ KiotViet đã hoàn tất flow
    const hisweetieStatus = record.status === 1 ? 5 : record.status;

    const ro = await this.prisma.returnOrder.create({
      data: {
        code: record.code,
        invoiceId: invoice?.id || null,
        customerId: customer?.id || null,
        branchId: branch.id,
        status: hisweetieStatus,
        statusValue: record.statusValue || null,
        totalReturnAmount: record.returnTotal || 0,
        // ── FIX: dùng returnTotal thay vì totalPayment ──
        // returnTotal = toàn bộ giá trị hàng trả (2,080,000) → khớp KiotViet zigzag
        // totalPayment = tiền mặt đã trả khách (40,000) → chỉ là phần chênh lệch
        refundAmount: record.returnTotal || 0,
        refundedAmount: record.totalPayment || 0,
        receivedById,
        receivedByName: record.soldByName || null,
        createdBy: receivedById || 1,
        createdByName: record.soldByName || '',
        kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
        lastSyncedAt: new Date(),
        createdAt: record.createdDate
          ? new Date(record.createdDate)
          : new Date(),
        updatedAt: record.modifiedDate
          ? new Date(record.modifiedDate)
          : new Date(),
      },
    });

    if (record.details?.length) {
      await this.syncDetails(ro.id, invoice?.id ?? null, record.details);
    }

    return 'created';
  }

  private async syncDetails(
    returnOrderId: number,
    invoiceId: number | null,
    details: any[],
  ) {
    for (const d of details) {
      const product = d.productId
        ? await this.prisma.product.findFirst({
            where: { kiotVietId: BigInt(d.productId) },
            select: { id: true, code: true, name: true },
          })
        : null;
      if (!product) continue;

      // Tìm invoice code
      let invoiceCode = '';
      if (invoiceId) {
        const inv = await this.prisma.invoice.findUnique({
          where: { id: invoiceId },
          select: { code: true },
        });
        invoiceCode = inv?.code || '';
      }

      await this.prisma.returnOrderDetail.create({
        data: {
          returnOrderId,
          invoiceId: invoiceId || 0,
          invoiceCode,
          productId: product.id,
          productCode: d.productCode || product.code,
          productName: d.productName || product.name,
          invoiceQuantity: d.quantity || 0,
          invoicePrice: d.price || 0,
          requestQuantity: d.quantity || 0,
          confirmedQuantity: d.quantity || 0,
          returnPrice: d.price || 0,
          totalAmount:
            d.subTotal || Number(d.quantity || 0) * Number(d.price || 0),
          goodQuantity: d.quantity || 0,
        },
      });
    }
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('returns', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }
}
