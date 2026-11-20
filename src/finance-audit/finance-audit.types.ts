import type { Prisma } from '@prisma/client';
import type { FinanceAuditAction } from './finance-audit.catalog';

/** Loại bản ghi tài chính nội bộ được ghi lịch sử (audit_logs.entity_type). */
export const FINANCE_AUDIT_ENTITY = {
  ENTRY: 'internal_finance_entries',
  BATCH: 'internal_finance_weekly_batches',
  FUND_TXN: 'internal_fund_transactions',
  FUND_TRANSFER: 'internal_fund_transfers',
  FUND_CLOSING: 'internal_fund_daily_closings',
  APPROVAL: 'approval_requests',
  VEHICLE: 'vehicles',
  FUEL_ADVANCE: 'fuel_advance_entries',
  SEPAY: 'sepay_transactions',
  SCRIPT: 'finance_scripts',
} as const;

export type FinanceAuditEntityType =
  (typeof FINANCE_AUDIT_ENTITY)[keyof typeof FINANCE_AUDIT_ENTITY];

/** Category chung của mọi dòng lịch sử tài chính nội bộ. */
export const FINANCE_AUDIT_CATEGORY = 'internal_finance';

export type AuditActorKind = 'USER' | 'LARK' | 'CRON' | 'SYSTEM' | 'SCRIPT';

export interface AuditActor {
  /** User.id thật (FK). Hệ thống → FINANCE_AUDIT_SYSTEM_USER_ID hoặc 1. */
  userId: number;
  /** write() tự lấy tên từ DB khi thiếu. */
  userName?: string;
  kind: AuditActorKind;
  /**
   * 'http' | 'packing-slip' | 'lark-webhook' | 'cron:reconcilePending' |
   * 'cron:syncRecentLarkInstances' | 'bootstrap:repairImportedWeeks' |
   * 'script:<name>'
   */
  trigger?: string;
  /** Vd người tạo đơn Lark khi hệ thống ghi thay. */
  onBehalfOfUserId?: number | null;
  /** randomUUID(); lưu vào audit_logs.request_id, chung cho một thao tác. */
  opId: string;
}

export type FinanceAuditChangeType =
  | 'field_changed'
  | 'item_added'
  | 'item_removed';

export interface FinanceAuditChange {
  field: string;
  label: string;
  /** Chuỗi hiển thị (trang Lịch sử in `{label}: {from} → {to}`). */
  from: string;
  to: string;
  type?: FinanceAuditChangeType;
  /** Giá trị gốc (không hiển thị). */
  detail?: unknown;
}

export type FinanceAuditParams = Record<
  string,
  string | number | null | undefined
>;

export interface FinanceAuditSnapshot {
  lines?: { label: string; value: string }[];
  [key: string]: unknown;
}

export interface FinanceAuditEntry {
  /** Mã trong catalog (FIN_*). */
  action: FinanceAuditAction;
  /** Bỏ trống thì lấy entityType mặc định của mã trong catalog. */
  entityType?: FinanceAuditEntityType;
  entityId: number | string;
  /** Mã phiếu/batch/dòng quỹ: tìm được ở trang Lịch sử. */
  entityCode?: string | null;
  branchId?: number | null;
  actor: AuditActor;
  params?: FinanceAuditParams;
  changes?: FinanceAuditChange[];
  /** Nhỏ gọn; Decimal → number, Date → ISO. */
  snapshot?: FinanceAuditSnapshot;
  metadata?: Record<string, unknown>;
}

/**
 * Client Prisma (transaction hoặc PrismaService) mà write() cần. customer /
 * invoice (có ở client thật) để đổi id khách hàng / hóa đơn trong changes thành
 * mã, tên dễ đọc; client giả thiếu thì giữ "#id".
 */
export type FinanceAuditDb = Pick<
  Prisma.TransactionClient,
  'auditLog' | 'user'
> &
  Partial<Pick<Prisma.TransactionClient, 'customer' | 'invoice'>>;
