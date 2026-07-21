import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { LarkProductSyncService } from './services/lark-product-sync.service';

const CRON_NAME = 'larkProductRetry';
const CRON_EXPR = '*/5 * * * *';

@Injectable()
export class LarkSyncCron implements OnModuleInit {
  private readonly logger = new Logger(LarkSyncCron.name);
  private isProductRunning = false;

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly productSync: LarkProductSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = await this.isEnabled();
    if (enabled) {
      this.startCron();
    } else {
      this.logger.log(
        `⏸️ Cron "${CRON_NAME}" disabled by Settings (sẽ không chạy)`,
      );
    }
  }

  private async isEnabled(): Promise<boolean> {
    const settings = await this.prisma.settings.findFirst({
      select: { larkProductRetryCronEnabled: true },
    });
    return settings?.larkProductRetryCronEnabled ?? true;
  }

  /**
   * Bật/tắt dynamic cron.
   * - Bật: nếu job đã tồn tại thì start lại, nếu chưa thì add.
   * - Tắt: nếu job đang tồn tại thì stop + delete khỏi registry.
   */
  setEnabled(enabled: boolean): { enabled: boolean } {
    if (enabled) {
      this.startCron();
    } else {
      this.stopCron();
    }
    this.logger.log(
      `🔄 Lark product retry cron ${enabled ? 'ENABLED' : 'DISABLED'}`,
    );
    return { enabled };
  }

  async getStatus(): Promise<{ enabled: boolean }> {
    const enabled = await this.isEnabled();
    return { enabled };
  }

  private startCron(): void {
    if (this.schedulerRegistry.doesExist('cron', CRON_NAME)) {
      const job = this.schedulerRegistry.getCronJob(CRON_NAME);
      if (!job.isActive) job.start();
      return;
    }
    const job = new CronJob(CRON_EXPR, () => {
      void this.handleProductRetrySync();
    });
    this.schedulerRegistry.addCronJob(CRON_NAME, job);
    job.start();
    this.logger.log(
      `⏰ Cron "${CRON_NAME}" (${CRON_EXPR}) started — product retry sync mỗi 5 phút`,
    );
  }

  private stopCron(): void {
    if (!this.schedulerRegistry.doesExist('cron', CRON_NAME)) return;
    const job = this.schedulerRegistry.getCronJob(CRON_NAME);
    job.stop();
    this.schedulerRegistry.deleteCronJob(CRON_NAME);
    this.logger.log(`⏹️ Cron "${CRON_NAME}" stopped & removed`);
  }

  async handleProductRetrySync() {
    if (this.isProductRunning) {
      this.logger.warn(
        '⏭️ Product retry sync: previous run still running, skip',
      );
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
