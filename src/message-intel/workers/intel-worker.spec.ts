import { ClassifierError } from '../providers/classifier.interface';
import { MAX_ATTEMPTS } from '../providers/backoff';
import type { ArchiveRow } from '../rules/rule-engine';
import { IntelWorkerService } from './intel-worker.service';

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  id: 11n,
  pagePid: 'zlwA',
  tid: 'zlw900001',
  msgPid: 'm1',
  senderPid: 'zlw555',
  senderName: 'Chị Lan',
  fromMe: false,
  type: 'message',
  text: 'Hàng thiếu 2 gói nhé em',
  attachments: null,
  sticker: null,
  recalled: false,
  createdAt: new Date('2026-11-27T03:00:00Z'),
  ...over,
});
const job = (attempt = 1) => ({
  id: 1n,
  msg_pid: 'm1',
  message_id: 11n,
  attempt_count: attempt,
});
const labels = {
  intent: 'complaint',
  topics: ['missing_items'],
  sentiment: 'negative',
  urgency: 2,
  purchaseIntent: 0,
  requiresReply: true,
  requiresEscalation: false,
  isAnomaly: true,
};

function make(
  opts: {
    rows?: ArchiveRow[];
    claimed?: ReturnType<typeof job>[];
    classify?: jest.Mock;
    runtime?: object;
    budget?: number;
    version?: object | null;
  } = {},
) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(opts.claimed ?? [job()]),
    smaxMessage: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? [row()]),
      findUnique: jest.fn(),
    },
    smaxMessageIntel: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    smaxIntelRuntime: { update: jest.fn().mockResolvedValue({}) },
  };
  const intel = {
    activeVersion: jest
      .fn()
      .mockResolvedValue(
        opts.version === undefined
          ? { id: 7, model: 'jev-1.14.0', questions: {}, thresholds: {} }
          : opts.version,
      ),
    runtime: jest.fn().mockResolvedValue({ paused: false, ...opts.runtime }),
    budgetLeft: jest.fn().mockResolvedValue(opts.budget ?? 1_000_000),
    ourPagePids: jest.fn().mockResolvedValue(new Set(['zlwA', 'zlwB'])),
    consumeTokens: jest.fn(),
  };
  const context = {
    build: jest.fn().mockResolvedValue({
      state: { target: {} },
      contextPartial: false,
      isGroup: false,
    }),
  };
  const jev = {
    classify:
      opts.classify ??
      jest.fn().mockResolvedValue({
        labels,
        answers: { intent: {} },
        model: 'jev-1.14.0',
        inputTokens: 2100,
        latencyMs: 250,
      }),
  };
  const svc = new IntelWorkerService(
    prisma as any,
    intel as any,
    context as any,
    jev as any,
  );
  return { prisma, intel, context, jev, svc };
}
const cfg = {
  enabled: true,
  dryRun: false,
  concurrency: 2,
  batch: 20,
  pagePids: [],
};
type Update = {
  where: { id: bigint; claimToken: string; status: string };
  data: Record<string, unknown>;
};
const update = (prisma: ReturnType<typeof make>['prisma'], i = 0) =>
  (prisma.smaxMessageIntel.updateMany.mock.calls as unknown[][])[
    i
  ][0] as Update;

describe('IntelWorkerService', () => {
  it('lấy job bằng FOR UPDATE SKIP LOCKED + lease; ghi kết quả có điều kiện claim_token, cộng token', async () => {
    const { prisma, intel, svc } = make();
    await svc.runOnce(cfg);
    const sql = (
      (prisma.$queryRaw.mock.calls as unknown[][])[0][0] as string[]
    ).join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'processing' AND locked_until <=");
    const u = update(prisma);
    expect(u.where).toMatchObject({ id: 1n, status: 'processing' });
    expect(u.where.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.data).toMatchObject({
      status: 'completed',
      processingSource: 'jev',
      intent: 'complaint',
      inputTokens: 2100,
      claimToken: null,
      lockedUntil: null,
    });
    expect(intel.consumeTokens).toHaveBeenCalledWith(2100);
  });

  it('không lấy job khi tạm dừng, chưa có phiên bản, hết ngân sách, hoặc dry-run (không gọi Jev)', async () => {
    for (const opts of [
      { runtime: { paused: true } },
      { version: null },
      { budget: 0 },
    ]) {
      const { prisma, jev, svc } = make(opts);
      await svc.runOnce(cfg);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(jev.classify).not.toHaveBeenCalled();
    }
    const dry = make();
    dry.prisma.smaxMessageIntel.count.mockResolvedValue(10);
    dry.prisma.smaxMessageIntel.findMany.mockResolvedValue([]);
    await dry.svc.runOnce({ ...cfg, dryRun: true });
    expect(dry.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(dry.jev.classify).not.toHaveBeenCalled();
  });

  it('kiểm tra lại luật với dữ liệu mới nhất: kênh khác vừa lưu bản from_me → bỏ qua, không gọi Jev', async () => {
    const { prisma, jev, svc } = make({
      rows: [row(), row({ id: 20n, pagePid: 'zlwB', fromMe: true })],
    });
    await svc.runOnce(cfg);
    expect(jev.classify).not.toHaveBeenCalled();
    expect(update(prisma).data).toMatchObject({
      status: 'skipped',
      skipReason: 'staff',
    });
  });

  it('tin đã thu hồi trước khi gửi → bỏ qua', async () => {
    const { prisma, jev, svc } = make({ rows: [row({ recalled: true })] });
    await svc.runOnce(cfg);
    expect(jev.classify).not.toHaveBeenCalled();
    expect(update(prisma).data).toMatchObject({
      status: 'skipped',
      skipReason: 'recalled',
    });
  });

  it('lỗi tạm thời → retry với backoff (Retry-After tối thiểu); quá số lần → failed; lỗi request → failed', async () => {
    const retry = make({
      classify: jest
        .fn()
        .mockRejectedValue(
          new ClassifierError('Jev HTTP 429', 'retry', 429, 120_000),
        ),
    });
    const before = Date.now();
    await retry.svc.runOnce(cfg);
    const d = update(retry.prisma).data;
    expect(d.status).toBe('retry');
    expect((d.nextRetryAt as Date).getTime()).toBeGreaterThanOrEqual(
      before + 120_000,
    );

    const last = make({
      claimed: [job(MAX_ATTEMPTS)],
      classify: jest
        .fn()
        .mockRejectedValue(new ClassifierError('timeout', 'retry')),
    });
    await last.svc.runOnce(cfg);
    expect(update(last.prisma).data).toMatchObject({
      status: 'failed',
      lastError: 'timeout',
    });

    const fatal = make({
      classify: jest
        .fn()
        .mockRejectedValue(new ClassifierError('Jev HTTP 422', 'fatal', 422)),
    });
    await fatal.svc.runOnce(cfg);
    expect(update(fatal.prisma).data).toMatchObject({ status: 'failed' });
  });

  it('API key sai → trả job về hàng đợi (không tính lượt) và tạm dừng worker', async () => {
    const { prisma, svc } = make({
      claimed: [job(3)],
      classify: jest
        .fn()
        .mockRejectedValue(new ClassifierError('Jev HTTP 401', 'auth', 401)),
    });
    await svc.runOnce(cfg);
    expect(update(prisma).data).toMatchObject({
      status: 'retry',
      attemptCount: 2,
    });
    expect(prisma.smaxIntelRuntime.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { paused: true },
    });
  });

  it('tin không còn trong kho → failed', async () => {
    const { prisma, svc } = make({ rows: [] });
    await svc.runOnce(cfg);
    expect(update(prisma).data).toMatchObject({ status: 'failed' });
  });
});
