/** Escape giá trị trước khi chèn vào HTML mẫu in. */
export function escapeHtml(
  value: string | number | boolean | null | undefined,
): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML do chính service dựng (ảnh QR, nhãn tên hàng, bảng nguyên liệu…).
 * Mọi chữ từ bản ghi bên trong phải được escape ngay lúc dựng. Giá trị thường
 * (chuỗi, số) luôn bị escape khi thay biến; chỉ TrustedHtml được giữ nguyên.
 */
export class TrustedHtml {
  constructor(readonly html: string) {}

  toString(): string {
    return this.html;
  }

  toJSON(): string {
    return this.html;
  }
}

export function trustedHtml(html: string): TrustedHtml {
  return new TrustedHtml(html);
}
