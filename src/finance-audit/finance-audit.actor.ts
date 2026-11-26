import { randomUUID } from 'crypto';
import type { AuditActor, AuditActorKind } from './finance-audit.types';

/** Mã thao tác: các dòng lịch sử của cùng một thao tác dùng chung opId. */
export function newOpId(): string {
  return randomUUID();
}

/**
 * User.id ghi cho thao tác hệ thống (audit_logs.user_id là khóa ngoại bắt
 * buộc): FINANCE_AUDIT_SYSTEM_USER_ID, mặc định 1.
 */
export function financeAuditSystemUserId(): number {
  const id = Number(process.env.FINANCE_AUDIT_SYSTEM_USER_ID);
  return Number.isInteger(id) && id > 0 ? id : 1;
}

type ActorUser = { id: number; name?: string | null; email?: string | null };

export const auditActor = {
  /** Người dùng thao tác trên POS (req.user hoặc chỉ id). */
  user(
    userOrId: number | ActorUser,
    trigger = 'http',
    opId?: string,
  ): AuditActor {
    const user = typeof userOrId === 'number' ? { id: userOrId } : userOrId;
    const userName =
      (typeof userOrId === 'object' &&
        (userOrId.name?.trim() || userOrId.email?.trim())) ||
      undefined;
    return {
      userId: Number(user.id),
      ...(userName ? { userName } : {}),
      kind: 'USER',
      trigger,
      opId: opId || newOpId(),
    };
  },

  /** Lark webhook, cron, khởi động, ... : ghi bằng user hệ thống. */
  system(
    kind: Exclude<AuditActorKind, 'USER'>,
    trigger: string,
    onBehalfOfUserId?: number | null,
    opId?: string,
  ): AuditActor {
    return {
      userId: financeAuditSystemUserId(),
      kind,
      trigger,
      onBehalfOfUserId: onBehalfOfUserId ?? null,
      opId: opId || newOpId(),
    };
  },

  /** Script bảo trì chạy --apply: userId là --user của người chạy. */
  script(name: string, userId: number, opId?: string): AuditActor {
    return {
      userId: Number(userId),
      kind: 'SCRIPT',
      trigger: `script:${name}`,
      opId: opId || newOpId(),
    };
  },
};

/** Tên hiển thị của người/hệ thống thực hiện khi không phải USER. */
export function systemActorName(actor: AuditActor): string | null {
  switch (actor.kind) {
    case 'LARK':
      return 'Hệ thống (Lark Approval)';
    case 'CRON':
    case 'SYSTEM':
      return 'Hệ thống (tự động)';
    case 'SCRIPT': {
      const name = (actor.trigger || '').replace(/^script:/, '').trim();
      return name ? `Script ${name}` : 'Script';
    }
    default:
      return null;
  }
}
