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

    const invoice = record.invoiceId
      ? await this.prisma.invoice.findFirst({
          where: { kiotVietId: BigInt(record.invoiceId) },
          select: { id: true },
        })
      : null;

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

    const branchKiotVietId =
      record.branch?.kiotVietId ?? record.branchId ?? null;
    const branch = branchKiotVietId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: branchKiotVietId },
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

    const hisweetieStatus = record.status === 1 ? 5 : (record.status ?? 1);

    const returnDate = record.returnDate
      ? new Date(record.returnDate)
      : record.createdDate
        ? new Date(record.createdDate)
        : new Date();

    if (existing) {
      // ── UPDATE: cập nhật đầy đủ fields + re-sync details ──
      await this.prisma.returnOrder.update({
        where: { id: existing.id },
        data: {
          status: hisweetieStatus,
          statusValue: record.statusValue || null,
          totalReturnAmount: record.returnTotal || 0,
          refundAmount: record.returnTotal || 0,
          refundedAmount: record.totalPayment || 0,
          refundType: existing.refundType || 'debt_offset',
          confirmedAt: returnDate,
          refundConfirmedAt: returnDate,
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });

      // Re-sync details nếu chưa có
      const existingDetailsCount = await this.prisma.returnOrderDetail.count({
        where: { returnOrderId: existing.id },
      });

      if (existingDetailsCount === 0 && record.details?.length) {
        const invoiceId = existing.invoiceId ?? invoice?.id ?? null;
        await this.syncDetails(existing.id, invoiceId, record.details);
      }

      return 'updated';
    }

    if (!branch) {
      this.logger.warn(`⚠️ ReturnOrder ${record.code}: branch not found`);
      return 'skipped';
    }

    const ro = await this.prisma.returnOrder.create({
      data: {
        code: record.code,
        invoiceId: invoice?.id || null,
        customerId: customer?.id || null,
        branchId: branch.id,
        status: hisweetieStatus,
        statusValue: record.statusValue || null,
        totalReturnAmount: record.returnTotal || 0,
        refundAmount: record.returnTotal || 0,
        refundedAmount: record.totalPayment || 0,
        refundType: 'debt_offset',
        receivedById,
        receivedByName: record.soldByName || null,
        createdBy: receivedById || 1,
        createdByName: record.soldByName || '',
        confirmedAt: returnDate,
        refundConfirmedAt: returnDate,
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
    // Lookup invoiceCode 1 lần duy nhất thay vì trong loop
    let invoiceCode = '';
    if (invoiceId) {
      const inv = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { code: true },
      });
      invoiceCode = inv?.code || '';
    }

    for (const d of details) {
      const product = d.productCode
        ? await this.prisma.product.findFirst({
            where: { code: d.productCode },
            select: { id: true, code: true, name: true },
          })
        : null;

      if (!product) {
        this.logger.warn(
          `⚠️ ReturnOrderDetail: product not found (code: ${d.productCode})`,
        );
        continue;
      }

      await this.prisma.returnOrderDetail.create({
        data: {
          returnOrderId,
          invoiceId: invoiceId ?? null,
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
          note: d.note || null,
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
