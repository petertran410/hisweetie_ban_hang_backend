/** So khớp tên hàng khách gõ trong chat ("mut xoai", "trà lài") với sản phẩm POS. */

export type MatchProduct = {
  id: number;
  code: string;
  name: string;
  unit: string | null;
};

/** Chữ thường, bỏ dấu tiếng Việt, đ → d. */
export const foldVi = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

// Từ xưng hô / đặt hàng trong câu chat, không phải tên hàng
const STOP = new Set(
  'lay cho chi em anh minh ban oi nhe nha a ah voi va them gui dat mua giup con co khong ko ha di nua so luong sl'.split(
    ' ',
  ),
);

const tokens = (s: string) =>
  foldVi(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));

/**
 * Sản phẩm khớp nhất với `query`, tối đa `limit`. Điểm = tỉ lệ từ khớp trong tên / mã,
 * cộng thêm nếu khách đã mua (`bought`: productId → số lần). Mã sản phẩm gõ đúng xếp đầu.
 */
export function matchProducts<T extends MatchProduct>(
  query: string,
  products: readonly T[],
  bought: ReadonlyMap<number, number> = new Map(),
  limit = 5,
): T[] {
  const words = tokens(query);
  if (!words.length) return [];
  const q = foldVi(query).trim();
  // Từ gốc còn dấu: "đào" khớp đúng dấu xếp trên "đao"
  const accented = query
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && foldVi(t) !== t);
  const wantsSample = q.includes('mau thu');
  const scored: { product: T; score: number }[] = [];
  for (const product of products) {
    const code = product.code.toLowerCase();
    if (code === q || words.includes(code)) {
      scored.push({ product, score: 10 });
      continue;
    }
    const name = foldVi(product.name);
    const nameWords = new Set(name.split(/[^a-z0-9]+/));
    let hit = 0;
    words.forEach((w, i) => {
      // Từ ngắn (vd "1kg", "tra") phải khớp nguyên từ; từ dài cho phép khớp một phần;
      // từ cuối có thể gõ dở ("siro đ") → khớp đầu từ
      if (
        nameWords.has(w) ||
        (w.length >= 4 && name.includes(w)) ||
        (i === words.length - 1 && [...nameWords].some((n) => n.startsWith(w)))
      )
        hit += 1;
    });
    const ratio = hit / words.length;
    if (ratio < 0.5) continue;
    const times = bought.get(product.id) ?? 0;
    const lower = product.name.normalize('NFC').toLowerCase();
    const exact = accented.filter((t) => lower.includes(t)).length * 0.1;
    // Hàng mẫu thử ít khi là món khách đặt
    const sample = !wantsSample && name.includes('mau thu') ? 0.3 : 0;
    // Ưu tiên tên ngắn (ít từ thừa) khi cùng tỉ lệ khớp
    const tight = hit / Math.max(nameWords.size, 1);
    scored.push({
      product,
      score:
        ratio +
        (times ? 0.4 + Math.min(times, 10) * 0.02 : 0) +
        tight * 0.1 +
        exact -
        sample,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.product);
}

/** Lấy JSON đầu tiên trong câu trả lời của model (bỏ ```json, lời dẫn). */
export function parseJsonReply<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
