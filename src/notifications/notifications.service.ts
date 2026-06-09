import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateNotificationInput {
  type: string;
  title: string;
  body?: string | null;
  data?: Prisma.InputJsonValue;
  link?: string | null;
  /** Khóa chống trùng trong cùng (userId, type). */
  dedupeKey?: string | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Tạo cùng một thông báo cho nhiều user (fan-out).
   * Idempotent theo unique [userId, type, dedupeKey] → Sepay retry webhook
   * không tạo thông báo lặp. Trả số bản ghi thực sự tạo mới.
   */
  async createForUsers(
    userIds: number[],
    input: CreateNotificationInput,
  ): Promise<number> {
    const uniqueIds = [...new Set(userIds)].filter((id) => Number.isInteger(id));
    if (uniqueIds.length === 0) return 0;

    const rows = uniqueIds.map((userId) => ({
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? Prisma.JsonNull,
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
    }));

    const res = await this.prisma.notification.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return res.count;
  }

  /**
   * Danh sách thông báo của 1 user, phân trang cursor-based theo id giảm dần.
   * Trả kèm unreadCount để FE cập nhật badge cùng lúc.
   */
  async listForUser(
    userId: number,
    opts: { cursor?: number; limit?: number },
  ) {
    const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    const unreadCount = await this.countUnread(userId);

    return { data, nextCursor, unreadCount };
  }

  countUnread(userId: number): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, readAt: null },
    });
  }

  /** Đánh dấu 1 thông báo đã đọc (chỉ của chính user). */
  async markRead(userId: number, id: number): Promise<{ success: boolean }> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true };
  }

  /** Đánh dấu toàn bộ thông báo chưa đọc của user là đã đọc. */
  async markAllRead(userId: number): Promise<{ success: boolean; count: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true, count: res.count };
  }
}
