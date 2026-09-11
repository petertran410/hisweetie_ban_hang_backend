import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TiktokEventsOutboxService } from './tiktok-events-outbox.service';
import { TiktokEventsApiService } from './tiktok-events-api.service';
import { TIKTOK_ERROR_CLASSIFICATION } from './tiktok-events-payload';

const MAX_CONCURRENCY = 5;

@Injectable()
export class TiktokEventsWorkerCron {
  private readonly logger = new Logger(TiktokEventsWorkerCron.name);

  constructor(
    private outboxService: TiktokEventsOutboxService,
    private apiService: TiktokEventsApiService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processBatch(): Promise<void> {
    const startTime = Date.now();

    try {
      const rows = await this.outboxService.claimBatch();
      if (rows.length === 0) return;

      let sent = 0;
      let retried = 0;
      let dead = 0;

      for (let i = 0; i < rows.length; i += MAX_CONCURRENCY) {
        const batch = rows.slice(i, i + MAX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((row) => this.processRow(row)),
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value === 'sent') sent++;
            else if (result.value === 'retry') retried++;
            else if (result.value === 'dead') dead++;
          }
        }
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `claimed=${rows.length} sent=${sent} retry=${retried} dead=${dead} durationMs=${durationMs}`,
      );
    } catch (err: any) {
      this.logger.error(`Worker batch failed: ${err.message}`);
    }
  }

  @Cron('30 3 * * *')
  async cleanupOldRecords(): Promise<void> {
    try {
      await this.outboxService.cleanupOldRecords();
      this.logger.log('TikTok retention cleanup completed');
    } catch (err: any) {
      this.logger.error(`TikTok retention cleanup failed: ${err.message}`);
    }
  }

  private async processRow(row: any): Promise<'sent' | 'retry' | 'dead'> {
    const id = row.id as bigint;
    const attempts = row.attempts as number;
    const payload = row.payload as any;
    const eventType = row.event_type || row.eventType;

    try {
      const result = await this.apiService.sendEvent(payload);

      if (result.success) {
        await this.outboxService.markSent(id);
        return 'sent';
      }

      if (result.classification === TIKTOK_ERROR_CLASSIFICATION.PERMANENT) {
        await this.outboxService.markDead(
          id,
          result.httpStatus ?? null,
          result.errorMessage ?? null,
        );
        this.logger.warn(
          `DEAD type=${eventType} httpStatus=${result.httpStatus} error=${result.errorMessage?.substring(0, 200)}`,
        );
        return 'dead';
      }

      await this.outboxService.markRetry(
        id,
        attempts,
        result.httpStatus ?? null,
        result.errorMessage ?? null,
      );
      return 'retry';
    } catch (err: any) {
      this.logger.error(
        `Unexpected error processing TikTok row id=${id}: ${err.message}`,
      );
      await this.outboxService
        .markRetry(id, attempts, null, err.message || 'Unexpected error')
        .catch(() => {});
      return 'retry';
    }
  }
}
