import {
  FINANCE_AUDIT_CATEGORY,
  FINANCE_AUDIT_ENTITY,
  type FinanceAuditEntityType,
} from './finance-audit.types';

// Không import audit-logs/audit-templates ở đây: audit-templates gộp catalog này
// vào AUDIT_TEMPLATES, import ngược lại sẽ thành vòng.

export type FinanceAuditSeverity = 'info' | 'warning' | 'critical';
/** POST = tạo, PUT = sửa, DELETE = hủy/gỡ (bản ghi vẫn giữ lại). */
export type FinanceAuditActionType = 'POST' | 'PUT' | 'DELETE';

export interface FinanceAuditCatalogItem {
  entityType: FinanceAuditEntityType;
  severity: FinanceAuditSeverity;
  actionType: FinanceAuditActionType;
  template: string;
}

const ENTRY = FINANCE_AUDIT_ENTITY.ENTRY;
const BATCH = FINANCE_AUDIT_ENTITY.BATCH;
const FUND_TXN = FINANCE_AUDIT_ENTITY.FUND_TXN;
const FUND_TRANSFER = FINANCE_AUDIT_ENTITY.FUND_TRANSFER;
const FUND_CLOSING = FINANCE_AUDIT_ENTITY.FUND_CLOSING;
const APPROVAL = FINANCE_AUDIT_ENTITY.APPROVAL;
const VEHICLE = FINANCE_AUDIT_ENTITY.VEHICLE;
const FUEL_ADVANCE = FINANCE_AUDIT_ENTITY.FUEL_ADVANCE;
const SEPAY = FINANCE_AUDIT_ENTITY.SEPAY;
const SCRIPT = FINANCE_AUDIT_ENTITY.SCRIPT;

/** Mã thao tác tài chính nội bộ: loại bản ghi, mức độ, kiểu và mẫu câu. */
export const FINANCE_AUDIT_CATALOG = {
  // Phiếu tài chính nội bộ
  FIN_ENTRY_CREATE: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'POST',
    template: 'Tạo {kindLabel} {code} – {amount}',
  },
  FIN_ENTRY_UPDATE: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Sửa {kindLabel} {code}{sourceSuffix}',
  },
  FIN_ENTRY_CODE_NORMALIZE: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Đổi mã phiếu {from} → {to}',
  },
  FIN_ENTRY_ATTACHMENTS_CHANGE: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Cập nhật chứng từ {code}: thêm {added}, gỡ {removed}',
  },
  FIN_ENTRY_CHECK: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Tick {roleLabel} phiếu {code}',
  },
  FIN_ENTRY_UNCHECK: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Bỏ tick {roleLabel} phiếu {code}',
  },
  FIN_ENTRY_REVIEW: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: '{roleLabel} {decisionLabel} phiếu {code}',
  },
  FIN_ENTRY_REJECT: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: '{roleLabel} từ chối phiếu {code}{reasonSuffix}',
  },
  FIN_ENTRY_CONFIRM_AMOUNT: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Kế toán kho xác nhận thực nhận {amount} phiếu {code}',
  },
  FIN_ENTRY_CONFIRM_CLEAR: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Bỏ xác nhận số thực nhận phiếu {code}',
  },
  FIN_ENTRY_POST: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Lập phiếu thu {cashFlowCodes} từ {code}',
  },
  // Lập phiếu thu dở dang: đã khóa phiếu (Đang lập) và / hoặc đã tạo phiếu thu
  // rồi lỗi; phiếu thu đã tạo nằm trong snapshot / metadata.postedCashFlows.
  FIN_ENTRY_POST_FAILED: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Lập phiếu thu từ {code} thất bại: {error}',
  },
  FIN_ENTRY_CASH_ISSUE: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Đánh dấu Đã chi {code}{reasonSuffix}',
  },
  FIN_ENTRY_CASH_ISSUE_REVERT: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Bỏ Đã chi {code}{reasonSuffix}',
  },
  FIN_ENTRY_CANCEL: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy {kindLabel} {code}{reasonSuffix}',
  },
  FIN_ENTRY_REOPEN: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Mở lại {kindLabel} {code}{reasonSuffix}',
  },
  FIN_ENTRY_NOTE_ADD: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'POST',
    template: 'Ghi chú phiếu {code}: {preview}',
  },
  FIN_ENTRY_BATCH_ADD: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Đưa phiếu {code} vào Approval tuần {batchCode}',
  },
  FIN_ENTRY_BATCH_REMOVE: {
    entityType: ENTRY,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Bỏ phiếu {code} khỏi Approval tuần {batchCode}{reasonSuffix}',
  },
  FIN_ENTRY_WEEKLY_STATUS: {
    entityType: ENTRY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Phiếu {code} – Approval tuần {batchCode}: {statusLabel}',
  },

  // Approval tuần
  FIN_BATCH_PREPARE: {
    entityType: BATCH,
    severity: 'info',
    actionType: 'POST',
    template: 'Tổng hợp tuần {batchCode}: {count} phiếu, {totalAmount}',
  },
  FIN_BATCH_REPREPARE: {
    entityType: BATCH,
    severity: 'info',
    actionType: 'PUT',
    template:
      'Gom lại tuần {batchCode}: thêm {added}, bỏ {dropped} phiếu, {totalAmount}',
  },
  FIN_BATCH_ADD_ENTRIES: {
    entityType: BATCH,
    severity: 'info',
    actionType: 'PUT',
    template: 'Thêm {count} phiếu sót vào {batchCode}, tổng {totalAmount}',
  },
  FIN_BATCH_REMOVE_ENTRIES: {
    entityType: BATCH,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Bỏ {count} phiếu khỏi {batchCode}, tổng {totalAmount}',
  },
  FIN_BATCH_SUBMIT: {
    entityType: BATCH,
    severity: 'info',
    actionType: 'PUT',
    template: 'Gửi Approval Lark tuần {batchCode} – {totalAmount}',
  },
  FIN_BATCH_SUBMIT_FAILED: {
    entityType: BATCH,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Gửi Approval Lark tuần {batchCode} thất bại: {error}',
  },
  FIN_BATCH_CANCEL: {
    entityType: BATCH,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy Approval tuần {batchCode}{reasonSuffix}',
  },
  FIN_BATCH_LARK_STATUS: {
    entityType: BATCH,
    severity: 'info',
    actionType: 'PUT',
    template: 'Lark: Approval tuần {batchCode} {statusLabel}',
  },
  FIN_BATCH_LARK_REVERT: {
    entityType: BATCH,
    severity: 'critical',
    actionType: 'PUT',
    template: 'Lark: Approval tuần {batchCode} bị thu hồi sau khi duyệt',
  },

  // Quỹ nội bộ
  FIN_FUND_TXN_POST: {
    entityType: FUND_TXN,
    severity: 'info',
    actionType: 'POST',
    template: 'Ghi quỹ {typeLabel} {code} {amount} – {sourceLabel}',
  },
  FIN_FUND_TXN_CANCEL: {
    entityType: FUND_TXN,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy dòng quỹ {code} {amount}{reasonSuffix}',
  },
  FIN_FUND_TXN_ADJUST: {
    entityType: FUND_TXN,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Điều chỉnh dòng quỹ {code}{reasonSuffix}',
  },
  FIN_FUND_TXN_REDATE: {
    entityType: FUND_TXN,
    severity: 'critical',
    actionType: 'PUT',
    template: 'Đổi ngày dòng quỹ {code}: {from} → {to}',
  },
  FIN_FUND_TXN_RESTORE: {
    entityType: FUND_TXN,
    severity: 'critical',
    actionType: 'PUT',
    template: 'Khôi phục dòng quỹ {code}{reasonSuffix}',
  },
  FIN_FUND_TXN_SCRIPT_UPDATE: {
    entityType: FUND_TXN,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Script cập nhật dòng quỹ {code}',
  },
  FIN_FUND_TRANSFER_REQUEST: {
    entityType: FUND_TRANSFER,
    severity: 'info',
    actionType: 'POST',
    template: 'Tạo chuyển quỹ {code} {amount}: {fromBranch} → {toBranch}',
  },
  FIN_FUND_TRANSFER_STATUS: {
    entityType: FUND_TRANSFER,
    severity: 'info',
    actionType: 'PUT',
    template: 'Chuyển quỹ {code}: {statusLabel}',
  },
  FIN_FUND_TRANSFER_CANCEL: {
    entityType: FUND_TRANSFER,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy chuyển quỹ {code}{reasonSuffix}',
  },
  FIN_FUND_CLOSING_SAVE: {
    entityType: FUND_CLOSING,
    severity: 'info',
    actionType: 'PUT',
    template: 'Lưu chốt sổ {branch} ngày {date}',
  },
  FIN_FUND_CLOSING_INVALIDATE: {
    entityType: FUND_CLOSING,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Chốt sổ {branch} ngày {date} cần đối soát lại ({cause})',
  },

  // Đơn Lark Approval
  FIN_APPROVAL_CREATE: {
    entityType: APPROVAL,
    severity: 'info',
    actionType: 'POST',
    template: 'Tạo đơn {kindLabel} {code}',
  },
  FIN_APPROVAL_CREATE_FAILED: {
    entityType: APPROVAL,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Gửi đơn {kindLabel} {code} lên Lark thất bại: {error}',
  },
  FIN_APPROVAL_STATUS: {
    entityType: APPROVAL,
    severity: 'info',
    actionType: 'PUT',
    template: 'Lark: đơn {kindLabel} {code} {from} → {to}',
  },
  FIN_APPROVAL_REVERT: {
    entityType: APPROVAL,
    severity: 'critical',
    actionType: 'PUT',
    template: 'Lark: đơn {kindLabel} {code} bị thu hồi',
  },
  FIN_APPROVAL_POST: {
    entityType: APPROVAL,
    severity: 'info',
    actionType: 'PUT',
    template: 'Ghi quỹ đơn {kindLabel} {code} – {amount}',
  },

  // Xe
  FIN_VEHICLE_CREATE: {
    entityType: VEHICLE,
    severity: 'info',
    actionType: 'POST',
    template: 'Thêm xe {label}',
  },
  FIN_VEHICLE_UPDATE: {
    entityType: VEHICLE,
    severity: 'info',
    actionType: 'PUT',
    template: 'Sửa xe {label}',
  },
  FIN_VEHICLE_DEACTIVATE: {
    entityType: VEHICLE,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Ngừng dùng xe {label}',
  },
  FIN_VEHICLE_REACTIVATE: {
    entityType: VEHICLE,
    severity: 'info',
    actionType: 'PUT',
    template: 'Dùng lại xe {label}',
  },
  FIN_VEHICLE_RENAME: {
    entityType: VEHICLE,
    severity: 'warning',
    actionType: 'PUT',
    template: 'Đổi tên xe {from} → {to} ({count} phiếu cũ đổi theo)',
  },

  // Tiền ứng xăng
  FIN_FUEL_ADVANCE_CREATE: {
    entityType: FUEL_ADVANCE,
    severity: 'info',
    actionType: 'POST',
    template: 'Nhập khoản ứng xăng {amount} ngày {date}',
  },
  FIN_FUEL_ADVANCE_CANCEL: {
    entityType: FUEL_ADVANCE,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy khoản ứng xăng {amount}{reasonSuffix}',
  },

  // Quỹ VPSG từ Biến động số dư
  FIN_VPSG_RECORD: {
    entityType: SEPAY,
    severity: 'info',
    actionType: 'PUT',
    template: 'Ghi vào quỹ VPSG {amount} – {content}',
  },
  FIN_VPSG_CANCEL: {
    entityType: SEPAY,
    severity: 'warning',
    actionType: 'DELETE',
    template: 'Hủy ghi quỹ VPSG {amount}{reasonSuffix}',
  },

  // Script bảo trì
  FIN_SCRIPT_RUN: {
    entityType: SCRIPT,
    severity: 'critical',
    actionType: 'POST',
    template: 'Chạy script {name} --apply: {summary}',
  },
} as const satisfies Record<string, FinanceAuditCatalogItem>;

export type FinanceAuditAction = keyof typeof FINANCE_AUDIT_CATALOG;

export const FINANCE_AUDIT_ACTIONS = Object.keys(
  FINANCE_AUDIT_CATALOG,
) as FinanceAuditAction[];

export function isFinanceAuditAction(code: string): code is FinanceAuditAction {
  return Object.hasOwn(FINANCE_AUDIT_CATALOG, code);
}

/**
 * Cùng dạng với AUDIT_TEMPLATES (audit-logs/audit-templates.ts) để các helper
 * chung (getCategoryFromActionCode, ...) nhận ra mã FIN_*.
 */
export const FINANCE_AUDIT_TEMPLATES: Record<
  FinanceAuditAction,
  { template: string; category: string; severity: FinanceAuditSeverity }
> = Object.fromEntries(
  FINANCE_AUDIT_ACTIONS.map((code) => [
    code,
    {
      template: FINANCE_AUDIT_CATALOG[code].template,
      category: FINANCE_AUDIT_CATEGORY,
      severity: FINANCE_AUDIT_CATALOG[code].severity,
    },
  ]),
) as Record<
  FinanceAuditAction,
  { template: string; category: string; severity: FinanceAuditSeverity }
>;
