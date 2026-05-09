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

      if (order.larkRecordId) {
        await this.larkBase.updateRecord(
          this.tableId,
          order.larkRecordId,
          fields,
        );
      } else {
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

    // Lọc chỉ lấy code DH + số
    const validOrders = orders.filter((o) => isValidOrderCode(o.code));

    if (validOrders.length === 0) {
      this.logger.log('No orders need sync');
      return { success: 0, failed: 0 };
    }

    this.logger.log(`🔄 Syncing ${validOrders.length} orders...`);

    // Phân loại: có larkRecordId → update, chưa có → create
    const toUpdate = validOrders.filter((o) => o.larkRecordId);
    const toCreate = validOrders.filter((o) => !o.larkRecordId);

    let success = 0;
    let failed = 0;

    // Batch update
    if (toUpdate.length > 0) {
      try {
        const updateRecords = toUpdate.map((o) => ({
          record_id: o.larkRecordId!,
          fields: this.mapOrderToLarkFields(o),
        }));

        await this.larkBase.batchUpdateRecords(this.tableId, updateRecords);

        await this.prisma.order.updateMany({
          where: { id: { in: toUpdate.map((o) => o.id) } },
          data: { larkSyncStatus: 'SYNCED', larkSyncedAt: new Date() },
        });

        success += toUpdate.length;
        this.logger.log(`✅ Batch updated ${toUpdate.length} orders`);
      } catch (error) {
        this.logger.error(`❌ Batch update failed: ${error.message}`);
        failed += toUpdate.length;
      }
    }

    // Xử lý orders chưa có larkRecordId
    if (toCreate.length > 0) {
      const reallyNew: typeof toCreate = [];

      // Search từng order trên Lark trước khi tạo mới
      for (const order of toCreate) {
        try {
          const existingRecordId = await this.larkBase.searchRecord(
            this.tableId,
            LARK_ORDER_FIELDS.MA_DON_HANG,
            order.code,
          );

          if (existingRecordId) {
            // Đã có trên Lark → lưu recordId + update
            await this.larkBase.updateRecord(
              this.tableId,
              existingRecordId,
              this.mapOrderToLarkFields(order),
            );
            await this.prisma.order.update({
              where: { id: order.id },
              data: {
                larkRecordId: existingRecordId,
                larkSyncStatus: 'SYNCED',
                larkSyncedAt: new Date(),
                larkSyncRetries: 0,
              },
            });
            success++;
          } else {
            reallyNew.push(order);
          }
        } catch (error) {
          this.logger.error(
            `❌ Search order ${order.code} failed: ${error.message}`,
          );
          reallyNew.push(order);
        }
      }

      // Batch create chỉ những order thực sự chưa có
      if (reallyNew.length > 0) {
        try {
          const createRecords = reallyNew.map((o) => ({
            fields: this.mapOrderToLarkFields(o),
          }));

          const newRecordIds = await this.larkBase.batchCreateRecords(
            this.tableId,
            createRecords,
          );

          for (let i = 0; i < reallyNew.length; i++) {
            if (newRecordIds[i]) {
              await this.prisma.order.update({
                where: { id: reallyNew[i].id },
                data: {
                  larkRecordId: newRecordIds[i],
                  larkSyncStatus: 'SYNCED',
                  larkSyncedAt: new Date(),
                  larkSyncRetries: 0,
                },
              });
              success++;
            }
          }

          this.logger.log(`✅ Batch created ${reallyNew.length} orders`);
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
}
