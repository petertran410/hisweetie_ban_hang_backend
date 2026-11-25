import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SmaxRecentThread } from './smax-api.service';
import type { ChatMessage } from './smax-chat.service';

/** Tin giữ trong DB bao lâu. */
export const ARCHIVE_DAYS = 30;
const DAY_MS = 86_400_000;
/** Đồng bộ nền chạy 5 phút/lần → DB "đủ" nếu đã quét tới cách đây tối đa 10 phút. */
const COVER_LAG_MS = 10 * 60_000;

/** Bật lưu tin Smax (cả lưu khi POS tải tin lẫn đồng bộ nền). Tạo bảng trước khi bật. */
export const archiveEnabled = () => process.env.SMAX_ARCHIVE_ENABLED === 'true';

type ThreadInfo = {
  platform?: string;
  name?: string;
  isGroup?: boolean;
  lastMessage?: string;
  lastMessageAt?: Date | null;
  lastCustomerAt?: Date | null;
};

/**
 * Kho tin nhắn Smax trên Postgres (30 ngày). Ghi: tin POS vừa tải (khung chat) và đồng bộ nền
 * (SmaxArchiveSyncService). Đọc: Trợ lý AI, báo cáo chat cuối ngày — chỉ khi `covered`.
 */
@Injectable()
export class SmaxArchiveService {
  private readonly logger = new Logger(SmaxArchiveService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lưu tin đã chuẩn hoá (bỏ tin cũ hơn 30 ngày, tin trùng bỏ qua) + cập nhật hội thoại. */
  async save(
    pagePid: string,
    tid: string,
    messages: ChatMessage[],
    thread: ThreadInfo = {},
  ) {
    const cutoff = Date.now() - ARCHIVE_DAYS * DAY_MS;
    const keep = messages.filter(
      (m) => new Date(m.createdAt).getTime() >= cutoff,
    );
    if (keep.length) {
      await this.prisma.smaxMessage.createMany({
        data: keep.map((m) => ({
          pagePid,
          tid,
          msgPid: m.id,
          senderPid: m.senderPid,
          senderName: m.senderName,
          fromMe: m.fromMe,
          type: m.type,
          text: m.text,
          attachments: m.attachments.length ? m.attachments : Prisma.DbNull,
          quote: m.quote ?? Prisma.DbNull,
          sticker: m.stickerId ?? m.stickerImage,
          recalled: m.recalled,
          createdAt: new Date(m.createdAt),
        })),
        skipDuplicates: true,
      });
      // Tin đổi sang "đã thu hồi" sau khi lưu (chỉ khung chat Zalo cá nhân biết)
      const recalled = keep.filter((m) => m.recalled).map((m) => m.id);
      if (recalled.length)
        await this.prisma.smaxMessage.updateMany({
          where: { pagePid, msgPid: { in: recalled }, recalled: false },
          data: { recalled: true },
        });
    }
    const last = keep.filter((m) => m.type !== 'system').at(-1);
    const lastAt =
      thread.lastMessageAt ?? (last ? new Date(last.createdAt) : null);
    if (!lastAt && !thread.name) return;
    await this.upsertThread(pagePid, tid, {
      ...thread,
      lastMessageAt: lastAt,
      lastMessage:
        thread.lastMessage ?? (last ? last.text || '[tệp/ảnh]' : undefined),
    });
  }

  /** Lưu khi POS tải tin: không chờ, lỗi chỉ ghi log (không ảnh hưởng khung chat). */
  saveQuietly(
    pagePid: string,
    tid: string,
    messages: ChatMessage[],
    thread: ThreadInfo = {},
  ) {
    if (!archiveEnabled()) return;
    this.save(pagePid, tid, messages, thread).catch((error: unknown) =>
      this.logger.warn(
        `Không lưu được tin ${pagePid}:${tid}: ${String(error)}`,
      ),
    );
  }

  /** Tạo / cập nhật hội thoại; tin cuối chỉ tiến lên (khung chat tải tin cũ không kéo lùi). */
  async upsertThread(
    pagePid: string,
    tid: string,
    info: ThreadInfo & { syncedThrough?: Date | null },
  ) {
    const existing = await this.prisma.smaxThread.findUnique({
      where: { pagePid_tid: { pagePid, tid } },
      select: { lastMessageAt: true },
    });
    const newer =
      !!info.lastMessageAt &&
      (!existing?.lastMessageAt || info.lastMessageAt > existing.lastMessageAt);
    const data = {
      ...(info.platform ? { platform: info.platform } : {}),
      ...(info.name ? { name: info.name } : {}),
      ...(info.isGroup !== undefined ? { isGroup: info.isGroup } : {}),
      ...(newer
        ? {
            lastMessageAt: info.lastMessageAt,
            ...(info.lastMessage !== undefined
              ? { lastMessage: info.lastMessage }
              : {}),
            ...(info.lastCustomerAt
              ? { lastCustomerAt: info.lastCustomerAt }
              : {}),
          }
        : {}),
      ...(info.syncedThrough !== undefined
        ? { syncedThrough: info.syncedThrough }
        : {}),
    };
    await this.prisma.smaxThread.upsert({
      where: { pagePid_tid: { pagePid, tid } },
      create: {
        pagePid,
        tid,
        ...data,
        lastMessageAt: info.lastMessageAt ?? null,
      },
      update: data,
    });
  }

  /**
   * DB có đủ tin của kênh trong khoảng [from, to] không: lưu từ trước `from` và đồng bộ nền
   * đã quét tới gần `to`. Không đủ → nơi gọi đọc Smax như cũ.
   */
  async covered(
    pagePid: string,
    fromMs: number,
    toMs: number,
  ): Promise<boolean> {
    if (!archiveEnabled()) return false;
    const row = await this.prisma.smaxSyncChannel
      .findUnique({
        where: { pagePid },
        select: { syncedUntil: true, backfillFrom: true },
      })
      .catch(() => null);
    if (!row) return false;
    const need = Math.min(toMs, Date.now()) - COVER_LAG_MS;
    return (
      row.backfillFrom.getTime() <= fromMs && row.syncedUntil.getTime() >= need
    );
  }

  /** Hội thoại có tin trong khoảng, mới nhất trước — dạng như danh sách Smax (không giới hạn số). */
  async threadsInRange(
    pagePid: string,
    fromMs: number,
    toMs: number,
  ): Promise<SmaxRecentThread[]> {
    const active = await this.prisma.smaxMessage.groupBy({
      by: ['tid'],
      where: {
        pagePid,
        createdAt: { gte: new Date(fromMs), lte: new Date(toMs) },
        type: { not: 'system' },
      },
    });
    if (!active.length) return [];
    const rows = await this.prisma.smaxThread.findMany({
      where: { pagePid, tid: { in: active.map((a) => a.tid) } },
      orderBy: { lastMessageAt: 'desc' },
    });
    return rows.map((t) => ({
      tid: t.tid,
      pagePid: t.pagePid,
      platform: t.platform,
      isComment: false,
      controlledBy: null,
      name: t.name,
      canReply: true,
      phones: [],
      isGroup: t.isGroup,
      lastMessage: t.lastMessage,
      lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
      lastCustomerAt: t.lastCustomerAt?.toISOString() ?? null,
      unread: false,
      messageCount: 0,
      avatar: null,
      memberPreview: [],
    }));
  }

  /** Tin của một hội thoại trong khoảng, cũ → mới, cùng dạng tin khung chat. */
  async messagesInRange(
    pagePid: string,
    tid: string,
    fromMs: number,
    toMs: number,
  ) {
    const [thread, rows] = await Promise.all([
      this.prisma.smaxThread.findUnique({
        where: { pagePid_tid: { pagePid, tid } },
        select: { name: true },
      }),
      this.prisma.smaxMessage.findMany({
        where: {
          pagePid,
          tid,
          createdAt: { gte: new Date(fromMs), lte: new Date(toMs) },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const messages: ChatMessage[] = rows.map((m) => ({
      id: m.msgPid,
      text: m.text,
      type: m.type,
      fromMe: m.fromMe,
      senderPid: m.senderPid,
      senderName: m.senderName,
      attachments: (m.attachments as ChatMessage['attachments'] | null) ?? [],
      albumId: null,
      stickerId: m.sticker && !/^https?:/.test(m.sticker) ? m.sticker : null,
      stickerImage: m.sticker && /^https?:/.test(m.sticker) ? m.sticker : null,
      quote: (m.quote as ChatMessage['quote']) ?? null,
      reactions: [],
      recalled: m.recalled,
      createdAt: m.createdAt.toISOString(),
    }));
    return { name: thread?.name ?? null, messages };
  }

  /** 3:00 sáng xoá tin / hội thoại cũ hơn 30 ngày. */
  @Cron('0 3 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async purge() {
    if (!archiveEnabled()) return;
    const cutoff = new Date(Date.now() - ARCHIVE_DAYS * DAY_MS);
    try {
      const [messages, threads] = await Promise.all([
        this.prisma.smaxMessage.deleteMany({
          where: { createdAt: { lt: cutoff } },
        }),
        this.prisma.smaxThread.deleteMany({
          where: { lastMessageAt: { lt: cutoff } },
        }),
      ]);
      // Kênh lưu từ trước 30 ngày: DB chỉ còn đủ từ mốc dọn
      await this.prisma.smaxSyncChannel.updateMany({
        where: { backfillFrom: { lt: cutoff } },
        data: { backfillFrom: cutoff },
      });
      this.logger.log(
        `Dọn tin Smax > ${ARCHIVE_DAYS} ngày: ${messages.count} tin, ${threads.count} hội thoại`,
      );
    } catch (error) {
      this.logger.error(`Dọn tin Smax lỗi: ${String(error)}`);
    }
  }
}
