/**
 * Trạng thái phiếu ký gửi — đồng bộ 3 dạng:
 *   - status (number): nguồn canonical để filter/where.
 *   - statusValue (string VN): nhãn hiển thị, map qua getStatusLabel.
 *   - consignStatus (string key): map qua convertStatus*.
 *
 * Vòng đời:
 *   B1: PENDING (Phiếu tạm) -> CONFIRMED (Đã xác nhận).
 *   B2 (xử lý kho): PACKED (Đã đóng hàng) -> LOADING (Đang giao) -> DELIVERED
 *       (Đã giao - đang ký gửi). Trừ kho 1 lần tại CONFIRMED -> PACKED.
 *   B3 (xuất hóa đơn): PARTIALLY_INVOICED (Ký gửi một phần) -> COMPLETED (Hoàn thành).
 *   CANCELLED (Đã hủy).
 */
export const CONSIGNMENT_STATUS = {
  PENDING: 1,
  CONFIRMED: 2,
  PACKED: 3,
  LOADING: 4,
  DELIVERED: 5,
  PARTIALLY_INVOICED: 6,
  COMPLETED: 7,
  CANCELLED: 8,
} as const;

export const CONSIGNMENT_STATUS_LABELS = {
  [CONSIGNMENT_STATUS.PENDING]: 'Phiếu tạm',
  [CONSIGNMENT_STATUS.CONFIRMED]: 'Đã xác nhận',
  [CONSIGNMENT_STATUS.PACKED]: 'Đã đóng hàng',
  [CONSIGNMENT_STATUS.LOADING]: 'Đang giao',
  [CONSIGNMENT_STATUS.DELIVERED]: 'Đã giao (đang ký gửi)',
  [CONSIGNMENT_STATUS.PARTIALLY_INVOICED]: 'Ký gửi một phần',
  [CONSIGNMENT_STATUS.COMPLETED]: 'Hoàn thành',
  [CONSIGNMENT_STATUS.CANCELLED]: 'Đã hủy',
} as const;

export const CONSIGNMENT_STATUS_STRING_MAP = {
  pending: CONSIGNMENT_STATUS.PENDING,
  confirmed: CONSIGNMENT_STATUS.CONFIRMED,
  packed: CONSIGNMENT_STATUS.PACKED,
  loading: CONSIGNMENT_STATUS.LOADING,
  delivered: CONSIGNMENT_STATUS.DELIVERED,
  partially_invoiced: CONSIGNMENT_STATUS.PARTIALLY_INVOICED,
  completed: CONSIGNMENT_STATUS.COMPLETED,
  cancelled: CONSIGNMENT_STATUS.CANCELLED,
} as const;

export const CONSIGNMENT_STATUS_NUMBER_TO_STRING = {
  [CONSIGNMENT_STATUS.PENDING]: 'pending',
  [CONSIGNMENT_STATUS.CONFIRMED]: 'confirmed',
  [CONSIGNMENT_STATUS.PACKED]: 'packed',
  [CONSIGNMENT_STATUS.LOADING]: 'loading',
  [CONSIGNMENT_STATUS.DELIVERED]: 'delivered',
  [CONSIGNMENT_STATUS.PARTIALLY_INVOICED]: 'partially_invoiced',
  [CONSIGNMENT_STATUS.COMPLETED]: 'completed',
  [CONSIGNMENT_STATUS.CANCELLED]: 'cancelled',
} as const;

export function convertStatusStringToNumber(statusString: string): number {
  return CONSIGNMENT_STATUS_STRING_MAP[statusString] || CONSIGNMENT_STATUS.PENDING;
}

export function convertStatusNumberToString(statusNumber: number): string {
  return CONSIGNMENT_STATUS_NUMBER_TO_STRING[statusNumber] || 'pending';
}

export function getStatusLabel(status: number): string {
  return CONSIGNMENT_STATUS_LABELS[status] || 'Không xác định';
}
