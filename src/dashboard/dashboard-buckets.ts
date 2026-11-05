/**
 * Hàm thuần cho các báo cáo trang chủ (gom mốc thời gian, khung giờ, tỷ lệ).
 * Tách khỏi service để test không cần cơ sở dữ liệu.
 */

export type Trunc = 'hour' | 'day' | 'month';

/**
 * Mức gom nhóm theo kỳ (giống `getRevenueTrend`): hôm nay / hôm qua theo giờ,
 * kỳ khác theo ngày; khoảng tự chọn ≤ 1 ngày theo giờ, ≤ 92 ngày theo ngày,
 * dài hơn theo tháng.
 */
export function trendTrunc(range: string, spanDays: number): Trunc {
  if (range === 'custom') {
    return spanDays <= 1 ? 'hour' : spanDays <= 92 ? 'day' : 'month';
  }
  return range === 'today' || range === 'yesterday' ? 'hour' : 'day';
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Nhãn mốc thời gian. Mốc đã đổi sang giờ Việt Nam trong SQL (timestamp
 * không múi giờ) nên Prisma trả về như giờ UTC → đọc bằng getUTC* để không
 * phụ thuộc múi giờ của máy chủ.
 */
export function localBucketLabel(d: Date, trunc: Trunc): string {
  if (trunc === 'hour') return pad(d.getUTCHours());
  if (trunc === 'month')
    return `${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}

export interface HeatCell {
  /** 0 = Chủ nhật … 6 = Thứ Bảy (giống EXTRACT(DOW) của Postgres). */
  dow: number;
  /** 0–23, giờ Việt Nam. */
  hour: number;
  revenue: number;
  count: number;
}

/** Chuẩn hoá hàng SQL của báo cáo khung giờ; bỏ hàng sai (thứ/giờ ngoài khoảng). */
export function toHeatCells(
  rows: { dow: unknown; hour: unknown; revenue: unknown; cnt: unknown }[],
): HeatCell[] {
  const cells: HeatCell[] = [];
  for (const r of rows) {
    const dow = Number(r.dow);
    const hour = Number(r.hour);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    cells.push({
      dow,
      hour,
      revenue: Number(r.revenue) || 0,
      count: Number(r.cnt) || 0,
    });
  }
  return cells;
}

/** Tỷ lệ % (1 chữ số thập phân); mẫu số 0 → 0. */
export function ratePct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
