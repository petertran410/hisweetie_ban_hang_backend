import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPayload,
  CustomerPii,
  hasAnyUserData,
  InvoiceForPurchase,
  META_OUTBOX_STATUS,
  MetaPurchasePayload,
} from './meta-purchase-payload';

const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;
const BATCH_SIZE = 20;
const SENT_RETENTION_DAYS = 30;
const DEAD_RETENTION_DAYS = 90;

type TxClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class MetaPurchaseOutboxService {
  private readonly logger = new Logger(MetaPurchaseOutboxService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  private getWorkerId(): string {
    const host = process.env.HOSTNAME || 'unknown';
    const pid = process.pid;
    return `${host}:${pid}`;
  }

  private getConfig(): {
    enabled: boolean;
    namespace: string;
    actionSource: string;
    datasetId: string;
  } {
    return {
      enabled:
        this.configService.get<string>('META_CAPI_ENABLED') === 'true',
      namespace:
        this.configService.get<string>('META_EVENT_NAMESPACE') || 'unknown',
      actionSource:
        this.configService.get<string>('META_ACTION_SOURCE') ||
        'physical_store',
      datasetId:
        this.configService.get<string>('META_DATASET_ID') || '',
    };
  }

  async enqueuePurchase(
    tx: TxClient,
    invoice: InvoiceForPurchase,
  ): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;

    const payload = buildPayload(invoice, config);

    if (!hasAnyUserData(payload.user_data)) {
      this.logger.warn(
        `Skipping Purchase for invoice ${invoice.code}: no matching user data`,
      );
      await (tx as any).metaPurchaseOutbox.create({
        data: {
          invoiceId: invoice.id,
          invoiceCode: invoice.code,
          eventId: payload.event_id,
          eventTime: new Date(payload.event_time * 1000),
          payload: payload as any,
          status: META_OUTBOX_STATUS.SKIPPED,
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: 'NO_MATCHING_USER_DATA',
        },
      });
      return;
    }

    await (tx as any).metaPurchaseOutbox.create({
      data: {
        invoiceId: invoice.id,
        invoiceCode: invoice.code,
        eventId: payload.event_id,
        eventTime: new Date(payload.event_time * 1000),
        payload: payload as any,
        status: META_OUTBOX_STATUS.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    });
  }

  async claimBatch(): Promise<any[]> {
    const workerId = this.getWorkerId();
    const config = this.getConfig();
    if (!config.enabled) return [];

    const leaseCutoff = new Date(
      Date.now() - LEASE_MINUTES * 60 * 1000,
    );

    const rows: any[] = await this.prisma.$queryRaw`
      WITH candidates AS (
        SELECT id
        FROM meta_purchase_outbox
        WHERE (
          status IN ('PENDING', 'RETRY')
          AND next_attempt_at <= NOW()
        ) OR (
          status = 'PROCESSING'
          AND locked_at <= ${leaseCutoff}
        )
        ORDER BY next_attempt_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      )
      UPDATE meta_purchase_outbox AS outbox
      SET
        status = 'PROCESSING',
        attempts = outbox.attempts + 1,
        locked_at = NOW(),
        locked_by = ${workerId},
        updated_at = NOW()
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING outbox.*;
    `;

    return rows;
  }

  async markSent(id: bigint): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE meta_purchase_outbox
      SET
        status = ${META_OUTBOX_STATUS.SENT},
        sent_at = NOW(),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async markRetry(
    id: bigint,
    attempt: number,
    lastHttpStatus: number | null,
    lastErrorCode: number | null,
    lastError: string | null,
  ): Promise<void> {
    const delayMs = this.computeDelayMs(attempt);
    const nextAttemptAt = new Date(Date.now() + delayMs);

    const truncatedError = lastError
      ? lastError.substring(0, 2000)
      : null;

    if (attempt >= MAX_ATTEMPTS) {
      await this.prisma.$executeRaw`
        UPDATE meta_purchase_outbox
        SET
          status = ${META_OUTBOX_STATUS.DEAD},
          last_http_status = ${lastHttpStatus},
          last_error_code = ${lastErrorCode},
          last_error = ${truncatedError},
          locked_at = NULL,
          locked_by = NULL,
          updated_at = NOW()
        WHERE id = ${id}
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE meta_purchase_outbox
        SET
          status = ${META_OUTBOX_STATUS.RETRY},
          next_attempt_at = ${nextAttemptAt},
          last_http_status = ${lastHttpStatus},
          last_error_code = ${lastErrorCode},
          last_error = ${truncatedError},
          locked_at = NULL,
          locked_by = NULL,
          updated_at = NOW()
        WHERE id = ${id}
      `;
    }
  }

  async markDead(
    id: bigint,
    lastHttpStatus: number | null,
    lastErrorCode: number | null,
    lastError: string | null,
  ): Promise<void> {
    const truncatedError = lastError
      ? lastError.substring(0, 2000)
      : null;

    await this.prisma.$executeRaw`
      UPDATE meta_purchase_outbox
      SET
        status = ${META_OUTBOX_STATUS.DEAD},
        last_http_status = ${lastHttpStatus},
        last_error_code = ${lastErrorCode},
        last_error = ${truncatedError},
        locked_at = NULL,
        locked_by = NULL,
        updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async cleanupOldRecords(): Promise<void> {
    const sentCutoff = new Date(
      Date.now() - SENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const deadCutoff = new Date(
      Date.now() - DEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.$executeRaw`
      DELETE FROM meta_purchase_outbox
      WHERE (
        status = ${META_OUTBOX_STATUS.SENT}
        AND sent_at <= ${sentCutoff}
      ) OR (
        status = ${META_OUTBOX_STATUS.DEAD}
        AND updated_at <= ${deadCutoff}
      )
    `;
  }

  private computeDelayMs(attempt: number): number {
    const baseMs = 30_000;
    const capMs = 6 * 60 * 60 * 1000;
    const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    const half = Math.floor(exponential / 2);
    return half + Math.floor(Math.random() * half);
  }
}