export const INVOICE_STATUS = {
  COMPLETED: 1,
  CANCELLED: 2,
  PROCESSING: 3,
  FAILED_DELIVERY: 4,
  PACKED: 5,
  LOADING: 6,
  DELIVERED: 7,
  RETURNED: 8,
} as const;

export const INVOICE_STATUS_LABELS = {
  [INVOICE_STATUS.PROCESSING]: 'Đang xử lý',
  [INVOICE_STATUS.CANCELLED]: 'Đã hủy',
  [INVOICE_STATUS.COMPLETED]: 'Hoàn thành',
  [INVOICE_STATUS.FAILED_DELIVERY]: 'Không giao được',
  [INVOICE_STATUS.PACKED]: 'Đóng hàng',
  [INVOICE_STATUS.LOADING]: 'Lấy hàng',
  [INVOICE_STATUS.DELIVERED]: 'Giao thành công',
  [INVOICE_STATUS.RETURNED]: 'Trả hàng',
} as const;

export const INVOICE_STATUS_STRING_MAP = {
  processing: INVOICE_STATUS.PROCESSING,
  completed: INVOICE_STATUS.COMPLETED,
  cancelled: INVOICE_STATUS.CANCELLED,
  failed_delivery: INVOICE_STATUS.FAILED_DELIVERY,
  packed: INVOICE_STATUS.PACKED,
  loading: INVOICE_STATUS.LOADING,
  delivered: INVOICE_STATUS.DELIVERED,
  returned: INVOICE_STATUS.RETURNED,
} as const;

export const INVOICE_STATUS_NUMBER_TO_STRING = {
  [INVOICE_STATUS.COMPLETED]: 'completed',
  [INVOICE_STATUS.CANCELLED]: 'cancelled',
  [INVOICE_STATUS.PROCESSING]: 'processing',
  [INVOICE_STATUS.FAILED_DELIVERY]: 'failed_delivery',
  [INVOICE_STATUS.PACKED]: 'packed',
  [INVOICE_STATUS.LOADING]: 'loading',
  [INVOICE_STATUS.DELIVERED]: 'delivered',
  [INVOICE_STATUS.RETURNED]: 'returned',
} as const;

export function convertStatusStringToNumber(statusString: string): number {
  return INVOICE_STATUS_STRING_MAP[statusString] || INVOICE_STATUS.PROCESSING;
}

export function convertStatusNumberToString(statusNumber: number): string {
  return INVOICE_STATUS_NUMBER_TO_STRING[statusNumber] || 'pending';
}

export function getStatusLabel(status: number): string {
  return INVOICE_STATUS_LABELS[status] || 'Không xác định';
}
