import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetaPurchaseOutboxService } from './meta-purchase-outbox.service';
import { MetaConversionsApiService } from './meta-conversions-api.service';
import { META_ERROR_CLASSIFICATION, META_OUTBOX_STATUS } from './meta-purchase-payload';

const MAX_CONCURRENCY = 5;

@Injectable()
export class MetaPurchaseWorkerCron {
  private readonly logger = new Logger(MetaPurchaseWorkerCron.name);

  constructor(
    private outboxService: MetaPurchaseOutboxService,
    private capiService: MetaConversionsApiService,
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

  @Cron('20 3 * * *')
  async cleanupOldRecords(): Promise<void> {
    try {
      await this.outboxService.cleanupOldRecords();
      this.logger.log('Retention cleanup completed');
    } catch (err: any) {
      this.logger.error(`Retention cleanup failed: ${err.message}`);
    }
  }

  private async processRow(row: any): Promise<'sent' | 'retry' | 'dead'> {
    const id = row.id as bigint;
    const attempts = row.attempts as number;
    const payload = row.payload as any;

    try {
      const result = await this.capiService.sendEvent(payload);

      if (result.success) {
        await this.outboxService.markSent(id);
        return 'sent';
      }

      if (result.classification === META_ERROR_CLASSIFICATION.PERMANENT) {
        await this.outboxService.markDead(
          id,
          result.httpStatus ?? null,
          result.metaErrorCode ?? null,
          result.errorMessage ?? null,
        );
        this.logger.warn(
          `DEAD eventId=${payload.event_id} httpStatus=${result.httpStatus} metaCode=${result.metaErrorCode} error=${result.errorMessage?.substring(0, 200)}`,
        );
        return 'dead';
      }

      await this.outboxService.markRetry(
        id,
        attempts,
        result.httpStatus ?? null,
        result.metaErrorCode ?? null,
        result.errorMessage ?? null,
      );
      return 'retry';
    } catch (err: any) {
      this.logger.error(
        `Unexpected error processing row id=${id}: ${err.message}`,
      );
      await this.outboxService.markRetry(
        id,
        attempts,
        null,
        null,
        err.message || 'Unexpected error',
      ).catch(() => {});
      return 'retry';
    }
  }
}