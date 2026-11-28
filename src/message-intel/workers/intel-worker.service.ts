import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageIntelService } from '../message-intel.service';
import { utcTs } from '../sql-time';
import { intelConfig } from '../message-intel.config';
import { ContextBuilder } from '../context/context-builder';
import { JevProvider } from '../providers/jev.provider';
import { MAX_ATTEMPTS, retryDelayMs } from '../providers/backoff';
import {
  ClassifierError,
  type IntelVersion,
} from '../providers/classifier.interface';
import { decide, groupByMsgPid } from '../rules/rule-engine';

/** Giữ job tối đa chừng này; worker chết giữa chừng thì lượt sau lấy lại. */
export const LEASE_MS = 5 * 60_000;
/** Ước tính token / tin khi dry-run (benchmark v1: ~2.185). */
const EST_TOKENS = 2_200;

type Claimed = {
  id: bigint;
  msg_pid: string;
  message_id: bigint;
  attempt_count: number;
};

async function pool<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

/**
 * Lấy job tới hạn (SKIP LOCKED, lease 5 phút) → kiểm tra lại luật với dữ liệu mới nhất → dựng ngữ cảnh →
 * gọi Jev ngoài transaction → ghi kết quả có điều kiện claim_token (worker hết lease không ghi đè).
 * Dừng khi tạm dừng / hết ngân sách ngày; lỗi API không ảnh hưởng POS.
 */
@Injectable()
export class IntelWorkerService {
  private readonly logger = new Logger(IntelWorkerService.name);
  private running = false;
  private lastDryRunLog = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly intel: MessageIntelService,
    private readonly context: ContextBuilder,
    private readonly jev: JevProvider,
  ) {}

  @Interval(15_000)
  async tick() {
    const cfg = intelConfig();
    if (!cfg.enabled || this.running) return;
    this.running = true;
    try {
      await this.runOnce(cfg);
    } catch (error) {
      this.logger.error(`Phân loại tin lỗi: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(cfg = intelConfig()) {
    const version = await this.intel.activeVersion();
    if (!version) return { processed: 0 };
    const runtime = await this.intel.runtime();
    if (runtime.paused) return { processed: 0 };
    if (cfg.dryRun) return this.dryRun(version);
    if ((await this.intel.budgetLeft()) <= 0) return { processed: 0 };
    const jobs = await this.claim(version.id, cfg.batch);
    let authFailed = false;
    await pool(jobs.claimed, cfg.concurrency, async (job) => {
      if (authFailed) return this.release(job, jobs.token);
      const result = await this.process(job, jobs.token, version);
      if (result === 'auth') authFailed = true;
    });
    if (authFailed) {
      await this.prisma.smaxIntelRuntime.update({
        where: { id: 1 },
        data: { paused: true },
      });
      this.logger.error(
        'Jev từ chối API key (401/403) → tạm dừng phân loại tin; kiểm tra AI_TYPESAFE_JEV_API_KEY rồi tiếp tục',
      );
    }
    return { processed: jobs.claimed.length };
  }

  /** Lấy job tới hạn hoặc job "processing" đã hết lease. Một token cho cả lô. */
  async claim(versionId: number, limit: number) {
    const token = randomUUID();
    const now = new Date();
    const claimed = await this.prisma.$queryRaw<Claimed[]>`
      WITH candidates AS (
        SELECT id FROM smax_message_intel
        WHERE version_id = ${versionId}
          AND ((status IN ('pending', 'retry') AND next_retry_at <= ${utcTs(now)})
            OR (status = 'processing' AND locked_until <= ${utcTs(now)}))
        ORDER BY next_retry_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE smax_message_intel AS j
      SET status = 'processing', claim_token = ${token}::uuid,
          locked_until = ${utcTs(new Date(now.getTime() + LEASE_MS))},
          attempt_count = j.attempt_count + 1, updated_at = ${utcTs(now)}
      FROM candidates WHERE j.id = candidates.id
      RETURNING j.id, j.msg_pid, j.message_id, j.attempt_count`;
    return { token, claimed };
  }

  /** Ghi kết quả chỉ khi job vẫn do lô này giữ. */
  private finish(job: Claimed, token: string, data: object) {
    return this.prisma.smaxMessageIntel.updateMany({
      where: { id: job.id, claimToken: token, status: 'processing' },
      data: { ...data, claimToken: null, lockedUntil: null },
    });
  }

  /** Trả job về hàng đợi ngay, không tính lượt (vd đang dừng vì lỗi API key). */
  private release(job: Claimed, token: string) {
    return this.finish(job, token, {
      status: 'retry',
      nextRetryAt: new Date(),
      attemptCount: Math.max(0, job.attempt_count - 1),
    }).then(() => undefined);
  }

  async process(job: Claimed, token: string, version: IntelVersion) {
    const ours = await this.intel.ourPagePids();
    // Dữ liệu mới nhất của tin (kênh khác có thể vừa lưu dòng from_me / thu hồi)
    const rows = await this.prisma.smaxMessage.findMany({
      where: { pagePid: { in: [...ours] }, msgPid: job.msg_pid },
    });
    const msg = groupByMsgPid(rows)[0];
    const rep = rows.find((r) => r.id === job.message_id) ?? msg?.rep;
    if (!msg || !rep) {
      await this.finish(job, token, {
        status: 'failed',
        lastError: 'Không còn tin trong kho',
      });
      return 'failed';
    }
    const decision = decide({ ...msg, rep }, ours);
    if (decision.status === 'skipped') {
      await this.finish(job, token, {
        status: 'skipped',
        processingSource: 'rule',
        skipReason: decision.skipReason,
      });
      return 'skipped';
    }
    if (decision.status === 'completed') {
      await this.finish(job, token, {
        status: 'completed',
        processingSource: 'rule',
        ...decision.labels,
        classifiedAt: new Date(),
      });
      return 'completed';
    }
    try {
      const { state, contextPartial } = await this.context.build(rep, ours);
      const result = await this.jev.classify(state, version);
      await this.finish(job, token, {
        status: 'completed',
        processingSource: 'jev',
        ...result.labels,
        answers: result.answers,
        contextPartial,
        model: result.model,
        inputTokens: result.inputTokens,
        latencyMs: result.latencyMs,
        classifiedAt: new Date(),
        lastError: null,
      });
      await this.intel.consumeTokens(result.inputTokens);
      return 'completed';
    } catch (error) {
      const e =
        error instanceof ClassifierError
          ? error
          : new ClassifierError(String(error).slice(0, 300), 'retry');
      if (e.kind === 'auth') {
        await this.release(job, token);
        return 'auth';
      }
      const lastError = e.message.slice(0, 1000);
      if (e.kind === 'fatal' || job.attempt_count >= MAX_ATTEMPTS) {
        await this.finish(job, token, { status: 'failed', lastError });
        return 'failed';
      }
      await this.finish(job, token, {
        status: 'retry',
        lastError,
        nextRetryAt: new Date(
          Date.now() + retryDelayMs(job.attempt_count, e.retryAfterMs),
        ),
      });
      return 'retry';
    }
  }

  /** Dry-run: không lấy job, không gọi API; dựng thử ngữ cảnh vài tin và log ước tính (10 phút / lần). */
  private async dryRun(version: IntelVersion) {
    if (Date.now() - this.lastDryRunLog < 10 * 60_000) return { processed: 0 };
    this.lastDryRunLog = Date.now();
    const [pending, sample] = await Promise.all([
      this.prisma.smaxMessageIntel.count({
        where: { versionId: version.id, status: { in: ['pending', 'retry'] } },
      }),
      this.prisma.smaxMessageIntel.findMany({
        where: { versionId: version.id, status: 'pending' },
        select: { messageId: true },
        take: 5,
      }),
    ]);
    const ours = await this.intel.ourPagePids();
    let built = 0;
    for (const s of sample) {
      const rep = await this.prisma.smaxMessage.findUnique({
        where: { id: s.messageId },
      });
      if (rep) {
        await this.context.build(rep, ours);
        built++;
      }
    }
    this.logger.log(
      `[dry-run] ${pending} tin chờ phân loại, ước tính ~${Math.round((pending * EST_TOKENS) / 1e6)} triệu token (~${((pending * EST_TOKENS) / 1e6) * 0.042} USD); dựng thử ngữ cảnh ${built}/${sample.length} tin`,
    );
    return { processed: 0 };
  }
}
