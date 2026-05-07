import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncOrderService extends BaseSyncService {
  protected readonly entityName = 'order';
  protected readonly endpoint = 'orders';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('orders', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.order.findFirst({
      where: { code: record.code },
    });

    const customer = record.customer?.code
      ? await this.prisma.customer.findFirst({
          where: { code: record.customer.code },
          select: { id: true },
        })
      : null;

    const branch = record.branch?.kiotVietId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.branch.kiotVietId },
          select: { id: true },
        })
      : null;

    const soldBy = record.soldById
      ? await this.prisma.user.findFirst({
          where: { kiotVietId: BigInt(record.soldById) },
          select: { id: true },
        })
      : null;

    const saleChannel = record.saleChannel?.kiotVietId
      ? await this.prisma.saleChannel.findFirst({
          where: { kiotVietId: record.saleChannel.kiotVietId },
          select: { id: true },
        })
      : null;

    // sync_kiot: total = trước giảm, totalPayment = sau giảm
    const totalAmount = Number(record.total || 0);
    const discount = Number(record.discount || 0);
    const grandTotal = Number(record.totalPayment || 0);
    const paidAmount = (record.payments || []).reduce(
      (sum: number, p: any) => sum + Number(p.amount || 0),
      0,
    );

    if (existing) {
      await this.prisma.order.update({
        where: { id: existing.id },
        data: {
          status: record.status ?? existing.status,
          statusValue: record.statusValue || null,
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });
      return 'updated';
    }

    const createdById = soldBy?.id || 1;

    const order = await this.prisma.order.create({
      data: {
        code: record.code,
        customerId: customer?.id || null,
        branchId: branch?.id || null,
        soldById: soldBy?.id || null,
        saleChannelId: saleChannel?.id || null,
        orderDate: new Date(record.purchaseDate),
        totalAmount,
        discount,
        discountRatio: record.discountRatio || 0,
        grandTotal,
        paidAmount,
        debtAmount: Math.max(grandTotal - paidAmount, 0),
        status: record.status ?? 1,
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

    // Sync order details
    if (record.orderDetails?.length) {
      await this.syncOrderItems(order.id, record.orderDetails);
    }

    // Sync order delivery
    if (record.orderDelivery) {
      await this.syncOrderDelivery(order.id, record.orderDelivery);
    }

    if (record.orderSurcharges?.length) {
      await this.syncOrderSurcharges(order.id, record.orderSurcharges);
    }

    return 'created';
  }

  private async syncOrderItems(orderId: number, details: any[]) {
    for (const detail of details) {
      const product = await this.prisma.product.findFirst({
        where: { kiotVietId: BigInt(detail.productId) },
        select: { id: true, code: true, name: true },
      });
      if (!product) continue;

      await this.prisma.orderItem.create({
        data: {
          orderId,
          productId: product.id,
          productCode: detail.productCode || product.code,
          productName: detail.productName || product.name,
          quantity: detail.quantity,
          price: detail.price,
          appliedPrice: detail.price,
          discount: detail.discount || 0,
          discountRatio: detail.discountRatio || 0,
          totalPrice:
            detail.subTotal || Number(detail.quantity) * Number(detail.price),
          note: detail.note || null,
        },
      });
    }
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

  private async syncOrderSurcharges(orderId: number, surcharges: any[]) {
    for (const sc of surcharges) {
      let surchargeId: number | null = null;
      if (sc.surchargeId) {
        const surcharge = await this.prisma.surcharge.findFirst({
          where: { kiotVietId: sc.surchargeId },
          select: { id: true },
        });
        surchargeId = surcharge?.id || null;
      }

      await this.prisma.orderSurcharge.create({
        data: {
          orderId,
          surchargeId,
          surchargeName: sc.surchargeName || '',
          surValue: sc.surValue || null,
          price: sc.price || null,
        },
      });
    }
  }
}
