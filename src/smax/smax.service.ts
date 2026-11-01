import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmaxApiService } from './smax-api.service';

@Injectable()
export class SmaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
  ) {}

  /**
   * Mọi kênh của biz trên Smax (Zalo cá nhân, Zalo OA, Facebook, TikTok, Shopee,
   * Website…) kèm người dùng POS đã liên kết. Chat trên POS hiện chỉ dùng Zalo cá
   * nhân. Liên kết tới kênh không còn trên Smax vẫn trả về (missing) để gỡ.
   */
  async getZaloChannels() {
    const [pages, links] = await Promise.all([
      this.smaxApi.listPages(),
      this.prisma.smaxChannelUser.findMany({
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    // 1 kênh → nhiều người dùng POS
    const usersByPid = new Map<string, (typeof links)[number]['user'][]>();
    for (const l of links) usersByPid.set(l.pagePid, [...(usersByPid.get(l.pagePid) ?? []), l.user]);
    const channels = pages.map((p) => ({
      pagePid: p.pid,
      name: p.name,
      platform: p.platform,
      active: p.active,
      connectionError: p.connectionError,
      missing: false,
      users: usersByPid.get(p.pid) ?? [],
    }));
    const onSmax = new Set(pages.map((p) => p.pid));
    const missingAdded = new Set<string>();
    for (const l of links) {
      if (!onSmax.has(l.pagePid) && !missingAdded.has(l.pagePid)) {
        missingAdded.add(l.pagePid);
        channels.push({
          pagePid: l.pagePid,
          name: l.pageName,
          platform: l.platform,
          active: false,
          connectionError: null,
          missing: true,
          users: usersByPid.get(l.pagePid) ?? [],
        });
      }
    }
    return channels;
  }

  /**
   * Đồng bộ kênh từ Smax: cập nhật tên / platform đã lưu của các liên kết
   * (kênh đổi tên trên Smax), rồi trả danh sách kênh mới nhất.
   */
  async syncZaloChannels() {
    const [pages, links] = await Promise.all([
      this.smaxApi.listPages(),
      this.prisma.smaxChannelUser.findMany({
        select: { pagePid: true, pageName: true, platform: true },
      }),
    ]);
    const byPid = new Map(pages.map((p) => [p.pid, p]));
    const stale = new Map<string, { pageName: string; platform: string }>();
    for (const l of links) {
      const p = byPid.get(l.pagePid);
      if (p && (p.name !== l.pageName || p.platform !== l.platform)) {
        stale.set(l.pagePid, { pageName: p.name, platform: p.platform });
      }
    }
    for (const [pagePid, data] of stale) {
      await this.prisma.smaxChannelUser.updateMany({ where: { pagePid }, data });
    }
    return { channels: await this.getZaloChannels(), updated: stale.size };
  }

  async link(pagePid: string, userId: number) {
    const page = (await this.smaxApi.listPages()).find((p) => p.pid === pagePid);
    if (!page) {
      throw new BadRequestException('Kênh không tồn tại trên Smax');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Người dùng không tồn tại');

    // Thêm người dùng vào kênh (đã có thì chỉ cập nhật snapshot tên kênh)
    const data = { pageName: page.name, platform: page.platform };
    return this.prisma.smaxChannelUser.upsert({
      where: { pagePid_userId: { pagePid, userId } },
      create: { pagePid, userId, ...data },
      update: data,
    });
  }

  /** Gỡ 1 người dùng khỏi kênh; không truyền userId = gỡ hết (vd kênh đã mất trên Smax). */
  async unlink(pagePid: string, userId?: number) {
    const where = userId ? { pagePid, userId } : { pagePid };
    const { count } = await this.prisma.smaxChannelUser.deleteMany({ where });
    if (!count) throw new NotFoundException('Kênh chưa được liên kết với người dùng này');
    return { success: true, removed: count };
  }
}
