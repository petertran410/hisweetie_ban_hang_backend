// Tính kỳ hiện tại / kỳ so sánh cho báo cáo Phân tích, chép đúng logic DAX của
// Power BI (dataset_sale: growth_*_samePeriod, switch_dynamics_metrics_sameYear).
// Toàn bộ là hàm thuần trên ngày dạng 'YYYY-MM-DD' (không múi giờ).

export const CALENDAR_START = '2022-01-01'; // dim_date = CALENDAR(DATE(2022,1,1), TODAY())

export type IsoDate = string; // 'YYYY-MM-DD'

const pad = (n: number) => String(n).padStart(2, '0');

/** DATE(y, m, d) của DAX: tự tràn (vd 2025-02-29 → 2025-03-01, tháng 13 → năm sau). */
export function daxDate(y: number, m: number, d: number): IsoDate {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function parts(date: IsoDate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { y, m, d } = parts(date);
  return daxDate(y, m, d + days);
}

/** Số ngày từ a đến b (DATEDIFF(a, b, DAY)). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  const ta = Date.UTC(parts(a).y, parts(a).m - 1, parts(a).d);
  const tb = Date.UTC(parts(b).y, parts(b).m - 1, parts(b).d);
  return Math.round((tb - ta) / 86400000);
}

/** EDATE(date, n): cộng n tháng, ngày vượt cuối tháng thì lấy ngày cuối tháng. */
export function edate(date: IsoDate, months: number): IsoDate {
  const { y, m, d } = parts(date);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = first.getUTCFullYear();
  const tm = first.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${pad(tm)}-${pad(Math.min(d, lastDay))}`;
}

/** Hôm nay theo giờ Việt Nam (UTC+7). */
export function todayVn(now: Date = new Date()): IsoDate {
  const vn = new Date(now.getTime() + 7 * 3600 * 1000);
  return `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())}`;
}

export interface PeriodSelection {
  year: number;
  months: number[]; // rỗng = cả năm
}

export interface CurrentPeriod {
  /** Ngày nhỏ nhất / lớn nhất của tập ngày đang lọc (đã cắt tới hôm nay). */
  min: IsoDate;
  max: IsoDate;
  /** Các tháng thực sự có ngày trong tập (sau khi cắt tới hôm nay). */
  months: number[];
  /** COUNTROWS(VALUES(dim_date[Month])) = 1 */
  hasMonthFilter: boolean;
}

/**
 * Tập ngày đang lọc = các ngày của năm (và các tháng chọn), nằm trong
 * [CALENDAR_START, hôm nay]. Trả null nếu tập rỗng (vd năm tương lai).
 */
export function currentPeriod(
  sel: PeriodSelection,
  today: IsoDate,
): CurrentPeriod | null {
  const months = (
    sel.months.length
      ? [...new Set(sel.months)]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  )
    .filter((m) => m >= 1 && m <= 12)
    .sort((a, b) => a - b);
  const valid: number[] = [];
  let min: IsoDate | null = null;
  let max: IsoDate | null = null;
  for (const m of months) {
    let from = daxDate(sel.year, m, 1);
    let to = daxDate(sel.year, m + 1, 0);
    if (from < CALENDAR_START) from = CALENDAR_START;
    if (to > today) to = today;
    if (from > to) continue;
    valid.push(m);
    if (!min || from < min) min = from;
    if (!max || to > max) max = to;
  }
  if (!min || !max) return null;
  return { min, max, months: valid, hasMonthFilter: valid.length === 1 };
}

export interface CompareWindow {
  from: IsoDate;
  to: IsoDate;
  /** Nhãn "vs …": 'MM/yyyy' (so tháng trước) hoặc 'YYYY' (so năm trước). */
  label: string;
}

/**
 * Kỳ so sánh của các thẻ (growth_*_samePeriod):
 *  - Đúng 1 tháng: [EDATE(min,-1), EDATE(max,-1)], nhãn MM/yyyy của EDATE(max,-1).
 *  - Còn lại: bắt đầu DATE(YEAR(min)-1, MONTH(min), DAY(min)), kéo dài cùng số
 *    ngày (max-min); nhãn = YEAR(max)-1.
 */
export function compareWindow(p: CurrentPeriod): CompareWindow {
  if (p.hasMonthFilter) {
    const from = edate(p.min, -1);
    const to = edate(p.max, -1);
    const { y, m } = parts(to);
    return { from, to, label: `${pad(m)}/${y}` };
  }
  const r = sameYearRange(p.min, p.max);
  return { ...r, label: String(parts(p.max).y - 1) };
}

/** switch_dynamics_metrics_sameYear: cùng ngày bắt đầu năm trước + cùng số ngày. */
export function sameYearRange(
  min: IsoDate,
  max: IsoDate,
): { from: IsoDate; to: IsoDate } {
  const { y, m, d } = parts(min);
  const from = daxDate(y - 1, m, d);
  return { from, to: addDays(from, diffDays(min, max)) };
}

/** Lùi 1 năm cho từng ngày (dùng cho trục Ngày / Thứ). */
export function shiftYear(date: IsoDate): IsoDate {
  const { y, m, d } = parts(date);
  return daxDate(y - 1, m, d);
}

/** Liệt kê mọi ngày trong tập đang lọc. */
export function listDates(p: CurrentPeriod, year: number): IsoDate[] {
  const out: IsoDate[] = [];
  for (const m of p.months) {
    let cur = daxDate(year, m, 1);
    const end = daxDate(year, m + 1, 0);
    while (cur <= end) {
      if (cur >= p.min && cur <= p.max) out.push(cur);
      cur = addDays(cur, 1);
    }
  }
  return out;
}

/** Thứ theo kiểu Power BI (vie_week_day): 1=Thứ 2 … 7=Chủ Nhật. */
export function isoWeekday(date: IsoDate): number {
  const { y, m, d } = parts(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=CN
  return wd === 0 ? 7 : wd;
}
