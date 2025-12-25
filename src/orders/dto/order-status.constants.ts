export const ORDER_STATUS = {
  PENDING: 1,
  CONFIRMED: 5,
  PROCESSING: 2,
  COMPLETED: 3,
  CANCELLED: 4,
} as const;

export const ORDER_STATUS_LABELS = {
  [ORDER_STATUS.PENDING]: 'Phiếu tạm',
  [ORDER_STATUS.CONFIRMED]: 'Đã xác nhận',
  [ORDER_STATUS.PROCESSING]: 'Đang giao hàng',
  [ORDER_STATUS.COMPLETED]: 'Hoàn thành',
  [ORDER_STATUS.CANCELLED]: 'Đã hủy',
} as const;

export const ORDER_STATUS_STRING_MAP = {
  pending: ORDER_STATUS.PENDING,
  confirmed: ORDER_STATUS.CONFIRMED,
  processing: ORDER_STATUS.PROCESSING,
  completed: ORDER_STATUS.COMPLETED,
  cancelled: ORDER_STATUS.CANCELLED,
} as const;

export const ORDER_STATUS_NUMBER_TO_STRING = {
  [ORDER_STATUS.PENDING]: 'pending',
  [ORDER_STATUS.CONFIRMED]: 'confirmed',
  [ORDER_STATUS.PROCESSING]: 'processing',
  [ORDER_STATUS.COMPLETED]: 'completed',
  [ORDER_STATUS.CANCELLED]: 'cancelled',
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
