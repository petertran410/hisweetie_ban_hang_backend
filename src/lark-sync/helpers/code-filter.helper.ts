/**
 * Chỉ sync đơn hàng có code dạng DH + số (DH000001, DH123456)
 * Loại bỏ: DHSPE001, DHTTS002, ...
 */
export function isValidOrderCode(code: string): boolean {
  return /^DH\d+$/.test(code);
}

/**
 * Chỉ sync hóa đơn có code dạng HD + số (HD000001)
 * Loại bỏ: HDSPE001, ...
 */
export function isValidInvoiceCode(code: string): boolean {
  return /^HD\d+$/.test(code);
}
