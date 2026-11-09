/**
 * SĐT Việt Nam về dạng 0xxxxxxxxx (10 số): bỏ khoảng trắng / dấu chấm / gạch, "+84" / "84" → "0",
 * bỏ hậu tố trùng của KiotViet (".1", ".2"). Không phải SĐT di động / bàn 10 số → null.
 */
export function normalizeVnPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const compact = raw
    .trim()
    .replace(/\.\d{1,2}$/, '')
    .replace(/[\s.\-()]/g, '');
  const m = compact.match(/^(?:\+?84|0)(\d{9})$/);
  return m ? `0${m[1]}` : null;
}
