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
    this.logger.log('⏰ Daily incremental sync started (23:30)...');

    try {
      const results = await this.syncService.runIncrementalSync();
      this.logger.log('✅ Daily sync completed');
      this.logger.log(JSON.stringify(results, null, 2));
    } catch (error) {
      this.logger.error(`❌ Daily sync failed: ${error.message}`);
    }
  }
}
