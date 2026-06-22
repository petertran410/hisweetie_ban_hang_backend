import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LarkProductBaseService } from './lark-product-base.service';
import {
  LARK_PRODUCT_FIELDS,
  BRANCH_INVENTORY_COLUMNS,
  SYNCED_BRANCH_IDS,
  resolvePriceBookColumn,
  toYesNo,
} from '../helpers/product-field-mapping';

// Include dùng chung — lấy thương hiệu, tồn kho 3 kho, bảng giá đang hoạt động
const PRODUCT_INCLUDE = {
  tradeMark: { select: { name: true } },
  inventories: {
    where: { branchId: { in: SYNCED_BRANCH_IDS } },
    select: { branchId: true, onHand: true, cost: true },
  },
  priceBookDetails: {
    where: { isActive: true },
    select: {
      price: true,
      priceBook: { select: { name: true } },
    },
  },
} as const;

@Injectable()
export class LarkProductSyncService {
  private readonly logger = new Logger(LarkProductSyncService.name);
  private readonly tableId: string | null;
  private readonly MAX_RETRIES = 3;

  // ★ Debounce queue: gom productId rồi flush sau DEBOUNCE_MS — gộp nhiều lần
  // cập nhật (giá/tồn/thông tin) trong 1 thao tác thành 1 lần đẩy Lark.
  private readonly DEBOUNCE_MS = 4000;
  private readonly pendingTimers = new Map<number, NodeJS.Timeout>();

  // ★ Whitelist tên field hợp lệ trên Lark — nạp 1 lần, dùng để lọc payload
  // tránh FieldNameNotFound làm fail cả batch. null = chưa nạp / nạp lỗi.
  private validFieldNames: Set<string> | null = null;

  constructor(
    private readonly larkBase: LarkProductBaseService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.tableId = this.config.get<string>('LARK_PRODUCT_TABLE_ID') || null;
    if (!this.tableId) {
      this.logger.warn(
        'LARK_PRODUCT_TABLE_ID chưa cấu hình — sync sản phẩm sẽ bị skip',
      );
    }
  }

  private isEnabled(): boolean {
    return !!this.tableId && this.larkBase.isEnabled();
  }

  /**
   * Nạp danh sách field hợp lệ từ Lark (1 lần / lần gọi sync).
   * Lỗi/empty → giữ null để mapping gửi nguyên payload (fallback an toàn).
   */
  private async ensureFieldWhitelist(force = false): Promise<void> {
    if (!force && this.validFieldNames) return;
    if (!this.tableId) return;
    const names = await this.larkBase.fetchFieldNames(this.tableId);
    this.validFieldNames = names.size > 0 ? names : null;
    if (this.validFieldNames) {
      this.logger.log(
        `🧾 Loaded ${this.validFieldNames.size} valid Lark field names for whitelist`,
      );
    }
  }

  /**
   * Lên lịch sync 1 sản phẩm (debounce). Mỗi productId chỉ giữ 1 timer;
   * lần gọi sau reset lại đồng hồ → chỉ đẩy 1 lần sau khi yên ổn DEBOUNCE_MS.
   */
  enqueueSync(productId: number): void {
    if (!this.isEnabled()) return;

    const existing = this.pendingTimers.get(productId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingTimers.delete(productId);
      this.syncSingleAsync(productId);
    }, this.DEBOUNCE_MS);

    if (typeof timer.unref === 'function') timer.unref();

    this.pendingTimers.set(productId, timer);
  }

  // =============================================
  // REAL-TIME SYNC (fire-and-forget với retry)
  // =============================================

  /**
   * Sync 1 sản phẩm lên Lark.
   * Fire-and-forget: không throw ra ngoài, tự đánh dấu FAILED.
   */
  async syncSingle(productId: number): Promise<void> {
    if (!this.isEnabled()) return;
    const tableId = this.tableId!;
    await this.ensureFieldWhitelist();

    try {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        include: PRODUCT_INCLUDE,
      });

      if (!product) {
        this.logger.warn(`Product #${productId} not found`);
        return;
      }

      if (!product.code) {
        this.logger.debug(`Skip product without code: #${productId}`);
        return;
      }

      // ★ Đánh dấu SYNCING ngay — cron sẽ không pick up
      await this.prisma.product.update({
        where: { id: productId },
        data: { larkSyncStatus: 'SYNCING' },
      });

      const fields = this.mapProductToLarkFields(product);
      let needSearchCreate = !product.larkRecordId;

      if (product.larkRecordId) {
        try {
          await this.larkBase.updateRecord(
            tableId,
            product.larkRecordId,
            fields,
          );
        } catch (updateError) {
          if (this.larkBase.isRecordNotFound(updateError)) {
            this.logger.warn(
              `⚠️ Record ${product.larkRecordId} deleted on Lark, re-creating product ${product.code}`,
            );
            await this.prisma.product.update({
              where: { id: productId },
              data: { larkRecordId: null },
            });
            needSearchCreate = true;
          } else {
            throw updateError;
          }
        }
      }

      if (needSearchCreate) {
        let recordId = await this.larkBase.searchRecord(
          tableId,
          LARK_PRODUCT_FIELDS.MA_HANG_HOA,
          product.code,
        );

        if (recordId) {
          await this.larkBase.updateRecord(tableId, recordId, fields);
        } else {
          recordId = await this.larkBase.createRecord(tableId, fields);
        }

        await this.prisma.product.update({
          where: { id: productId },
          data: { larkRecordId: recordId },
        });
      }

      // ★ Thành công → SYNCED + reset retries
      await this.prisma.product.update({
        where: { id: productId },
        data: {
          larkSyncStatus: 'SYNCED',
          larkSyncedAt: new Date(),
          larkSyncRetries: 0,
        },
      });
      this.logger.log(`✅ Synced product ${product.code} to Lark`);
    } catch (error: any) {
      this.logger.error(
        `❌ Sync product #${productId} failed: ${error.message}`,
      );

      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { larkSyncRetries: true },
      });

      const currentRetries = product?.larkSyncRetries ?? 0;

      await this.prisma.product.update({
        where: { id: productId },
        data: {
          larkSyncStatus:
            currentRetries + 1 >= this.MAX_RETRIES ? 'FAILED' : 'PENDING',
          larkSyncRetries: { increment: 1 },
        },
      });
    }
  }

  /**
   * Fire-and-forget wrapper — gọi từ service khác, không block.
   */
  syncSingleAsync(productId: number): void {
    if (!this.isEnabled()) return;
    this.syncSingle(productId).catch((err) => {
      this.logger.error(
        `Async sync product #${productId} error: ${err.message}`,
      );
    });
  }

  // =============================================
  // CRON JOB — retry FAILED + sync PENDING
  // =============================================

  async syncPendingAndFailed(): Promise<{ success: number; failed: number }> {
    if (!this.isEnabled()) {
      this.logger.warn('Product sync disabled — bỏ qua');
      return { success: 0, failed: 0 };
    }
    const tableId = this.tableId!;
    // Force reload whitelist mỗi lần chạy batch — bắt kịp cột mới thêm trên Lark.
    await this.ensureFieldWhitelist(true);

    const products = await this.prisma.product.findMany({
      where: {
        code: { not: '' },
        larkSyncStatus: { not: 'SYNCING' },
      },
      include: PRODUCT_INCLUDE,
    });

    if (products.length === 0) {
      this.logger.log('No products need sync');
      return { success: 0, failed: 0 };
    }

    this.logger.log(`🔄 Syncing ${products.length} products...`);

    const toUpdate = products.filter((p) => p.larkRecordId);
    let toCreate = products.filter((p) => !p.larkRecordId);

    let success = 0;
    let failed = 0;

    // =============================================
    // BATCH UPDATE — pre-verify + batch update
    // =============================================
    if (toUpdate.length > 0) {
      const allRecordIds = toUpdate.map((p) => p.larkRecordId!);
      const existingIds = await this.larkBase.verifyRecordIds(
        tableId,
        allRecordIds,
      );

      const validProducts = toUpdate.filter((p) =>
        existingIds.has(p.larkRecordId!),
      );
      const staleProducts = toUpdate.filter(
        (p) => !existingIds.has(p.larkRecordId!),
      );

      if (staleProducts.length > 0) {
        this.logger.warn(
          `⚠️ ${staleProducts.length} records deleted on Lark, resetting: ${staleProducts.map((p) => p.code).join(', ')}`,
        );
        await this.prisma.product.updateMany({
          where: { id: { in: staleProducts.map((p) => p.id) } },
          data: { larkRecordId: null },
        });
        toCreate = [
          ...toCreate,
          ...staleProducts.map((p) => ({ ...p, larkRecordId: null })),
        ];
      }

      if (validProducts.length > 0) {
        try {
          const updateRecords = validProducts.map((p) => ({
            record_id: p.larkRecordId!,
            fields: this.mapProductToLarkFields(p),
          }));

          await this.larkBase.batchUpdateRecords(tableId, updateRecords);

          await this.prisma.product.updateMany({
            where: { id: { in: validProducts.map((p) => p.id) } },
            data: {
              larkSyncStatus: 'SYNCED',
              larkSyncedAt: new Date(),
              larkSyncRetries: 0,
            },
          });

          success += validProducts.length;
          this.logger.log(`✅ Batch updated ${validProducts.length} products`);
        } catch (error: any) {
          this.logger.error(
            `❌ Batch update failed after verify: ${error.message}`,
          );
          failed += validProducts.length;
        }
      }
    }

    // =============================================
    // SEARCH + CREATE — cho products chưa có larkRecordId
    // =============================================
    if (toCreate.length > 0) {
      this.logger.log(
        `📝 Processing ${toCreate.length} products (fetch all + match)...`,
      );

      const larkCodeMap = await this.larkBase.fetchAllRecords(tableId, [
        LARK_PRODUCT_FIELDS.MA_HANG_HOA,
      ]);
      this.logger.log(
        `📋 Fetched ${larkCodeMap.size} existing records from Lark`,
      );

      const toMatchUpdate: Array<{
        product: (typeof toCreate)[0];
        larkRecordId: string;
      }> = [];
      const reallyNew: typeof toCreate = [];

      for (const product of toCreate) {
        const existingRecordId = product.code
          ? larkCodeMap.get(product.code)
          : undefined;
        if (existingRecordId) {
          toMatchUpdate.push({ product, larkRecordId: existingRecordId });
        } else {
          reallyNew.push(product);
        }
      }

      this.logger.log(
        `🔍 Matched: ${toMatchUpdate.length} existing, ${reallyNew.length} new`,
      );

      if (toMatchUpdate.length > 0) {
        try {
          const updateRecords = toMatchUpdate.map((m) => ({
            record_id: m.larkRecordId,
            fields: this.mapProductToLarkFields(m.product),
          }));

          await this.larkBase.batchUpdateRecords(tableId, updateRecords);

          await this.prisma.$transaction(
            toMatchUpdate.map((m) =>
              this.prisma.product.update({
                where: { id: m.product.id },
                data: {
                  larkRecordId: m.larkRecordId,
                  larkSyncStatus: 'SYNCED',
                  larkSyncedAt: new Date(),
                  larkSyncRetries: 0,
                },
              }),
            ),
          );

          success += toMatchUpdate.length;
          this.logger.log(
            `✅ Batch updated ${toMatchUpdate.length} matched products`,
          );
        } catch (error: any) {
          this.logger.error(
            `❌ Batch update matched products failed: ${error.message}`,
          );
          failed += toMatchUpdate.length;
        }
      }

      if (reallyNew.length > 0) {
        this.logger.log(`🆕 Batch creating ${reallyNew.length} new products...`);
        try {
          const createRecords = reallyNew.map((p) => ({
            fields: this.mapProductToLarkFields(p),
          }));

          const newRecordIds = await this.larkBase.batchCreateRecords(
            tableId,
            createRecords,
          );

          if (newRecordIds.length !== reallyNew.length) {
            this.logger.warn(
              `⚠️ ID count mismatch: ${newRecordIds.length} IDs vs ${reallyNew.length} products`,
            );
          }

          const updateOps = reallyNew
            .map((product, i) => {
              if (!newRecordIds[i]) return null;
              return this.prisma.product.update({
                where: { id: product.id },
                data: {
                  larkRecordId: newRecordIds[i],
                  larkSyncStatus: 'SYNCED',
                  larkSyncedAt: new Date(),
                  larkSyncRetries: 0,
                },
              });
            })
            .filter((op): op is NonNullable<typeof op> => op !== null);

          if (updateOps.length > 0) {
            await this.prisma.$transaction(updateOps);
          }

          success += updateOps.length;
          failed += reallyNew.length - updateOps.length;
          this.logger.log(`✅ Batch created ${updateOps.length} products`);
        } catch (error: any) {
          this.logger.error(`❌ Batch create failed: ${error.message}`);
          failed += reallyNew.length;
        }
      }
    }

    this.logger.log(`🎯 Sync done: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  // =============================================
  // FULL SYNC — manual trigger (toàn bộ sản phẩm)
  // =============================================

  async fullSync(): Promise<{ success: number; failed: number }> {
    if (!this.isEnabled()) {
      this.logger.warn('Product sync disabled — bỏ qua');
      return { success: 0, failed: 0 };
    }

    const result = await this.prisma.product.updateMany({
      where: { code: { not: '' } },
      data: { larkSyncStatus: 'PENDING' },
    });

    this.logger.log(
      `📋 Marked ${result.count} products as PENDING for full sync`,
    );

    return this.syncPendingAndFailed();
  }

  // =============================================
  // FIELD MAPPING
  // =============================================

  private mapProductToLarkFields(product: any): Record<string, any> {
    const fields: Record<string, any> = {
      [LARK_PRODUCT_FIELDS.MA_HANG_HOA]: product.code || '',
      [LARK_PRODUCT_FIELDS.ID_HANG_HOA]: product.id ?? null,
      [LARK_PRODUCT_FIELDS.TEN_HANG_HOA]: product.name || '',
      [LARK_PRODUCT_FIELDS.TEN_DAY_DU]: product.fullName || '',
      [LARK_PRODUCT_FIELDS.THUONG_HIEU]: product.tradeMark?.name || '',
      [LARK_PRODUCT_FIELDS.DON_VI]: product.unit || '',
      [LARK_PRODUCT_FIELDS.CAN_NANG]:
        product.weight != null ? Number(product.weight) : null,
      [LARK_PRODUCT_FIELDS.MO_TA]: product.description || '',
      [LARK_PRODUCT_FIELDS.NGUON_GOC]: product.middleName || '',
      [LARK_PRODUCT_FIELDS.LOAI_HANG]: product.parentName || '',
      [LARK_PRODUCT_FIELDS.DANH_MUC]: product.childName || '',
      [LARK_PRODUCT_FIELDS.CHO_PHEP_BAN]: toYesNo(product.allowsSale),
      [LARK_PRODUCT_FIELDS.HANG_KINH_DOANH]: toYesNo(product.isActive),
      [LARK_PRODUCT_FIELDS.NGAY_TAO]: product.createdAt
        ? new Date(product.createdAt).getTime()
        : null,
      [LARK_PRODUCT_FIELDS.NGAY_CAP_NHAT]: product.updatedAt
        ? new Date(product.updatedAt).getTime()
        : null,
      [LARK_PRODUCT_FIELDS.BANG_GIA_CHUNG]: Number(product.basePrice) || 0,
    };

    // Tồn kho + giá vốn theo 3 kho
    for (const inv of product.inventories || []) {
      const cols = BRANCH_INVENTORY_COLUMNS[inv.branchId];
      if (!cols) continue;
      fields[cols.onHand] = Number(inv.onHand) || 0;
      fields[cols.cost] = Number(inv.cost) || 0;
    }

    // Bảng giá — map theo TÊN bảng giá (không theo id, vì id không ổn định)
    for (const detail of product.priceBookDetails || []) {
      const col = resolvePriceBookColumn(detail.priceBook?.name || '');
      if (!col) continue;
      fields[col] = Number(detail.price) || 0;
    }

    // ★ Whitelist: chỉ giữ field tồn tại trên Lark → tránh FieldNameNotFound.
    // Nếu chưa nạp được whitelist (null) thì gửi nguyên payload (fallback).
    if (this.validFieldNames) {
      const whitelist = this.validFieldNames;
      for (const key of Object.keys(fields)) {
        if (!whitelist.has(key)) {
          delete fields[key];
        }
      }
    }

    return fields;
  }
}
