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

    const customer = record.customer?.code
      ? await this.prisma.customer.findFirst({
          where: { code: record.customer.code },
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

    const soldBy = record.soldById
      ? await this.prisma.user.findFirst({
          where: { kiotVietId: BigInt(record.soldById) },
          select: { id: true },
        })
      : null;

    const order = record.orderCode
      ? await this.prisma.order.findFirst({
          where: { code: record.orderCode },
          select: { id: true },
        })
      : null;

    const totalAmount = Number(record.total ?? record.totalAmount ?? 0);
    const discount = Number(record.discount ?? 0);
    const grandTotal = Number(
      record.totalPayment ?? record.grandTotal ?? totalAmount - discount,
    );

    // Tính paidAmount từ payments
    const paidAmount = (record.payments || []).reduce(
      (sum: number, p: any) => sum + Number(p.amount || 0),
      0,
    );
    const debtAmount = grandTotal - paidAmount;

    if (existing) {
      await this.prisma.invoice.update({
        where: { id: existing.id },
        data: {
          customerId: customer?.id || existing.customerId,
          branchId: branch?.id || existing.branchId,
          orderId: order?.id || existing.orderId,
          soldById: soldBy?.id || existing.soldById,
          status: record.status,
          statusValue: record.statusValue || null,
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          totalAmount,
          discount,
          discountRatio: record.discountRatio || 0,
          grandTotal,
          paidAmount,
          debtAmount: Math.max(debtAmount, 0),
          usingCod: record.usingCod ?? false,
          description: record.description || null,
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
        orderId: order?.id || null,
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
        createdAt: record.createdDate
          ? new Date(record.createdDate)
          : new Date(),
        updatedAt: record.modifiedDate
          ? new Date(record.modifiedDate)
          : new Date(),
        lastSyncedAt: new Date(),
      },
    });

    // Sync invoice details
    if (record.invoiceDetails?.length) {
      await this.syncInvoiceDetails(invoice.id, record.invoiceDetails);
    }

    if (record.invoiceDelivery) {
      await this.syncInvoiceDelivery(invoice.id, record.invoiceDelivery);
    }

    if (record.invoiceSurcharges?.length) {
      await this.syncInvoiceSurcharges(invoice.id, record.invoiceSurcharges);
    }

    if (record.payments?.length) {
      await this.syncInvoicePayments(invoice.id, record.payments);
    }

    return 'created';
  }

  private async syncInvoiceDetails(invoiceId: number, details: any[]) {
    for (const detail of details) {
      const productKiotId =
        detail.product?.kiotVietId ?? detail.productKiotVietId;

      let product = productKiotId
        ? await this.prisma.product.findFirst({
            where: { kiotVietId: BigInt(productKiotId) },
            select: { id: true, code: true, name: true },
          })
        : null;

      if (!product && detail.productCode) {
        product = await this.prisma.product.findFirst({
          where: { code: detail.productCode },
          select: { id: true, code: true, name: true },
        });
      }

      if (!product) {
        this.logger.warn(
          `⚠️ Invoice ${invoiceId}: product not found (kiotId: ${productKiotId}, code: ${detail.productCode})`,
        );
        continue;
      }

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

  private async syncInvoiceDelivery(invoiceId: number, delivery: any) {
    const existing = await this.prisma.invoiceDelivery.findUnique({
      where: { invoiceId },
    });
    if (existing) return;

    await this.prisma.invoiceDelivery.create({
      data: {
        invoiceId,
        deliveryCode: delivery.deliveryCode || null,
        type: delivery.type || null,
        status: delivery.status || 1,
        price: delivery.price || null,
        receiver: delivery.receiver || '',
        contactNumber: delivery.contactNumber || '',
        address: delivery.address || '',
        locationName: delivery.locationName || null,
        wardName: delivery.wardName || null,
        weight: delivery.weight || null,
        length: delivery.length || null,
        width: delivery.width || null,
        height: delivery.height || null,
      },
    });
  }

  private async syncInvoiceSurcharges(invoiceId: number, surcharges: any[]) {
    for (const sc of surcharges) {
      let surchargeId: number | null = null;
      if (sc.surchargeId) {
        const surcharge = await this.prisma.surcharge.findFirst({
          where: { kiotVietId: sc.surchargeId },
          select: { id: true },
        });
        surchargeId = surcharge?.id || null;
      }

      await this.prisma.invoiceSurcharge.create({
        data: {
          invoiceId,
          surchargeId,
          surchargeName: sc.surchargeName || sc.name || '',
          surValue: sc.surValue || null,
          price: sc.price || null,
        },
      });
    }
  }

  private async syncInvoicePayments(invoiceId: number, payments: any[]) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        code: true,
        branchId: true,
        customerId: true,
        customer: {
          select: {
            name: true,
            contactNumber: true,
            addresses: { where: { isDefault: true }, take: 1 },
          },
        },
      },
    });

    for (const pm of payments) {
      const code = pm.code || `TT${invoice?.code}-${Date.now()}`;

      // Skip nếu InvoicePayment đã tồn tại
      const existingPayment = await this.prisma.invoicePayment.findFirst({
        where: { code },
      });
      if (existingPayment) continue;

      let accountId: number | null = null;
      if (pm.accountId) {
        const account = await this.prisma.bankAccount.findFirst({
          where: { kiotVietId: pm.accountId },
          select: { id: true },
        });
        accountId = account?.id || null;
      }

      // Check CashFlow đã tồn tại chưa (có thể từ sync trước hoặc standalone)
      let cashFlow = await this.prisma.cashFlow.findFirst({
        where: { code },
      });

      if (!cashFlow) {
        cashFlow = await this.prisma.cashFlow.create({
          data: {
            code,
            branchId: invoice?.branchId || 1,
            cashFlowGroupId: 3,
            isReceipt: true,
            amount: pm.amount || 0,
            transDate: pm.transDate ? new Date(pm.transDate) : new Date(),
            method: pm.method || 'cash',
            accountId,
            partnerType: 'C',
            partnerId: invoice?.customerId || null,
            partnerName: invoice?.customer?.name || null,
            contactNumber: invoice?.customer?.contactNumber || null,
            address: invoice?.customer?.addresses?.[0]?.address || null,
            description: pm.description || `Thu tiền hóa đơn ${invoice?.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: 1,
            usedForFinancialReporting: 1,
            createdAt: pm.transDate ? new Date(pm.transDate) : new Date(),
          },
        });
      }

      await this.prisma.invoicePayment.create({
        data: {
          code,
          invoiceId,
          amount: pm.amount || 0,
          paymentDate: pm.transDate ? new Date(pm.transDate) : new Date(),
          status: pm.status ?? 1,
          paymentMethod: pm.method || 'cash',
          accountId,
          description: pm.description || null,
          cashFlowId: cashFlow.id,
        },
      });
    }
  }
}
