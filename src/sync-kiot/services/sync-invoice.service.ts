import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncInvoiceService extends BaseSyncService {
  protected readonly entityName = 'invoice';
  protected readonly endpoint = 'invoices';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('invoices', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.invoice.findFirst({
      where: { code: record.code },
    });

    // Resolve FK bằng kiotVietId
    const customer = record.customerId
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

    const soldBy = record.soldById
      ? await this.prisma.user.findFirst({
          where: { kiotVietId: BigInt(record.soldById) },
          select: { id: true },
        })
      : null;

    // sync_kiot: total = tổng trước giảm, totalPayment = tổng phải trả
    // hisweetie: totalAmount = tổng trước giảm, grandTotal = sau giảm
    const totalAmount = Number(record.total || 0);
    const discount = Number(record.discount || 0);
    const grandTotal = Number(record.totalPayment || 0);

    // Tính paidAmount từ payments
    const paidAmount = (record.payments || []).reduce(
      (sum: number, p: any) => sum + Number(p.amount || 0),
      0,
    );
    const debtAmount = grandTotal - paidAmount;

    if (existing) {
      // Chỉ update status và kiotVietId, KHÔNG ghi đè paidAmount/debtAmount
      // vì hisweetie tự tính theo Formula A
      await this.prisma.invoice.update({
        where: { id: existing.id },
        data: {
          status: record.status,
          statusValue: record.statusValue || null,
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });
      return 'updated';
    }

    // Cần createdBy — lấy soldBy hoặc user đầu tiên
    const createdById = soldBy?.id || 1;

    const invoice = await this.prisma.invoice.create({
      data: {
        code: record.code,
        customerId: customer?.id || null,
        branchId: branch?.id || null,
        soldById: soldBy?.id || null,
        purchaseDate: new Date(record.purchaseDate),
        totalAmount,
        discount,
        discountRatio: record.discountRatio || 0,
        grandTotal,
        paidAmount,
        debtAmount: Math.max(debtAmount, 0),
        status: record.status,
        statusValue: record.statusValue || null,
        usingCod: record.usingCod ?? false,
        description: record.description || null,
        createdBy: createdById,
        kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
        lastSyncedAt: new Date(),
      },
    });

    // Sync invoice details
    if (record.invoiceDetails?.length) {
      await this.syncInvoiceDetails(invoice.id, record.invoiceDetails);
    }

    return 'created';
  }

  private async syncInvoiceDetails(invoiceId: number, details: any[]) {
    for (const detail of details) {
      const product = await this.prisma.product.findFirst({
        where: {
          kiotVietId: BigInt(detail.productId || detail.productKiotVietId),
        },
        select: { id: true, code: true, name: true },
      });
      if (!product) continue;

      await this.prisma.invoiceDetail.create({
        data: {
          invoiceId,
          productId: product.id,
          productCode: detail.productCode || product.code,
          productName: detail.productName || product.name,
          quantity: detail.quantity,
          price: detail.price,
          discount: detail.discount || 0,
          discountRatio: detail.discountRatio || 0,
          totalPrice:
            detail.subTotal || Number(detail.quantity) * Number(detail.price),
          note: detail.note || null,
        },
      });
    }
  }
}
