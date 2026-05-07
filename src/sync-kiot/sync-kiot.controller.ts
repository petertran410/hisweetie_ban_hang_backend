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
    this.logger.log('📨 Manual full sync triggered');
    const results = await this.syncService.runFullSync();
    return { success: true, results, timestamp: new Date().toISOString() };
  }

  @Post('incremental')
  async triggerIncrementalSync() {
    this.logger.log('📨 Manual incremental sync triggered');
    const results = await this.syncService.runIncrementalSync();
    return { success: true, results, timestamp: new Date().toISOString() };
  }

  /**
   * Webhook receiver — sync_kiot_data gọi sau khi upsert
   */
  @Post('webhook')
  async handleWebhook(
    @Body() body: { entityType: string; code: string; action: string },
  ) {
    this.logger.log(
      `📨 Webhook: ${body.entityType} ${body.code} (${body.action})`,
    );

    const result = await this.syncService.syncSingleEntity(
      body.entityType,
      body.code,
    );

    return { success: true, result };
  }

  @Get('status')
  async getSyncStatus() {
    const { PrismaService } = await import('../prisma/prisma.service');
    // Dùng trực tiếp từ syncService
    return this.syncService['prisma'].syncControl.findMany({
      orderBy: { entityType: 'asc' },
    });
  }

  @Post('entity/:entityType')
  async syncEntity(@Param('entityType') entityType: string) {
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
