import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { type Actor, MessageIntelService } from './message-intel.service';
import { MessageIntelQueryService } from './message-intel-query.service';
import { IntelDiscoveryService } from './workers/intel-discovery.service';

/** Số tin gần nhất của hội thoại dùng để tìm cùng nhóm ở kênh khác (cùng msg_pid). */
const SIBLING_SAMPLE = 300;
const SEARCH_LIMIT = 20;
/** Lô tạo lại job khi bỏ loại trừ */
const REQUEUE_BATCH = 500;

type ThreadRef = { pagePid: string; tid: string };
const keyOf = (t: ThreadRef) => `${t.pagePid}:${t.tid}`;

/**
 * Danh sách hội thoại loại trừ khỏi phân loại tin: tin của các hội thoại này không gửi AI (skip_reason =
 * excluded). Nhóm Zalo có ở nhiều kênh: loại trừ 1 kênh = loại trừ mọi kênh (lưu đủ các hội thoại cùng nhóm
 * dưới 1 group_key; lúc quét, tin có mặt ở bất kỳ hội thoại nào trong danh sách đều bị bỏ qua).
 */
@Injectable()
export class MessageIntelExclusionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intel: MessageIntelService,
    private readonly query: MessageIntelQueryService,
    private readonly discovery: IntelDiscoveryService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Danh sách theo nhóm: hội thoại được chọn trước, sau đó các kênh cùng nhóm. */
  async list() {
    const [rows, channels] = await Promise.all([
      this.prisma.smaxIntelExclusion.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.smaxSyncChannel.findMany({
        select: { pagePid: true, name: true },
      }),
    ]);
    const channelName = new Map(channels.map((c) => [c.pagePid, c.name]));
    const groups = new Map<
      string,
      {
        groupKey: string;
        name: string;
        createdByName: string | null;
        createdAt: Date;
        threads: (ThreadRef & { name: string; channel: string })[];
      }
    >();
    for (const r of rows) {
      const g = groups.get(r.groupKey) ?? {
        groupKey: r.groupKey,
        name: '',
        createdByName: r.createdByName,
        createdAt: r.createdAt,
        threads: [],
      };
      const thread = {
        pagePid: r.pagePid,
        tid: r.tid,
        name: r.name,
        channel: channelName.get(r.pagePid) ?? r.pagePid,
      };
      if (keyOf(r) === r.groupKey) {
        g.threads.unshift(thread);
        g.name = r.name || g.name;
      } else g.threads.push(thread);
      g.name ||= r.name;
      groups.set(r.groupKey, g);
    }
    return [...groups.values()];
  }

  /** Tìm hội thoại theo tên (kho tin Smax) để thêm vào danh sách. */
  async searchThreads(q: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const ours = [...(await this.intel.ourPagePids())];
    const [threads, channels] = await Promise.all([
      this.prisma.smaxThread.findMany({
        where: {
          pagePid: { in: ours },
          name: { contains: term, mode: 'insensitive' },
        },
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        take: SEARCH_LIMIT,
        select: {
          pagePid: true,
          tid: true,
          name: true,
          isGroup: true,
          lastMessageAt: true,
        },
      }),
      this.prisma.smaxSyncChannel.findMany({
        select: { pagePid: true, name: true },
      }),
    ]);
    const excluded = await this.query.excludedKeys(threads);
    const channelName = new Map(channels.map((c) => [c.pagePid, c.name]));
    return threads.map((t) => ({
      ...t,
      channel: channelName.get(t.pagePid) ?? t.pagePid,
      excluded: excluded.has(keyOf(t)),
    }));
  }

  /** Loại trừ hội thoại (kèm các kênh cùng nhóm); tin đang chờ gửi AI của nhóm chuyển sang bỏ qua. */
  async add(ref: ThreadRef, actor: Actor) {
    const existing = await this.prisma.smaxIntelExclusion.findUnique({
      where: { pagePid_tid: ref },
    });
    if (existing)
      return { groupKey: existing.groupKey, threads: 0, skipped: 0 };
    const groupKey = keyOf(ref);
    const threads = await this.siblingThreads(ref);
    const names = await this.prisma.smaxThread.findMany({
      where: { OR: threads },
      select: { pagePid: true, tid: true, name: true },
    });
    const nameOf = new Map(names.map((t) => [keyOf(t), t.name]));
    await this.prisma.smaxIntelExclusion.createMany({
      data: threads.map((t) => ({
        groupKey,
        pagePid: t.pagePid,
        tid: t.tid,
        name: nameOf.get(keyOf(t)) ?? '',
        createdBy: actor.id,
        createdByName: actor.name || null,
      })),
      skipDuplicates: true,
    });
    const { count: skipped } = await this.prisma.smaxMessageIntel.updateMany({
      where: { status: { in: ['pending', 'retry'] }, OR: threads },
      data: {
        status: 'skipped',
        processingSource: 'rule',
        skipReason: 'excluded',
        claimToken: null,
        lockedUntil: null,
      },
    });
    const name = nameOf.get(groupKey) || ref.tid;
    await this.audit(
      actor,
      'MESSAGE_INTEL_EXCLUDE',
      `Loại trừ hội thoại "${name}" khỏi phân loại tin AI (${threads.length} kênh)`,
      { groupKey, threads, skipped },
    );
    return { groupKey, threads: threads.length, skipped };
  }

  /** Bỏ loại trừ cả nhóm; tin đã bỏ qua vì loại trừ được xét lại theo luật thường (gửi AI nếu cần). */
  async remove(
    input: { groupKey?: string } & Partial<ThreadRef>,
    actor: Actor,
  ) {
    let groupKey = input.groupKey;
    if (!groupKey && input.pagePid && input.tid)
      groupKey = (
        await this.prisma.smaxIntelExclusion.findUnique({
          where: { pagePid_tid: { pagePid: input.pagePid, tid: input.tid } },
          select: { groupKey: true },
        })
      )?.groupKey;
    if (!groupKey && !(input.pagePid && input.tid))
      throw new BadRequestException('Thiếu hội thoại cần bỏ loại trừ');
    const rows = groupKey
      ? await this.prisma.smaxIntelExclusion.findMany({ where: { groupKey } })
      : [];
    if (!rows.length)
      throw new NotFoundException(
        'Hội thoại không có trong danh sách loại trừ',
      );
    await this.prisma.smaxIntelExclusion.deleteMany({ where: { groupKey } });
    const threads = rows.map((r) => ({ pagePid: r.pagePid, tid: r.tid }));
    const requeued = await this.requeue(threads);
    const name = rows.find((r) => keyOf(r) === groupKey)?.name || rows[0].name;
    await this.audit(
      actor,
      'MESSAGE_INTEL_INCLUDE',
      `Bỏ loại trừ hội thoại "${name || groupKey}": phân loại tin AI trở lại`,
      { groupKey, threads, requeued },
    );
    return { groupKey, requeued };
  }

  /** Hội thoại cùng nhóm ở các kênh của mình: có chung msg_pid với các tin gần nhất (luôn gồm chính nó). */
  private async siblingThreads(ref: ThreadRef): Promise<ThreadRef[]> {
    const ours = [...(await this.intel.ourPagePids())];
    const rows = await this.prisma.$queryRaw<
      { page_pid: string; tid: string }[]
    >`
      SELECT DISTINCT m.page_pid, m.tid FROM smax_messages m
      WHERE m.page_pid = ANY(${ours}::text[]) AND m.msg_pid IN (
        SELECT s.msg_pid FROM smax_messages s
        WHERE s.page_pid = ${ref.pagePid} AND s.tid = ${ref.tid} AND s.type = 'message'
        ORDER BY s.id DESC LIMIT ${SIBLING_SAMPLE}
      )`;
    const out = new Map([[keyOf(ref), ref]]);
    for (const r of rows)
      out.set(`${r.page_pid}:${r.tid}`, { pagePid: r.page_pid, tid: r.tid });
    return [...out.values()];
  }

  /** Xoá job "excluded" của phiên bản đang chạy rồi tạo lại theo luật thường. */
  private async requeue(threads: ThreadRef[]) {
    const version = await this.intel.activeVersion();
    if (!version) return 0;
    const jobs = await this.prisma.smaxMessageIntel.findMany({
      where: { versionId: version.id, skipReason: 'excluded', OR: threads },
      select: { id: true, messageId: true },
    });
    let requeued = 0;
    for (let i = 0; i < jobs.length; i += REQUEUE_BATCH) {
      const lot = jobs.slice(i, i + REQUEUE_BATCH);
      await this.prisma.smaxMessageIntel.deleteMany({
        where: { id: { in: lot.map((j) => j.id) } },
      });
      const messages = await this.prisma.smaxMessage.findMany({
        where: { id: { in: lot.map((j) => j.messageId) } },
      });
      requeued += await this.discovery.createJobs(messages, version.id);
    }
    return requeued;
  }

  private audit(
    actor: Actor,
    actionCode: string,
    message: string,
    metadata?: object,
  ) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'smax_intel_exclusion',
      category: 'message_intel',
      message,
      userId: actor.id,
      userName: actor.name || 'Hệ thống',
      metadata,
    });
  }
}
