import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { MisaDictionaryService } from './misa-dictionary.service';

const CRON_NAME = 'misaDictionaryCron';
const CRON_EXPR = '0 */6 * * *';

@Injectable()
export class MisaSyncCron implements OnModuleInit {
  private readonly logger = new Logger(MisaSyncCron.name);
  private isRunning = false;

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly dictionaryService: MisaDictionaryService,
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
      select: { misaDictionaryCronEnabled: true },
    });
    return settings?.misaDictionaryCronEnabled ?? false;
  }

  /**
   * Bật/tắt dynamic cron Misa dictionary sync.
   */
  setEnabled(enabled: boolean): { enabled: boolean } {
    if (enabled) {
      this.startCron();
    } else {
      this.stopCron();
    }
    this.logger.log(
      `🔄 Misa dictionary cron ${enabled ? 'ENABLED' : 'DISABLED'}`,
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
      void this.handleDictionarySync();
    });
    this.schedulerRegistry.addCronJob(CRON_NAME, job);
    job.start();
    this.logger.log(
      `⏰ Cron "${CRON_NAME}" (${CRON_EXPR}) started — Misa dictionary sync mỗi 6 giờ`,
    );
  }

  private stopCron(): void {
    if (!this.schedulerRegistry.doesExist('cron', CRON_NAME)) return;
    const job = this.schedulerRegistry.getCronJob(CRON_NAME);
    job.stop();
    this.schedulerRegistry.deleteCronJob(CRON_NAME);
    this.logger.log(`⏹️ Cron "${CRON_NAME}" stopped & removed`);
  }

  async handleDictionarySync() {
    if (this.isRunning) {
      this.logger.warn(
        '⏭️ Misa dictionary sync: previous run still running, skip',
      );
      return;
    }

    this.isRunning = true;
    this.logger.log('⏰ Misa dictionary sync started');

    try {
      const result = await this.dictionaryService.syncAllDictionaries();
      this.logger.log(
        `⏰ Misa dictionary sync done — ${JSON.stringify(result)}`,
      );
    } catch (error: any) {
      this.logger.error(`⏰ Misa dictionary sync error — ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
