import { Controller, Post, Body, Get, Logger, Param } from '@nestjs/common';
import { SyncKiotService } from './sync-kiot.service';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Sync KiotViet')
@Public()
@Controller('sync-kiot')
export class SyncKiotController {
  private readonly logger = new Logger(SyncKiotController.name);

  constructor(private readonly syncService: SyncKiotService) {}

  @Post('full')
  async triggerFullSync() {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn('⏭️ Sync disabled, skipping full sync');
      return { success: false, reason: 'Sync is disabled' };
    }
    this.logger.log('📨 Manual full sync triggered');
    const results = await this.syncService.runFullSync();
    return { success: true, results, timestamp: new Date().toISOString() };
  }

  @Post('incremental')
  async triggerIncrementalSync() {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn('⏭️ Sync disabled, skipping incremental sync');
      return { success: false, reason: 'Sync is disabled' };
    }
    this.logger.log('📨 Manual incremental sync triggered');
    const results = await this.syncService.runIncrementalSync();
    return { success: true, results, timestamp: new Date().toISOString() };
  }

  @Post('recent')
  async triggerRecentSync(@Body() body?: { daysBack?: number }) {
    if (!(await this.syncService.isSyncEnabled())) {
      return { success: false, reason: 'Sync is disabled' };
    }
    const daysBack = body?.daysBack ?? 3;
    this.logger.log(`📨 Manual recent sync triggered (last ${daysBack} days)`);
    const results = await this.syncService.runRecentSync(daysBack);
    return { success: true, results, timestamp: new Date().toISOString() };
  }

  @Post('invoice/:code')
  async syncOneInvoice(@Param('code') code: string) {
    this.logger.log(`📨 Manual sync invoice: ${code}`);
    const result = await this.syncService.syncSingleEntity('invoice', code);
    return { success: true, result, timestamp: new Date().toISOString() };
  }

  @Post('order/:code')
  async syncOneOrder(@Param('code') code: string) {
    this.logger.log(`📨 Manual sync order: ${code}`);
    const result = await this.syncService.syncSingleEntity('order', code);
    return { success: true, result, timestamp: new Date().toISOString() };
  }

  /**
   * Sync Order theo cận trên purchaseDate (batch migration lịch sử).
   * Body: { toDate?: string } — ISO datetime, optional.
   *   Default: 2026-04-01T16:59:59.999Z (hết ngày 01/04/2026 giờ Asia/Ho_Chi_Minh).
   * Không update SyncControl.
   */
  @Post('orders/before-date')
  async syncOrdersBeforeDate(@Body() body?: { toDate?: string }) {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn('⏭️ Sync disabled, skipping orders/before-date sync');
      return { success: false, reason: 'Sync is disabled' };
    }

    // Default: hết ngày 01/04/2026 giờ VN (UTC+7)
    // = 2026-04-01 23:59:59.999+07:00 = 2026-04-01T16:59:59.999Z
    const DEFAULT_TO_DATE = '2026-04-01T16:59:59.999Z';
    const toDate = new Date(body?.toDate ?? DEFAULT_TO_DATE);

    if (isNaN(toDate.getTime())) {
      return {
        success: false,
        reason: `Invalid toDate: ${body?.toDate}`,
      };
    }

    this.logger.log(
      `📨 Manual sync orders where purchaseDate <= ${toDate.toISOString()}`,
    );
    const results = await this.syncService.runOrdersBeforeDate(toDate);
    return {
      success: true,
      toDate: toDate.toISOString(),
      results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sync CashFlow theo khoảng transDate (batch migration sổ quỹ theo ngày).
   * Body: { fromDate?: string; toDate?: string } — ISO datetime, optional.
   *   Default fromDate: 2026-05-24T17:00:00.000Z (= 25/05/2026 00:00 giờ Asia/Ho_Chi_Minh).
   *   Default toDate:   hết ngày hiện tại theo giờ Asia/Ho_Chi_Minh.
   * Không update SyncControl.
   */
  @Post('cashflows/by-date-range')
  async syncCashflowsByDateRange(
    @Body() body?: { fromDate?: string; toDate?: string },
  ) {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn(
        '⏭️ Sync disabled, skipping cashflows/by-date-range sync',
      );
      return { success: false, reason: 'Sync is disabled' };
    }

    // Default fromDate: 25/05/2026 00:00:00 giờ VN (UTC+7)
    // = 2026-05-25 00:00:00+07:00 = 2026-05-24T17:00:00.000Z
    const DEFAULT_FROM_DATE = '2026-05-24T17:00:00.000Z';

    // Default toDate: hết ngày hôm nay theo giờ VN (UTC+7)
    // = today 23:59:59.999+07:00 = today 16:59:59.999Z
    const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const yyyy = nowVN.getUTCFullYear();
    const mm = String(nowVN.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(nowVN.getUTCDate()).padStart(2, '0');
    const DEFAULT_TO_DATE = `${yyyy}-${mm}-${dd}T16:59:59.999Z`;

    const fromDate = new Date(body?.fromDate ?? DEFAULT_FROM_DATE);
    const toDate = new Date(body?.toDate ?? DEFAULT_TO_DATE);

    if (isNaN(fromDate.getTime())) {
      return {
        success: false,
        reason: `Invalid fromDate: ${body?.fromDate}`,
      };
    }
    if (isNaN(toDate.getTime())) {
      return {
        success: false,
        reason: `Invalid toDate: ${body?.toDate}`,
      };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      return {
        success: false,
        reason: `fromDate (${fromDate.toISOString()}) must be <= toDate (${toDate.toISOString()})`,
      };
    }

    this.logger.log(
      `📨 Manual sync cashflows where transDate in [${fromDate.toISOString()}, ${toDate.toISOString()}]`,
    );
    const results = await this.syncService.runCashflowsByDateRange(
      fromDate,
      toDate,
    );
    return {
      success: true,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sync Customer theo khoảng createdDate (batch migration khách hàng theo ngày).
   * Body: { fromDate?: string; toDate?: string } — ISO datetime, optional.
   *   Default fromDate: 2026-05-24T17:00:00.000Z (= 25/05/2026 00:00 giờ Asia/Ho_Chi_Minh).
   *   Default toDate:   hết ngày hiện tại theo giờ Asia/Ho_Chi_Minh.
   * Không update SyncControl.
   */
  @Post('customers/by-date-range')
  async syncCustomersByDateRange(
    @Body() body?: { fromDate?: string; toDate?: string },
  ) {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn(
        '⏭️ Sync disabled, skipping customers/by-date-range sync',
      );
      return { success: false, reason: 'Sync is disabled' };
    }

    // Default fromDate: 25/05/2026 00:00:00 giờ VN (UTC+7)
    // = 2026-05-25 00:00:00+07:00 = 2026-05-24T17:00:00.000Z
    const DEFAULT_FROM_DATE = '2026-05-24T17:00:00.000Z';

    // Default toDate: hết ngày hôm nay theo giờ VN (UTC+7)
    // = today 23:59:59.999+07:00 = today 16:59:59.999Z
    const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const yyyy = nowVN.getUTCFullYear();
    const mm = String(nowVN.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(nowVN.getUTCDate()).padStart(2, '0');
    const DEFAULT_TO_DATE = `${yyyy}-${mm}-${dd}T16:59:59.999Z`;

    const fromDate = new Date(body?.fromDate ?? DEFAULT_FROM_DATE);
    const toDate = new Date(body?.toDate ?? DEFAULT_TO_DATE);

    if (isNaN(fromDate.getTime())) {
      return {
        success: false,
        reason: `Invalid fromDate: ${body?.fromDate}`,
      };
    }
    if (isNaN(toDate.getTime())) {
      return {
        success: false,
        reason: `Invalid toDate: ${body?.toDate}`,
      };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      return {
        success: false,
        reason: `fromDate (${fromDate.toISOString()}) must be <= toDate (${toDate.toISOString()})`,
      };
    }

    this.logger.log(
      `📨 Manual sync customers where createdDate in [${fromDate.toISOString()}, ${toDate.toISOString()}]`,
    );
    const results = await this.syncService.runCustomersByDateRange(
      fromDate,
      toDate,
    );
    return {
      success: true,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      results,
      timestamp: new Date().toISOString(),
    };
  }

  @Post('webhook')
  async handleWebhook(
    @Body() body: { entityType: string; code: string; action: string },
  ) {
    // Tạm disable webhook để tránh sync KiotViet tạo duplicate OrderItem
    // (lineNumber=null từ user save không match với upsert lineNumber=1..N của sync).
    // Bật lại sau khi fix Bug C hoàn tất.
    this.logger.warn(
      `⏭️ Webhook disabled (Bug C mitigation): ${body.entityType} ${body.code} (${body.action})`,
    );
    return { success: false, reason: 'Webhook is temporarily disabled' };

    // if (!(await this.syncService.isSyncEnabled())) {
    //   this.logger.warn(
    //     `⏭️ Sync disabled, skipping webhook: ${body.entityType} ${body.code}`,
    //   );
    //   return { success: false, reason: 'Sync is disabled' };
    // }
    // this.logger.log(
    //   `📨 Webhook: ${body.entityType} ${body.code} (${body.action})`,
    // );
    // const result = await this.syncService.syncSingleEntity(
    //   body.entityType,
    //   body.code,
    // );
    // return { success: true, result };
  }

  @Get('status')
  async getSyncStatus() {
    return this.syncService['prisma'].syncControl.findMany({
      orderBy: { entityType: 'asc' },
    });
  }

  @Post('entity/:entityType')
  async syncEntity(@Param('entityType') entityType: string) {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn(`⏭️ Sync disabled, skipping entity: ${entityType}`);
      return { success: false, reason: 'Sync is disabled' };
    }
    this.logger.log(`📨 Manual sync triggered for: ${entityType}`);
    const result = await this.syncService.syncEntity(entityType);
    return {
      success: true,
      entityType,
      result,
      timestamp: new Date().toISOString(),
    };
  }
}
