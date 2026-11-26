import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  SmaxApiService,
  type SmaxPage,
  type SmaxRecentThread,
} from './smax-api.service';
import { SmaxChatService } from './smax-chat.service';
import { SmaxArchiveService, archiveEnabled } from './smax-archive.service';

const DAY_MS = 86_400_000;
/** Quét lại chồng 5 phút so với lượt trước (tin tới trễ / đồng hồ lệch). */
const OVERLAP_MS = 5 * 60_000;
/** Smax không phân trang danh sách hội thoại → đủ số này thì chia đôi khoảng thời gian. */
export const LIST_LIMIT = 500;
/** Trần đọc lùi mỗi hội thoại mỗi lượt (20 tin/trang): 1.000 tin. */
export const MAX_PAGES = 50;
const CONCURRENCY = 3;
/** Kênh lấy bù 2 ngày khi bật (user chốt): Zalo Ms Mai Phương, Facebook LerMao - Sành Ăn Như Gấu. */
const DEFAULT_BACKFILL_PAGES = 'zlw114085522560807078,fb365228306663549';
const BACKFILL_MS = 2 * DAY_MS;

async function pool<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

/**
 * Đồng bộ nền tin Smax về DB, 5 phút/lần (SMAX_ARCHIVE_ENABLED=true). Smax không có webhook:
 * mỗi kênh lấy hội thoại có tin cuối từ lượt trước tới giờ, đọc lùi tin của từng hội thoại tới
 * mốc đã lưu đủ (`synced_through`). Khung chat POS cũng lưu tin nó tải (SmaxChatService).
 */
@Injectable()
export class SmaxArchiveSyncService {
  private readonly logger = new Logger(SmaxArchiveSyncService.name);
  private running = false;
  private readonly backfillPages = new Set(
    (process.env.SMAX_ARCHIVE_BACKFILL_PAGES ?? DEFAULT_BACKFILL_PAGES)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
    private readonly smaxChat: SmaxChatService,
    private readonly archive: SmaxArchiveService,
  ) {}

  @Interval(5 * 60_000)
  async tick() {
    if (!archiveEnabled() || this.running) return;
    this.running = true;
    const started = Date.now();
    try {
      const pages = (await this.smaxApi.listPages()).filter(
        (p) => p.active && !p.connectionError,
      );
      let threads = 0;
      let failed = 0;
      for (const page of pages) {
        const result = await this.syncChannel(page);
        threads += result.threads;
        if (result.error) failed++;
      }
      this.logger.log(
        `Đồng bộ tin Smax: ${pages.length} kênh, ${threads} hội thoại có tin mới` +
          `${failed ? `, ${failed} kênh lỗi` : ''} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    } catch (error) {
      this.logger.error(`Đồng bộ tin Smax lỗi: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async syncChannel(page: SmaxPage, now = new Date()) {
    let row = await this.prisma.smaxSyncChannel.findUnique({
      where: { pagePid: page.pid },
    });
    if (!row) {
      // Kênh mới: lấy bù 2 ngày nếu được chọn, còn lại lưu từ lúc bật
      const from = new Date(
        now.getTime() - (this.backfillPages.has(page.pid) ? BACKFILL_MS : 0),
      );
      row = await this.prisma.smaxSyncChannel.create({
        data: {
          pagePid: page.pid,
          platform: page.platform,
          name: page.name,
          syncedUntil: from,
          backfillFrom: from,
        },
      });
    }
    // Kho lưu vĩnh viễn: backend tắt lâu thì lượt sau quét bù cả khoảng đã lỡ (tới mốc bắt đầu
    // lưu), để `covered` không báo "đủ" cho khoảng DB chưa có tin.
    const floor = row.backfillFrom.getTime();
    const from = new Date(
      Math.max(row.syncedUntil.getTime() - OVERLAP_MS, floor),
    );
    try {
      const threads = await this.listWindow(page.pid, from, now);
      const errors: string[] = [];
      await pool(threads, async (t) => {
        await this.syncThread(page, t, floor).catch((error: unknown) =>
          errors.push(`${t.tid}: ${String(error)}`),
        );
      });
      if (errors.length)
        throw new Error(`${errors.length} hội thoại lỗi, vd ${errors[0]}`);
      await this.prisma.smaxSyncChannel.update({
        where: { pagePid: page.pid },
        data: { syncedUntil: now, lastError: null, name: page.name },
      });
      return { threads: threads.length, error: null };
    } catch (error) {
      const message = String(error).slice(0, 500);
      this.logger.warn(`Đồng bộ tin kênh ${page.name}: ${message}`);
      await this.prisma.smaxSyncChannel.update({
        where: { pagePid: page.pid },
        data: { lastError: message },
      });
      return { threads: 0, error: message };
    }
  }

  /** Hội thoại có tin cuối trong [from, to]; đủ LIST_LIMIT thì chia đôi khoảng để không sót. */
  async listWindow(
    pagePid: string,
    from: Date,
    to: Date,
  ): Promise<SmaxRecentThread[]> {
    const list = await this.smaxApi.listRecentThreads(
      [pagePid],
      LIST_LIMIT,
      undefined,
      { from, to },
    );
    if (list.length >= LIST_LIMIT && to.getTime() - from.getTime() > 60_000) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      const [older, newer] = await Promise.all([
        this.listWindow(pagePid, from, mid),
        this.listWindow(pagePid, mid, to),
      ]);
      return [...new Map([...older, ...newer].map((t) => [t.tid, t])).values()];
    }
    // Phòng API dự phòng bỏ qua dateRange: chỉ giữ hội thoại có tin cuối trong khoảng
    return list.filter(
      (t) =>
        t.lastMessageAt &&
        new Date(t.lastMessageAt).getTime() >= from.getTime(),
    );
  }

  /** Đọc lùi tin mới của một hội thoại tới mốc đã lưu đủ rồi lưu. */
  async syncThread(page: SmaxPage, t: SmaxRecentThread, floorMs: number) {
    const lastAt = t.lastMessageAt ? new Date(t.lastMessageAt) : null;
    if (!lastAt) return;
    const stored = await this.prisma.smaxThread.findUnique({
      where: { pagePid_tid: { pagePid: page.pid, tid: t.tid } },
      select: { syncedThrough: true },
    });
    if (stored?.syncedThrough && stored.syncedThrough >= lastAt) return;
    const stopAt = Math.max(stored?.syncedThrough?.getTime() ?? 0, floorMs);
    // Tên người gửi trong nhóm lấy từ thông tin thread
    const members = t.isGroup
      ? ((await this.smaxApi.getThread(page.pid, t.tid).catch(() => null))
          ?.members ?? {})
      : {};
    let before: string | undefined;
    let pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const raw = await this.smaxApi.getMessages(page.pid, t.tid, before);
      if (!raw.length) break;
      const messages = this.smaxChat
        .normalize(raw, page.pid, members)
        .filter((m) => new Date(m.createdAt).getTime() >= stopAt);
      await this.archive.save(page.pid, t.tid, messages);
      const oldest = raw.map((m) => m.created_at).sort()[0];
      if (raw.length < 20 || !oldest || new Date(oldest).getTime() < stopAt)
        break;
      before = oldest;
    }
    if (pages >= MAX_PAGES)
      this.logger.warn(
        `Hội thoại ${page.pid}:${t.tid} quá ${MAX_PAGES * 20} tin/lượt, bỏ phần cũ hơn`,
      );
    await this.archive.upsertThread(page.pid, t.tid, {
      platform: t.platform,
      name: t.name,
      isGroup: t.isGroup,
      lastMessage: t.lastMessage,
      lastMessageAt: lastAt,
      lastCustomerAt: t.lastCustomerAt ? new Date(t.lastCustomerAt) : null,
      syncedThrough: lastAt,
    });
  }
}
