import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LarkProductSyncService } from './services/lark-product-sync.service';

@Injectable()
export class LarkSyncCron {
  private readonly logger = new Logger(LarkSyncCron.name);
  private isProductRunning = false;

  constructor(private readonly productSync: LarkProductSyncService) {}

  @Cron('*/5 * * * *')
  async handleProductRetrySync() {
    if (this.isProductRunning) {
      this.logger.warn('⏭️ Product retry sync: previous run still running, skip');
      return;
    }

    this.isProductRunning = true;
    this.logger.log('⏰ Product retry sync started');

    try {
      const result = await this.productSync.syncPendingAndFailed();
      this.logger.log(
        `⏰ Product retry sync done — ${result.success} success, ${result.failed} failed`,
      );
    } catch (error: any) {
      this.logger.error(`⏰ Product retry sync error — ${error.message}`);
    } finally {
      this.isProductRunning = false;
    }
  }
}
