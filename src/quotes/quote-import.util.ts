/**
 * Import file "Bảng báo giá tổng hợp" → Thư viện báo giá: hàm thuần (không DB)
 * để khớp tên sản phẩm Excel với sản phẩm POS và đọc tiêu đề cột giá.
 */

const STOP = new Set([
  'gau',
  'lermao',
  'bao',
  'quan',
  'tu',
  'dong',
  'lanh',
  'tui',
  'thung',
  'hop',
  'goi',
  'nau',
  'u',
  'lon',
]);

/** Bỏ dấu, đ→d, gộp đơn vị khối lượng ("500 gr" → "500g"), tách từ, bỏ từ không phân biệt sản phẩm. */
export function nameTokens(name: string): Set<string> {
  const s = name
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(
      /(\d)\s*(kg|gr|g)\b/g,
      (_, d, u) => `${d}${u === 'kg' ? 'kg' : 'g'}`,
    );
  return new Set((s.match(/[a-z0-9.]+/g) ?? []).filter((t) => !STOP.has(t)));
}

export interface ProductCandidate {
  id: number;
  name: string;
}

/**
 * Sản phẩm POS khớp tên Excel: phủ ≥ 90% từ của tên Excel; hoà thì chọn tên ít từ thừa hơn.
 * Bỏ qua "Mẫu thử". Không khớp → null (in ra ở dry-run để Sale khớp tay).
 */
export function matchProduct<T extends ProductCandidate>(
  excelName: string,
  products: T[],
): T | null {
  const want = nameTokens(excelName);
  if (!want.size) return null;
  let best: { p: T; cov: number; extra: number } | null = null;
  for (const p of products) {
    if (/m[ẫa]u\s*th[ửu]/i.test(p.name)) continue;
    const have = nameTokens(p.name);
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    const cov = hit / want.size;
    const extra = [...have].filter((t) => !want.has(t)).length;
    if (!best || cov > best.cov || (cov === best.cov && extra < best.extra))
      best = { p, cov, extra };
  }
  return best && best.cov >= 0.9 ? best.p : null;
}

/** Tiêu đề cột giá Excel → khung giá. null = không phải cột giá. */
export function tierFromHeader(header: string): {
  key: string;
  label: string;
  minQty: number | null;
  maxQty: number | null;
} | null {
  const h = header.replace(/\s+/g, ' ').toLowerCase();
  if (!h.startsWith('giá')) return null;
  if (h.includes('ctv'))
    return { key: 'ctv', label: 'Giá CTV', minQty: null, maxQty: null };
  if (/<\s*10/.test(h))
    return { key: 'dl_lt10', label: 'Giá Đại lý < 10T', minQty: 1, maxQty: 9 };
  if (/>=\s*10|≥\s*10/.test(h))
    return {
      key: 'dl_ge10',
      label: 'Giá Đại lý ≥ 10T',
      minQty: 10,
      maxQty: null,
    };
  if (h.includes('buôn'))
    return { key: 'buon', label: 'Giá buôn', minQty: null, maxQty: null };
  if (h.includes('lẻ'))
    return { key: 'le', label: 'Giá lẻ', minQty: null, maxQty: null };
  return null;
}

/** "(30 túi/ thùng)" → "30 túi/ thùng". */
export const cleanSpec = (s: string) =>
  s
    .trim()
    .replace(/^\((.*)\)$/, '$1')
    .trim();

/** "Kính gủi: Quý Đại lý" → "Quý Đại lý" (file có lỗi chính tả "gủi"). */
export const cleanGreeting = (s: string) =>
  s.replace(/^\s*kính\s+g[ửủu]i\s*:\s*/i, '').trim();

/** "(Áp dụng … từ ngày 01/09/2026)" hoặc "… ngày 01 tháng 09 năm 2026" → "2026-09-01". */
export function parseAppliedDate(s: string): string | null {
  const m =
    s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) ??
    s.match(/(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
