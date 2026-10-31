import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SESSION_CREATED,
  SESSION_REVOKED,
  SessionCreatedEvent,
  SessionRevokedEvent,
  sessionEvents,
} from './session-events';
import { sessionConfig } from './session.config';
import { describeUserAgent } from './user-agent.util';

export type RevokeReason =
  | 'logout'
  | 'replaced'
  | 'remote_logout'
  | 'reuse'
  | 'permission'
  | 'password'
  | 'disabled'
  | 'expired';

/** Mã lỗi trả cho FE để hiển thị thông báo phù hợp. */
export type SessionErrorCode =
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'PERMISSION_CHANGED'
  | 'ACCOUNT_DISABLED';

export interface SessionContext {
  userAgent?: string;
  ip?: string;
  /** Refresh token phiên cũ mà trình duyệt đang giữ (đăng nhập lại → thay thế). */
  replaceToken?: string;
  /** Mã trình duyệt (cookie `hs_did`): 1 user + 1 trình duyệt = 1 dòng. */
  deviceId?: string;
}

export interface IssuedRefresh {
  sessionId: number;
  token: string;
  expiresAt: Date;
}

export interface RotateResult {
  userId: number;
  permissionVersion: number;
  sessionId: number;
  /** Không có khi rơi vào ân hạn nhiều tab (cookie hiện tại đã là token mới). */
  refresh?: IssuedRefresh;
}

export interface RotateOptions {
  /**
   * Chỉ dùng cho app di động: app gửi lại token LIỀN TRƯỚC trong ân hạn vì
   * phản hồi lần làm mới trước bị mất (mạng chập chờn) → cấp token mới thay vì
   * không cấp gì (app không có cookie giữ sẵn token mới như trình duyệt).
   * Chỉ khi mã thiết bị khớp dòng phiên; không kéo dài cửa sổ ân hạn.
   */
  reissueOnGrace?: boolean;
}

export interface ActiveSession {
  id: number;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

const sessionError = (code: SessionErrorCode, message: string) =>
  new UnauthorizedException({ statusCode: 401, code, message });

/** Cache ngắn trạng thái sid để JwtStrategy không phải query DB mỗi request. */
const SID_CACHE_TTL_MS = 30_000;
const CLEANUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mỗi trình duyệt/thiết bị đăng nhập = 1 dòng `auth_sessions`.
 * Refresh token được xoay vòng NGAY TRÊN DÒNG đó (không tạo dòng mới);
 * `previousTokenHash` giữ token liền trước để cho phép nhiều tab gọi cùng lúc
 * (ân hạn 30s) và phát hiện token cũ bị dùng lại (nghi đánh cắp).
 */
@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);
  private readonly sidCache = new Map<number, { ok: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Thiết kế cũ tạo 1 dòng cho mỗi lần làm mới ('rotated') và giữ dòng bị thay
   * khi đăng nhập lại ('replaced'). Xóa các dòng đó khi khởi động — dòng đang
   * hoạt động vẫn dùng tiếp được.
   */
  async onModuleInit() {
    try {
      const { count } = await this.prisma.authSession.deleteMany({
        where: { revokeReason: { in: ['rotated', 'replaced'] } },
      });
      if (count)
        this.logger.log(`Removed ${count} legacy rotated/replaced sessions`);
    } catch (error) {
      this.logger.warn(
        `Legacy session cleanup skipped: ${(error as Error)?.message}`,
      );
    }
  }

  /**
   * Tạo phiên mới (đăng nhập). Xoá trước các dòng cũ của chính trình duyệt này:
   * - dòng của refresh token trình duyệt đang giữ (`ctx.replaceToken`, có thể
   *   là của user khác trên máy dùng chung — cookie sắp bị ghi đè nên phiên đó
   *   không còn dùng được nữa);
   * - dòng cùng user + cùng mã trình duyệt (`ctx.deviceId`) — kể cả khi cookie
   *   refresh đã mất (đăng xuất, bị buộc đăng nhập lại, đăng nhập Lark).
   * Dòng mới có id mới → access token gắn `sid` cũ không dùng lại được.
   */
  async createSession(
    userId: number,
    permissionVersion: number,
    ctx: SessionContext = {},
  ): Promise<IssuedRefresh> {
    try {
      return await this.insertReplacingDevice(userId, permissionVersion, ctx);
    } catch (error) {
      // 2 tab cùng đăng nhập 1 lúc → đụng unique (userId, deviceId): thử lại
      // 1 lần, lần này sẽ thấy và xoá dòng tab kia vừa tạo.
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      return this.insertReplacingDevice(userId, permissionVersion, ctx);
    }
  }

  private async insertReplacingDevice(
    userId: number,
    permissionVersion: number,
    ctx: SessionContext,
  ): Promise<IssuedRefresh> {
    const now = Date.now();
    const token = newToken();
    const absoluteExpiresAt = new Date(now + sessionConfig.refreshAbsoluteMs);
    const expiresAt = new Date(
      Math.min(now + sessionConfig.refreshIdleMs, absoluteExpiresAt.getTime()),
    );
    const deviceId = ctx.deviceId || null;

    const stale: Record<string, unknown>[] = [];
    const replacedHash = ctx.replaceToken ? hash(ctx.replaceToken) : undefined;
    if (replacedHash) {
      stale.push(
        { tokenHash: replacedHash },
        { previousTokenHash: replacedHash },
      );
    }
    if (deviceId) stale.push({ userId, deviceId });

    const newDevice = await this.isNewDevice(userId, ctx, replacedHash);

    const { created, removed } = await this.prisma.$transaction(async (tx) => {
      const { count } = stale.length
        ? await tx.authSession.deleteMany({ where: { OR: stale } })
        : { count: 0 };
      const row = await tx.authSession.create({
        data: {
          userId,
          familyId: randomUUID(),
          tokenHash: hash(token),
          permissionVersion,
          expiresAt,
          absoluteExpiresAt,
          userAgent: ctx.userAgent?.slice(0, 500),
          ip: ctx.ip?.slice(0, 100),
          deviceId,
        },
        select: { id: true },
      });
      return { created: row, removed: count };
    });
    if (removed) this.sidCache.clear();
    sessionEvents.emit(SESSION_CREATED, {
      userId,
      sessionId: created.id,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      newDevice,
    } satisfies SessionCreatedEvent);
    return { sessionId: created.id, token, expiresAt };
  }

  /**
   * Trình duyệt này lạ với user? Quen nếu: đang giữ phiên cũ của user, có dòng
   * cùng mã trình duyệt, hoặc (dòng cũ trước khi có `hs_did`) cùng loại
   * trình duyệt + hệ điều hành + thiết bị. User chưa từng có phiên → không báo.
   */
  private async isNewDevice(
    userId: number,
    ctx: SessionContext,
    replacedHash?: string,
  ): Promise<boolean> {
    try {
      const prior = await this.prisma.authSession.findMany({
        where: { userId },
        select: {
          deviceId: true,
          userAgent: true,
          tokenHash: true,
          previousTokenHash: true,
        },
      });
      if (prior.length === 0) return false;
      const fingerprint = (ua?: string | null) => {
        const d = describeUserAgent(ua);
        return `${d.browser}|${d.os}|${d.deviceType}`;
      };
      const current = fingerprint(ctx.userAgent);
      const known = prior.some(
        (row) =>
          (replacedHash &&
            (row.tokenHash === replacedHash ||
              row.previousTokenHash === replacedHash)) ||
          (ctx.deviceId && row.deviceId === ctx.deviceId) ||
          (!row.deviceId && fingerprint(row.userAgent) === current),
      );
      return !known;
    } catch (error) {
      this.logger.warn(
        `New-device check skipped: ${(error as Error)?.message}`,
      );
      return false;
    }
  }

  /**
   * Đổi refresh token cũ lấy token mới — cập nhật ngay trên dòng của phiên.
   * Ném 401 kèm `code` khi không hợp lệ.
   */
  async rotate(
    raw: string,
    ctx: SessionContext = {},
    opts: RotateOptions = {},
  ): Promise<RotateResult> {
    if (!raw) throw sessionError('SESSION_INVALID', 'Phiên không hợp lệ');
    const presented = hash(raw);
    let unboundDevice = false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE token_hash = ${presented} OR previous_token_hash = ${presented} FOR UPDATE`;
      const session = await tx.authSession.findFirst({
        where: {
          OR: [{ tokenHash: presented }, { previousTokenHash: presented }],
        },
      });
      if (!session) {
        return { error: sessionError('SESSION_INVALID', 'Phiên không hợp lệ') };
      }
      unboundDevice = !session.deviceId;
      if (session.revokedAt) {
        return { error: this.errorForReason(session.revokeReason) };
      }

      const now = new Date();
      const user = await tx.user.findUnique({
        where: { id: session.userId },
        select: { id: true, isActive: true, permissionVersion: true },
      });

      const revoke = async (reason: RevokeReason) => {
        await tx.authSession.update({
          where: { id: session.id },
          data: { revokedAt: now, revokeReason: reason },
        });
        return {
          error: this.errorForReason(reason),
          revoked: { sessionId: session.id, reason },
        };
      };

      if (now > session.expiresAt || now > session.absoluteExpiresAt) {
        return revoke('expired');
      }
      if (!user || !user.isActive) return revoke('disabled');
      if (user.permissionVersion !== session.permissionVersion) {
        return revoke('permission');
      }

      /** Ghi token mới lên dòng phiên; `extra` = cột xoay vòng (nếu có). */
      const issue = async (
        extra: Record<string, unknown>,
      ): Promise<{ ok: RotateResult; error?: undefined }> => {
        const token = newToken();
        const expiresAt = new Date(
          Math.min(
            now.getTime() + sessionConfig.refreshIdleMs,
            session.absoluteExpiresAt.getTime(),
          ),
        );
        await tx.authSession.update({
          where: { id: session.id },
          data: {
            ...extra,
            tokenHash: hash(token),
            expiresAt,
            lastUsedAt: now,
            ...(ctx.userAgent
              ? { userAgent: ctx.userAgent.slice(0, 500) }
              : {}),
            ...(ctx.ip ? { ip: ctx.ip.slice(0, 100) } : {}),
          },
        });
        return {
          ok: {
            userId: user.id,
            permissionVersion: user.permissionVersion,
            sessionId: session.id,
            refresh: { sessionId: session.id, token, expiresAt },
          } as RotateResult,
        };
      };

      // Trình duyệt gửi token LIỀN TRƯỚC.
      if (session.tokenHash !== presented) {
        const withinGrace =
          session.rotatedAt != null &&
          now.getTime() - session.rotatedAt.getTime() <
            sessionConfig.rotationGraceMs;
        if (withinGrace) {
          if (
            opts.reissueOnGrace &&
            session.deviceId &&
            ctx.deviceId === session.deviceId
          ) {
            // App mất phản hồi lần trước: cấp token khác. Giữ nguyên
            // previousTokenHash + rotatedAt → ân hạn không bị kéo dài.
            return issue({});
          }
          // Nhiều tab làm mới cùng lúc: cookie trình duyệt đã là token mới.
          return {
            ok: {
              userId: user.id,
              permissionVersion: user.permissionVersion,
              sessionId: session.id,
            } as RotateResult,
          };
        }
        this.logger.warn(
          `Refresh token reuse detected (user ${session.userId}, session ${session.id}) — revoking`,
        );
        return revoke('reuse');
      }

      return issue({ previousTokenHash: presented, rotatedAt: now });
    });

    if ('error' in outcome && outcome.error) {
      if ('revoked' in outcome && outcome.revoked) {
        this.afterRevoke(
          { sessionIds: [outcome.revoked.sessionId] },
          outcome.revoked.reason,
        );
      }
      throw outcome.error;
    }
    if (unboundDevice && ctx.deviceId) {
      await this.bindDevice(outcome.ok.userId, outcome.ok.sessionId, ctx);
    }
    return outcome.ok;
  }

  /**
   * Dòng tạo trước khi có cookie `hs_did` → gắn mã trình duyệt ở lần làm mới
   * đầu tiên, để lần đăng nhập lại sau đó thay đúng dòng này. Chỉ là dọn dẹp:
   * lỗi (vd trình duyệt đã có dòng khác) không được làm hỏng việc làm mới.
   */
  private async bindDevice(
    userId: number,
    sessionId: number,
    ctx: SessionContext,
  ) {
    try {
      const taken = await this.prisma.authSession.findFirst({
        where: { userId, deviceId: ctx.deviceId },
        select: { id: true },
      });
      if (taken) return;
      await this.prisma.authSession.updateMany({
        where: { id: sessionId, deviceId: null },
        data: { deviceId: ctx.deviceId },
      });
    } catch (error) {
      this.logger.warn(
        `Bind device to session ${sessionId} skipped: ${(error as Error)?.message}`,
      );
    }
  }

  /** Đăng xuất bằng refresh token của chính trình duyệt đó. */
  async revokeByToken(raw: string | undefined, reason: RevokeReason) {
    if (!raw) return;
    const { count } = await this.prisma.authSession.updateMany({
      where: { tokenHash: hash(raw), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    if (count) this.sidCache.clear();
  }

  /**
   * App di động đăng xuất bằng refresh token nó đang giữ (chấp nhận cả token
   * liền trước, phòng app chưa kịp lưu token mới). Có phát sự kiện thu hồi.
   */
  async revokeOwnSession(
    raw: string | undefined,
    reason: RevokeReason = 'logout',
  ): Promise<boolean> {
    if (!raw) return false;
    const presented = hash(raw);
    const session = await this.prisma.authSession.findFirst({
      where: {
        revokedAt: null,
        OR: [{ tokenHash: presented }, { previousTokenHash: presented }],
      },
      select: { id: true, userId: true },
    });
    if (!session) return false;
    return this.revokeSession(session.userId, session.id, reason);
  }

  /** Thu hồi 1 phiên (thiết bị) của user. Trả false nếu không phải của user đó. */
  async revokeSession(
    userId: number,
    sessionId: number,
    reason: RevokeReason = 'remote_logout',
  ): Promise<boolean> {
    const { count } = await this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    if (count) this.afterRevoke({ sessionIds: [sessionId] }, reason);
    return count > 0;
  }

  /** Đăng xuất mọi thiết bị khác của user (giữ thiết bị đang dùng). */
  async revokeOtherSessions(
    userId: number,
    keepSessionId?: number,
  ): Promise<number> {
    const targets = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
      },
      select: { id: true },
    });
    if (targets.length === 0) return 0;
    const ids = targets.map((t) => t.id);
    await this.prisma.authSession.updateMany({
      where: { id: { in: ids } },
      data: { revokedAt: new Date(), revokeReason: 'remote_logout' },
    });
    this.afterRevoke({ sessionIds: ids }, 'remote_logout');
    return ids.length;
  }

  /** Các thiết bị đang đăng nhập (mới dùng gần nhất trước). */
  async listActiveSessions(userId: number): Promise<ActiveSession[]> {
    const now = new Date();
    return this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  /**
   * Bắt user đăng nhập lại ở MỌI thiết bị (đổi quyền, đổi mật khẩu, khóa...):
   * thu hồi phiên + báo realtime để trình duyệt đang mở về trang login ngay.
   */
  async forceReLogin(userIds: number[], reason: RevokeReason) {
    const ids = [...new Set(userIds)].filter((id) => Number.isInteger(id));
    if (ids.length === 0) return;
    try {
      await this.prisma.authSession.updateMany({
        where: { userId: { in: ids }, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      });
    } catch (error) {
      this.logger.error(
        `forceReLogin revoke failed: ${(error as Error)?.message}`,
      );
    }
    this.afterRevoke({ userIds: ids }, reason);
  }

  /** Access token có `sid`: phiên phải chưa bị thu hồi / chưa hết hạn tuyệt đối. */
  async isSessionUsable(sessionId: number): Promise<boolean> {
    const cached = this.sidCache.get(sessionId);
    if (cached && Date.now() - cached.at < SID_CACHE_TTL_MS) return cached.ok;

    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, absoluteExpiresAt: true },
    });
    const ok =
      !!session && !session.revokedAt && session.absoluteExpiresAt > new Date();
    this.sidCache.set(sessionId, { ok, at: Date.now() });
    if (this.sidCache.size > 5000) this.sidCache.clear();
    return ok;
  }

  /** Dọn phiên đã thu hồi / hết hạn quá 7 ngày. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    const cutoff = new Date(Date.now() - CLEANUP_AFTER_MS);
    try {
      const { count } = await this.prisma.authSession.deleteMany({
        where: {
          OR: [
            { revokedAt: { lt: cutoff } },
            { expiresAt: { lt: cutoff } },
            { absoluteExpiresAt: { lt: cutoff } },
          ],
        },
      });
      if (count) this.logger.log(`Cleaned ${count} auth sessions`);
    } catch (error) {
      this.logger.warn(`Session cleanup failed: ${(error as Error)?.message}`);
    }
  }

  private afterRevoke(
    target: { userIds?: number[]; sessionIds?: number[] },
    reason: string,
  ) {
    this.sidCache.clear();
    sessionEvents.emit(SESSION_REVOKED, {
      userIds: target.userIds ?? [],
      sessionIds: target.sessionIds ?? [],
      reason,
    } satisfies SessionRevokedEvent);
  }

  private errorForReason(reason: string | null) {
    switch (reason) {
      case 'permission':
        return sessionError(
          'PERMISSION_CHANGED',
          'Quyền của bạn đã được thay đổi. Vui lòng đăng nhập lại.',
        );
      case 'password':
        return sessionError(
          'SESSION_INVALID',
          'Mật khẩu đã được thay đổi. Vui lòng đăng nhập lại.',
        );
      case 'disabled':
        return sessionError('ACCOUNT_DISABLED', 'Tài khoản đã bị vô hiệu hóa.');
      case 'expired':
        return sessionError(
          'SESSION_EXPIRED',
          'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
        );
      case 'remote_logout':
        return sessionError(
          'SESSION_INVALID',
          'Bạn đã bị đăng xuất khỏi thiết bị này.',
        );
      default:
        return sessionError(
          'SESSION_INVALID',
          'Phiên đăng nhập không còn hiệu lực. Vui lòng đăng nhập lại.',
        );
    }
  }
}
