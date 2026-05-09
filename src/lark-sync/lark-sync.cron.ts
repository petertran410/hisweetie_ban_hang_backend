import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LarkOrderSyncService } from './services/lark-order-sync.service';

@Injectable()
export class LarkSyncCron {
  private readonly logger = new Logger(LarkSyncCron.name);

  constructor(private readonly orderSync: LarkOrderSyncService) {}

  /**
   * Mỗi 15 phút: retry FAILED + sync PENDING
   */
  @Cron(CronExpression.EVERY_MINUTE) // Đổi thành EVERY_15_MINUTES khi production
  async handleOrderSync() {
    this.logger.log('⏰ Cron: Order sync started');
    try {
      const result = await this.orderSync.syncPendingAndFailed();
      this.logger.log(
        `⏰ Cron: Order sync done — ${result.success} success, ${result.failed} failed`,
      );
    } catch (error) {
      this.logger.error(`⏰ Cron: Order sync error — ${error.message}`);
    }
  }
}
