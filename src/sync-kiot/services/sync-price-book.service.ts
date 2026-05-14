import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';

@Injectable()
export class SyncPriceBookService extends BaseSyncService {
  protected readonly entityName = 'price_book';
  protected readonly endpoint = 'price-books';

  constructor(prisma: PrismaService, api: SyncKiotApiService) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('price-books', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // sync_kiot PriceBook: kiotVietId (Int unique), name
    // hisweetie PriceBook: name, isActive, isGlobal, startDate, endDate...
    // Match bằng kiotVietId hoặc name
    const existing = await this.prisma.priceBook.findFirst({
      where: {
        OR: [{ kiotVietId: record.kiotVietId }, { name: record.name }],
      },
    });

    const kiotOwnedData = {
      name: record.name,
      isActive: record.isActive ?? true,
      isGlobal: record.isGlobal ?? false,
      startDate: record.startDate ? new Date(record.startDate) : null,
      endDate: record.endDate ? new Date(record.endDate) : null,
      forAllCusGroup: record.forAllCusGroup ?? false,
      forAllUser: record.forAllUser ?? false,
      kiotVietId: record.kiotVietId,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      await this.prisma.priceBook.update({
        where: { id: existing.id },
        data: kiotOwnedData,
      });

      // Sync sub-entities
      if (record.details?.length) {
        await this.syncDetails(existing.id, record.details);
      }
      if (record.branches?.length) {
        await this.syncBranches(existing.id, record.branches);
      }
      if (record.customerGroups?.length) {
        await this.syncCustomerGroups(existing.id, record.customerGroups);
      }
      if (record.users?.length) {
        await this.syncUsers(existing.id, record.users);
      }

      return 'updated';
    }

    const priceBook = await this.prisma.priceBook.create({
      data: kiotOwnedData,
    });

    if (record.details?.length) {
      await this.syncDetails(priceBook.id, record.details);
    }
    if (record.branches?.length) {
      await this.syncBranches(priceBook.id, record.branches);
    }
    if (record.customerGroups?.length) {
      await this.syncCustomerGroups(priceBook.id, record.customerGroups);
    }
    if (record.users?.length) {
      await this.syncUsers(priceBook.id, record.users);
    }

    return 'created';
  }

  private async syncDetails(priceBookId: number, details: any[]) {
    for (const detail of details) {
      // productId là internal ID của sync_kiot_data → không dùng được
      // chỉ dùng productKiotId (KiotViet ID thực)
      if (!detail.productKiotId) {
        this.logger.warn(
          `⚠️ PriceBookDetail missing productKiotId, skipping (productId: ${detail.productId})`,
        );
        continue;
      }

      const product = await this.prisma.product.findFirst({
        where: { kiotVietId: BigInt(detail.productKiotId) },
        select: { id: true },
      });
      if (!product) continue;

      await this.prisma.priceBookDetail.upsert({
        where: {
          priceBookId_productId: {
            priceBookId,
            productId: product.id,
          },
        },
        update: {
          price: detail.price || 0,
          isActive: detail.isActive ?? true,
        },
        create: {
          priceBookId,
          productId: product.id,
          price: detail.price || 0,
          isActive: detail.isActive ?? true,
        },
      });
    }
  }

  private async syncBranches(priceBookId: number, branches: any[]) {
    for (const branchData of branches) {
      // sync_kiot PriceBookBranch.branchId là kiotVietId của Branch
      const branch = await this.prisma.branch.findFirst({
        where: { kiotVietId: branchData.branchId },
        select: { id: true, name: true },
      });
      if (!branch) continue;

      await this.prisma.priceBookBranch.upsert({
        where: {
          priceBookId_branchId: {
            priceBookId,
            branchId: branch.id,
          },
        },
        update: { branchName: branchData.branchName || branch.name },
        create: {
          priceBookId,
          branchId: branch.id,
          branchName: branchData.branchName || branch.name,
        },
      });
    }
  }

  private async syncCustomerGroups(priceBookId: number, groups: any[]) {
    for (const groupData of groups) {
      const group = await this.prisma.customerGroup.findFirst({
        where: { kiotVietId: groupData.customerGroupId },
        select: { id: true, name: true },
      });
      if (!group) continue;

      await this.prisma.priceBookCustomerGroup.upsert({
        where: {
          priceBookId_customerGroupId: {
            priceBookId,
            customerGroupId: group.id,
          },
        },
        update: {
          customerGroupName: groupData.customerGroupName || group.name,
        },
        create: {
          priceBookId,
          customerGroupId: group.id,
          customerGroupName: groupData.customerGroupName || group.name,
        },
      });
    }
  }

  private async syncUsers(priceBookId: number, users: any[]) {
    for (const userData of users) {
      // sync_kiot PriceBookUser.userId là kiotVietId (BigInt) của User
      const user = await this.prisma.user.findFirst({
        where: { kiotVietId: BigInt(userData.userId) },
        select: { id: true, name: true },
      });
      if (!user) continue;

      await this.prisma.priceBookUser.upsert({
        where: {
          priceBookId_userId: {
            priceBookId,
            userId: user.id,
          },
        },
        update: { userName: userData.userName || user.name },
        create: {
          priceBookId,
          userId: user.id,
          userName: userData.userName || user.name,
        },
      });
    }
  }
}
