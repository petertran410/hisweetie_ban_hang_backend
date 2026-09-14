/**
 * Phân tích độ ổn định doanh số theo đúng quy trình nghiệp vụ:
 *
 *   1. Nhìn 3 tháng gần nhất đã hoàn tất.
 *   2. Không bất thường → mức nền = trung bình 3 tháng.
 *   3. Có bất thường → đối chiếu khuyến mãi / trend và soi lại lịch sử dài hơn.
 *   4. Tháng đột biến do KM/trend được tách khỏi mức nền, không kéo lệch forecast.
 *   5. Tháng bất thường không giải thích được → hạ độ tin cậy, không phóng đại nhu cầu.
 */

export interface MonthlySales {
  /** `YYYY-MM` */
  month: string;
  quantity: number;
  /** Số ngày quan sát trong tháng — tháng đang chạy dở sẽ ít hơn. */
  days: number;
  /** Số ngày lịch thực tế của tháng. */
  daysInMonth?: number;
  /** Số ngày xác nhận SKU có hàng, dùng làm mẫu số bán/ngày. */
  validSellingDays?: number;
  /** `false` khi đã biết SKU hết hàng cả tháng; `undefined` là thiếu lịch sử. */
  hadStock?: boolean;
  /** Có snapshot tồn kho cho ít nhất một ngày trong tháng hay không. */
  stockDataAvailable?: boolean;
  /** Số ngày có snapshot tồn kho trong tháng. */
  stockDataDays?: number;
  /** Tháng snapshot hiện tại, chỉ dùng số ngày đã trôi qua. */
  isCurrentMonth?: boolean;
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
  quantity?: number;
  daysInMonth?: number;
  validSellingDays?: number;
  hadStock?: boolean;
  stockDataAvailable?: boolean;
  stockDataDays?: number;
  isCurrentMonth?: boolean;
  dailyRate: number;
  anomaly: MonthAnomaly;
  anomalyReason?: string | null;
  ratio: number;
  hasPromotion: boolean;
  promotionNames: string[];
  hasTrend: boolean;
  trendNames: string[];
  /** Bất thường mà không có khuyến mãi / trend giải thích. */
  suspectedTrend: boolean;
}

export type DemandStability = 'STABLE' | 'VOLATILE' | 'INSUFFICIENT_DATA';
export type GrowthFactorConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';

export interface StabilityResult {
  baselineDailyDemand: number;
  stability: DemandStability;
  variationCoefficient: number;
  monthsUsed: number;
  months: MonthAssessment[];
  /** 24 tháng đã hoàn tất cộng tháng hiện tại dở, dùng cho trace và biểu đồ. */
  historyMonths: MonthAssessment[];
  lookbackMonths: MonthAssessment[];
  lookbackRepeatsAnomaly: boolean;
  unexplainedAnomaly: boolean;
  trendMonths: string[];
  promotionMonths: string[];
  /** Hệ số tăng trưởng đề xuất từ xu hướng ngắn hạn và mùa vụ. */
  systemGrowthFactor: number;
  shortTermTrend: number;
  seasonalIndex: number | null;
  seasonalWeight: number;
  growthFactorConfidence: GrowthFactorConfidence;
  growthFactorMethod: string;
  growthFactorDataMonths: number;
  growthFactorWarnings: string[];
  growthFactorAnalysis: {
    inputMonths: number;
    cleanMonths: number;
    excludedMonths: string[];
    shortTermTrend: number;
    seasonalIndex: number | null;
    seasonalWeight: number;
    systemGrowthFactor: number;
    confidence: GrowthFactorConfidence;
    formula: string;
  };
}

const SPIKE_THRESHOLD = 1.4;
const DROP_THRESHOLD = 0.6;
const VOLATILE_CV = 0.35;

export function analyzeDemandStability(
  months: MonthlySales[],
  promotions: PromotionWindow[] = [],
  trends: TrendWindow[] = [],
  targetMonth?: number,
): StabilityResult {
  const usable = months
    .filter((month) => month.days > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  const completed = usable.filter((month) => !month.isCurrentMonth);
  const analysisMonths = completed.length > 0 ? completed : usable;

  if (analysisMonths.length < 2) {
    const assessed = analysisMonths.map((month) => emptyAssessment(month));
    const confidence: GrowthFactorConfidence =
      analysisMonths.length === 0 ? 'NO_DATA' : 'LOW';
    return {
      baselineDailyDemand: analysisMonths[0] ? rate(analysisMonths[0]) : 0,
      stability: 'INSUFFICIENT_DATA',
      variationCoefficient: 0,
      monthsUsed: analysisMonths.length,
      months: assessed,
      historyMonths: assessed,
      lookbackMonths: [],
      lookbackRepeatsAnomaly: false,
      unexplainedAnomaly: false,
      trendMonths: [],
      promotionMonths: [],
      systemGrowthFactor: 1,
      shortTermTrend: 1,
      seasonalIndex: null,
      seasonalWeight: 0,
      growthFactorConfidence: confidence,
      growthFactorMethod: 'INSUFFICIENT_DATA',
      growthFactorDataMonths: analysisMonths.length,
      growthFactorWarnings: ['INSUFFICIENT_HISTORY'],
      growthFactorAnalysis: {
        inputMonths: usable.length,
        cleanMonths: assessed.length,
        excludedMonths: [],
        shortTermTrend: 1,
        seasonalIndex: null,
        seasonalWeight: 0,
        systemGrowthFactor: 1,
        confidence,
        formula: '1.00 khi chưa đủ dữ liệu',
      },
    };
  }

  const recent = analysisMonths.slice(-3);
  const recentAssessment = assess(recent, promotions, trends);
  const recentHasAnomaly = recentAssessment.some(
    (month) => month.anomaly !== 'NORMAL',
  );

  const lookbackSource = recentHasAnomaly ? analysisMonths.slice(-5, -3) : [];
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
  const completedSource = usable.filter((month) => !month.isCurrentMonth);
  const currentSource = usable.filter((month) => month.isCurrentMonth);
  const historyMonths = [
    ...assess(completedSource.slice(-24), promotions, trends),
    ...assess(currentSource, promotions, trends),
  ];
  const unexplainedAnomaly = assessments.some(
    (month) => month.anomaly === 'SPIKE' && month.suspectedTrend,
  );

  const completedHistory = historyMonths.filter(
    (month) => !month.isCurrentMonth,
  );
  const cleanHistory = completedHistory.filter(isCleanMonth);
  // Tháng KM/trend và tháng hết hàng không đưa vào mức nền.
  const baselineMonths = (
    cleanHistory.length > 0 ? cleanHistory : completedHistory
  ).slice(-12);
  const baseRates = baselineMonths.map((month) => month.dailyRate);

  const baseline = mean(baseRates);
  const cv = coefficientOfVariation(assessments.map((m) => m.dailyRate));
  const growth = deriveGrowthFactor(
    completedHistory,
    targetMonth ?? nextMonthNumber(usable[usable.length - 1]?.month),
  );

  return {
    baselineDailyDemand: round(baseline),
    stability: cv > VOLATILE_CV ? 'VOLATILE' : 'STABLE',
    variationCoefficient: round(cv),
    monthsUsed: recent.length,
    months: assessments,
    historyMonths,
    lookbackMonths,
    lookbackRepeatsAnomaly,
    unexplainedAnomaly,
    trendMonths: assessments
      .filter((month) => month.suspectedTrend || month.hasTrend)
      .map((month) => month.month),
    promotionMonths: assessments
      .filter((month) => month.anomaly !== 'NORMAL' && month.hasPromotion)
      .map((month) => month.month),
    systemGrowthFactor: growth.systemGrowthFactor,
    shortTermTrend: growth.shortTermTrend,
    seasonalIndex: growth.seasonalIndex,
    seasonalWeight: growth.seasonalWeight,
    growthFactorConfidence: growth.confidence,
    growthFactorMethod: growth.method,
    growthFactorDataMonths: growth.dataMonths,
    growthFactorWarnings: growth.warnings,
    growthFactorAnalysis: growth.analysis,
  };
}

/**
 * Suy hệ số tăng trưởng từ 6 tháng gần nhất sau khi làm sạch; các tháng
 * SPIKE/DROP bị loại khỏi phép so sánh để một tháng bất thường không làm
 * phình forecast. Lịch sử dài hơn được dùng để kiểm tra xu hướng và mùa vụ.
 */
export function deriveSystemGrowthFactor(months: MonthAssessment[]): number {
  return deriveGrowthFactor(months).systemGrowthFactor;
}

function deriveGrowthFactor(months: MonthAssessment[], targetMonth?: number) {
  const clean = months.filter(isCleanMonth);
  const excludedMonths = months
    .filter((month) => !isCleanMonth(month))
    .map((month) => month.month);
  const warnings: string[] = [];
  if (months.length < 12) warnings.push('INSUFFICIENT_HISTORY');
  if (months.some((month) => month.stockDataAvailable === false)) {
    warnings.push('MISSING_STOCK_HISTORY');
  }

  const recent = clean.slice(-3);
  const previous = clean.length >= 6 ? clean.slice(-6, -3) : clean.slice(0, -3);
  const shortTermTrend =
    previous.length >= 2 && recent.length >= 2
      ? safeRatio(
          mean(recent.map((month) => month.dailyRate)),
          mean(previous.map((month) => month.dailyRate)),
        )
      : 1;

  const longTermTrend =
    clean.length >= 12
      ? safeRatio(
          mean(clean.slice(-6).map((month) => month.dailyRate)),
          mean(clean.slice(-12, -6).map((month) => month.dailyRate)),
        )
      : null;
  if (
    longTermTrend != null &&
    Math.abs(shortTermTrend - 1) > 0.1 &&
    Math.abs(longTermTrend - 1) > 0.1 &&
    Math.sign(shortTermTrend - 1) !== Math.sign(longTermTrend - 1)
  ) {
    warnings.push('SHORT_LONG_TERM_MISMATCH');
  }

  const seasonal = calculateSeasonality(months, targetMonth);
  if (seasonal.warning) warnings.push(seasonal.warning);
  const systemGrowthFactor = clampFactor(
    shortTermTrend * (1 + seasonal.weight * ((seasonal.index ?? 1) - 1)),
  );
  const dataMonths = months.length;
  const confidence: GrowthFactorConfidence =
    clean.length === 0 || mean(clean.map((month) => month.dailyRate)) <= 0
      ? 'NO_DATA'
      : dataMonths >= 24 &&
          !warnings.includes('SEASONALITY_UNCERTAIN') &&
          !warnings.includes('MISSING_STOCK_HISTORY') &&
          !warnings.includes('SHORT_LONG_TERM_MISMATCH')
        ? 'HIGH'
        : dataMonths >= 12
          ? 'MEDIUM'
          : dataMonths >= 4
            ? 'LOW'
            : 'NO_DATA';
  const method =
    seasonal.index == null
      ? '6M_TREND'
      : dataMonths >= 24
        ? '6M_TREND+24M_SEASONALITY'
        : '6M_TREND+12M_SEASONALITY';
  const formula = 'shortTermTrend × (1 + seasonalWeight × (seasonalIndex - 1))';

  return {
    systemGrowthFactor,
    shortTermTrend,
    seasonalIndex: seasonal.index,
    seasonalWeight: seasonal.weight,
    confidence,
    method,
    dataMonths,
    warnings,
    analysis: {
      inputMonths: months.length,
      cleanMonths: clean.length,
      excludedMonths,
      shortTermTrend,
      seasonalIndex: seasonal.index,
      seasonalWeight: seasonal.weight,
      systemGrowthFactor,
      confidence,
      formula,
    },
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
    quantity: month.quantity,
    daysInMonth: month.daysInMonth ?? month.days,
    validSellingDays: validDays(month),
    hadStock: month.hadStock,
    stockDataAvailable: month.stockDataAvailable,
    stockDataDays: month.stockDataDays,
    isCurrentMonth: Boolean(month.isCurrentMonth),
    dailyRate: rate(month),
    anomaly: 'NORMAL',
    anomalyReason: null,
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
    const stockout = month.hadStock === false || validDays(month) === 0;
    const anomaly: MonthAnomaly = stockout
      ? 'DROP'
      : reference <= 0 || (dailyRate === 0 && month.hadStock !== false)
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
      quantity: month.quantity,
      daysInMonth: month.daysInMonth ?? month.days,
      validSellingDays: validDays(month),
      hadStock: month.hadStock,
      stockDataAvailable: month.stockDataAvailable,
      stockDataDays: month.stockDataDays,
      isCurrentMonth: Boolean(month.isCurrentMonth),
      dailyRate: round(dailyRate),
      anomaly,
      anomalyReason: stockout
        ? 'Không có hàng hoặc không có ngày tồn kho hợp lệ'
        : anomaly === 'SPIKE'
          ? overlappingPromos.length > 0
            ? 'Tăng đột biến trùng khuyến mãi'
            : 'Tăng đột biến chưa giải thích'
          : anomaly === 'DROP'
            ? 'Tốc độ bán thấp hơn nền'
            : null,
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
  const denominator = validDays(month);
  return denominator > 0 ? month.quantity / denominator : 0;
}

function validDays(month: MonthlySales): number {
  if (month.validSellingDays != null) {
    return Math.max(0, Math.min(month.days, month.validSellingDays));
  }
  return Math.max(0, month.days);
}

function isCleanMonth(month: MonthAssessment): boolean {
  return (
    month.anomaly === 'NORMAL' &&
    !month.hasPromotion &&
    !month.hasTrend &&
    (month.validSellingDays ?? 0) > 0
  );
}

function safeRatio(numerator: number, denominator: number): number {
  if (numerator <= 0 || denominator <= 0) return 1;
  return clampFactor(numerator / denominator);
}

function clampFactor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return round(Math.min(1.5, Math.max(0.8, value)));
}

function calculateSeasonality(
  months: MonthAssessment[],
  targetMonth?: number,
): {
  index: number | null;
  weight: number;
  warning?: string;
} {
  if (months.length < 12 || targetMonth == null) {
    return { index: null, weight: 0 };
  }
  const seasonalCandidates = months.filter(
    (month) =>
      (month.validSellingDays ?? 0) > 0 &&
      month.hadStock !== false &&
      !month.hasPromotion &&
      !month.hasTrend,
  );
  const sameMonth = seasonalCandidates.filter(
    (month) => monthNumber(month.month) === targetMonth,
  );
  const otherMonths = seasonalCandidates.filter(
    (month) => monthNumber(month.month) !== targetMonth,
  );
  const base = mean(otherMonths.map((month) => month.dailyRate));
  if (sameMonth.length === 0 || base <= 0) {
    return { index: null, weight: 0, warning: 'SEASONALITY_UNCERTAIN' };
  }
  const index = round(
    Math.min(
      1.4,
      Math.max(0.7, mean(sameMonth.map((month) => month.dailyRate)) / base),
    ),
  );
  const weight = months.length >= 24 ? 0.6 : 0.4;
  const sameRates = sameMonth.map((month) => month.dailyRate);
  const unstable =
    sameRates.length >= 2 && coefficientOfVariation(sameRates) > 0.35;
  return {
    index,
    weight: unstable ? Math.min(weight, 0.3) : weight,
    ...(unstable ? { warning: 'SEASONALITY_UNCERTAIN' } : {}),
  };
}

function monthNumber(month: string): number {
  return Number(month.slice(5, 7));
}

function nextMonthNumber(month?: string): number | undefined {
  if (!month) return undefined;
  return (monthNumber(month) % 12) + 1;
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
