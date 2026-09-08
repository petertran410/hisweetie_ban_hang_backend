/**
 * Nhu cầu tăng thêm do trend do người dùng khai theo sản phẩm / nhóm hàng
 * và khoảng thời gian.
 *
 * Chỉ áp dụng khi khoảng trend giao với horizon đặt hàng. Trend hết hạn
 * không được cộng vào nhu cầu.
 */

const DAY_MS = 86_400_000;
const MAX_UPLIFT = 3;

export interface PlanningTrendWindow {
  id?: number;
  productId?: number | null;
  categoryName?: string | null;
  startDate: Date;
  endDate: Date;
  name?: string | null;
  note?: string | null;
  kind?: 'UPLIFT' | 'QUANTITY';
  upliftFactor?: number | null;
  extraQuantity?: number | null;
}

export interface TrendUpliftInput {
  today: Date;
  horizonDays: number;
  baselineDailyDemand: number;
  trends: PlanningTrendWindow[];
}

export interface TrendUpliftResult {
  extraDemand: number;
  trendDays: number;
  windows: Array<{
    id?: number;
    name: string | null;
    startDate: Date;
    endDate: Date;
    extraDemand: number;
  }>;
}

export function calculateTrendUplift(
  input: TrendUpliftInput,
): TrendUpliftResult {
  const empty: TrendUpliftResult = { extraDemand: 0, trendDays: 0, windows: [] };
  if (input.horizonDays <= 0) return empty;

  const horizonEnd = addDays(input.today, input.horizonDays);
  const active = input.trends.filter(
    (trend) => trend.endDate >= input.today && trend.startDate <= horizonEnd,
  );
  if (active.length === 0) return empty;

  const windows = active.map((trend) => {
    const overlapDays = countOverlapDays(
      trend.startDate,
      trend.endDate,
      input.today,
      horizonEnd,
    );
    const totalDays = Math.max(
      1,
      Math.floor((trend.endDate.getTime() - trend.startDate.getTime()) / DAY_MS) +
        1,
    );
    let extraDemand = 0;
    if (trend.extraQuantity != null && Number.isFinite(trend.extraQuantity)) {
      extraDemand = Math.max(0, trend.extraQuantity) * (overlapDays / totalDays);
    } else if (
      trend.upliftFactor != null &&
      Number.isFinite(trend.upliftFactor) &&
      input.baselineDailyDemand > 0
    ) {
      const factor = Math.min(MAX_UPLIFT, Math.max(1, trend.upliftFactor));
      extraDemand = input.baselineDailyDemand * (factor - 1) * overlapDays;
    }
    return {
      id: trend.id,
      name: trend.name ?? trend.note ?? null,
      startDate: trend.startDate,
      endDate: trend.endDate,
      extraDemand: Math.round(Math.max(0, extraDemand)),
    };
  });

  const trendDays = countCoveredDays(active, input.today, horizonEnd);
  return {
    extraDemand: windows.reduce((sum, window) => sum + window.extraDemand, 0),
    trendDays,
    windows: windows.filter((window) => window.extraDemand > 0),
  };
}

export function trendsForProduct(
  product: { id: number; parentName?: string | null; middleName?: string | null; childName?: string | null },
  trends: PlanningTrendWindow[],
): PlanningTrendWindow[] {
  return trends.filter((trend) => {
    if (trend.productId != null) return trend.productId === product.id;
    if (trend.categoryName) {
      return [
        product.parentName,
        product.middleName,
        product.childName,
      ].includes(trend.categoryName);
    }
    return false;
  });
}

function countOverlapDays(
  start: Date,
  end: Date,
  from: Date,
  to: Date,
): number {
  const rangeStart = Math.max(start.getTime(), from.getTime());
  const rangeEnd = Math.min(end.getTime(), to.getTime());
  if (rangeEnd < rangeStart) return 0;
  return Math.floor((rangeEnd - rangeStart) / DAY_MS) + 1;
}

function countCoveredDays(
  windows: Array<{ startDate: Date; endDate: Date }>,
  from: Date,
  to: Date,
): number {
  const ranges = windows
    .map((window) => ({
      start: Math.max(window.startDate.getTime(), from.getTime()),
      end: Math.min(window.endDate.getTime(), to.getTime()),
    }))
    .filter((range) => range.end >= range.start)
    .sort((a, b) => a.start - b.start);

  let days = 0;
  let cursor = -Infinity;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    if (range.end < start) continue;
    days += Math.floor((range.end - start) / DAY_MS) + 1;
    cursor = range.end + DAY_MS;
  }
  return days;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
