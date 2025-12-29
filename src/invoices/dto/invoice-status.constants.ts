export const INVOICE_STATUS = {
  COMPLETED: 1,
  CANCELLED: 2,
  PROCESSING: 3,
  FAILED_DELIVERY: 4,
} as const;

export const INVOICE_STATUS_LABELS = {
  [INVOICE_STATUS.PROCESSING]: 'Đang xử lý',
  [INVOICE_STATUS.CANCELLED]: 'Đã hủy',
  [INVOICE_STATUS.COMPLETED]: 'Hoàn thành',
  [INVOICE_STATUS.FAILED_DELIVERY]: 'Không giao được',
} as const;

export const INVOICE_STATUS_STRING_MAP = {
  processing: INVOICE_STATUS.PROCESSING,
  completed: INVOICE_STATUS.COMPLETED,
  cancelled: INVOICE_STATUS.CANCELLED,
  failed_delivery: INVOICE_STATUS.FAILED_DELIVERY,
} as const;

export const INVOICE_STATUS_NUMBER_TO_STRING = {
  [INVOICE_STATUS.FAILED_DELIVERY]: 'failed_delivery',
  [INVOICE_STATUS.PROCESSING]: 'processing',
  [INVOICE_STATUS.COMPLETED]: 'completed',
  [INVOICE_STATUS.CANCELLED]: 'cancelled',
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
