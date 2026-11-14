/**
 * Báo giá — hàm thuần (không DB): khung giá theo số lượng, lợi nhuận đại lý,
 * chuẩn hoá giá khi import file Excel báo giá.
 */

export interface TierLike {
  key: string;
  label: string;
  minQty: number | null;
  maxQty: number | null;
  price?: number | null;
}

const bounded = (t: TierLike) => t.minQty != null || t.maxQty != null;

/**
 * Khung áp dụng cho số lượng `qty` (cùng đơn vị với khung, mặc định thùng).
 * Khung không có cận (Giá lẻ, Giá CTV — theo loại khách) bị bỏ qua.
 */
export function tierForQty<T extends TierLike>(
  tiers: T[],
  qty: number,
): T | null {
  return (
    tiers.find(
      (t) =>
        bounded(t) &&
        (t.minQty == null || qty >= t.minQty) &&
        (t.maxQty == null || qty <= t.maxQty),
    ) ?? null
  );
}

/** Lỗi đầu tiên của bộ khung (null = hợp lệ): nhãn trống, trùng khoá, từ > đến, khoảng chồng nhau. */
export function validateTiers(tiers: TierLike[]): string | null {
  if (!tiers.length) return 'Cần ít nhất 1 khung giá';
  const keys = new Set<string>();
  for (const t of tiers) {
    if (!t.label?.trim()) return 'Khung giá cần có nhãn';
    if (keys.has(t.key)) return `Trùng khoá khung giá "${t.key}"`;
    keys.add(t.key);
    if (
      (t.minQty != null && t.minQty < 0) ||
      (t.maxQty != null && t.maxQty < 0)
    )
      return `Khung "${t.label}": số lượng không được âm`;
    if (t.minQty != null && t.maxQty != null && t.minQty > t.maxQty)
      return `Khung "${t.label}": số lượng từ lớn hơn số lượng đến`;
    if (t.price != null && t.price < 0)
      return `Khung "${t.label}": giá không được âm`;
  }
  const ranges = tiers
    .filter(bounded)
    .map((t) => ({ t, lo: t.minQty ?? 0, hi: t.maxQty ?? Infinity }))
    .sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].lo <= ranges[i - 1].hi)
      return `Khung "${ranges[i - 1].t.label}" và "${ranges[i].t.label}" chồng khoảng số lượng`;
  }
  return null;
}

/**
 * Lợi nhuận đại lý như cột "Lợi Nhuận" trong file Excel:
 * (giá khung đầu − giá thấp nhất) ÷ giá thấp nhất.
 */
export function marginPct(tiers: TierLike[]): number | null {
  const prices = tiers
    .map((t) => t.price)
    .filter((p): p is number => p != null && p > 0);
  const first = tiers[0]?.price;
  if (prices.length < 2 || first == null) return null;
  const low = Math.min(...prices);
  return (first - low) / low;
}

/**
 * Hệ số đơn vị giá của một sheet: có sheet ghi 38 (= 38.000đ), có sheet ghi 95000.
 * Giá lớn nhất của sheet < 100.000 → sheet ghi theo nghìn đồng → ×1000.
 * Xét cả sheet (không từng ô) vì sheet nghìn đồng vẫn có giá như 2050 (= 2.050.000đ / bao 25kg).
 */
export function sheetPriceMultiplier(prices: number[]): 1 | 1000 {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (!valid.length) return 1;
  return Math.max(...valid) < 100_000 ? 1000 : 1;
}

/** Giá ô Excel → VNĐ. Chữ (COMING SOON), trống, âm → null. */
export function toVnd(value: unknown, multiplier: 1 | 1000): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+([.,]\d+)?\s*$/.test(value)
        ? Number(value.replace(',', '.'))
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * multiplier);
}
