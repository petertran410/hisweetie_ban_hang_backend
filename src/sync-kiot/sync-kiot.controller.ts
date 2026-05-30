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
