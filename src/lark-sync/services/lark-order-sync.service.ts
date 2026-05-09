import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LarkBaseService } from './lark-base.service';
import { isValidOrderCode } from '../helpers/code-filter.helper';

// Field mapping: Lark field name → field ID (cho reference)
const LARK_ORDER_FIELDS = {
  MA_DON_HANG: 'Mã Đơn Hàng',
  CHI_NHANH: 'Chi Nhánh',
  NGUOI_BAN: 'Người Bán',
  KHACH_CAN_TRA: 'Khách Cần Trả',
  TONG_DON_HANG: 'Tổng Đơn Hàng',
  NGAY_MUA_HANG: 'Ngày Mua Hàng',
  GIAM_GIA: 'Giảm Giá',
  PHAN_TRAM_GIAM_GIA: 'Phần Trăm Giảm Giá',
  KHACH_DA_TRA: 'Khách Đã Trả',
  NO_CON_LAI: 'Nợ Còn Lại',
  TRANG_THAI: 'Trạng Thái',
  NGUOI_TAO: 'Người Tạo',
  NGAY_TAO: 'Ngày Tạo',
  NGAY_CAP_NHAT: 'Ngày Cập Nhật',
  BANG_GIA: 'Bảng Giá',
  MA_HOA_DON: 'Mã Hóa Đơn',
  TEN_KHACH_HANG: 'Tên Khách Hàng',
  GHI_CHU: 'Ghi Chú',
} as const;

@Injectable()
export class LarkOrderSyncService {
  private readonly logger = new Logger(LarkOrderSyncService.name);
  private readonly tableId: string;
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly larkBase: LarkBaseService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const tableId = this.config.get<string>('LARK_ORDER_TABLE_ID');
    if (!tableId) {
      throw new Error('LARK_ORDER_TABLE_ID must be configured');
    }
    this.tableId = tableId;
  }

  // =============================================
  // REAL-TIME SYNC (fire-and-forget với retry)
  // =============================================

  /**
   * Sync 1 order lên Lark — gọi từ OrdersService hoặc SyncKiotService
   * Fire-and-forget: không throw ra ngoài, tự đánh dấu FAILED
   */
  async syncSingle(orderId: number): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          invoices: {
            where: { status: { not: 2 } },
            select: { code: true },
          },
        },
      });

      if (!order) {
        this.logger.warn(`Order #${orderId} not found`);
        return;
      }

      if (!isValidOrderCode(order.code)) {
        this.logger.debug(`Skip non-standard order: ${order.code}`);
        return;
      }

      // ★ Đánh dấu SYNCING ngay lập tức — cron sẽ không pick up
      await this.prisma.order.update({
        where: { id: orderId },
        data: { larkSyncStatus: 'SYNCING' },
      });

      const fields = this.mapOrderToLarkFields(order);
      let needSearchCreate = !order.larkRecordId;

      if (order.larkRecordId) {
        try {
          await this.larkBase.updateRecord(
            this.tableId,
            order.larkRecordId,
            fields,
          );
        } catch (updateError) {
          if (this.isRecordNotFound(updateError)) {
            this.logger.warn(
              `⚠️ Record ${order.larkRecordId} deleted on Lark, re-creating order ${order.code}`,
            );
            await this.prisma.order.update({
              where: { id: orderId },
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
          this.tableId,
          LARK_ORDER_FIELDS.MA_DON_HANG,
          order.code,
        );

        if (recordId) {
          await this.larkBase.updateRecord(this.tableId, recordId, fields);
        } else {
          recordId = await this.larkBase.createRecord(this.tableId, fields);
        }

        await this.prisma.order.update({
          where: { id: orderId },
          data: { larkRecordId: recordId },
        });
      }

      // ★ Thành công → SYNCED + reset retries
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          larkSyncStatus: 'SYNCED',
          larkSyncedAt: new Date(),
          larkSyncRetries: 0,
        },
      });
      this.logger.log(`✅ Synced order ${order.code} to Lark`);
    } catch (error) {
      this.logger.error(`❌ Sync order #${orderId} failed: ${error.message}`);

      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { larkSyncRetries: true },
      });

      const currentRetries = order?.larkSyncRetries ?? 0;

      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          larkSyncStatus:
            currentRetries + 1 >= this.MAX_RETRIES ? 'FAILED' : 'PENDING',
          larkSyncRetries: { increment: 1 },
        },
      });
    }
  }

  /**
   * Fire-and-forget wrapper — gọi từ service khác, không block
   */
  syncSingleAsync(orderId: number): void {
    this.syncSingle(orderId).catch((err) => {
      this.logger.error(`Async sync order #${orderId} error: ${err.message}`);
    });
  }

  // =============================================
  // CRON JOB — retry FAILED + sync PENDING (3 tháng)
  // =============================================

  async syncPendingAndFailed(): Promise<{
    success: number;
    failed: number;
  }> {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const orders = await this.prisma.order.findMany({
      where: {
        orderDate: { gte: threeMonthsAgo },
        code: { startsWith: 'DH' },
        larkSyncStatus: { not: 'SYNCING' },
      },
      include: {
        customer: { select: { name: true } },
        branch: { select: { name: true } },
        soldBy: { select: { name: true } },
        creator: { select: { name: true } },
        invoices: {
          where: { status: { not: 2 } },
          select: { code: true },
        },
      },
      orderBy: { orderDate: 'desc' },
    });

    const validOrders = orders.filter((o) => isValidOrderCode(o.code));

    if (validOrders.length === 0) {
      this.logger.log('No orders need sync');
      return { success: 0, failed: 0 };
    }

    this.logger.log(`🔄 Syncing ${validOrders.length} orders...`);

    const toUpdate = validOrders.filter((o) => o.larkRecordId);
    let toCreate = validOrders.filter((o) => !o.larkRecordId);

    let success = 0;
    let failed = 0;

    // =============================================
    // BATCH UPDATE — pre-verify + batch update
    // =============================================
    if (toUpdate.length > 0) {
      // Bước 1: Verify record IDs nào còn tồn tại trên Lark
      const allRecordIds = toUpdate.map((o) => o.larkRecordId!);
      const existingIds = await this.larkBase.verifyRecordIds(
        this.tableId,
        allRecordIds,
      );

      const validOrders = toUpdate.filter((o) =>
        existingIds.has(o.larkRecordId!),
      );
      const staleOrders = toUpdate.filter(
        (o) => !existingIds.has(o.larkRecordId!),
      );

      // Bước 2: Batch reset stale records (1 lệnh DB duy nhất)
      if (staleOrders.length > 0) {
        this.logger.warn(
          `⚠️ ${staleOrders.length} records deleted on Lark, resetting: ${staleOrders.map((o) => o.code).join(', ')}`,
        );
        await this.prisma.order.updateMany({
          where: { id: { in: staleOrders.map((o) => o.id) } },
          data: { larkRecordId: null },
        });
        // Đẩy sang toCreate để search + create
        toCreate = [
          ...toCreate,
          ...staleOrders.map((o) => ({ ...o, larkRecordId: null })),
        ];
      }

      // Bước 3: Batch update chỉ valid records
      if (validOrders.length > 0) {
        try {
          const updateRecords = validOrders.map((o) => ({
            record_id: o.larkRecordId!,
            fields: this.mapOrderToLarkFields(o),
          }));

          await this.larkBase.batchUpdateRecords(this.tableId, updateRecords);

          await this.prisma.order.updateMany({
            where: { id: { in: validOrders.map((o) => o.id) } },
            data: {
              larkSyncStatus: 'SYNCED',
              larkSyncedAt: new Date(),
              larkSyncRetries: 0,
            },
          });

          success += validOrders.length;
          this.logger.log(`✅ Batch updated ${validOrders.length} orders`);
        } catch (error) {
          this.logger.error(
            `❌ Batch update failed after verify: ${error.message}`,
          );
          failed += validOrders.length;
        }
      }
    }

    // =============================================
    // SEARCH + CREATE — cho orders chưa có larkRecordId
    // =============================================
    if (toCreate.length > 0) {
      this.logger.log(
        `📝 Processing ${toCreate.length} orders (fetch all + match)...`,
      );

      // Bước 1: Fetch TẤT CẢ records từ Lark 1 lần (paginate 500/page)
      const larkCodeMap = await this.larkBase.fetchAllRecords(this.tableId, [
        LARK_ORDER_FIELDS.MA_DON_HANG,
      ]);
      this.logger.log(
        `📋 Fetched ${larkCodeMap.size} existing records from Lark`,
      );

      // Bước 2: Tách thành 2 nhóm bằng so sánh local (O(n), không gọi API)
      const toMatchUpdate: Array<{
        order: (typeof toCreate)[0];
        larkRecordId: string;
      }> = [];
      const reallyNew: typeof toCreate = [];

      for (const order of toCreate) {
        const existingRecordId = larkCodeMap.get(order.code);
        if (existingRecordId) {
          toMatchUpdate.push({ order, larkRecordId: existingRecordId });
        } else {
          reallyNew.push(order);
        }
      }

      this.logger.log(
        `🔍 Matched: ${toMatchUpdate.length} existing, ${reallyNew.length} new`,
      );

      // Bước 3: Batch update orders đã tồn tại trên Lark
      if (toMatchUpdate.length > 0) {
        try {
          const updateRecords = toMatchUpdate.map((m) => ({
            record_id: m.larkRecordId,
            fields: this.mapOrderToLarkFields(m.order),
          }));

          await this.larkBase.batchUpdateRecords(this.tableId, updateRecords);

          // Batch lưu larkRecordId vào DB — dùng transaction cho nhanh
          await this.prisma.$transaction(
            toMatchUpdate.map((m) =>
              this.prisma.order.update({
                where: { id: m.order.id },
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
            `✅ Batch updated ${toMatchUpdate.length} matched orders`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Batch update matched orders failed: ${error.message}`,
          );
          failed += toMatchUpdate.length;
        }
      }

      // Bước 4: Batch create orders thực sự mới
      if (reallyNew.length > 0) {
        this.logger.log(`🆕 Batch creating ${reallyNew.length} new orders...`);
        try {
          const createRecords = reallyNew.map((o) => ({
            fields: this.mapOrderToLarkFields(o),
          }));

          const newRecordIds = await this.larkBase.batchCreateRecords(
            this.tableId,
            createRecords,
          );

          this.logger.log(
            `📋 batchCreate returned ${newRecordIds.length} IDs for ${reallyNew.length} orders`,
          );

          if (newRecordIds.length !== reallyNew.length) {
            this.logger.warn(
              `⚠️ ID count mismatch: ${newRecordIds.length} IDs vs ${reallyNew.length} orders`,
            );
          }

          const updateOps = reallyNew
            .map((order, i) => {
              if (!newRecordIds[i]) return null;
              return this.prisma.order.update({
                where: { id: order.id },
                data: {
                  larkRecordId: newRecordIds[i],
                  larkSyncStatus: 'SYNCED',
                  larkSyncedAt: new Date(),
                  larkSyncRetries: 0,
                },
              });
            })
            .filter((op): op is NonNullable<typeof op> => op !== null);

          this.logger.log(
            `💾 Saving ${updateOps.length} larkRecordIds to DB...`,
          );

          if (updateOps.length > 0) {
            await this.prisma.$transaction(updateOps);
          }

          success += updateOps.length;
          failed += reallyNew.length - updateOps.length;
          this.logger.log(`✅ Batch created ${updateOps.length} orders`);
        } catch (error) {
          this.logger.error(`❌ Batch create failed: ${error.message}`);
          failed += reallyNew.length;
        }
      }
    }

    this.logger.log(`🎯 Sync done: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  // =============================================
  // FULL SYNC — manual trigger (3 tháng)
  // =============================================

  async fullSync(): Promise<{ success: number; failed: number }> {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Reset tất cả orders 3 tháng về PENDING để cron xử lý
    const result = await this.prisma.order.updateMany({
      where: {
        orderDate: { gte: threeMonthsAgo },
        code: { startsWith: 'DH' },
      },
      data: { larkSyncStatus: 'PENDING' },
    });

    this.logger.log(
      `📋 Marked ${result.count} orders as PENDING for full sync`,
    );

    // Chạy sync ngay
    return this.syncPendingAndFailed();
  }

  // =============================================
  // FIELD MAPPING
  // =============================================

  private mapOrderToLarkFields(order: any): Record<string, any> {
    const invoiceCodes =
      order.invoices?.map((inv: any) => inv.code).join(', ') || '';

    return {
      [LARK_ORDER_FIELDS.MA_DON_HANG]: order.code || '',
      [LARK_ORDER_FIELDS.CHI_NHANH]: order.branch?.name || '',
      [LARK_ORDER_FIELDS.NGUOI_BAN]: order.soldBy?.name || '',
      [LARK_ORDER_FIELDS.KHACH_CAN_TRA]: Number(order.grandTotal) || 0,
      [LARK_ORDER_FIELDS.TONG_DON_HANG]: Number(order.totalAmount) || 0,
      [LARK_ORDER_FIELDS.NGAY_MUA_HANG]: order.orderDate
        ? new Date(order.orderDate).getTime()
        : null,
      [LARK_ORDER_FIELDS.GIAM_GIA]: Number(order.discount) || 0,
      [LARK_ORDER_FIELDS.PHAN_TRAM_GIAM_GIA]: Number(order.discountRatio) || 0,
      [LARK_ORDER_FIELDS.KHACH_DA_TRA]: Number(order.paidAmount) || 0,
      [LARK_ORDER_FIELDS.NO_CON_LAI]: Number(order.debtAmount) || 0,
      [LARK_ORDER_FIELDS.TRANG_THAI]: order.statusValue || '',
      [LARK_ORDER_FIELDS.NGUOI_TAO]: order.creator?.name || '',
      [LARK_ORDER_FIELDS.NGAY_TAO]: order.createdAt
        ? new Date(order.createdAt).getTime()
        : null,
      [LARK_ORDER_FIELDS.NGAY_CAP_NHAT]: order.updatedAt
        ? new Date(order.updatedAt).getTime()
        : null,
      [LARK_ORDER_FIELDS.BANG_GIA]: order.priceBookName || '',
      [LARK_ORDER_FIELDS.MA_HOA_DON]: invoiceCodes,
      [LARK_ORDER_FIELDS.TEN_KHACH_HANG]: order.customer?.name || '',
      [LARK_ORDER_FIELDS.GHI_CHU]: order.description || '',
    };
  }

  private isRecordNotFound(error: any): boolean {
    // Lark SDK: error.code hoặc error.response.data.code
    const code = error?.code ?? error?.response?.data?.code ?? error?.errCode;
    return code === 1254043;
  }
}
