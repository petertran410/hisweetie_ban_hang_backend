import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

interface InvoiceLookupContext {
  customerByCode: Map<string, number>;
  branchByKiotId: Map<string, number>;
  userByKiotId: Map<string, number>;
  saleChannelByKiotId: Map<string, number>;
  orderByCode: Map<string, number>;
  productByKiotId: Map<string, { id: number; code: string; name: string }>;
  productByCode: Map<string, { id: number; code: string; name: string }>;
  surchargeByKiotId: Map<string, number>;
  bankAccountByKiotId: Map<string, number>;
}

@Injectable()
export class SyncInvoiceService extends BaseSyncService {
  protected readonly entityName = 'invoice';
  protected readonly endpoint = 'invoices';
  protected concurrency = 8;

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('invoices', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async preloadLookups(
    records: any[],
  ): Promise<InvoiceLookupContext> {
    const customerCodes = new Set<string>();
    const branchKiotIds = new Set<number>();
    const userKiotIds = new Set<bigint>();
    const saleChannelKiotIds = new Set<number>();
    const orderCodes = new Set<string>();
    const productKiotIds = new Set<bigint>();
    const productCodes = new Set<string>();
    const surchargeKiotIds = new Set<number>();
    const bankAccountKiotIds = new Set<number>();

    for (const r of records) {
      if (r?.customer?.code) customerCodes.add(r.customer.code);
      const branchKiot = r?.branch?.kiotVietId ?? r?.branchId;
      if (branchKiot) branchKiotIds.add(Number(branchKiot));
      if (r?.soldById) userKiotIds.add(BigInt(r.soldById));
      if (r?.saleChannel?.kiotVietId)
        saleChannelKiotIds.add(Number(r.saleChannel.kiotVietId));
      if (r?.orderCode) orderCodes.add(r.orderCode);

      for (const d of r?.invoiceDetails ?? []) {
        const pk = d?.product?.kiotVietId ?? d?.productKiotVietId;
        if (pk) productKiotIds.add(BigInt(pk));
        if (d?.productCode) productCodes.add(d.productCode);
      }

      for (const sc of r?.invoiceSurcharges ?? []) {
        if (sc?.surchargeId) surchargeKiotIds.add(Number(sc.surchargeId));
      }

      for (const pm of r?.payments ?? []) {
        if (pm?.accountId) bankAccountKiotIds.add(Number(pm.accountId));
      }
    }

    const [
      customers,
      branches,
      users,
      saleChannels,
      orders,
      productsByKiot,
      productsByCode,
      surcharges,
      bankAccounts,
    ] = await Promise.all([
      customerCodes.size > 0
        ? this.prisma.customer.findMany({
            where: { code: { in: [...customerCodes] } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
      branchKiotIds.size > 0
        ? this.prisma.branch.findMany({
            where: { kiotVietId: { in: [...branchKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      userKiotIds.size > 0
        ? this.prisma.user.findMany({
            where: { kiotVietId: { in: [...userKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      saleChannelKiotIds.size > 0
        ? this.prisma.saleChannel.findMany({
            where: { kiotVietId: { in: [...saleChannelKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      orderCodes.size > 0
        ? this.prisma.order.findMany({
            where: { code: { in: [...orderCodes] } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
      productKiotIds.size > 0
        ? this.prisma.product.findMany({
            where: { kiotVietId: { in: [...productKiotIds] } },
            select: { id: true, code: true, name: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      productCodes.size > 0
        ? this.prisma.product.findMany({
            where: { code: { in: [...productCodes] } },
            select: { id: true, code: true, name: true },
          })
        : Promise.resolve([]),
      surchargeKiotIds.size > 0
        ? this.prisma.surcharge.findMany({
            where: { kiotVietId: { in: [...surchargeKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
      bankAccountKiotIds.size > 0
        ? this.prisma.bankAccount.findMany({
            where: { kiotVietId: { in: [...bankAccountKiotIds] } },
            select: { id: true, kiotVietId: true },
          })
        : Promise.resolve([]),
    ]);

    const customerByCode = new Map<string, number>();
    for (const c of customers) if (c.code) customerByCode.set(c.code, c.id);

    const branchByKiotId = new Map<string, number>();
    for (const b of branches as any[]) {
      if (b.kiotVietId != null) branchByKiotId.set(String(b.kiotVietId), b.id);
    }

    const userByKiotId = new Map<string, number>();
    for (const u of users as any[]) {
      if (u.kiotVietId != null) userByKiotId.set(String(u.kiotVietId), u.id);
    }

    const saleChannelByKiotId = new Map<string, number>();
    for (const s of saleChannels as any[]) {
      if (s.kiotVietId != null)
        saleChannelByKiotId.set(String(s.kiotVietId), s.id);
    }

    const orderByCode = new Map<string, number>();
    for (const o of orders) orderByCode.set(o.code, o.id);

    const productByKiotId = new Map<
      string,
      { id: number; code: string; name: string }
    >();
    const productByCode = new Map<
      string,
      { id: number; code: string; name: string }
    >();
    for (const p of productsByKiot as any[]) {
      if (p.kiotVietId != null)
        productByKiotId.set(String(p.kiotVietId), {
          id: p.id,
          code: p.code,
          name: p.name,
        });
      productByCode.set(p.code, { id: p.id, code: p.code, name: p.name });
    }
    for (const p of productsByCode as any[]) {
      if (!productByCode.has(p.code)) {
        productByCode.set(p.code, { id: p.id, code: p.code, name: p.name });
      }
    }

    const surchargeByKiotId = new Map<string, number>();
    for (const s of surcharges as any[]) {
      if (s.kiotVietId != null)
        surchargeByKiotId.set(String(s.kiotVietId), s.id);
    }

    const bankAccountByKiotId = new Map<string, number>();
    for (const b of bankAccounts as any[]) {
      if (b.kiotVietId != null)
        bankAccountByKiotId.set(String(b.kiotVietId), b.id);
    }

    return {
      customerByCode,
      branchByKiotId,
      userByKiotId,
      saleChannelByKiotId,
      orderByCode,
      productByKiotId,
      productByCode,
      surchargeByKiotId,
      bankAccountByKiotId,
    };
  }

  protected async upsertRecordWithContext(
    record: any,
    context: InvoiceLookupContext,
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
    ctx: InvoiceLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.invoice.findFirst({
      where: {
        OR: [
          { code: record.code },
          ...(record.kiotVietId
            ? [{ kiotVietId: BigInt(record.kiotVietId) }]
            : []),
        ],
      },
    });

    const customerId = record.customer?.code
      ? (ctx.customerByCode.get(record.customer.code) ?? null)
      : null;

    const branchKiot = record.branch?.kiotVietId ?? record.branchId ?? null;
    const branchId = branchKiot
      ? (ctx.branchByKiotId.get(String(branchKiot)) ?? null)
      : null;

    const soldById = record.soldById
      ? (ctx.userByKiotId.get(String(record.soldById)) ?? null)
      : null;

    const saleChannelId = record.saleChannel?.kiotVietId
      ? (ctx.saleChannelByKiotId.get(String(record.saleChannel.kiotVietId)) ??
        null)
      : null;

    const orderId = record.orderCode
      ? (ctx.orderByCode.get(record.orderCode) ?? null)
      : null;

    const discount = Number(record.discount ?? 0);
    const discountRatio = Number(record.discountRatio ?? 0);
    const totalAmount =
      discountRatio > 0
        ? Number(record.total ?? 0) +
          (Number(record.total ?? 0) * Number(record.discountRatio ?? 0)) / 100
        : Number(record.total ?? 0) + Number(record.discount ?? 0);
    const grandTotal = Number(record.total ?? 0);
    const paidAmount = Number(record.totalPayment ?? 0);
    const debtAmount = Math.max(grandTotal - paidAmount, 0);

    let invoiceId: number;

    if (existing) {
      await this.prisma.invoice.update({
        where: { id: existing.id },
        data: {
          customerId: customerId ?? existing.customerId,
          branchId: branchId ?? existing.branchId,
          orderId: orderId ?? existing.orderId,
          soldById: soldById ?? existing.soldById,
          saleChannelId: saleChannelId ?? existing.saleChannelId,
          totalAmount,
          discount,
          discountRatio: Number(record.discountRatio || 0),
          grandTotal,
          paidAmount,
          debtAmount: Math.max(debtAmount, 0),
          status: record.status,
          statusValue: record.statusValue || null,
          description: record.description || null,
          purchaseDate: record.purchaseDate
            ? new Date(record.purchaseDate)
            : existing.purchaseDate,
          updatedAt: record.modifiedDate
            ? new Date(record.modifiedDate)
            : new Date(),
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });
      invoiceId = existing.id;

      // Chỉ tạo details nếu chưa có (giữ logic cũ)
      const existingDetails = await this.prisma.invoiceDetail.count({
        where: { invoiceId: existing.id },
      });
      if (existingDetails === 0 && record.invoiceDetails?.length) {
        await this.syncInvoiceDetailsBulk(
          existing.id,
          record.invoiceDetails,
          ctx,
        );
      }

      if (record.invoiceDelivery) {
        const existingDelivery = await this.prisma.invoiceDelivery.findUnique({
          where: { invoiceId: existing.id },
        });
        if (!existingDelivery) {
          await this.syncInvoiceDelivery(existing.id, record.invoiceDelivery);
        }
      }

      if (record.payments?.length) {
        await this.syncInvoicePayments(existing.id, record.payments, ctx);
      }

      return 'updated';
    }

    const createdById = soldById ?? 1;

    const invoice = await this.prisma.invoice.create({
      data: {
        code: record.code,
        customerId: customerId,
        branchId: branchId,
        orderId: orderId,
        soldById: soldById,
        saleChannelId: saleChannelId,
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
    invoiceId = invoice.id;

    if (record.invoiceDetails?.length) {
      await this.syncInvoiceDetailsBulk(invoiceId, record.invoiceDetails, ctx);
    }

    if (record.invoiceDelivery) {
      await this.syncInvoiceDelivery(invoiceId, record.invoiceDelivery);
    }

    if (record.invoiceSurcharges?.length) {
      await this.syncInvoiceSurchargesBulk(
        invoiceId,
        record.invoiceSurcharges,
        ctx,
      );
    }

    if (record.payments?.length) {
      await this.syncInvoicePayments(invoiceId, record.payments, ctx);
    }

    return 'created';
  }

  private async syncInvoiceDetailsBulk(
    invoiceId: number,
    details: any[],
    ctx: InvoiceLookupContext,
  ) {
    const data: any[] = [];
    for (const detail of details) {
      const productKiotId =
        detail.product?.kiotVietId ?? detail.productKiotVietId;

      let product = productKiotId
        ? (ctx.productByKiotId.get(String(productKiotId)) ?? null)
        : null;
      if (!product && detail.productCode) {
        product = ctx.productByCode.get(detail.productCode) ?? null;
      }

      if (!product) {
        this.logger.warn(
          `⚠️ Invoice ${invoiceId}: product not found (kiotId: ${productKiotId}, code: ${detail.productCode})`,
        );
        continue;
      }

      data.push({
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
      });
    }

    if (data.length === 0) return;
    await this.prisma.invoiceDetail.createMany({ data });
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

  private async syncInvoiceSurchargesBulk(
    invoiceId: number,
    surcharges: any[],
    ctx: InvoiceLookupContext,
  ) {
    const data = surcharges.map((sc) => ({
      invoiceId,
      surchargeId: sc.surchargeId
        ? (ctx.surchargeByKiotId.get(String(sc.surchargeId)) ?? null)
        : null,
      surchargeName: sc.surchargeName || sc.name || '',
      surValue: sc.surValue || null,
      price: sc.price || null,
    }));
    if (data.length === 0) return;
    await this.prisma.invoiceSurcharge.createMany({ data });
  }

  private async syncInvoicePayments(
    invoiceId: number,
    payments: any[],
    ctx: InvoiceLookupContext,
  ) {
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
      const code =
        pm.code || `TT${invoice?.code}-${Date.now()}-${invoiceId}`;

      // Check theo (code, invoiceId): 1 phiếu thu KiotViet có thể chia cho N invoice
      // → mỗi invoice có 1 InvoicePayment row riêng, nhưng cùng code chung
      const existingPayment = await this.prisma.invoicePayment.findFirst({
        where: { code, invoiceId },
      });
      if (existingPayment) continue;

      const accountId = pm.accountId
        ? (ctx.bankAccountByKiotId.get(String(pm.accountId)) ?? null)
        : null;

      let cashFlow = await this.prisma.cashFlow.findFirst({ where: { code } });

      if (!cashFlow) {
        try {
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
              description:
                pm.description || `Thu tiền hóa đơn ${invoice?.code}`,
              status: pm.status === 1 ? 2 : 0,
              statusValue: pm.status === 1 ? 'Đã hủy' : 'Đã thanh toán',
              createdBy: 1,
              usedForFinancialReporting: 1,
              createdAt: pm.transDate ? new Date(pm.transDate) : new Date(),
            },
          });
        } catch (e: any) {
          if (e?.code === 'P2002') {
            // Race: worker khác vừa tạo → re-fetch
            cashFlow = await this.prisma.cashFlow.findFirst({
              where: { code },
            });
            if (!cashFlow) {
              this.logger.warn(
                `⚠️ CashFlow ${code} race conflict but cannot re-fetch, skip payment`,
              );
              continue;
            }
          } else {
            throw e;
          }
        }
      }
      try {
        await this.prisma.invoicePayment.create({
          data: {
            code,
            kiotVietId: pm.id ? BigInt(pm.id) : null,
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
      } catch (e: any) {
        if (e?.code === 'P2002') {
          // Payment đã được worker khác tạo (race trên (code, invoiceId)
          // hoặc trên kiotVietId) → skip
          continue;
        }
        throw e;
      }
    }
  }
}
