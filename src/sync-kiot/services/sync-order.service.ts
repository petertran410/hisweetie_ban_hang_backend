import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

function mapKiotStatusToOrderStatus(status: number): string {
  switch (status) {
    case 1:
      return 'pending'; // Phiếu tạm
    case 2:
      return 'processing'; // Đang giao hàng
    case 3:
      return 'completed'; // Hoàn thành
    case 4:
      return 'cancelled'; // Đã hủy
    case 5:
      return 'completed'; // Hoàn thành (đã giao)
    case 6:
      return 'partially_invoiced';
    default:
      return 'pending';
  }
}

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

    const saleChannel = record.saleChannel?.kiotVietId
      ? await this.prisma.saleChannel.findFirst({
          where: { kiotVietId: record.saleChannel.kiotVietId },
          select: { id: true },
        })
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

    if (existing) {
      await this.prisma.order.update({
        where: { id: existing.id },
        data: {
          customerId: customer?.id || existing.customerId,
          branchId: branch?.id || existing.branchId,
          soldById: soldBy?.id || existing.soldById,
          saleChannelId: saleChannel?.id || existing.saleChannelId,
          totalAmount,
          discount,
          discountRatio: Number(record.discountRatio || 0),
          grandTotal,
          paidAmount,
          debtAmount: Math.max(debtAmount, 0),
          status: record.status ?? existing.status,
          statusValue: record.statusValue || null,
          orderStatus: mapKiotStatusToOrderStatus(record.status ?? 1),
          kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
          lastSyncedAt: new Date(),
        },
      });

      const existingItems = await this.prisma.orderItem.count({
        where: { orderId: existing.id },
      });
      if (existingItems === 0 && record.orderDetails?.length) {
        await this.syncOrderItems(existing.id, record.orderDetails);
      }

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
        orderStatus: mapKiotStatusToOrderStatus(record.status ?? 1),
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

    if (record.orderDetails?.length) {
      await this.syncOrderItems(order.id, record.orderDetails);
    }

    if (record.orderDelivery) {
      await this.syncOrderDelivery(order.id, record.orderDelivery);
    }

    if (record.orderSurcharges?.length) {
      await this.syncOrderSurcharges(order.id, record.orderSurcharges);
    }

    if (record.payments?.length) {
      await this.syncOrderPayments(order.id, record.payments);
    }

    return 'created';
  }

  private async syncOrderItems(orderId: number, details: any[]) {
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
          `⚠️ Order ${orderId}: product not found (kiotId: ${productKiotId}, code: ${detail.productCode})`,
        );
        continue;
      }

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

  private async syncOrderPayments(orderId: number, payments: any[]) {
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
      const code = pm.code || `TTDH${order?.code}-${Date.now()}`;

      const existingPayment = await this.prisma.orderPayment.findFirst({
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

      // 1. Tìm hoặc tạo CashFlow
      let cashFlow = await this.prisma.cashFlow.findFirst({
        where: { code },
      });

      if (!cashFlow) {
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
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: 1,
            usedForFinancialReporting: 1,
            createdAt: pm.transDate ? new Date(pm.transDate) : new Date(),
          },
        });
      }

      // 2. Tạo OrderPayment
      await this.prisma.orderPayment.create({
        data: {
          code,
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
    }
  }
}
