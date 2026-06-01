import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

function mapKiotStatusToHisweetie(kiotStatus: number | null | undefined): {
  status: number;
  statusValue: string;
  orderStatus: string;
} {
  switch (kiotStatus) {
    case 1:
      return { status: 1, statusValue: 'Phiếu tạm', orderStatus: 'pending' };
    case 2:
      return { status: 3, statusValue: 'Hoàn thành', orderStatus: 'completed' }; // Đang giao hàng → Hoàn thành
    case 3:
      return { status: 3, statusValue: 'Hoàn thành', orderStatus: 'completed' };
    case 4:
      return { status: 4, statusValue: 'Đã hủy', orderStatus: 'cancelled' };
    case 5:
      return {
        status: 5,
        statusValue: 'Đã xác nhận',
        orderStatus: 'confirmed',
      };
    default:
      return { status: 1, statusValue: 'Phiếu tạm', orderStatus: 'pending' };
  }
}

interface OrderLookupContext {
  customerByCode: Map<string, number>;
  branchByKiotId: Map<string, number>;
  userByKiotId: Map<string, number>;
  saleChannelByKiotId: Map<string, number>;
  productByKiotId: Map<string, { id: number; code: string; name: string }>;
  productByCode: Map<string, { id: number; code: string; name: string }>;
  surchargeByKiotId: Map<string, number>;
  bankAccountByKiotId: Map<string, number>;
}

@Injectable()
export class SyncOrderService extends BaseSyncService {
  protected readonly entityName = 'order';
  protected readonly endpoint = 'orders';
  protected concurrency = 8;

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('orders', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  /**
   * Sync toàn bộ Order có purchaseDate <= toDate.
   * Forward `purchaseDateTo` xuống sync_kiot_data để DB-side filter.
   * Không update SyncControl (gọi từ orchestrator riêng).
   */
  async syncBeforeDate(toDate: Date): Promise<{
    created: number;
    updated: number;
    skipped: number;
  }> {
    const purchaseDateTo = toDate.toISOString();
    this.logger.log(`🔄 Sync orders with purchaseDate <= ${purchaseDateTo}...`);
    return this.streamSync(undefined, { purchaseDateTo });
  }

  /**
   * Preload tất cả foreign-key lookup cho 1 page records.
   * Giải N+1 ở mức page.
   */
  protected async preloadLookups(records: any[]): Promise<OrderLookupContext> {
    const customerCodes = new Set<string>();
    const branchKiotIds = new Set<number>();
    const userKiotIds = new Set<bigint>();
    const saleChannelKiotIds = new Set<number>();
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

      for (const d of r?.orderDetails ?? []) {
        const pk = d?.product?.kiotVietId ?? d?.productKiotVietId;
        if (pk) productKiotIds.add(BigInt(pk));
        if (d?.productCode) productCodes.add(d.productCode);
      }

      for (const sc of r?.orderSurcharges ?? []) {
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
      productByKiotId,
      productByCode,
      surchargeByKiotId,
      bankAccountByKiotId,
    };
  }

  protected async upsertRecordWithContext(
    record: any,
    context: OrderLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    return this.upsertWithCtx(record, context);
  }

  /**
   * Path cũ: gọi syncByCode hoặc các nơi khác không có context.
   * Build context tạm thời cho 1 record.
   */
  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const context = await this.preloadLookups([record]);
    return this.upsertWithCtx(record, context);
  }

  private async upsertWithCtx(
    record: any,
    ctx: OrderLookupContext,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.order.findFirst({
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

    // sync_kiot: total = trước giảm, totalPayment = sau giảm
    const totalAmount = Number(record.total ?? 0);
    const discount = Number(record.discount ?? 0);
    const discountRatio = Number(record.discountRatio ?? 0);
    const grandTotal =
      discountRatio > 0
        ? totalAmount - (totalAmount * discountRatio) / 100
        : totalAmount - discount;
    const paidAmount = Number(record.totalPayment ?? 0);
    const debtAmount = Math.max(grandTotal - paidAmount, 0);

    const mapped = mapKiotStatusToHisweetie(record.status);

    let orderId: number;

    if (existing) {
      await this.prisma.order.update({
        where: { id: existing.id },
        data: {
          customerId: customerId ?? existing.customerId,
          branchId: branchId ?? existing.branchId,
          soldById: soldById ?? existing.soldById,
          saleChannelId: saleChannelId ?? existing.saleChannelId,
          totalAmount,
          discount,
          discountRatio: Number(record.discountRatio || 0),
          grandTotal,
          paidAmount,
          debtAmount: Math.max(debtAmount, 0),
          status: mapped.status,
          statusValue: mapped.statusValue,
          orderStatus: mapped.orderStatus,
          description: record.description || null,
          updatedAt: record.modifiedDate
            ? new Date(record.modifiedDate)
            : new Date(),
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });
      orderId = existing.id;
    } else {
      const createdById = soldById ?? 1;
      const created = await this.prisma.order.create({
        data: {
          code: record.code,
          customerId: customerId,
          branchId: branchId,
          soldById: soldById,
          saleChannelId: saleChannelId,
          orderDate: new Date(record.purchaseDate),
          totalAmount,
          discount,
          discountRatio: record.discountRatio || 0,
          grandTotal,
          paidAmount,
          debtAmount: Math.max(grandTotal - paidAmount, 0),
          status: mapped.status,
          statusValue: mapped.statusValue,
          orderStatus: mapped.orderStatus,
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
      orderId = created.id;
    }

    if (record.orderDetails?.length) {
      await this.syncOrderItemsBulk(orderId, record.orderDetails, ctx);
    }

    if (!existing && record.orderDelivery) {
      await this.syncOrderDelivery(orderId, record.orderDelivery);
    }

    if (!existing && record.orderSurcharges?.length) {
      await this.syncOrderSurchargesBulk(orderId, record.orderSurcharges, ctx);
    }

    if (!existing && record.payments?.length) {
      await this.syncOrderPayments(orderId, record.payments, ctx);
    }

    return existing ? 'updated' : 'created';
  }

  /**
   * Bulk sync OrderItem cho 1 order: 1 query findMany + 1 deleteMany + 1 createMany.
   */
  private async syncOrderItemsBulk(
    orderId: number,
    details: any[],
    ctx: OrderLookupContext,
  ): Promise<void> {
    const itemsToCreate: any[] = [];

    for (let i = 0; i < details.length; i++) {
      const detail = details[i];
      const lineNumber = i + 1;

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
          `⚠️ Order ${orderId}: product not found (kiotId: ${productKiotId}, code: ${detail.productCode})`,
        );
        continue;
      }

      const price = Number(detail.price ?? 0);
      const discount = Number(detail.discount ?? 0);
      const discountRatio = Number(detail.discountRatio ?? 0);
      const appliedPrice = price - discount - (price * discountRatio) / 100;
      const totalPrice = detail.subTotal || Number(detail.quantity) * price;

      itemsToCreate.push({
        orderId,
        lineNumber,
        productId: product.id,
        productCode: detail.productCode || product.code,
        productName: detail.productName || product.name,
        quantity: detail.quantity,
        price: detail.price,
        appliedPrice,
        discount: detail.discount || 0,
        discountRatio: detail.discountRatio || 0,
        totalPrice,
        note: detail.note || null,
      });
    }

    if (itemsToCreate.length === 0) return;

    // Strategy: deleteMany + createMany (idempotent, không tạo duplicate)
    // Tránh được Bug C (lineNumber=null collision với items user save).
    await this.prisma.$transaction([
      this.prisma.orderItem.deleteMany({ where: { orderId } }),
      this.prisma.orderItem.createMany({ data: itemsToCreate }),
    ]);
  }

  private async syncOrderDelivery(orderId: number, delivery: any) {
    await this.prisma.orderDelivery.create({
      data: {
        orderId,
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

  private async syncOrderSurchargesBulk(
    orderId: number,
    surcharges: any[],
    ctx: OrderLookupContext,
  ) {
    const data = surcharges.map((sc) => ({
      orderId,
      surchargeId: sc.surchargeId
        ? (ctx.surchargeByKiotId.get(String(sc.surchargeId)) ?? null)
        : null,
      surchargeName: sc.surchargeName || '',
      surValue: sc.surValue || null,
      price: sc.price || null,
    }));
    if (data.length === 0) return;
    await this.prisma.orderSurcharge.createMany({ data });
  }

  private async syncOrderPayments(
    orderId: number,
    payments: any[],
    ctx: OrderLookupContext,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
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
      const code = pm.code || `TTDH${order?.code}-${Date.now()}-${orderId}`;

      // Check theo (code, orderId): 1 phiếu thu KiotViet có thể chia cho N order
      const existingPayment = await this.prisma.orderPayment.findFirst({
        where: { code, orderId },
      });
      if (existingPayment) continue;

      const accountId = pm.accountId
        ? (ctx.bankAccountByKiotId.get(String(pm.accountId)) ?? null)
        : null;

      let cashFlow = await this.prisma.cashFlow.findFirst({
        where: { code },
      });

      if (!cashFlow) {
        try {
          cashFlow = await this.prisma.cashFlow.create({
            data: {
              code,
              branchId: order?.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: pm.amount || 0,
              transDate: pm.transDate ? new Date(pm.transDate) : new Date(),
              method: pm.method || 'cash',
              accountId,
              partnerType: 'C',
              partnerId: order?.customerId || null,
              partnerName: order?.customer?.name || null,
              contactNumber: order?.customer?.contactNumber || null,
              address: order?.customer?.addresses?.[0]?.address || null,
              description:
                pm.description || `Thu tạm ứng đơn hàng ${order?.code}`,
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
        await this.prisma.orderPayment.create({
          data: {
            code,
            kiotVietId: pm.id ? BigInt(pm.id) : null,
            orderId,
            amount: pm.amount || 0,
            paymentDate: pm.transDate ? new Date(pm.transDate) : new Date(),
            paymentMethod: pm.method || 'cash',
            accountId,
            description: pm.description || null,
            status: pm.status ?? 1,
            createdBy: 1,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') {
          // Race trên (code, orderId) hoặc kiotVietId → skip
          continue;
        }
        throw e;
      }
    }
  }
}
