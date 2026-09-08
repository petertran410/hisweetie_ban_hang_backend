/**
 * Phân tích độ ổn định doanh số theo đúng quy trình nghiệp vụ:
 *
 *   1. Nhìn 3 tháng gần nhất đã hoàn tất.
 *   2. Không bất thường → mức nền = trung bình 3 tháng.
 *   3. Có bất thường → đối chiếu khuyến mãi / trend, rồi soi thêm tháng 4 và 5.
 *   4. Tháng đột biến do KM/trend được tách khỏi mức nền, không kéo lệch forecast.
 *   5. Tháng bất thường không giải thích được → hạ độ tin cậy, không phóng đại nhu cầu.
 */

export interface MonthlySales {
  /** `YYYY-MM` */
  month: string;
  quantity: number;
  /** Số ngày có dữ liệu trong tháng — tháng đang chạy dở sẽ ít hơn. */
  days: number;
}

export interface PromotionWindow {
  startDate: Date;
  endDate: Date;
  name?: string | null;
}

export interface TrendWindow {
  startDate: Date;
  endDate: Date;
  name?: string | null;
}

export type MonthAnomaly = 'SPIKE' | 'DROP' | 'NORMAL';

export interface MonthAssessment {
  month: string;
  dailyRate: number;
  anomaly: MonthAnomaly;
  ratio: number;
  hasPromotion: boolean;
  promotionNames: string[];
  hasTrend: boolean;
  trendNames: string[];
  /** Bất thường mà không có khuyến mãi / trend giải thích. */
  suspectedTrend: boolean;
}

export type DemandStability = 'STABLE' | 'VOLATILE' | 'INSUFFICIENT_DATA';

export interface StabilityResult {
  baselineDailyDemand: number;
  stability: DemandStability;
  variationCoefficient: number;
  monthsUsed: number;
  months: MonthAssessment[];
  lookbackMonths: MonthAssessment[];
  lookbackRepeatsAnomaly: boolean;
  unexplainedAnomaly: boolean;
  trendMonths: string[];
  promotionMonths: string[];
}

const SPIKE_THRESHOLD = 1.4;
const DROP_THRESHOLD = 0.6;
const VOLATILE_CV = 0.35;

export function analyzeDemandStability(
  months: MonthlySales[],
  promotions: PromotionWindow[] = [],
  trends: TrendWindow[] = [],
): StabilityResult {
  const usable = months.filter((month) => month.days > 0);

  if (usable.length < 2) {
    return {
      baselineDailyDemand: usable[0] ? rate(usable[0]) : 0,
      stability: 'INSUFFICIENT_DATA',
      variationCoefficient: 0,
      monthsUsed: usable.length,
      months: usable.map((month) => emptyAssessment(month)),
      lookbackMonths: [],
      lookbackRepeatsAnomaly: false,
      unexplainedAnomaly: false,
      trendMonths: [],
      promotionMonths: [],
    };
  }

  const recent = usable.slice(-3);
  const recentAssessment = assess(recent, promotions, trends);
  const recentHasAnomaly = recentAssessment.some(
    (month) => month.anomaly !== 'NORMAL',
  );

  const lookbackSource = recentHasAnomaly ? usable.slice(-5, -3) : [];
  const lookbackMonths = lookbackSource.length
    ? assess(lookbackSource, promotions, trends)
    : [];
  const lookbackRepeatsAnomaly = lookbackMonths.some((month) =>
    recentAssessment.some(
      (recentMonth) =>
        recentMonth.anomaly !== 'NORMAL' &&
        month.anomaly === recentMonth.anomaly,
    ),
  );

  const assessments = recentAssessment;
  const unexplainedAnomaly = assessments.some(
    (month) => month.anomaly === 'SPIKE' && month.suspectedTrend,
  );

  const baseMonths = assessments.filter(
    (month) =>
      month.anomaly === 'NORMAL' ||
      ((month.hasPromotion || month.hasTrend) && month.anomaly === 'SPIKE'),
  );
  // Tháng KM/trend không đưa vào mức nền — phần tăng thêm được cộng riêng.
  const normalMonths = assessments.filter((month) => month.anomaly === 'NORMAL');
  const baseRates = (
    normalMonths.length > 0 ? normalMonths : baseMonths.length > 0 ? baseMonths : assessments
  ).map((month) => month.dailyRate);

  const baseline = mean(baseRates);
  const cv = coefficientOfVariation(assessments.map((m) => m.dailyRate));

  return {
    baselineDailyDemand: round(baseline),
    stability: cv > VOLATILE_CV ? 'VOLATILE' : 'STABLE',
    variationCoefficient: round(cv),
    monthsUsed: recent.length,
    months: assessments,
    lookbackMonths,
    lookbackRepeatsAnomaly,
    unexplainedAnomaly,
    trendMonths: assessments
      .filter((month) => month.suspectedTrend || month.hasTrend)
      .map((month) => month.month),
    promotionMonths: assessments
      .filter((month) => month.anomaly !== 'NORMAL' && month.hasPromotion)
      .map((month) => month.month),
  };
}

export function safetyDaysFromStability(
  result: StabilityResult,
  leadTimeDays: number,
): number {
  if (result.stability === 'INSUFFICIENT_DATA') {
    return Math.max(7, Math.round(leadTimeDays * 0.25));
  }
  const buffer = result.variationCoefficient * Math.sqrt(leadTimeDays) * 3;
  return Math.max(3, Math.round(buffer));
}

function emptyAssessment(month: MonthlySales): MonthAssessment {
  return {
    month: month.month,
    dailyRate: rate(month),
    anomaly: 'NORMAL',
    ratio: 1,
    hasPromotion: false,
    promotionNames: [],
    hasTrend: false,
    trendNames: [],
    suspectedTrend: false,
  };
}

function assess(
  months: MonthlySales[],
  promotions: PromotionWindow[],
  trends: TrendWindow[],
): MonthAssessment[] {
  const rates = months.map(rate);
  const reference = median(rates);

  return months.map((month, index) => {
    const dailyRate = rates[index];
    const ratio = reference > 0 ? dailyRate / reference : 1;
    const anomaly: MonthAnomaly =
      reference <= 0
        ? 'NORMAL'
        : ratio >= SPIKE_THRESHOLD
          ? 'SPIKE'
          : ratio <= DROP_THRESHOLD
            ? 'DROP'
            : 'NORMAL';

    const overlappingPromos = promotions.filter((promotion) =>
      overlapsMonth(month.month, promotion),
    );
    const overlappingTrends = trends.filter((trend) =>
      overlapsMonth(month.month, trend),
    );

    return {
      month: month.month,
      dailyRate: round(dailyRate),
      anomaly,
      ratio: round(ratio),
      hasPromotion: overlappingPromos.length > 0,
      promotionNames: overlappingPromos
        .map((promotion) => promotion.name)
        .filter((name): name is string => Boolean(name)),
      hasTrend: overlappingTrends.length > 0,
      trendNames: overlappingTrends
        .map((trend) => trend.name)
        .filter((name): name is string => Boolean(name)),
      suspectedTrend:
        anomaly === 'SPIKE' &&
        overlappingPromos.length === 0 &&
        overlappingTrends.length === 0,
    };
  });
}

function overlapsMonth(
  month: string,
  window: { startDate: Date; endDate: Date },
): boolean {
  const start = window.startDate.toISOString().slice(0, 7);
  const end = window.endDate.toISOString().slice(0, 7);
  return month >= start && month <= end;
}

function rate(month: MonthlySales): number {
  return month.days > 0 ? month.quantity / month.days : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (average <= 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / average;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
