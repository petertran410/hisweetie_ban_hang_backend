/** Trạng thái chung của phiếu tạm ứng và phiếu hoàn ứng. */
export const CASH_ADVANCE_STATUS = {
  // Phiếu tạm: vừa tạo, sửa được, chưa đụng tới quỹ.
  DRAFT: 'DRAFT',
  // Đang xác nhận: đã giao/nhận tiền (đã ghi quỹ), chờ upload phiếu đã ký.
  CONFIRMING: 'CONFIRMING',
  // Hoàn thành: đã upload phiếu đã ký.
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type CashAdvanceStatus =
  (typeof CASH_ADVANCE_STATUS)[keyof typeof CASH_ADVANCE_STATUS];

/** Phiếu đã ghi quỹ (đã giao / nhận tiền). */
export const CASH_ADVANCE_POSTED_STATUSES: string[] = [
  CASH_ADVANCE_STATUS.CONFIRMING,
  CASH_ADVANCE_STATUS.COMPLETED,
];

export const CASH_ADVANCE_ATTACHMENT_KIND = {
  INITIAL: 'INITIAL',
  SIGNED: 'SIGNED',
} as const;

export const CASH_ADVANCE_ALLOCATION_STATUS = {
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
} as const;

export const CASH_ADVANCE_PERIOD_MODE = {
  WEEK: 'WEEK',
  RANGE: 'RANGE',
} as const;

/** Chỉ quỹ kho (Kho HN, Kho SG) được tạm ứng. */
export const CASH_ADVANCE_BRANCH_IDS = [6, 1] as const;

/** Số ngày ân hạn làm hoàn ứng sau khi hết kỳ tạm ứng. */
export const CASH_ADVANCE_GRACE_DAYS = 5;

/** Kỳ tự chọn tối đa (ngày). */
export const CASH_ADVANCE_MAX_RANGE_DAYS = 92;

/** Category dùng cho bộ đếm mã TCNB-TU / TCNB-HU. */
export const CASH_ADVANCE_CODE_CATEGORY = {
  ADVANCE: 'CASH_ADVANCE',
  REFUND: 'CASH_ADVANCE_REFUND',
} as const;

/** sourceType của dòng quỹ nội bộ. */
export const CASH_ADVANCE_FUND_SOURCE = {
  ADVANCE: 'CASH_ADVANCE',
  REFUND: 'CASH_ADVANCE_REFUND',
} as const;

export const cashAdvanceFundKey = (id: number) => `CASH_ADVANCE:${id}`;
export const cashAdvanceRefundFundKey = (id: number) =>
  `CASH_ADVANCE_REFUND:${id}`;

export const CASH_ADVANCE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Phiếu tạm',
  CONFIRMING: 'Đang xác nhận',
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã hủy',
};
