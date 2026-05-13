import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SyncKiotService } from './sync-kiot.service';

@Injectable()
export class SyncKiotScheduler {
  private readonly logger = new Logger(SyncKiotScheduler.name);

  constructor(private readonly syncService: SyncKiotService) {}

  @Cron('30 23 * * *', {
    name: 'daily_kiot_sync',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailySync() {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn('⏭️ Sync disabled, skipping daily cron');
      return;
    }

    this.logger.log('⏰ Daily incremental sync started (23:30)...');

    try {
      const results = await this.syncService.runIncrementalSync();
      this.logger.log('✅ Daily sync completed');
      this.logger.log(JSON.stringify(results, null, 2));
    } catch (error) {
      this.logger.error(`❌ Daily sync failed: ${error.message}`);
    }
  }

  @Cron('0 */1 * * *', {
    name: 'hourly_recent_sync',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleRecentSync() {
    if (!(await this.syncService.isSyncEnabled())) {
      this.logger.warn('⏭️ Sync disabled, skipping recent sync');
      return;
    }

    this.logger.log('⏰ Hourly recent sync started (last 3 days)...');

    try {
      const results = await this.syncService.runRecentSync(3);
      this.logger.log('✅ Recent sync completed');
      this.logger.log(JSON.stringify(results, null, 2));
    } catch (error) {
      this.logger.error(`❌ Recent sync failed: ${error.message}`);
    }
  }
}
