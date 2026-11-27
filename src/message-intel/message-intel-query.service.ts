import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type SmaxMessage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MessageIntelService } from './message-intel.service';
import { intelConfig } from './message-intel.config';
import { JevProvider } from './providers/jev.provider';
import type { IntelVersion } from './providers/classifier.interface';
import {
  buildState,
  contentOf,
  PREVIOUS_LIMIT,
  type Role,
} from './context/context-builder';
import { type ArchiveRow, decide, isStaffMessage } from './rules/rule-engine';
import {
  buildJevQuestions,
  DEFAULT_THRESHOLDS,
  INTENTS,
  JEV_MODEL,
} from './taxonomy/taxonomy-v1';

export type IntelRange = { from: Date; to: Date; pagePid?: string };
export type IntelMessageFilter = IntelRange & {
  versionId?: number;
  status?: string;
  intent?: string;
  topic?: string;
  sentiment?: string;
  flag?: 'anomaly' | 'escalation' | 'reply';
  page: number;
  limit: number;
};
export type ReviewLabels = {
  intent: string | null;
  topics: string[];
  sentiment: string | null;
  urgency: number | null;
  purchaseIntent: number | null;
  requiresReply: boolean | null;
  requiresEscalation: boolean | null;
  isAnomaly: boolean | null;
};

const SKIPPED_ELIGIBLE = new Set(['media_only', 'sticker_only']);
const THREAD_LABEL_DAYS = 3;
type ThreadRow = { intent: string | null; is_anomaly: boolean | null };
/** Nhãn hội thoại (cùng bộ nhãn nút "Phân loại" cũ: ai_thread_labels) theo thứ tự ưu tiên. */
const THREAD_LABEL_ORDER: {
  label: string;
  match: (r: ThreadRow) => boolean;
}[] = [
  {
    label: 'complaint',
    match: (r) =>
      ['complaint', 'return_refund'].includes(r.intent ?? '') ||
      r.is_anomaly === true,
  },
  {
    label: 'order',
    match: (r) =>
      ['order', 'order_change', 'order_cancel'].includes(r.intent ?? ''),
  },
  { label: 'delivery', match: (r) => r.intent === 'delivery_inquiry' },
  { label: 'price', match: (r) => r.intent === 'price_inquiry' },
  { label: 'other', match: () => true },
];
const count = (rows: { _count: { _all: number } }[]) =>
  rows.reduce((s, r) => s + r._count._all, 0);
const hash = (s: string) =>
  [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

/**
 * Đọc kết quả phân loại cho màn hình quản trị: tổng quan / độ phủ, danh sách tin có nhãn, hàng chấm nhãn
 * người, thử nghiệm 1 câu. Nội dung tin chỉ trả khi người xem có quyền xem chat (controller kiểm).
 */
@Injectable()
export class MessageIntelQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intel: MessageIntelService,
    private readonly jev: JevProvider,
  ) {}

  private async versionId(id?: number) {
    if (id) return id;
    const v = await this.intel.activeVersion();
    if (!v) throw new BadRequestException('Chưa có phiên bản đang chạy');
    return v.id;
  }

  private async channelNames() {
    const rows = await this.prisma.smaxSyncChannel.findMany({
      select: { pagePid: true, name: true },
    });
    return new Map(rows.map((r) => [r.pagePid, r.name]));
  }

  /**
   * Độ phủ = đã có kết quả / tin cần hiểu (không tính tin nhân viên, báo đơn, thu hồi, rỗng). Tin chỉ ảnh /
   * sticker là "chưa hiểu" (không phải âm tính) nên vẫn tính vào mẫu số.
   */
  async overview(range: IntelRange, versionIdArg?: number) {
    const versionId = await this.versionId(versionIdArg);
    const where: Prisma.SmaxMessageIntelWhereInput = {
      versionId,
      messageAt: { gte: range.from, lt: range.to },
      ...(range.pagePid ? { pagePid: range.pagePid } : {}),
    };
    const done = { ...where, status: 'completed' };
    const [byStatus, byChannel, intents, sentiments, urgency, flags, oldest] =
      await Promise.all([
        this.prisma.smaxMessageIntel.groupBy({
          by: ['status', 'skipReason', 'processingSource'],
          where,
          _count: { _all: true },
          _sum: { inputTokens: true },
        }),
        this.prisma.smaxMessageIntel.groupBy({
          by: ['pagePid', 'status', 'skipReason'],
          where,
          _count: { _all: true },
        }),
        this.prisma.smaxMessageIntel.groupBy({
          by: ['intent'],
          where: done,
          _count: { _all: true },
        }),
        this.prisma.smaxMessageIntel.groupBy({
          by: ['sentiment'],
          where: done,
          _count: { _all: true },
        }),
        this.prisma.smaxMessageIntel.groupBy({
          by: ['urgency'],
          where: done,
          _count: { _all: true },
        }),
        Promise.all([
          this.prisma.smaxMessageIntel.count({
            where: { ...done, isAnomaly: true },
          }),
          this.prisma.smaxMessageIntel.count({
            where: { ...done, requiresEscalation: true },
          }),
          this.prisma.smaxMessageIntel.count({
            where: { ...done, requiresReply: true },
          }),
          this.prisma.smaxMessageIntel.count({
            where: { ...done, intent: 'complaint' },
          }),
        ]),
        this.prisma.smaxMessageIntel.findFirst({
          where: {
            ...where,
            status: { in: ['pending', 'retry', 'processing'] },
          },
          orderBy: { messageAt: 'asc' },
          select: { messageAt: true },
        }),
      ]);
    const topics = await this.prisma.$queryRaw<{ topic: string; n: bigint }[]>`
      SELECT t.topic, count(*) AS n
      FROM smax_message_intel i, unnest(i.topics) AS t(topic)
      WHERE i.version_id = ${versionId} AND i.status = 'completed'
        AND i.message_at >= ${range.from} AND i.message_at < ${range.to}
        AND (${range.pagePid ?? null}::text IS NULL OR i.page_pid = ${range.pagePid ?? null})
      GROUP BY t.topic ORDER BY n DESC`;
    const isEligible = (r: { status: string; skipReason: string | null }) =>
      r.status !== 'skipped' || SKIPPED_ELIGIBLE.has(r.skipReason ?? '');
    const names = await this.channelNames();
    const channels = new Map<
      string,
      {
        pagePid: string;
        name: string;
        total: number;
        eligible: number;
        completed: number;
        pending: number;
        failed: number;
      }
    >();
    for (const r of byChannel) {
      const c = channels.get(r.pagePid) ?? {
        pagePid: r.pagePid,
        name: names.get(r.pagePid) ?? r.pagePid,
        total: 0,
        eligible: 0,
        completed: 0,
        pending: 0,
        failed: 0,
      };
      const n = r._count._all;
      c.total += n;
      if (isEligible(r)) c.eligible += n;
      if (r.status === 'completed') c.completed += n;
      if (['pending', 'retry', 'processing'].includes(r.status)) c.pending += n;
      if (r.status === 'failed') c.failed += n;
      channels.set(r.pagePid, c);
    }
    const pick = (f: (r: (typeof byStatus)[number]) => boolean) =>
      count(byStatus.filter(f));
    const eligible = pick(isEligible);
    const completed = pick((r) => r.status === 'completed');
    return {
      versionId,
      totals: {
        messages: pick(() => true),
        eligible,
        completed,
        completedByJev: pick(
          (r) => r.status === 'completed' && r.processingSource === 'jev',
        ),
        completedByRule: pick(
          (r) => r.status === 'completed' && r.processingSource === 'rule',
        ),
        pending: pick((r) =>
          ['pending', 'retry', 'processing'].includes(r.status),
        ),
        failed: pick((r) => r.status === 'failed'),
        coverage: eligible ? completed / eligible : null,
        inputTokens: byStatus.reduce(
          (s, r) => s + (r._sum.inputTokens ?? 0),
          0,
        ),
        oldestPendingAt: oldest?.messageAt ?? null,
      },
      skipped: Object.fromEntries(
        byStatus
          .filter((r) => r.status === 'skipped')
          .reduce(
            (m, r) =>
              m.set(
                r.skipReason ?? 'other',
                (m.get(r.skipReason ?? 'other') ?? 0) + r._count._all,
              ),
            new Map<string, number>(),
          ),
      ),
      flags: {
        anomaly: flags[0],
        escalation: flags[1],
        reply: flags[2],
        complaint: flags[3],
      },
      intents: intents.map((r) => ({ key: r.intent, count: r._count._all })),
      sentiments: sentiments.map((r) => ({
        key: r.sentiment,
        count: r._count._all,
      })),
      urgency: urgency.map((r) => ({ key: r.urgency, count: r._count._all })),
      topics: topics.map((r) => ({ key: r.topic, count: Number(r.n) })),
      channels: [...channels.values()].sort((a, b) => b.total - a.total),
    };
  }

  /** Danh sách tin có nhãn (mới nhất trước). `withContent=false` → không trả nội dung tin. */
  async messages(filter: IntelMessageFilter, withContent: boolean) {
    const versionId = await this.versionId(filter.versionId);
    const where: Prisma.SmaxMessageIntelWhereInput = {
      versionId,
      messageAt: { gte: filter.from, lt: filter.to },
      ...(filter.pagePid ? { pagePid: filter.pagePid } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.intent ? { intent: filter.intent } : {}),
      ...(filter.sentiment ? { sentiment: filter.sentiment } : {}),
      ...(filter.topic ? { topics: { has: filter.topic } } : {}),
      ...(filter.flag === 'anomaly' ? { isAnomaly: true } : {}),
      ...(filter.flag === 'escalation' ? { requiresEscalation: true } : {}),
      ...(filter.flag === 'reply' ? { requiresReply: true } : {}),
    };
    const [total, jobs] = await Promise.all([
      this.prisma.smaxMessageIntel.count({ where }),
      this.prisma.smaxMessageIntel.findMany({
        where,
        orderBy: [{ messageAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);
    const [rows, threads, names] = await Promise.all([
      withContent
        ? this.prisma.smaxMessage.findMany({
            where: { id: { in: jobs.map((j) => j.messageId) } },
          })
        : Promise.resolve([] as SmaxMessage[]),
      this.prisma.smaxThread.findMany({
        where: {
          OR: jobs.map((j) => ({ pagePid: j.pagePid, tid: j.tid })),
        },
        select: { pagePid: true, tid: true, name: true, isGroup: true },
      }),
      this.channelNames(),
    ]);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const threadOf = new Map(threads.map((t) => [`${t.pagePid}:${t.tid}`, t]));
    return {
      total,
      page: filter.page,
      limit: filter.limit,
      contentVisible: withContent,
      items: jobs.map((j) => {
        const row = rowById.get(j.messageId);
        const thread = threadOf.get(`${j.pagePid}:${j.tid}`);
        const answers = j.answers as {
          intent?: { confidence?: number };
        } | null;
        return {
          id: j.id.toString(),
          msgPid: j.msgPid,
          messageAt: j.messageAt,
          channel: names.get(j.pagePid) ?? j.pagePid,
          pagePid: j.pagePid,
          tid: j.tid,
          threadName: thread?.name ?? null,
          isGroup: thread?.isGroup ?? null,
          senderName: withContent ? (row?.senderName ?? null) : null,
          text: withContent && row ? contentOf(row) : null,
          status: j.status,
          skipReason: j.skipReason,
          source: j.processingSource,
          lastError: j.lastError,
          intent: j.intent,
          intentConfidence: answers?.intent?.confidence ?? null,
          topics: j.topics,
          sentiment: j.sentiment,
          urgency: j.urgency,
          purchaseIntent: j.purchaseIntent,
          requiresReply: j.requiresReply,
          requiresEscalation: j.requiresEscalation,
          isAnomaly: j.isAnomaly,
          contextPartial: j.contextPartial,
        };
      }),
    };
  }

  /**
   * Tin tiếp theo để người chấm (chấm mù: không trả nhãn AI). Lấy tin đã phân loại bằng Jev của phiên bản,
   * người này chưa chấm; kèm tối đa 5 tin trước (nội dung thật, dùng nội bộ).
   */
  async nextReview(reviewerId: number, versionIdArg?: number) {
    const versionId = await this.versionId(versionIdArg);
    const [next] = await this.prisma.$queryRaw<
      { msg_pid: string; message_id: bigint; page_pid: string; tid: string }[]
    >`
      SELECT i.msg_pid, i.message_id, i.page_pid, i.tid FROM smax_message_intel i
      WHERE i.version_id = ${versionId} AND i.status = 'completed' AND i.processing_source = 'jev'
        AND NOT EXISTS (
          SELECT 1 FROM smax_intel_reviews r WHERE r.msg_pid = i.msg_pid AND r.reviewer_id = ${reviewerId}
        )
      ORDER BY md5(i.msg_pid) LIMIT 1`;
    const [done, total] = await Promise.all([
      this.prisma.smaxIntelReview.count({ where: { reviewerId } }),
      this.prisma.smaxMessageIntel.count({
        where: { versionId, status: 'completed', processingSource: 'jev' },
      }),
    ]);
    if (!next) return { item: null, done, total };
    const ours = await this.intel.ourPagePids();
    const [target, thread, previous] = await Promise.all([
      this.prisma.smaxMessage.findUnique({ where: { id: next.message_id } }),
      this.prisma.smaxThread.findUnique({
        where: { pagePid_tid: { pagePid: next.page_pid, tid: next.tid } },
        select: { name: true, isGroup: true },
      }),
      this.prisma.smaxMessage
        .findFirst({
          where: { id: next.message_id },
          select: { createdAt: true },
        })
        .then((t) =>
          t
            ? // Cùng cách chọn ngữ cảnh gửi Jev: (created_at, id) nhỏ hơn tin đích
              this.prisma.smaxMessage.findMany({
                where: {
                  pagePid: next.page_pid,
                  tid: next.tid,
                  type: 'message',
                  recalled: false,
                  OR: [
                    { createdAt: { lt: t.createdAt } },
                    { createdAt: t.createdAt, id: { lt: next.message_id } },
                  ],
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: PREVIOUS_LIMIT,
              })
            : [],
        ),
    ]);
    const sentByUs = new Set(
      (
        await this.prisma.smaxMessage.findMany({
          where: {
            pagePid: { in: [...ours] },
            msgPid: { in: previous.map((p) => p.msgPid) },
            fromMe: true,
          },
          select: { msgPid: true },
        })
      ).map((r) => r.msgPid),
    );
    const role = (r: ArchiveRow): Role =>
      sentByUs.has(r.msgPid) || isStaffMessage([r], ours)
        ? 'staff'
        : thread?.isGroup
          ? 'other_member'
          : 'customer';
    const names = await this.channelNames();
    return {
      done,
      total,
      item: target && {
        msgPid: next.msg_pid,
        channel: names.get(next.page_pid) ?? next.page_pid,
        threadName: thread?.name ?? null,
        isGroup: thread?.isGroup ?? false,
        messageAt: target.createdAt,
        senderName: target.senderName,
        text: contentOf(target),
        quote: (target.quote as { text?: string } | null)?.text ?? null,
        previous: previous.reverse().map((p) => ({
          role: role(p),
          senderName: p.senderName,
          at: p.createdAt,
          text: contentOf(p),
        })),
      },
    };
  }

  async saveReview(
    reviewerId: number,
    input: { msgPid: string; labels: ReviewLabels; note?: string },
  ) {
    const exists = await this.prisma.smaxMessageIntel.findFirst({
      where: { msgPid: input.msgPid },
      select: { id: true },
    });
    if (!exists) throw new BadRequestException('Không có tin này');
    // 40% hiệu chỉnh ngưỡng / 60% kiểm tra, cố định theo mã tin
    const split = hash(input.msgPid) % 10 < 4 ? 'calibration' : 'test';
    await this.prisma.smaxIntelReview.upsert({
      where: { msgPid_reviewerId: { msgPid: input.msgPid, reviewerId } },
      create: {
        msgPid: input.msgPid,
        reviewerId,
        labels: input.labels,
        split,
        note: input.note ?? null,
      },
      update: { labels: input.labels, note: input.note ?? null },
    });
    return { ok: true };
  }

  /** So nhãn người chấm với nhãn AI của phiên bản (nhanh; báo cáo chi tiết dùng script benchmark-eval). */
  async reviewSummary(versionIdArg?: number) {
    const versionId = await this.versionId(versionIdArg);
    const reviews = await this.prisma.smaxIntelReview.findMany();
    const jobs = new Map(
      (
        await this.prisma.smaxMessageIntel.findMany({
          where: {
            versionId,
            msgPid: { in: reviews.map((r) => r.msgPid) },
            status: 'completed',
          },
        })
      ).map((j) => [j.msgPid, j]),
    );
    const pairs = reviews
      .map((r) => ({ gold: r.labels as ReviewLabels, ai: jobs.get(r.msgPid) }))
      .filter(
        (p): p is { gold: ReviewLabels; ai: NonNullable<typeof p.ai> } =>
          !!p.ai,
      );
    const agree = <K extends keyof ReviewLabels>(
      k: K,
      aiKey: keyof (typeof pairs)[number]['ai'],
    ) => {
      const usable = pairs.filter(
        (p) => p.gold[k] !== null && p.ai[aiKey] !== null,
      );
      return {
        n: usable.length,
        rate: usable.length
          ? usable.filter((p) => p.gold[k] === p.ai[aiKey]).length /
            usable.length
          : null,
      };
    };
    const issues = pairs.filter(
      (p) => p.gold.intent === 'complaint' || p.gold.isAnomaly === true,
    );
    return {
      versionId,
      reviewed: reviews.length,
      matched: pairs.length,
      intent: agree('intent', 'intent'),
      sentiment: agree('sentiment', 'sentiment'),
      urgency: agree('urgency', 'urgency'),
      requiresReply: agree('requiresReply', 'requiresReply'),
      isAnomaly: agree('isAnomaly', 'isAnomaly'),
      complaintRecall: {
        n: issues.length,
        rate: issues.length
          ? issues.filter(
              (p) => p.ai.intent === 'complaint' || p.ai.isAnomaly === true,
            ).length / issues.length
          : null,
      },
    };
  }

  /**
   * Nhãn tin trong các kênh `pagePids` (Trợ lý AI: chỉ kênh của người hỏi). Tin nhóm thuộc kênh nếu kênh đó có
   * lưu tin (cùng msg_pid), không chỉ kênh đại diện; `ref` = hội thoại trên kênh của người hỏi. Không có phiên
   * bản đang chạy → null (nơi gọi tự bỏ qua).
   */
  async labelsForChannels(
    pagePids: string[],
    range: { from: Date; to: Date },
    filter: {
      intent?: string;
      topic?: string;
      sentiment?: string;
      flag?: 'anomaly' | 'escalation' | 'reply';
    },
    limit: number,
  ) {
    const version = await this.intel.activeVersion();
    if (!version || !pagePids.length) return null;
    // Mỗi job + 1 dòng của tin trên kênh của người hỏi (index unique (page_pid, msg_pid))
    const scoped = Prisma.sql`
      SELECT i.*, m.page_pid AS my_page, m.tid AS my_tid, m.id AS my_id
      FROM smax_message_intel i
      JOIN LATERAL (
        SELECT page_pid, tid, id FROM smax_messages m
        WHERE m.page_pid = ANY(${pagePids}::text[]) AND m.msg_pid = i.msg_pid ORDER BY m.id LIMIT 1
      ) m ON true
      WHERE i.version_id = ${version.id} AND i.message_at >= ${range.from} AND i.message_at < ${range.to}`;
    const conds: Prisma.Sql[] = [Prisma.sql`status = 'completed'`];
    if (filter.intent) conds.push(Prisma.sql`intent = ${filter.intent}`);
    if (filter.sentiment)
      conds.push(Prisma.sql`sentiment = ${filter.sentiment}`);
    if (filter.topic) conds.push(Prisma.sql`${filter.topic} = ANY(topics)`);
    if (filter.flag === 'anomaly') conds.push(Prisma.sql`is_anomaly`);
    if (filter.flag === 'escalation')
      conds.push(Prisma.sql`requires_escalation`);
    if (filter.flag === 'reply') conds.push(Prisma.sql`requires_reply`);
    type Row = {
      msg_pid: string;
      my_page: string;
      my_tid: string;
      my_id: bigint;
      message_at: Date;
      intent: string | null;
      topics: string[];
      sentiment: string | null;
      urgency: number | null;
      is_anomaly: boolean | null;
      requires_escalation: boolean | null;
      requires_reply: boolean | null;
      processing_source: string | null;
      answers: { intent?: { confidence?: number } } | null;
    };
    const [stats, rows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          status: string;
          skip_reason: string | null;
          intent: string | null;
          anomaly: boolean | null;
          escalation: boolean | null;
          n: bigint;
        }[]
      >`
        WITH j AS (${scoped})
        SELECT status, skip_reason, intent, is_anomaly AS anomaly, requires_escalation AS escalation, count(*) AS n
        FROM j GROUP BY 1, 2, 3, 4, 5`,
      this.prisma.$queryRaw<Row[]>`
        WITH j AS (${scoped})
        SELECT msg_pid, my_page, my_tid, my_id, message_at, intent, topics, sentiment, urgency, is_anomaly,
               requires_escalation, requires_reply, processing_source, answers
        FROM j WHERE ${Prisma.join(conds, ' AND ')}
        ORDER BY message_at DESC LIMIT ${limit + 1}`,
    ]);
    const n = (f: (r: (typeof stats)[number]) => boolean) =>
      stats.filter(f).reduce((s, r) => s + Number(r.n), 0);
    const eligible = n(
      (r) =>
        r.status !== 'skipped' || SKIPPED_ELIGIBLE.has(r.skip_reason ?? ''),
    );
    const labeled = n((r) => r.status === 'completed');
    const byIntent: Record<string, number> = {};
    for (const r of stats)
      if (r.status === 'completed' && r.intent)
        byIntent[r.intent] = (byIntent[r.intent] ?? 0) + Number(r.n);
    const page = rows.slice(0, limit);
    const [texts, threads, names] = await Promise.all([
      this.prisma.smaxMessage.findMany({
        where: { id: { in: page.map((r) => r.my_id) } },
      }),
      page.length
        ? this.prisma.smaxThread.findMany({
            where: {
              OR: page.map((r) => ({ pagePid: r.my_page, tid: r.my_tid })),
            },
            select: { pagePid: true, tid: true, name: true, isGroup: true },
          })
        : Promise.resolve(
            [] as {
              pagePid: string;
              tid: string;
              name: string;
              isGroup: boolean;
            }[],
          ),
      this.channelNames(),
    ]);
    const textOf = new Map(texts.map((t) => [t.id, t]));
    const threadOf = new Map(threads.map((t) => [`${t.pagePid}:${t.tid}`, t]));
    return {
      versionId: version.id,
      coverage: {
        customerMessages: eligible,
        labeled,
        pending: n((r) =>
          ['pending', 'retry', 'processing'].includes(r.status),
        ),
        ratio: eligible ? labeled / eligible : null,
      },
      counts: {
        byIntent,
        complaint: byIntent.complaint ?? 0,
        anomaly: n((r) => r.status === 'completed' && r.anomaly === true),
        escalation: n((r) => r.status === 'completed' && r.escalation === true),
      },
      truncated: rows.length > limit,
      messages: page.map((r) => {
        const row = textOf.get(r.my_id);
        const thread = threadOf.get(`${r.my_page}:${r.my_tid}`);
        return {
          ref: `${r.my_page}:${r.my_tid}`,
          channel: names.get(r.my_page) ?? r.my_page,
          thread: thread?.name ?? null,
          isGroup: thread?.isGroup ?? null,
          at: r.message_at,
          text: row ? contentOf(row).slice(0, 200) : null,
          intent: r.intent,
          intentConfidence: r.answers?.intent?.confidence ?? null,
          byRule: r.processing_source === 'rule',
          topics: r.topics,
          sentiment: r.sentiment,
          urgency: r.urgency,
          anomaly: r.is_anomaly,
          escalation: r.requires_escalation,
          needsReply: r.requires_reply,
        };
      }),
    };
  }

  /**
   * Báo cáo cuối ngày: hội thoại (`page_pid:tid`, mọi kênh có lưu tin) có tin khiếu nại / bất thường / cần quản
   * lý trong ngày, và số liệu nhãn + độ phủ. Không có phiên bản đang chạy → null.
   */
  async dailySignals(range: { from: Date; to: Date }) {
    const version = await this.intel.activeVersion();
    if (!version) return null;
    const pages = [...(await this.intel.ourPagePids())];
    const [flagged, overview] = await Promise.all([
      this.prisma.$queryRaw<{ page_pid: string; tid: string }[]>`
        SELECT DISTINCT m.page_pid, m.tid
        FROM smax_message_intel i
        JOIN smax_messages m ON m.page_pid = ANY(${pages}::text[]) AND m.msg_pid = i.msg_pid
        WHERE i.version_id = ${version.id} AND i.status = 'completed'
          AND i.message_at >= ${range.from} AND i.message_at < ${range.to}
          AND (i.intent = 'complaint' OR i.is_anomaly OR i.requires_escalation)`,
      this.overview(range, version.id),
    ]);
    return {
      flaggedThreads: new Set(flagged.map((f) => `${f.page_pid}:${f.tid}`)),
      coverage: overview.totals.coverage,
      customerMessages: overview.totals.eligible,
      labeled: overview.totals.completed,
      complaints: overview.flags.complaint,
      anomalies: overview.flags.anomaly,
      escalations: overview.flags.escalation,
    };
  }

  /**
   * Kênh đang được phân loại tin (worker bật + có phiên bản chạy + nằm trong MESSAGE_INTEL_PAGE_PIDS nếu có).
   * Khung chat dùng nhãn hội thoại tự động thay nút "Phân loại" cho các kênh này.
   */
  async coveredPagePids(pagePids: string[]) {
    const cfg = intelConfig();
    if (!cfg.enabled || !(await this.intel.activeVersion())) return [];
    const allow = new Set(cfg.pagePids);
    return pagePids.filter((p) => !allow.size || allow.has(p));
  }

  /**
   * Nhãn hội thoại suy từ nhãn từng tin (không gọi AI): xét tin trong 3 ngày; "cửa sổ mở" = tin khách sau
   * tin nhân viên cuối (không có thì 5 tin khách gần nhất). Nhãn ưu tiên: khiếu nại (khiếu nại / đổi trả /
   * bất thường) > đặt hàng > hỏi giao hàng > hỏi giá > khác. pending: tin cuối là của khách và có tin cần trả
   * lời trong cửa sổ. stale: tin khách mới nhất chưa phân loại xong.
   */
  async threadLabels(
    threads: { pagePid: string; tid: string }[],
    now = new Date(),
  ) {
    const out = new Map<
      string,
      {
        label: string;
        reason: string;
        pending: boolean;
        stale: boolean;
        at: Date;
      }
    >();
    const version = await this.intel.activeVersion();
    if (!version || !threads.length) return out;
    type Row = {
      page_pid: string;
      tid: string;
      created_at: Date;
      from_me: boolean;
      status: string | null;
      skip_reason: string | null;
      intent: string | null;
      is_anomaly: boolean | null;
      requires_reply: boolean | null;
    };
    const pairs = Prisma.join(
      threads.map((t) => Prisma.sql`(${t.pagePid}, ${t.tid})`),
    );
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT m.page_pid, m.tid, m.created_at, m.from_me, i.status, i.skip_reason, i.intent, i.is_anomaly, i.requires_reply
      FROM smax_messages m
      LEFT JOIN smax_message_intel i ON i.msg_pid = m.msg_pid AND i.version_id = ${version.id}
      WHERE (m.page_pid, m.tid) IN (${pairs}) AND m.type = 'message' AND m.recalled = false
        AND m.created_at >= ${new Date(now.getTime() - THREAD_LABEL_DAYS * 86_400_000)}
      ORDER BY m.created_at, m.id`;
    const byThread = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.page_pid}:${r.tid}`;
      byThread.set(k, [...(byThread.get(k) ?? []), r]);
    }
    for (const [key, list] of byThread) {
      const isStaff = (r: Row) =>
        r.from_me || (r.status === 'skipped' && r.skip_reason === 'staff');
      const lastStaff = list.reduce((i, r, idx) => (isStaff(r) ? idx : i), -1);
      const customer = list.filter((r) => !isStaff(r));
      const opened = list
        .slice(lastStaff + 1)
        .filter((r) => r.status === 'completed');
      const window = opened.length
        ? opened
        : customer.filter((r) => r.status === 'completed').slice(-5);
      if (!window.length) continue;
      const pick = THREAD_LABEL_ORDER.find((l) =>
        window.some((r) => l.match(r)),
      )!;
      const hit = [...window].reverse().find((r) => pick.match(r))!;
      const last = list[list.length - 1];
      const latestCustomer = customer[customer.length - 1];
      const vnTime = new Date(hit.created_at.getTime() + 7 * 3_600_000)
        .toISOString()
        .slice(11, 16);
      out.set(key, {
        label: pick.label,
        // Nhãn khiếu nại do cờ bất thường (ý định khác) → ghi "Bất thường" cho rõ lý do
        reason: `${
          pick.label === 'complaint' &&
          hit.is_anomaly &&
          !['complaint', 'return_refund'].includes(hit.intent ?? '')
            ? 'Bất thường'
            : (INTENTS[hit.intent as keyof typeof INTENTS]?.[0] ?? 'Khác')
        } lúc ${vnTime}`,
        pending:
          !isStaff(last) && opened.some((r) => r.requires_reply === true),
        stale:
          !!latestCustomer &&
          !['completed', 'skipped'].includes(latestCustomer.status ?? ''),
        at: hit.created_at,
      });
    }
    return out;
  }

  /**
   * Hồ sơ AI của khách POS trong N ngày: tin khách ở các hội thoại đã gắn khách (Zalo cá nhân: mọi kênh cùng
   * mã Zalo; kênh khác: đúng kênh). Không có phiên bản / chưa gắn hội thoại → null.
   */
  async customerSummary(customerId: number, days = 90, withContent = false) {
    const version = await this.intel.activeVersion();
    if (!version) return null;
    const contacts = await this.prisma.customerZaloContact.findMany({
      where: { customerId },
      select: { zaloId: true, pagePid: true },
    });
    if (!contacts.length) return { linked: false as const };
    const since = new Date(Date.now() - days * 86_400_000);
    const threadConds = contacts.map((c) =>
      /^\d+$/.test(c.zaloId)
        ? Prisma.sql`(m.tid = ${`zlw${c.zaloId}`}${c.pagePid ? Prisma.sql` AND m.page_pid = ${c.pagePid}` : Prisma.empty})`
        : Prisma.sql`(m.tid = ${c.zaloId}${c.pagePid ? Prisma.sql` AND m.page_pid = ${c.pagePid}` : Prisma.empty})`,
    );
    type Row = {
      msg_pid: string;
      message_id: bigint;
      message_at: Date;
      intent: string | null;
      topics: string[];
      sentiment: string | null;
      purchase_intent: number | null;
      is_anomaly: boolean | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (i.msg_pid) i.msg_pid, i.message_id, i.message_at, i.intent, i.topics, i.sentiment,
             i.purchase_intent, i.is_anomaly
      FROM smax_messages m
      JOIN smax_message_intel i ON i.msg_pid = m.msg_pid AND i.version_id = ${version.id} AND i.status = 'completed'
      WHERE (${Prisma.join(threadConds, ' OR ')}) AND m.created_at >= ${since}
      ORDER BY i.msg_pid`;
    const sorted = rows.sort(
      (a, b) => b.message_at.getTime() - a.message_at.getTime(),
    );
    const issues = sorted.filter(
      (r) => r.intent === 'complaint' || r.is_anomaly === true,
    );
    const topics = new Map<string, number>();
    for (const r of sorted)
      for (const t of r.topics) topics.set(t, (topics.get(t) ?? 0) + 1);
    const lastIssue = issues[0];
    const lastIssueRow =
      withContent && lastIssue
        ? await this.prisma.smaxMessage.findUnique({
            where: { id: lastIssue.message_id },
          })
        : null;
    const count = (f: (r: Row) => boolean) => sorted.filter(f).length;
    return {
      linked: true as const,
      days,
      messages: sorted.length,
      complaints: count((r) => r.intent === 'complaint'),
      anomalies: count((r) => r.is_anomaly === true),
      orders: count((r) => ['order', 'order_change'].includes(r.intent ?? '')),
      negative: count((r) => r.sentiment === 'negative'),
      positive: count((r) => r.sentiment === 'positive'),
      highPurchaseIntent: count((r) => (r.purchase_intent ?? 0) >= 2),
      topTopics: [...topics]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key, n]) => ({ key, n })),
      lastIssue: lastIssue
        ? {
            at: lastIssue.message_at,
            intent: lastIssue.intent,
            text: lastIssueRow ? contentOf(lastIssueRow).slice(0, 160) : null,
          }
        : null,
      lastMessageAt: sorted[0]?.message_at ?? null,
    };
  }

  /** Thử 1 câu (manage): luật → state đã ẩn danh → Jev theo phiên bản đang chạy (chưa có thì v1). Tính vào ngân sách. */
  async sandbox(input: {
    text: string;
    isGroup: boolean;
    previous: { role: 'staff' | 'customer'; text: string }[];
  }) {
    if (!input.text.trim()) throw new BadRequestException('Nhập nội dung tin');
    const at = Date.now();
    const fake = (i: number, text: string, staff = false): ArchiveRow => ({
      id: BigInt(i + 1),
      pagePid: 'sandbox',
      tid: 'sandbox',
      msgPid: `sandbox-${i}`,
      senderPid: null,
      senderName: null,
      fromMe: staff,
      type: 'message',
      text,
      attachments: null,
      sticker: null,
      recalled: false,
      createdAt: new Date(at - (input.previous.length - i + 1) * 60_000),
    });
    const target = fake(input.previous.length, input.text);
    const rule = decide(
      { msgPid: target.msgPid, rep: target, rows: [target] },
      new Set(),
    );
    const state = buildState({
      target,
      isGroup: input.isGroup,
      previous: input.previous.map((p, i) => ({
        row: fake(i, p.text),
        staff: p.role === 'staff',
      })),
      quoted: null,
    });
    if (rule.status !== 'pending') return { rule, state, result: null };
    const version: IntelVersion = (await this.intel.activeVersion()) ?? {
      id: 0,
      model: JEV_MODEL,
      questions: buildJevQuestions(),
      thresholds: DEFAULT_THRESHOLDS,
    };
    const result = await this.jev.classify(state, version);
    await this.intel.consumeTokens(result.inputTokens);
    return { rule, state, result };
  }
}
