import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SESSION_REVOKED,
  SessionRevokedEvent,
  sessionEvents,
} from './session-events';
import { sessionConfig } from './session.config';

export type RevokeReason =
  | 'rotated'
  | 'logout'
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

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

const sessionError = (code: SessionErrorCode, message: string) =>
  new UnauthorizedException({ statusCode: 401, code, message });

/** Cache ngắn trạng thái sid để JwtStrategy không phải query DB mỗi request. */
const SID_CACHE_TTL_MS = 30_000;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sidCache = new Map<number, { ok: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Tạo phiên mới (đăng nhập). */
  async createSession(
    userId: number,
    permissionVersion: number,
    ctx: SessionContext = {},
  ): Promise<IssuedRefresh> {
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + sessionConfig.refreshAbsoluteMs);
    return this.insertSession({
      userId,
      permissionVersion,
      familyId: randomUUID(),
      absoluteExpiresAt,
      ctx,
    });
  }

  /**
   * Đổi refresh token cũ lấy token mới (xoay vòng).
   * Ném 401 kèm `code` khi không hợp lệ.
   */
  async rotate(raw: string, ctx: SessionContext = {}): Promise<RotateResult> {
    if (!raw) throw sessionError('SESSION_INVALID', 'Phiên không hợp lệ');
    const tokenHash = hash(raw);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE token_hash = ${tokenHash} FOR UPDATE`;
      const session = await tx.authSession.findUnique({
        where: { tokenHash },
      });
      if (!session) {
        return { error: sessionError('SESSION_INVALID', 'Phiên không hợp lệ') };
      }

      const now = new Date();
      const user = await tx.user.findUnique({
        where: { id: session.userId },
        select: { id: true, isActive: true, permissionVersion: true },
      });

      // Đã bị thay bởi token mới.
      if (session.revokedAt) {
        const withinGrace =
          session.revokeReason === 'rotated' &&
          session.replacedById != null &&
          now.getTime() - session.revokedAt.getTime() <
            sessionConfig.rotationGraceMs;
        if (withinGrace && user?.isActive) {
          const successor = await tx.authSession.findUnique({
            where: { id: session.replacedById! },
          });
          if (
            successor &&
            !successor.revokedAt &&
            successor.permissionVersion === user.permissionVersion
          ) {
            return {
              ok: {
                userId: user.id,
                permissionVersion: user.permissionVersion,
                sessionId: successor.id,
              } as RotateResult,
            };
          }
        }
        if (session.revokeReason === 'rotated') {
          // Token cũ bị dùng lại ngoài ân hạn → nghi bị đánh cắp.
          this.logger.warn(
            `Refresh token reuse detected (user ${session.userId}, family ${session.familyId}) — revoking family`,
          );
          await this.revokeFamilyTx(tx, session.familyId, 'reuse');
        }
        return { error: this.errorForReason(session.revokeReason) };
      }

      if (now > session.expiresAt || now > session.absoluteExpiresAt) {
        await this.revokeFamilyTx(tx, session.familyId, 'expired');
        return {
          error: sessionError(
            'SESSION_EXPIRED',
            'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
          ),
        };
      }

      if (!user || !user.isActive) {
        await this.revokeFamilyTx(tx, session.familyId, 'disabled');
        return { error: this.errorForReason('disabled') };
      }

      if (user.permissionVersion !== session.permissionVersion) {
        await this.revokeFamilyTx(tx, session.familyId, 'permission');
        return { error: this.errorForReason('permission') };
      }

      const next = await this.insertSession(
        {
          userId: user.id,
          permissionVersion: session.permissionVersion,
          familyId: session.familyId,
          absoluteExpiresAt: session.absoluteExpiresAt,
          ctx,
        },
        tx,
      );
      await tx.authSession.update({
        where: { id: session.id },
        data: {
          revokedAt: now,
          revokeReason: 'rotated',
          replacedById: next.sessionId,
          lastUsedAt: now,
        },
      });

      return {
        ok: {
          userId: user.id,
          permissionVersion: user.permissionVersion,
          sessionId: next.sessionId,
          refresh: next,
        } as RotateResult,
      };
    });

    if ('error' in outcome && outcome.error) {
      this.sidCache.clear();
      throw outcome.error;
    }
    return outcome.ok;
  }

  /** Đăng xuất: thu hồi cả chuỗi của refresh token hiện tại. */
  async revokeByToken(raw: string | undefined, reason: RevokeReason) {
    if (!raw) return;
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hash(raw) },
      select: { familyId: true },
    });
    if (!session) return;
    await this.revokeFamilyTx(this.prisma, session.familyId, reason);
    this.sidCache.clear();
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
        where: {
          userId: { in: ids },
          OR: [{ revokedAt: null }, { revokeReason: 'rotated' }],
        },
        data: { revokedAt: new Date(), revokeReason: reason },
      });
    } catch (error) {
      this.logger.error(
        `forceReLogin revoke failed: ${(error as Error)?.message}`,
      );
    }
    this.sidCache.clear();
    sessionEvents.emit(SESSION_REVOKED, {
      userIds: ids,
      reason,
    } satisfies SessionRevokedEvent);
  }

  /** Access token có `sid`: phiên phải còn hiệu lực (xoay vòng bình thường vẫn OK). */
  async isSessionUsable(sessionId: number): Promise<boolean> {
    const cached = this.sidCache.get(sessionId);
    if (cached && Date.now() - cached.at < SID_CACHE_TTL_MS) return cached.ok;

    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, revokeReason: true, absoluteExpiresAt: true },
    });
    const ok =
      !!session &&
      (!session.revokedAt || session.revokeReason === 'rotated') &&
      session.absoluteExpiresAt > new Date();
    this.sidCache.set(sessionId, { ok, at: Date.now() });
    if (this.sidCache.size > 5000) this.sidCache.clear();
    return ok;
  }

  /** Dọn phiên hết hạn/đã thu hồi quá 7 ngày. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.authSession.deleteMany({
        where: {
          OR: [
            { absoluteExpiresAt: { lt: cutoff } },
            { expiresAt: { lt: cutoff } },
            { revokedAt: { lt: cutoff } },
          ],
        },
      });
      if (count) this.logger.log(`Cleaned ${count} auth sessions`);
    } catch (error) {
      this.logger.warn(`Session cleanup failed: ${(error as Error)?.message}`);
    }
  }

  private async insertSession(
    input: {
      userId: number;
      permissionVersion: number;
      familyId: string;
      absoluteExpiresAt: Date;
      ctx: SessionContext;
    },
    tx: Pick<PrismaService, 'authSession'> = this.prisma,
  ): Promise<IssuedRefresh> {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(
      Math.min(
        now + sessionConfig.refreshIdleMs,
        input.absoluteExpiresAt.getTime(),
      ),
    );
    const created = await tx.authSession.create({
      data: {
        userId: input.userId,
        familyId: input.familyId,
        tokenHash: hash(token),
        permissionVersion: input.permissionVersion,
        expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        userAgent: input.ctx.userAgent?.slice(0, 500),
        ip: input.ctx.ip?.slice(0, 100),
      },
      select: { id: true },
    });
    return { sessionId: created.id, token, expiresAt };
  }

  private async revokeFamilyTx(
    tx: Pick<PrismaService, 'authSession'>,
    familyId: string,
    reason: RevokeReason,
  ) {
    // Ghi đè cả các dòng 'rotated' để access token cũ (sid cũ) cũng hết hiệu lực.
    await tx.authSession.updateMany({
      where: {
        familyId,
        OR: [{ revokedAt: null }, { revokeReason: 'rotated' }],
      },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
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
      default:
        return sessionError(
          'SESSION_INVALID',
          'Phiên đăng nhập không còn hiệu lực. Vui lòng đăng nhập lại.',
        );
    }
  }
}
