import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SmaxApiService, type SmaxTokenKind } from './smax-api.service';
import { decryptSmaxToken, encryptSmaxToken, jwtExpiry } from './smax-secret.util';

// Dòng trong bảng smax_user_tokens theo loại token
const TOKEN_ROW_ID: Record<SmaxTokenKind, number> = { user: 1, api: 2 };
const TOKEN_KINDS: SmaxTokenKind[] = ['user', 'api'];
const TOKEN_LABEL: Record<SmaxTokenKind, string> = {
  user: 'token đăng nhập Smax (SMAX_USER_TOKEN)',
  api: 'Partner API token Smax (SMAX_API_TOKEN)',
};

@Injectable()
export class SmaxService implements OnModuleInit {
  private readonly logger = new Logger(SmaxService.name);
  // Có dòng token trên POS nhưng không giải mã được (đổi khoá mã hoá) → báo nhập lại
  private readonly tokenUnreadable: Record<SmaxTokenKind, boolean> = { user: false, api: false };

  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async onModuleInit() {
    try {
      await this.loadTokens();
    } catch (e) {
      // Bảng chưa tạo (chưa db push) → dùng .env như cũ
      this.logger.warn(`Không đọc được token Smax lưu trên POS: ${(e as Error).message}`);
    }
  }

  /** Nạp token Smax lưu trên POS (ưu tiên hơn .env); trả dòng DB theo loại. */
  private async loadTokens() {
    const rows = await this.prisma.smaxUserToken.findMany({
      where: { id: { in: Object.values(TOKEN_ROW_ID) } },
    });
    const byKind = {} as Record<SmaxTokenKind, (typeof rows)[number] | undefined>;
    for (const kind of TOKEN_KINDS) {
      const row = rows.find((r) => r.id === TOKEN_ROW_ID[kind]);
      const plain = row ? decryptSmaxToken(row.token) : null;
      this.tokenUnreadable[kind] = !!row && !plain;
      this.smaxApi.useStoredToken(kind, plain);
      byKind[kind] = row;
    }
    return byKind;
  }

  /**
   * Tình trạng token Smax cho trang /cai-dat/smax: nguồn, vài ký tự cuối, hạn (JWT), còn dùng được
   * không (thử API chỉ đọc), cảnh báo (vd không ra hội thoại). Không bao giờ trả nguyên token.
   */
  async tokenStatus(kind: SmaxTokenKind) {
    // Đọc lại DB: backend chạy nhiều tiến trình thì tiến trình này cũng thấy token mới
    const row = (await this.loadTokens())[kind];
    const token = this.smaxApi.activeToken(kind);
    const check = token ? await this.smaxApi.checkToken(kind, token) : null;
    const updatedBy = row?.updatedById
      ? await this.prisma.user.findUnique({ where: { id: row.updatedById }, select: { name: true } })
      : null;
    return {
      source: this.smaxApi.tokenSources[kind],
      envConfigured: this.smaxApi.hasEnvToken(kind),
      last4: token ? token.slice(-4) : null,
      expiresAt: token ? jwtExpiry(token) : null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: updatedBy?.name ?? null,
      valid: check ? check.ok : null,
      error: this.tokenUnreadable[kind]
        ? 'Token đã lưu không giải mã được (khoá mã hoá đã đổi) — nhập lại token'
        : (check?.message ?? null),
      warning: check?.warning ?? null,
    };
  }

  /** Lưu token mới (kiểm tra với Smax trước, Smax từ chối thì không lưu); dùng ngay, không cần khởi động lại. */
  async setToken(kind: SmaxTokenKind, raw: string, actor: { id: number; name?: string }) {
    const token = raw.trim().replace(/^Bearer\s+/i, '');
    if (!token) throw new BadRequestException('Nhập token');
    const check = await this.smaxApi.checkToken(kind, token);
    if (!check.ok) throw new BadRequestException(check.message);
    const id = TOKEN_ROW_ID[kind];
    const data = { token: encryptSmaxToken(token), updatedById: actor.id };
    await this.prisma.smaxUserToken.upsert({ where: { id }, create: { id, ...data }, update: data });
    this.tokenUnreadable[kind] = false;
    this.smaxApi.useStoredToken(kind, token);
    await this.auditLogs.create({
      actionType: 'PUT',
      actionCode: kind === 'user' ? 'SMAX_USER_TOKEN_UPDATE' : 'SMAX_API_TOKEN_UPDATE',
      entityType: 'smax_user_tokens',
      entityId: String(id),
      message: `Cập nhật ${TOKEN_LABEL[kind]}`,
      userId: actor.id,
      userName: actor.name || 'Người dùng',
      // Không ghi token; chỉ hạn (nếu là JWT) để tra cứu
      metadata: { expiresAt: jwtExpiry(token) },
    });
    return this.tokenStatus(kind);
  }

  /** Xoá token lưu trên POS → quay về token trong .env (nếu có). */
  async clearToken(kind: SmaxTokenKind, actor: { id: number; name?: string }) {
    const id = TOKEN_ROW_ID[kind];
    await this.prisma.smaxUserToken.deleteMany({ where: { id } });
    this.tokenUnreadable[kind] = false;
    this.smaxApi.useStoredToken(kind, null);
    await this.auditLogs.create({
      actionType: 'DELETE',
      actionCode: kind === 'user' ? 'SMAX_USER_TOKEN_CLEAR' : 'SMAX_API_TOKEN_CLEAR',
      entityType: 'smax_user_tokens',
      entityId: String(id),
      message: `Xoá ${TOKEN_LABEL[kind]} lưu trên POS (dùng lại token trong .env)`,
      userId: actor.id,
      userName: actor.name || 'Người dùng',
    });
    return this.tokenStatus(kind);
  }

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
