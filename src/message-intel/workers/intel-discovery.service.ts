import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageIntelService } from '../message-intel.service';
import { intelConfig } from '../message-intel.config';
import { type ArchiveRow, decide, groupByMsgPid } from '../rules/rule-engine';

/** Số dòng smax_messages mỗi lượt quét. */
export const SCAN_BATCH = 500;
/** Backfill: tối đa chừng này lô / phút. */
const BACKFILL_BATCHES_PER_TICK = 10;
/**
 * Chỉ xét tin cũ hơn chừng này: cùng 1 tin nhóm được các kênh khác lưu sau vài phút (đồng bộ nền 5 phút);
 * đợi để thấy dòng from_me của kênh đã gửi, tránh coi tin nhân viên là tin khách.
 */
export const SETTLE_MS = 10 * 60_000;
/** Tin mới vào kho nhưng tạo trước khi bật phiên bản quá chừng này (vd tải tin cũ) → để backfill xử lý. */
const OLD_MESSAGE_MS = 24 * 3_600_000;
const RECONCILE_DAYS = 3;
const RECONCILE_LIMIT = 5_000;

/**
 * Quét tin mới trong kho Smax → gộp theo msg_pid → luật → tạo job (`smax_message_intel`). Không gọi API.
 * Con trỏ theo id + đối soát đêm (tin commit lệch thứ tự id); backfill tin cũ khi quản trị bật.
 */
@Injectable()
export class IntelDiscoveryService {
  private readonly logger = new Logger(IntelDiscoveryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly intel: MessageIntelService,
  ) {}

  @Interval(60_000)
  async tick() {
    if (!intelConfig().enabled || this.running) return;
    this.running = true;
    try {
      const created = await this.discover();
      let backfilled = 0;
      for (let i = 0; i < BACKFILL_BATCHES_PER_TICK; i++) {
        const lot = await this.backfill();
        backfilled += lot.created;
        if (!lot.more) break;
      }
      if (created || backfilled)
        this.logger.log(
          `Phân loại tin: thêm ${created} job tin mới, ${backfilled} job tin cũ`,
        );
    } catch (error) {
      this.logger.error(`Quét tin phân loại lỗi: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Tin mới sau con trỏ, đã "lắng" SETTLE_MS. Trả số job tạo. */
  async discover(now = new Date()) {
    const version = await this.intel.activeVersion();
    if (!version) return 0;
    const runtime = await this.intel.runtime();
    const rows = await this.prisma.smaxMessage.findMany({
      where: { id: { gt: runtime.discoveryCursor } },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
    });
    // Dừng ở dòng đầu tiên chưa đủ "lắng" (giữ thứ tự id cho con trỏ)
    const settledUntil = now.getTime() - SETTLE_MS;
    const cut = rows.findIndex((r) => r.createdAt.getTime() > settledUntil);
    const ready = cut < 0 ? rows : rows.slice(0, cut);
    if (!ready.length) return 0;
    const activatedAt = (await this.intel.activatedAt()) ?? now;
    const fresh = ready.filter(
      (r) => r.createdAt.getTime() >= activatedAt.getTime() - OLD_MESSAGE_MS,
    );
    const created = await this.createJobs(fresh, version.id);
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: { discoveryCursor: ready[ready.length - 1].id },
    });
    return created;
  }

  /** Một lô backfill (khi đang chạy). Hết tin trong phạm vi → done. */
  async backfill(): Promise<{ created: number; more: boolean }> {
    const runtime = await this.intel.runtime();
    if (runtime.backfillStatus !== 'running')
      return { created: 0, more: false };
    const version = await this.intel.activeVersion();
    if (!version) return { created: 0, more: false };
    const rows = await this.prisma.smaxMessage.findMany({
      where: {
        id: { gt: runtime.backfillCursor, lte: runtime.backfillUntilId },
      },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
    });
    const pages = new Set(runtime.backfillPagePids);
    const inRange = rows.filter(
      (r) =>
        (!runtime.backfillFrom || r.createdAt >= runtime.backfillFrom) &&
        (!runtime.backfillTo || r.createdAt < runtime.backfillTo) &&
        (!pages.size || pages.has(r.pagePid)),
    );
    const created = await this.createJobs(inRange, version.id);
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: {
        backfillCursor: rows.length
          ? rows[rows.length - 1].id
          : runtime.backfillCursor,
        ...(rows.length < SCAN_BATCH ? { backfillStatus: 'done' } : {}),
      },
    });
    return { created, more: rows.length >= SCAN_BATCH };
  }

  /** 02:30 hằng đêm: tin 3 ngày gần đây (sau khi bật phiên bản) chưa có job → tạo bù. */
  @Cron('30 2 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async reconcile(now = new Date()) {
    if (!intelConfig().enabled) return 0;
    const version = await this.intel.activeVersion();
    const activatedAt = await this.intel.activatedAt();
    if (!version || !activatedAt) return 0;
    const runtime = await this.intel.runtime();
    const since = new Date(
      Math.max(
        now.getTime() - RECONCILE_DAYS * 86_400_000,
        activatedAt.getTime(),
      ),
    );
    const missing = await this.prisma.$queryRaw<{ id: bigint }[]>`
      SELECT m.id FROM smax_messages m
      WHERE m.created_at >= ${since} AND m.id <= ${runtime.discoveryCursor} AND m.type = 'message'
        AND NOT EXISTS (
          SELECT 1 FROM smax_message_intel i WHERE i.msg_pid = m.msg_pid AND i.version_id = ${version.id}
        )
      ORDER BY m.id LIMIT ${RECONCILE_LIMIT}`;
    if (!missing.length) return 0;
    const rows = await this.prisma.smaxMessage.findMany({
      where: { id: { in: missing.map((m) => m.id) } },
    });
    const created = await this.createJobs(rows, version.id);
    if (created)
      this.logger.warn(`Đối soát phân loại tin: tạo bù ${created} job`);
    return created;
  }

  /**
   * Tạo job cho các tin logic trong `rows`: nạp đủ mọi dòng cùng msg_pid ở các kênh (để luật nhân viên thấy
   * from_me của kênh đã gửi), áp luật, ghi `ON CONFLICT DO NOTHING` (tin đã có job bỏ qua).
   */
  async createJobs(rows: ArchiveRow[], versionId: number) {
    if (!rows.length) return 0;
    const ours = await this.intel.ourPagePids();
    const allow = new Set(intelConfig().pagePids);
    const msgPids = [
      ...new Set(rows.filter((r) => r.type !== 'system').map((r) => r.msgPid)),
    ];
    if (!msgPids.length) return 0;
    const siblings = await this.prisma.smaxMessage.findMany({
      // Kèm page_pid để dùng index unique (page_pid, msg_pid)
      where: {
        pagePid: { in: [...new Set([...ours, ...rows.map((r) => r.pagePid)])] },
        msgPid: { in: msgPids },
      },
    });
    const data: Prisma.SmaxMessageIntelCreateManyInput[] = [];
    for (const msg of groupByMsgPid(siblings)) {
      if (allow.size && !msg.rows.some((r) => allow.has(r.pagePid))) continue;
      const decision = decide(msg, ours);
      const base = {
        msgPid: msg.msgPid,
        versionId,
        messageId: msg.rep.id,
        pagePid: msg.rep.pagePid,
        tid: msg.rep.tid,
        messageAt: msg.rep.createdAt,
      };
      if (decision.status === 'pending')
        data.push({ ...base, status: 'pending' });
      else if (decision.status === 'skipped')
        data.push({
          ...base,
          status: 'skipped',
          processingSource: 'rule',
          skipReason: decision.skipReason,
        });
      else
        data.push({
          ...base,
          status: 'completed',
          processingSource: 'rule',
          ...decision.labels,
          classifiedAt: new Date(),
        });
    }
    if (!data.length) return 0;
    const { count } = await this.prisma.smaxMessageIntel.createMany({
      data,
      skipDuplicates: true,
    });
    return count;
  }
}
