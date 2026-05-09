import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LarkOrderSyncService } from './services/lark-order-sync.service';

@Injectable()
export class LarkSyncCron {
  private readonly logger = new Logger(LarkSyncCron.name);
  private isRunning = false;

  constructor(private readonly orderSync: LarkOrderSyncService) {}

  // @Cron('*/15 * * * *')
  // async handleOrderSync() {
  //   if (this.isRunning) {
  //     this.logger.warn('⏭️ Cron: Previous sync still running, skipping');
  //     return;
  //   }

  //   this.isRunning = true;
  //   this.logger.log('⏰ Cron: Order sync started');

  //   try {
  //     const result = await this.orderSync.syncPendingAndFailed();
  //     this.logger.log(
  //       `⏰ Cron: Order sync done — ${result.success} success, ${result.failed} failed`,
  //     );
  //   } catch (error) {
  //     this.logger.error(`⏰ Cron: Order sync error — ${error.message}`);
  //   } finally {
  //     this.isRunning = false;
  //   }
  // }
}
