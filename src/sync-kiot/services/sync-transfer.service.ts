import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncTransferService extends BaseSyncService {
  protected readonly entityName = 'transfer';
  protected readonly endpoint = 'transfers';

  private computeTotals(details: any[]): {
    totalTransfer: number;
    totalReceive: number;
  } {
    return details.reduce(
      (acc, d) => ({
        totalTransfer:
          acc.totalTransfer + (d.sendQuantity || 0) * (d.sendPrice || 0),
        totalReceive:
          acc.totalReceive + (d.receivedQuantity || 0) * (d.receivePrice || 0),
      }),
      { totalTransfer: 0, totalReceive: 0 },
    );
  }

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.transfer.findFirst({
      where: { code: record.code },
    });

    const fromBranch = record.fromBranchId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.fromBranchId },
          select: { id: true, name: true },
        })
      : null;

    const toBranch = record.toBranchId
      ? await this.prisma.branch.findFirst({
          where: { kiotVietId: record.toBranchId },
          select: { id: true, name: true },
        })
      : null;

    if (!fromBranch || !toBranch) {
      this.logger.warn(`⚠️ Transfer ${record.code}: missing branch mapping`);
      return 'skipped';
    }

    const kiotOwnedData = {
      status: record.status ?? 1,
      noteBySource: record.description || null,
      kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.transfer.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });

      if (record.details?.length) {
        await this.syncDetails(existing.id, record.details);
        const { totalTransfer, totalReceive } = this.computeTotals(
          record.details,
        );
        await this.prisma.transfer.update({
          where: { id: existing.id },
          data: { totalTransfer, totalReceive },
        });
      }

      return 'updated';
    }

    const transfer = await this.prisma.transfer.create({
      data: {
        code: record.code,
        fromBranchId: fromBranch.id,
        toBranchId: toBranch.id,
        fromBranchName: fromBranch.name,
        toBranchName: toBranch.name,
        transferredDate: record.dispatchedDate
          ? new Date(record.dispatchedDate)
          : null,
        receivedDate: record.receivedDate
          ? new Date(record.receivedDate)
          : null,
        createdById: 1,
        createdByName: '',
        noteBySource: record.description || null,
        status: record.status ?? 1,
        kiotVietId: record.kiotVietId ? BigInt(record.kiotVietId) : null,
        lastSyncedAt: new Date(),
      },
    });

    if (record.details?.length) {
      await this.syncDetails(transfer.id, record.details);
      const { totalTransfer, totalReceive } = this.computeTotals(
        record.details,
      );
      await this.prisma.transfer.update({
        where: { id: transfer.id },
        data: { totalTransfer, totalReceive },
      });
    }

    return 'created';
  }

  private async syncDetails(transferId: number, details: any[]) {
    for (const d of details) {
      // FIX Bug 2: Dùng productCode thay vì kiotVietId(d.productId là internal ID của sync_kiot_data)
      if (!d.productCode) continue;

      const product = await this.prisma.product.findFirst({
        where: { code: d.productCode },
        select: { id: true, code: true, name: true },
      });

      if (!product) {
        this.logger.warn(
          `⚠️ TransferDetail: product not found (code: ${d.productCode}), skipping`,
        );
        continue;
      }

      await this.prisma.transferDetail.upsert({
        where: {
          transferId_productId: {
            transferId,
            productId: product.id,
          },
        },
        update: {
          productCode: d.productCode || product.code,
          productName: d.productName || product.name,
          sendQuantity: d.sendQuantity || 0,
          receivedQuantity: d.receivedQuantity || 0,
          sendPrice: d.sendPrice || 0,
          receivePrice: d.receivePrice || 0,
          totalTransfer: (d.sendQuantity || 0) * (d.sendPrice || 0),
          totalReceive: (d.receivedQuantity || 0) * (d.receivePrice || 0),
        },
        create: {
          transferId,
          productId: product.id,
          productCode: d.productCode || product.code,
          productName: d.productName || product.name,
          sendQuantity: d.sendQuantity || 0,
          receivedQuantity: d.receivedQuantity || 0,
          sendPrice: d.sendPrice || 0,
          receivePrice: d.receivePrice || 0,
          totalTransfer: (d.sendQuantity || 0) * (d.sendPrice || 0),
          totalReceive: (d.receivedQuantity || 0) * (d.receivePrice || 0),
        },
      });
    }
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('transfers', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }
}
