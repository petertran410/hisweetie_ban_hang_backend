import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncPurchaseOrderService extends BaseSyncService {
  protected readonly entityName = 'purchase_order';
  protected readonly endpoint = 'purchase-orders';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.purchaseOrder.findFirst({
      where: { code: record.code },
    });

    const supplier = record.supplierCode
      ? await this.prisma.supplier.findFirst({
          where: { code: record.supplierCode },
          select: { id: true },
        })
      : record.supplierId
        ? await this.prisma.supplier.findFirst({
            where: { kiotVietId: BigInt(record.supplierId) },
            select: { id: true },
          })
        : null;

    const branch = record.branchId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.branchId },
          select: { id: true },
        })
      : null;

    let purchaseById: number | null = null;
    if (record.purchaseById) {
      const user = await this.prisma.user.findFirst({
        where: { kiotVietId: BigInt(record.purchaseById) },
        select: { id: true },
      });
      purchaseById = user?.id || null;
    }

    const total = Number(record.total || 0);
    const discount = Number(record.discount || 0);
    const paidAmount = Number(record.paidAmount || 0);

    const kiotOwnedData = {
      status: record.status ?? 0,
      statusValue: record.statusValue || null,
      description: record.description || null,
      partnerType: record.partnerType || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.purchaseOrder.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    if (!supplier) {
      this.logger.warn(`⚠️ PurchaseOrder ${record.code}: supplier not found`);
      return 'skipped';
    }

    const po = await this.prisma.purchaseOrder.create({
      data: {
        code: record.code,
        supplierId: supplier.id,
        branchId: branch?.id || null,
        purchaseById,
        purchaseDate: record.purchaseDate
          ? new Date(record.purchaseDate)
          : new Date(),
        total,
        totalAmount: total,
        discount,
        discountRatio: record.discountRatio || 0,
        subTotal: total - discount,
        paidAmount,
        debtAmount: Math.max(total - discount - paidAmount, 0),
        createdBy: purchaseById || 1,
        ...kiotOwnedData,
        createdAt: record.createdDate
          ? new Date(record.createdDate)
          : new Date(),
        updatedAt: record.modifiedDate
          ? new Date(record.modifiedDate)
          : new Date(),
      },
    });

    if (record.details?.length) {
      await this.syncItems(po.id, record.details);
    }

    if (record.surcharges?.length) {
      await this.syncSurcharges(po.id, record.surcharges);
    }

    if (record.payments?.length) {
      await this.syncPayments(po.id, record.payments);
    }

    return 'created';
  }

  private async syncItems(purchaseOrderId: number, details: any[]) {
    for (const d of details) {
      const product = d.productId
        ? await this.prisma.product.findFirst({
            where: { kiotVietId: BigInt(d.productId) },
            select: { id: true, code: true, name: true },
          })
        : null;
      if (!product) continue;

      await this.prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId,
          productId: product.id,
          productCode: d.productCode || product.code,
          productName: d.productName || product.name,
          quantity: d.quantity || 0,
          price: d.price || 0,
          discount: d.discount || 0,
          discountRatio: d.discountRatio || 0,
          totalPrice: Number(d.quantity || 0) * Number(d.price || 0),
          description: d.description || null,
        },
      });
    }
  }

  private async syncSurcharges(purchaseOrderId: number, surcharges: any[]) {
    for (const sc of surcharges) {
      await this.prisma.purchaseOrderSurcharge.create({
        data: {
          purchaseOrderId,
          code: sc.code || `SC-${purchaseOrderId}-${Date.now()}`,
          name: sc.name || '',
          value: sc.value || null,
          valueRatio: sc.valueRatio || null,
          isSupplierExpense: sc.isSupplierExpense ?? false,
          type: sc.type ?? 0,
        },
      });
    }
  }

  private async syncPayments(purchaseOrderId: number, payments: any[]) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: {
        id: true,
        code: true,
        branchId: true,
        supplierId: true,
        supplier: {
          select: {
            name: true,
            contactNumber: true,
            address: true,
          },
        },
      },
    });

    for (const pm of payments) {
      const code = pm.code || `PNPC${po?.code}-${Date.now()}`;

      const existing = await this.prisma.purchaseOrderPayment.findFirst({
        where: { code },
      });
      if (existing) continue;

      let accountId: number | null = null;
      if (pm.accountId) {
        const account = await this.prisma.bankAccount.findFirst({
          where: { kiotVietId: pm.accountId },
          select: { id: true },
        });
        accountId = account?.id || null;
      }

      // 1. Tạo CashFlow (phiếu chi nhập hàng)
      await this.prisma.cashFlow.create({
        data: {
          code,
          branchId: po?.branchId || 1,
          cashFlowGroupId: 4, // Chi tiền nhập hàng
          isReceipt: false,
          amount: pm.amount || 0,
          transDate: pm.transDate ? new Date(pm.transDate) : new Date(),
          method: pm.method || 'cash',
          accountId,
          partnerType: 'S',
          partnerId: po?.supplierId || null,
          partnerName: po?.supplier?.name || null,
          contactNumber: po?.supplier?.contactNumber || null,
          address: po?.supplier?.address || null,
          description: pm.description || `Chi tiền nhập hàng ${po?.code}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: 1,
          usedForFinancialReporting: 1,
          createdAt: pm.transDate ? new Date(pm.transDate) : new Date(),
        },
      });

      // 2. Tạo PurchaseOrderPayment
      await this.prisma.purchaseOrderPayment.create({
        data: {
          code,
          purchaseOrderId,
          amount: pm.amount || 0,
          paymentDate: pm.transDate ? new Date(pm.transDate) : new Date(),
          paymentMethod: pm.method || 'cash',
          accountId,
          status: pm.status ?? 1,
          description: pm.description || null,
        },
      });
    }
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('purchase-orders', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }
}
