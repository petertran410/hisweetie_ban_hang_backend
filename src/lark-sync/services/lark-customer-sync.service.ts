import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LarkCustomerBaseService } from './lark-customer-base.service';
import { setCustomerChangedHook } from '../../common/customer-debt.util';

// Field mapping: Lark field name → field ID (cho reference)
const LARK_CUSTOMER_FIELDS = {
  TEN_KHACH_HANG: 'Tên Khách Hàng',
  MA_KHACH_HANG: 'Mã Khách Hàng',
  NO_HIEN_TAI: 'Nợ Hiện Tại',
  TONG_BAN: 'Tổng Bán',
  TONG_DOANH_THU: 'Tổng Doanh Thu',
  DIA_CHI_KHACH_HANG: 'Địa Chỉ Khách Hàng',
  KHU_VUC: 'Khu Vực',
  PHUONG_XA: 'Phường xã',
  MA_SO_THUE: 'Mã Số Thuế',
  THOI_GIAN_TAO: 'Thời Gian Tạo',
  THOI_GIAN_CAP_NHAT: 'Thời Gian Cập Nhật',
  NHOM_KHACH_HANG: 'Nhóm Khách Hàng',
} as const;

// Include dùng chung — lấy địa chỉ mặc định để map Địa chỉ / Khu vực / Phường xã
const CUSTOMER_INCLUDE = {
  addresses: {
    where: { isDefault: true },
    take: 1,
    select: {
      address: true,
      cityName: true,
      newCityName: true,
      wardName: true,
      newWardName: true,
    },
  },
} as const;

@Injectable()
export class LarkCustomerSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LarkCustomerSyncService.name);
  private readonly tableId: string | null;
  private readonly MAX_RETRIES = 3;

  // ★ Debounce queue: gom customerId rồi flush sau DEBOUNCE_MS.
  // Lý do: recalcCustomerDebt gọi hook BÊN TRONG transaction chưa commit.
  // Nếu đọc DB + đẩy Lark ngay (connection khác) sẽ đọc trúng giá trị CŨ
  // (READ COMMITTED). Hoãn vài giây → tx đã commit → đọc đúng totalDebt mới,
  // đồng thời gộp nhiều lần recalc trong 1 thao tác thành 1 lần đẩy.
  private readonly DEBOUNCE_MS = 4000;
  private readonly pendingTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly larkBase: LarkCustomerBaseService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.tableId = this.config.get<string>('LARK_CUSTOMER_TABLE_ID') || null;
    if (!this.tableId) {
      this.logger.warn(
        'LARK_CUSTOMER_TABLE_ID chưa cấu hình — sync khách hàng sẽ bị skip',
      );
    }
  }

  /**
   * Đăng ký hook vào recalcCustomerDebt — bắt mọi biến động công nợ real-time.
   * Dùng debounce để đảm bảo transaction đã commit trước khi đọc DB đẩy Lark.
   */
  onModuleInit(): void {
    setCustomerChangedHook((customerId) => this.enqueueSync(customerId));
    this.logger.log('✅ Registered customer-debt change hook for Lark sync');
  }

  onModuleDestroy(): void {
    setCustomerChangedHook(null);
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Lên lịch sync 1 khách hàng (debounce). Mỗi customerId chỉ giữ 1 timer;
   * lần gọi sau reset lại đồng hồ → chỉ đẩy 1 lần sau khi yên ổn DEBOUNCE_MS.
   */
  enqueueSync(customerId: number): void {
    if (!this.isEnabled()) return;

    const existing = this.pendingTimers.get(customerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingTimers.delete(customerId);
      this.syncSingleAsync(customerId);
    }, this.DEBOUNCE_MS);

    // Không giữ event loop sống chỉ vì timer này
    if (typeof timer.unref === 'function') timer.unref();

    this.pendingTimers.set(customerId, timer);
  }

  private isEnabled(): boolean {
    return !!this.tableId && this.larkBase.isEnabled();
  }

  // =============================================
  // REAL-TIME SYNC (fire-and-forget với retry)
  // =============================================

  /**
   * Sync 1 khách hàng lên Lark.
   * Fire-and-forget: không throw ra ngoài, tự đánh dấu FAILED.
   * Chỉ sync khách hàng đang hoạt động (isActive = true).
   */
  async syncSingle(customerId: number): Promise<void> {
    if (!this.isEnabled()) return;
    const tableId = this.tableId!;

    try {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        include: CUSTOMER_INCLUDE,
      });

      if (!customer) {
        this.logger.warn(`Customer #${customerId} not found`);
        return;
      }

      // Chỉ đồng bộ khách hàng đang hoạt động. KH inactive: để nguyên record cũ.
      if (!customer.isActive) {
        this.logger.debug(`Skip inactive customer: ${customer.code}`);
        return;
      }

      if (!customer.code) {
        this.logger.debug(`Skip customer without code: #${customerId}`);
        return;
      }

      // ★ Đánh dấu SYNCING ngay — cron sẽ không pick up
      await this.prisma.customer.update({
        where: { id: customerId },
        data: { larkSyncStatus: 'SYNCING' },
      });

      const fields = this.mapCustomerToLarkFields(customer);
      let needSearchCreate = !customer.larkRecordId;

      if (customer.larkRecordId) {
        try {
          await this.larkBase.updateRecord(
            tableId,
            customer.larkRecordId,
            fields,
          );
        } catch (updateError) {
          if (this.larkBase.isRecordNotFound(updateError)) {
            this.logger.warn(
              `⚠️ Record ${customer.larkRecordId} deleted on Lark, re-creating customer ${customer.code}`,
            );
            await this.prisma.customer.update({
              where: { id: customerId },
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
          LARK_CUSTOMER_FIELDS.MA_KHACH_HANG,
          customer.code,
        );

        if (recordId) {
          await this.larkBase.updateRecord(tableId, recordId, fields);
        } else {
          recordId = await this.larkBase.createRecord(tableId, fields);
        }

        await this.prisma.customer.update({
          where: { id: customerId },
          data: { larkRecordId: recordId },
        });
      }

      // ★ Thành công → SYNCED + reset retries
      await this.prisma.customer.update({
        where: { id: customerId },
        data: {
          larkSyncStatus: 'SYNCED',
          larkSyncedAt: new Date(),
          larkSyncRetries: 0,
        },
      });
      this.logger.log(`✅ Synced customer ${customer.code} to Lark`);
    } catch (error: any) {
      this.logger.error(
        `❌ Sync customer #${customerId} failed: ${error.message}`,
      );

      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { larkSyncRetries: true },
      });

      const currentRetries = customer?.larkSyncRetries ?? 0;

      await this.prisma.customer.update({
        where: { id: customerId },
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
  syncSingleAsync(customerId: number): void {
    if (!this.isEnabled()) return;
    this.syncSingle(customerId).catch((err) => {
      this.logger.error(
        `Async sync customer #${customerId} error: ${err.message}`,
      );
    });
  }

  // =============================================
  // CRON JOB — retry FAILED + sync PENDING
  // =============================================

  async syncPendingAndFailed(): Promise<{ success: number; failed: number }> {
    if (!this.isEnabled()) {
      this.logger.warn('Customer sync disabled — bỏ qua');
      return { success: 0, failed: 0 };
    }
    const tableId = this.tableId!;

    const customers = await this.prisma.customer.findMany({
      where: {
        isActive: true,
        code: { not: null },
        larkSyncStatus: { not: 'SYNCING' },
      },
      include: CUSTOMER_INCLUDE,
    });

    if (customers.length === 0) {
      this.logger.log('No customers need sync');
      return { success: 0, failed: 0 };
    }

    this.logger.log(`🔄 Syncing ${customers.length} customers...`);

    const toUpdate = customers.filter((c) => c.larkRecordId);
    let toCreate = customers.filter((c) => !c.larkRecordId);

    let success = 0;
    let failed = 0;

    // =============================================
    // BATCH UPDATE — pre-verify + batch update
    // =============================================
    if (toUpdate.length > 0) {
      const allRecordIds = toUpdate.map((c) => c.larkRecordId!);
      const existingIds = await this.larkBase.verifyRecordIds(
        tableId,
        allRecordIds,
      );

      const validCustomers = toUpdate.filter((c) =>
        existingIds.has(c.larkRecordId!),
      );
      const staleCustomers = toUpdate.filter(
        (c) => !existingIds.has(c.larkRecordId!),
      );

      if (staleCustomers.length > 0) {
        this.logger.warn(
          `⚠️ ${staleCustomers.length} records deleted on Lark, resetting: ${staleCustomers.map((c) => c.code).join(', ')}`,
        );
        await this.prisma.customer.updateMany({
          where: { id: { in: staleCustomers.map((c) => c.id) } },
          data: { larkRecordId: null },
        });
        toCreate = [
          ...toCreate,
          ...staleCustomers.map((c) => ({ ...c, larkRecordId: null })),
        ];
      }

      if (validCustomers.length > 0) {
        try {
          const updateRecords = validCustomers.map((c) => ({
            record_id: c.larkRecordId!,
            fields: this.mapCustomerToLarkFields(c),
          }));

          await this.larkBase.batchUpdateRecords(tableId, updateRecords);

          await this.prisma.customer.updateMany({
            where: { id: { in: validCustomers.map((c) => c.id) } },
            data: {
              larkSyncStatus: 'SYNCED',
              larkSyncedAt: new Date(),
              larkSyncRetries: 0,
            },
          });

          success += validCustomers.length;
          this.logger.log(
            `✅ Batch updated ${validCustomers.length} customers`,
          );
        } catch (error: any) {
          this.logger.error(
            `❌ Batch update failed after verify: ${error.message}`,
          );
          failed += validCustomers.length;
        }
      }
    }

    // =============================================
    // SEARCH + CREATE — cho customers chưa có larkRecordId
    // =============================================
    if (toCreate.length > 0) {
      this.logger.log(
        `📝 Processing ${toCreate.length} customers (fetch all + match)...`,
      );

      const larkCodeMap = await this.larkBase.fetchAllRecords(tableId, [
        LARK_CUSTOMER_FIELDS.MA_KHACH_HANG,
      ]);
      this.logger.log(
        `📋 Fetched ${larkCodeMap.size} existing records from Lark`,
      );

      const toMatchUpdate: Array<{
        customer: (typeof toCreate)[0];
        larkRecordId: string;
      }> = [];
      const reallyNew: typeof toCreate = [];

      for (const customer of toCreate) {
        const existingRecordId = customer.code
          ? larkCodeMap.get(customer.code)
          : undefined;
        if (existingRecordId) {
          toMatchUpdate.push({ customer, larkRecordId: existingRecordId });
        } else {
          reallyNew.push(customer);
        }
      }

      this.logger.log(
        `🔍 Matched: ${toMatchUpdate.length} existing, ${reallyNew.length} new`,
      );

      if (toMatchUpdate.length > 0) {
        try {
          const updateRecords = toMatchUpdate.map((m) => ({
            record_id: m.larkRecordId,
            fields: this.mapCustomerToLarkFields(m.customer),
          }));

          await this.larkBase.batchUpdateRecords(tableId, updateRecords);

          await this.prisma.$transaction(
            toMatchUpdate.map((m) =>
              this.prisma.customer.update({
                where: { id: m.customer.id },
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
            `✅ Batch updated ${toMatchUpdate.length} matched customers`,
          );
        } catch (error: any) {
          this.logger.error(
            `❌ Batch update matched customers failed: ${error.message}`,
          );
          failed += toMatchUpdate.length;
        }
      }

      if (reallyNew.length > 0) {
        this.logger.log(
          `🆕 Batch creating ${reallyNew.length} new customers...`,
        );
        try {
          const createRecords = reallyNew.map((c) => ({
            fields: this.mapCustomerToLarkFields(c),
          }));

          const newRecordIds = await this.larkBase.batchCreateRecords(
            tableId,
            createRecords,
          );

          if (newRecordIds.length !== reallyNew.length) {
            this.logger.warn(
              `⚠️ ID count mismatch: ${newRecordIds.length} IDs vs ${reallyNew.length} customers`,
            );
          }

          const updateOps = reallyNew
            .map((customer, i) => {
              if (!newRecordIds[i]) return null;
              return this.prisma.customer.update({
                where: { id: customer.id },
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
          this.logger.log(`✅ Batch created ${updateOps.length} customers`);
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
  // FULL SYNC — manual trigger
  // =============================================

  async fullSync(): Promise<{ success: number; failed: number }> {
    if (!this.isEnabled()) {
      this.logger.warn('Customer sync disabled — bỏ qua');
      return { success: 0, failed: 0 };
    }

    // Reset tất cả khách hàng đang hoạt động về PENDING để xử lý
    const result = await this.prisma.customer.updateMany({
      where: { isActive: true, code: { not: null } },
      data: { larkSyncStatus: 'PENDING' },
    });

    this.logger.log(
      `📋 Marked ${result.count} customers as PENDING for full sync`,
    );

    return this.syncPendingAndFailed();
  }

  // =============================================
  // FIELD MAPPING
  // =============================================

  private mapCustomerToLarkFields(customer: any): Record<string, any> {
    const addr = customer.addresses?.[0];

    return {
      [LARK_CUSTOMER_FIELDS.TEN_KHACH_HANG]: customer.name || '',
      [LARK_CUSTOMER_FIELDS.MA_KHACH_HANG]: customer.code || '',
      [LARK_CUSTOMER_FIELDS.NO_HIEN_TAI]: Number(customer.totalDebt) || 0,
      [LARK_CUSTOMER_FIELDS.TONG_BAN]: Number(customer.totalInvoiced) || 0,
      [LARK_CUSTOMER_FIELDS.TONG_DOANH_THU]: Number(customer.totalRevenue) || 0,
      [LARK_CUSTOMER_FIELDS.DIA_CHI_KHACH_HANG]: addr?.address || '',
      [LARK_CUSTOMER_FIELDS.KHU_VUC]: addr?.newCityName || addr?.cityName || '',
      [LARK_CUSTOMER_FIELDS.PHUONG_XA]:
        addr?.newWardName || addr?.wardName || '',
      [LARK_CUSTOMER_FIELDS.MA_SO_THUE]: customer.taxCode || '',
      [LARK_CUSTOMER_FIELDS.THOI_GIAN_TAO]: customer.createdAt
        ? new Date(customer.createdAt).getTime()
        : null,
      [LARK_CUSTOMER_FIELDS.THOI_GIAN_CAP_NHAT]: customer.updatedAt
        ? new Date(customer.updatedAt).getTime()
        : null,
      [LARK_CUSTOMER_FIELDS.NHOM_KHACH_HANG]: customer.groups || '',
    };
  }
}
