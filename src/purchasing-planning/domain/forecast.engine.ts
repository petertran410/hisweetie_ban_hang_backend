import { daysBetween, round, toDateKey } from './date';
import { DemandDay, ForecastConfidence, ForecastResult } from './models';

export interface ForecastInput {
  days: DemandDay[];
  asOfDate: string | Date;
  firstActivityDate?: string | Date | null;
  growthFactor?: number;
  minDays?: number;
}

const CONFIDENCE: ForecastConfidence[] = [
  'NO_DATA',
  'VERY_LOW',
  'LOW',
  'MEDIUM',
  'HIGH',
];

function confidenceForDays(days: number, minDays: number): ForecastConfidence {
  if (days < minDays) return 'NO_DATA';
  if (days < 30) return 'VERY_LOW';
  if (days < 60) return 'LOW';
  if (days < 90) return 'MEDIUM';
  return 'HIGH';
}

function lowerConfidence(value: ForecastConfidence): ForecastConfidence {
  if (value === 'NO_DATA') return value;
  return CONFIDENCE[Math.max(1, CONFIDENCE.indexOf(value) - 1)];
}

function movingAverage(
  days: DemandDay[],
  asOfDate: string,
  window: number,
): { value: number | null; validDays: number } {
  const start = new Date(`${asOfDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - window + 1);
  const startKey = toDateKey(start);
  const selected = days.filter(
    (day) => day.date >= startKey && day.date <= asOfDate && day.hadStock,
  );
  if (selected.length === 0) return { value: null, validDays: 0 };
  // PRD §5.4: denominator is valid in-stock days, including zero-demand days.
  return {
    value: round(
      selected.reduce((total, day) => total + Math.max(0, day.demand), 0) /
        selected.length,
    ),
    validDays: selected.length,
  };
}

function calendarAverage(days: DemandDay[], asOfDate: string, window: number) {
  if (window <= 0) return null;
  const start = new Date(`${asOfDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - window + 1);
  const startKey = toDateKey(start);
  return round(
    days
      .filter((day) => day.date >= startKey && day.date <= asOfDate)
      .reduce((total, day) => total + Math.max(0, day.demand), 0) / window,
  );
}

export function forecastDemand(input: ForecastInput): ForecastResult {
  const asOfDate = toDateKey(input.asOfDate);
  const minDays = input.minDays ?? 14;
  const growthFactor = input.growthFactor ?? 1;
  const normalized = input.days.map((day) => ({
    ...day,
    date: toDateKey(day.date),
  }));
  const usedHeuristic = normalized.some((day) => day.hadStock === undefined);
  const days = normalized.map((day) => ({
    ...day,
    // PRD §5.6: without stock history, a sales day is an in-stock day proxy.
    hadStock: day.hadStock ?? day.demand > 0,
  }));
  const firstDate = input.firstActivityDate
    ? toDateKey(input.firstActivityDate)
    : days.reduce<string | null>(
        (first, day) => (!first || day.date < first ? day.date : first),
        null,
      );
  const skuAgeDays = firstDate
    ? Math.max(1, daysBetween(firstDate, asOfDate) + 1)
    : 0;
  const maxWindow = Math.min(90, skuAgeDays);
  const ma30 = movingAverage(days, asOfDate, Math.min(30, maxWindow));
  const ma60 = movingAverage(days, asOfDate, Math.min(60, maxWindow));
  const ma90 = movingAverage(days, asOfDate, maxWindow);
  // PRD §5.5: use all available SKU age up to the 90-day cap.
  const windowDays = maxWindow;
  const selected = movingAverage(days, asOfDate, windowDays);
  const windowStart = new Date(`${asOfDate}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays + 1);
  const windowStartKey = toDateKey(windowStart);
  const totalDemand = days
    .filter((day) => day.date >= windowStartKey && day.date <= asOfDate)
    .reduce((total, day) => total + Math.max(0, day.demand), 0);
  const ageConfidence = confidenceForDays(skuAgeDays, minDays);
  const stockConfidence = confidenceForDays(selected.validDays, minDays);
  let confidence =
    CONFIDENCE.indexOf(ageConfidence) < CONFIDENCE.indexOf(stockConfidence)
      ? ageConfidence
      : stockConfidence;
  const flags: ForecastResult['flags'] = [];
  if (usedHeuristic) {
    confidence = lowerConfidence(confidence);
    flags.push('LOW_CONFIDENCE_FORECAST');
  }
  // Dữ liệu B2B bán theo lô có ít ngày giao dịch. Khi heuristic không đủ mẫu,
  // dùng calendar-day MA để không biến nhu cầu có thật thành NO_DATA và cũng
  // không phóng đại một ngày bán thành nhu cầu mỗi ngày.
  const calendarFallback =
    usedHeuristic && confidence === 'NO_DATA' && totalDemand > 0;
  if (calendarFallback) {
    confidence = 'VERY_LOW';
    if (!flags.includes('LOW_CONFIDENCE_FORECAST'))
      flags.push('LOW_CONFIDENCE_FORECAST');
  }
  if (confidence === 'NO_DATA') flags.push('NO_DATA');

  return {
    forecastDailyDemand:
      confidence === 'NO_DATA'
        ? 0
        : round(
            (calendarFallback
              ? totalDemand / Math.max(1, windowDays)
              : (selected.value ?? 0)) * growthFactor,
          ),
    ma30: calendarFallback
      ? calendarAverage(days, asOfDate, Math.min(30, maxWindow))
      : ma30.value,
    ma60: calendarFallback
      ? calendarAverage(days, asOfDate, Math.min(60, maxWindow))
      : ma60.value,
    ma90: calendarFallback
      ? calendarAverage(days, asOfDate, maxWindow)
      : ma90.value,
    windowDays,
    validStockDays: selected.validDays,
    skuAgeDays,
    growthFactor,
    confidence,
    flags,
  };
}
