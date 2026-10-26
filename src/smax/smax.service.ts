import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmaxApiService } from './smax-api.service';

const ZALO_PLATFORMS = ['zalo', 'zaloweb'];

@Injectable()
export class SmaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
  ) {}

  /**
   * Kênh Zalo trên Smax (Zalo OA + Zalo cá nhân) kèm người dùng POS đã liên
   * kết. Liên kết tới kênh không còn trên Smax vẫn trả về (missing) để gỡ.
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
    const zaloPages = pages.filter((p) => ZALO_PLATFORMS.includes(p.platform));

    const channels = zaloPages.map((p) => ({
      pagePid: p.pid,
      name: p.name,
      platform: p.platform,
      active: p.active,
      connectionError: p.connectionError,
      missing: false,
      users: usersByPid.get(p.pid) ?? [],
    }));
    const onSmax = new Set(zaloPages.map((p) => p.pid));
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

  async link(pagePid: string, userId: number) {
    const page = (await this.smaxApi.listPages()).find(
      (p) => p.pid === pagePid && ZALO_PLATFORMS.includes(p.platform),
    );
    if (!page) {
      throw new BadRequestException('Kênh Zalo không tồn tại trên Smax');
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
