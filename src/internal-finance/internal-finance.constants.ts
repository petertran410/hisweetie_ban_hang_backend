export const INTERNAL_FINANCE_DIRECTION = {
  EXPENSE: 'EXPENSE',
  RECEIPT: 'RECEIPT',
} as const;

export const INTERNAL_FINANCE_CATEGORY = {
  DELIVERY_FEE: 'DELIVERY_FEE',
  FUEL: 'FUEL',
  VEHICLE_CARE: 'VEHICLE_CARE',
  SALARY_ADVANCE: 'SALARY_ADVANCE',
  CUSTOMER_RECEIPT: 'CUSTOMER_RECEIPT',
  MANUAL_RECEIPT: 'MANUAL_RECEIPT',
  OTHER_EXPENSE: 'OTHER_EXPENSE',
  // Giao dịch quỹ tiền mặt duyệt trên Lark (PHIẾU CHI / PHIẾU THU): hiện ở
  // Tài chính nội bộ, không phải chi phí vận hành của Phiếu chi kho.
  CASH_FUND_EXPENSE: 'CASH_FUND_EXPENSE',
  CASH_FUND_RECEIPT: 'CASH_FUND_RECEIPT',
} as const;

export const INTERNAL_FINANCE_SUBCATEGORY = {
  FEE_GUI_BEN: 'FEE_GUI_BEN',
  FEE_GRAB: 'FEE_GRAB',
  SHIPPING_OUT: 'SHIPPING_OUT',
  SHIPPING_IN: 'SHIPPING_IN',
  FUEL: 'FUEL',
  VEHICLE_CARE: 'VEHICLE_CARE',
  SALARY_ADVANCE: 'SALARY_ADVANCE',
  OTHER: 'OTHER',
  WAREHOUSE_ITEM_SALE: 'WAREHOUSE_ITEM_SALE',
} as const;

/** Tên tiếng Việt của loại phí báo đơn, dùng làm nội dung phiếu chi. */
export const PACKING_FEE_LABELS: Record<string, string> = {
  FEE_GUI_BEN: 'Phí gửi bến',
  FEE_GRAB: 'Phí Grab',
  SHIPPING_OUT: 'Cước gửi hàng',
  SHIPPING_IN: 'Cước nhận hàng',
};

/** Đổi mã loại phí cũ còn nằm trong nội dung phiếu (vd "FEE_GUI_BEN - BD-1"). */
export function localizeFeeCodes(text: string | null | undefined) {
  if (!text) return text ?? null;
  return text.replace(
    /\b(FEE_GUI_BEN|FEE_GRAB|SHIPPING_OUT|SHIPPING_IN)\b/g,
    (code) => PACKING_FEE_LABELS[code] || code,
  );
}

/** Phiếu sinh từ đơn Lark Approval đã duyệt (tiền mặt Kho HN / Kho SG). */
export const LARK_APPROVAL_SOURCE_TYPE = 'LARK_APPROVAL';

/** Lý do khóa thao tác trên phiếu sinh từ đơn Lark Approval. */
export const LARK_APPROVAL_LOCK_REASON =
  'Phiếu từ Lark Approval đã duyệt, sửa hoặc thu hồi trên Lark';

export const INTERNAL_FINANCE_BRANCH_CODES: Record<number, string> = {
  6: 'HN',
  1: 'SG',
  4: 'VPHN',
  7: 'VPSG',
};

export const INTERNAL_FINANCE_STATUS = {
  PENDING_ACCOUNTANT: 'PENDING_ACCOUNTANT',
  ACCOUNTANT_APPROVED: 'ACCOUNTANT_APPROVED',
  PENDING_MANAGER: 'PENDING_MANAGER',
  MANAGER_APPROVED: 'MANAGER_APPROVED',
  READY_FOR_WEEKLY_APPROVAL: 'READY_FOR_WEEKLY_APPROVAL',
  IN_WEEKLY_APPROVAL: 'IN_WEEKLY_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  POSTING: 'POSTING',
  POSTED: 'POSTED',
  CANCELLED: 'CANCELLED',
} as const;

export const INTERNAL_FINANCE_EVIDENCE_STATUS = {
  COMPLETE: 'COMPLETE',
  MISSING: 'MISSING',
  EXCEPTION_APPROVED: 'EXCEPTION_APPROVED',
} as const;

export const INTERNAL_FINANCE_REVIEW_ROLE = {
  ACCOUNTANT: 'ACCOUNTANT',
  MANAGER: 'MANAGER',
} as const;

export const INTERNAL_FINANCE_REVIEW_DECISION = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  MARK_MISSING: 'MARK_MISSING',
  EXCEPTION_APPROVE: 'EXCEPTION_APPROVE',
} as const;

export const INTERNAL_FINANCE_WEEKLY_STATUS = {
  DRAFT: 'DRAFT',
  READY: 'READY',
  IN_APPROVAL: 'IN_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  POSTED: 'POSTED',
  CANCELLED: 'CANCELLED',
} as const;

export const INTERNAL_FINANCE_BRANCH_IDS = [1, 4, 6, 7] as const;

export const WAREHOUSE_CASH_BRANCH_IDS = [6, 1] as const;

export const DELIVERY_EXPENSE_CATEGORIES = [
  INTERNAL_FINANCE_CATEGORY.DELIVERY_FEE,
] as const;

export const POSTABLE_INTERNAL_FINANCE_STATUSES = new Set([
  INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
  INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
  INTERNAL_FINANCE_STATUS.APPROVED,
]);

// Khoản mục mặc định của các phiếu chi tự sinh (theo cột "Khoản mục" trên Lark).
export const WAREHOUSE_EXPENSE_ITEM = {
  DELIVERY: 'Cước gửi hàng cho khách: cước chành xe, ship nội thành',
  FUEL: 'Xăng xe: oto, xe tại kho',
  VEHICLE_CARE: 'Sửa chữa, bảo dưỡng; oto xe máy',
  OTHER: 'Khác',
} as const;

export const WAREHOUSE_EXPENSE_ITEMS = [
  'Chi phí tiền lương CBNV',
  'Cước chuyển phát nhanh tài liệu, chứng từ - đơn hàng bán lẻ',
  'Chi phí điện sinh hoạt',
  'Điện nước',
  'Cước điện thoại di động',
  'Chi phí nước uống, nước sinh hoạt',
  'Chi phí văn phòng phẩm, đồ dùng văn phòng',
  'Mua sắm CCDC, thiết bị văn phòng',
  'Chi phí sửa chữa thiết bị văn phòng',
  'Mua sắm TSCĐ',
  'Cước đường bộ, vé gửi xe:',
  WAREHOUSE_EXPENSE_ITEM.VEHICLE_CARE,
  WAREHOUSE_EXPENSE_ITEM.FUEL,
  'Chi phí ngoại giao ( xử lý )',
  'Chi phí bốc xếp hàng hóa tại kho',
  WAREHOUSE_EXPENSE_ITEM.DELIVERY,
  'Mua bao bì, CCDC phục vụ đóng gói hàng hóa: carton, xốp, băng keo...',
  'Thanh toán công nợ NCC',
  WAREHOUSE_EXPENSE_ITEM.OTHER,
] as const;
