import { requestHasPermission } from '../auth/request-permissions';
import type { LeadActor } from '../leads/leads.service';
import type { QuoteActor } from '../quotes/quotes.service';
import { QUOTES_VIEW_ALL } from '../quotes/quotes.constants';

/**
 * Người đang hỏi trợ lý và những gì họ được xem — dựng y như các controller đang làm,
 * nên công cụ không bao giờ thấy nhiều hơn màn hình tương ứng.
 */
export interface AiScope {
  userId: number;
  userName: string;
  /** Quyền theo chi nhánh đang chọn (X-Branch-Id), Super Admin luôn true. */
  can: (permission: string) => boolean;
  /** `req.user` (JwtStrategy) — truyền nguyên cho service nhận `currentUser`. */
  user: {
    id: number;
    name: string;
    canViewOtherStaffData: boolean;
    branchId: number | null;
    branchIds: number[];
    roles: string[];
    [key: string]: unknown;
  };
  /** Chi nhánh đang chọn trên POS (header X-Branch-Id), null = không chọn. */
  branchId: number | null;
  leadActor: LeadActor;
  quoteActor: QuoteActor;
}

/** Request sau JwtAuthGuard + PermissionsGuard (gắn user và effectivePermissions). */
export type AiRequest = {
  user: AiScope['user'];
  headers?: Record<string, string | string[] | undefined>;
  effectivePermissions?: string[];
};

export function buildAiScope(req: AiRequest): AiScope {
  const user = req.user;
  const raw = req.headers?.['x-branch-id'];
  const branchId = raw ? parseInt(String(raw), 10) : NaN;
  const can = (permission: string) => requestHasPermission(req, permission);
  return {
    userId: user.id,
    userName: user.name,
    can,
    user,
    branchId: Number.isFinite(branchId) ? branchId : null,
    leadActor: { id: user.id, name: user.name, ownOnly: !can('leads:update') },
    quoteActor: {
      id: user.id,
      name: user.name,
      ownOnly: !can(QUOTES_VIEW_ALL),
    },
  };
}
