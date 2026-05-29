export const ORDER_STATUS = {
  PENDING: 1,
  COMPLETED: 3,
  CANCELLED: 4,
  CONFIRMED: 5,
  PARTIALLY_INVOICED: 6,
} as const;

export const ORDER_STATUS_LABELS = {
  [ORDER_STATUS.PENDING]: 'Phiếu tạm',
  [ORDER_STATUS.COMPLETED]: 'Hoàn thành',
  [ORDER_STATUS.CANCELLED]: 'Đã hủy',
  [ORDER_STATUS.CONFIRMED]: 'Đã xác nhận',
  [ORDER_STATUS.PARTIALLY_INVOICED]: 'Đã ra 1 phần hóa đơn',
} as const;

export const ORDER_STATUS_STRING_MAP = {
  pending: ORDER_STATUS.PENDING,
  completed: ORDER_STATUS.COMPLETED,
  cancelled: ORDER_STATUS.CANCELLED,
  confirmed: ORDER_STATUS.CONFIRMED,
  partially_invoiced: ORDER_STATUS.PARTIALLY_INVOICED,
} as const;

export const ORDER_STATUS_NUMBER_TO_STRING = {
  [ORDER_STATUS.PENDING]: 'pending',
  [ORDER_STATUS.COMPLETED]: 'completed',
  [ORDER_STATUS.CANCELLED]: 'cancelled',
  [ORDER_STATUS.CONFIRMED]: 'confirmed',
  [ORDER_STATUS.PARTIALLY_INVOICED]: 'partially_invoiced',
} as const;

export function convertStatusStringToNumber(statusString: string): number {
  return ORDER_STATUS_STRING_MAP[statusString] || ORDER_STATUS.PENDING;
}

export function convertStatusNumberToString(statusNumber: number): string {
  return ORDER_STATUS_NUMBER_TO_STRING[statusNumber] || 'pending';
}

export function getStatusLabel(status: number): string {
  return ORDER_STATUS_LABELS[status] || 'Không xác định';
}
