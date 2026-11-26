// Tìm mã đơn (DH…) / hóa đơn (HD…) trong nội dung chuyển khoản.
//
// Hậu tố của mã đã sửa luôn có đúng 2 chữ số (HD049170.01 — xem
// generateInvoiceCodeWithSuffix). Nội dung chuyển khoản QR của ngân hàng hay
// nối ngày ngay sau mã bằng dấu chấm (".DH129766.20261120.") nên chỉ nhận
// ".dd" không có chữ số liền sau, tránh đọc nhầm thành "DH129766.20261120".
const DOCUMENT_CODE_PATTERN = /(HD|DH)(\d+)(?:\.(\d{2})(?!\d))?/gi;

/**
 * Các mã ứng viên theo thứ tự xuất hiện trong nội dung, viết hoa, không trùng.
 * Mã có hậu tố đứng trước mã gốc của nó (HD049170.01 rồi HD049170) để vẫn
 * khớp được khi bản đã sửa không tồn tại.
 */
export function extractDocumentCodeCandidates(content: string): string[] {
  const candidates: string[] = [];
  for (const match of content.matchAll(DOCUMENT_CODE_PATTERN)) {
    const base = `${match[1]}${match[2]}`.toUpperCase();
    if (match[3]) candidates.push(`${base}.${match[3]}`);
    candidates.push(base);
  }
  return [...new Set(candidates)];
}
