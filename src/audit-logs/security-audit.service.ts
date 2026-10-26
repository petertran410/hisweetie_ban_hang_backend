import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from './audit-logs.service';
import {
  getSeverityFromActionCode,
  renderAuditMessage,
} from './audit-templates';
import {
  SESSION_REVOKED,
  SessionRevokedEvent,
  sessionEvents,
} from '../auth/session/session-events';
import { describeUserAgent } from '../auth/session/user-agent.util';

export type SecurityActionCode =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_LOGIN_LOCKED'
  | 'AUTH_TOKEN_REUSE'
  | 'AUTH_PASSWORD_CHANGE'
  | 'AUTH_SUPER_ADMIN_GRANT'
  | 'AUTH_SUPER_ADMIN_REVOKE';

export interface SecurityEventInput {
  /** Tài khoản bị tác động. */
  userId: number;
  /** Người thực hiện (mặc định = chính userId). */
  actorId?: number;
  ip?: string;
  userAgent?: string | null;
  params?: Record<string, string | number>;
  metadata?: Record<string, unknown>;
}

/**
 * Nhật ký sự kiện bảo mật (đăng nhập, khoá tạm, token bị đánh cắp, đổi mật
 * khẩu, gán/gỡ Super Admin) ghi vào audit_logs với category `security`.
 * Ghi kiểu "bắn rồi quên": không bao giờ ném lỗi hay làm chậm request.
 */
@Injectable()
export class SecurityAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityAuditService.name);

  constructor(
    private readonly auditLogs: AuditLogsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    sessionEvents.on(SESSION_REVOKED, this.onSessionRevoked);
  }

  onModuleDestroy() {
    sessionEvents.off(SESSION_REVOKED, this.onSessionRevoked);
  }

  record(actionCode: SecurityActionCode, input: SecurityEventInput): void {
    this.write(actionCode, input).catch((error) =>
      this.logger.warn(
        `Security audit ${actionCode} skipped: ${(error as Error)?.message}`,
      ),
    );
  }

  /** Phiên bị thu hồi vì token cũ bị dùng lại → ghi sự kiện nghi đánh cắp. */
  private readonly onSessionRevoked = (event: SessionRevokedEvent) => {
    if (event.reason !== 'reuse') return;
    for (const sessionId of event.sessionIds ?? []) {
      this.prisma.authSession
        .findUnique({
          where: { id: sessionId },
          select: { userId: true, ip: true, userAgent: true },
        })
        .then((session) => {
          if (!session) return;
          this.record('AUTH_TOKEN_REUSE', {
            userId: session.userId,
            ip: session.ip ?? undefined,
            userAgent: session.userAgent,
            metadata: { sessionId },
          });
        })
        .catch((error) =>
          this.logger.warn(
            `Token reuse audit skipped: ${(error as Error)?.message}`,
          ),
        );
    }
  };

  async write(actionCode: SecurityActionCode, input: SecurityEventInput) {
    const actorId = input.actorId ?? input.userId;
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set([input.userId, actorId])] } },
      select: { id: true, name: true, email: true },
    });
    const subject = users.find((u) => u.id === input.userId);
    const actor = users.find((u) => u.id === actorId);
    if (!subject) return;

    const ua = describeUserAgent(input.userAgent);
    const params = {
      targetName: subject.name || subject.email,
      device: `${ua.browser} trên ${ua.os}`,
      ip: input.ip || 'không rõ',
      ...input.params,
    };
    await this.auditLogs.create({
      actionType: 'SECURITY',
      actionCode,
      entityType: 'users',
      entityId: String(subject.id),
      entityCode: subject.email,
      category: 'security',
      severity: getSeverityFromActionCode(actionCode),
      message: renderAuditMessage(actionCode, params),
      messageTemplate: actionCode,
      messageParams: params,
      userId: actor?.id ?? subject.id,
      userName: actor?.name || actor?.email || 'System',
      ipAddress: input.ip,
      userAgent: input.userAgent?.slice(0, 500),
      metadata: input.metadata,
    });
  }
}
