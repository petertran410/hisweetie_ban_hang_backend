import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncOrderSupplierService extends BaseSyncService {
  protected readonly entityName = 'order_supplier';
  protected readonly endpoint = 'order-suppliers';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.orderSupplier.findFirst({
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

    let userId: number | null = null;
    if (record.userId) {
      const user = await this.prisma.user.findFirst({
        where: { kiotVietId: BigInt(record.userId) },
        select: { id: true },
      });
      userId = user?.id || null;
    }

    const kiotOwnedData = {
      status: record.status ?? 0,
      statusValue: record.statusValue || null,
      description: record.description || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.orderSupplier.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });
      return 'updated';
    }

    if (!supplier) {
      this.logger.warn(`⚠️ OrderSupplier ${record.code}: supplier not found`);
      return 'skipped';
    }

    const os = await this.prisma.orderSupplier.create({
      data: {
        code: record.code,
        orderDate: record.orderDate ? new Date(record.orderDate) : new Date(),
        branchId: branch?.id || null,
        supplierId: supplier.id,
        userId,
        total: record.total || 0,
        discount: record.discount || 0,
        discountRatio: record.discountRatio || 0,
        subTotal: record.subTotal || 0,
        paidAmount: record.paidAmount || 0,
        createdBy: userId || 1,
        ...kiotOwnedData,
        createdAt: record.createdDate
          ? new Date(record.createdDate)
          : new Date(),
      },
    });

    if (record.orderSupplierDetails?.length) {
      await this.syncItems(os.id, record.orderSupplierDetails);
    }

    return 'created';
  }

  private async syncItems(orderSupplierId: number, details: any[]) {
    for (const d of details) {
      const product = d.productId
        ? await this.prisma.product.findFirst({
            where: { kiotVietId: BigInt(d.productId) },
            select: { id: true, code: true, name: true },
          })
        : null;
      if (!product) continue;

      await this.prisma.orderSupplierItem.create({
        data: {
          orderSupplierId,
          productId: product.id,
          productCode: d.productCode || product.code,
          productName: d.productName || product.name,
          quantity: d.quantity || 0,
          price: d.price || 0,
          discount: d.discount || 0,
          totalPrice: Number(d.subTotal || 0),
          description: d.description || null,
        },
      });
    }
  }
}
