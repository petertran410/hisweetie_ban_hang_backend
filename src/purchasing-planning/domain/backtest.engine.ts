import { MonthlySales, analyzeDemandStability } from './stability.engine';

export type BacktestMethod = 'A' | 'B' | 'C';

export interface BacktestProductHistory {
  productId: number;
  productCode: string;
  productName: string;
  months: MonthlySales[];
}

export interface ForecastBacktestOptions {
  minTrainingMonths?: number;
}

export interface BacktestMethodMetrics {
  method: BacktestMethod;
  label: string;
  samples: number;
  mae: number;
  wape: number;
  bias: number;
  underForecastRate: number;
  overForecastRate: number;
}

export interface BacktestSkuReport {
  productId: number;
  productCode: string;
  productName: string;
  samples: number;
  metrics: Record<BacktestMethod, BacktestMethodMetrics>;
}

export interface ForecastBacktestResult {
  evaluatedProducts: number;
  evaluatedSamples: number;
  methods: BacktestMethodMetrics[];
  improvedVsLegacy: number;
  worseThanLegacy: number;
  skuReports: BacktestSkuReport[];
}

interface Sample {
  productId: number;
  productCode: string;
  productName: string;
  actual: number;
  predicted: Record<BacktestMethod, number>;
}

const METHOD_LABELS: Record<BacktestMethod, string> = {
  A: 'Công thức cũ 5 tháng',
  B: 'Xu hướng 6 tháng',
  C: 'Xu hướng 6 tháng + mùa vụ',
};

export function runForecastBacktest(
  products: BacktestProductHistory[],
  options: ForecastBacktestOptions = {},
): ForecastBacktestResult {
  const minTrainingMonths = Math.max(
    6,
    Math.min(24, options.minTrainingMonths ?? 12),
  );
  const samples: Sample[] = [];

  for (const product of products) {
    const months = [...product.months].sort((a, b) =>
      a.month.localeCompare(b.month),
    );
    for (let index = minTrainingMonths; index < months.length; index += 1) {
      const actualMonth = months[index];
      if (actualMonth.isCurrentMonth) continue;
      const training = months.slice(0, index);
      if (training.length < minTrainingMonths) continue;
      const targetMonth = Number(actualMonth.month.slice(5, 7));
      const stability = analyzeDemandStability(training, [], [], targetMonth);
      if (
        stability.baselineDailyDemand <= 0 &&
        training.every((month) => month.quantity <= 0)
      ) {
        continue;
      }
      const days =
        actualMonth.daysInMonth ??
        actualMonth.days ??
        daysInCalendarMonth(actualMonth.month);
      const factorA = legacyGrowthFactor(training);
      const factorB = clamp(stability.shortTermTrend);
      const factorC = clamp(stability.systemGrowthFactor);
      const baselineA = legacyBaseline(training);
      samples.push({
        productId: product.productId,
        productCode: product.productCode,
        productName: product.productName,
        actual: Math.max(0, actualMonth.quantity),
        predicted: {
          A: baselineA * factorA * days,
          B: stability.baselineDailyDemand * factorB * days,
          C: stability.baselineDailyDemand * factorC * days,
        },
      });
    }
  }

  const methods = (['A', 'B', 'C'] as BacktestMethod[]).map((method) =>
    aggregateMetrics(samples, method),
  );
  const skuReports = buildSkuReports(samples);
  const improvedVsLegacy = skuReports.filter(
    (report) => report.metrics.C.wape < report.metrics.A.wape,
  ).length;
  const worseThanLegacy = skuReports.filter(
    (report) => report.metrics.C.wape > report.metrics.A.wape,
  ).length;

  return {
    evaluatedProducts: skuReports.length,
    evaluatedSamples: samples.length,
    methods,
    improvedVsLegacy,
    worseThanLegacy,
    skuReports,
  };
}

function legacyBaseline(months: MonthlySales[]): number {
  const recent = months.slice(-3).map(dailyRate);
  const reference = median(months.slice(-5).map(dailyRate));
  if (reference <= 0) return mean(recent);
  const normal = recent.filter((rate) => {
    const ratio = rate / reference;
    return ratio < 1.4 && ratio > 0.6;
  });
  return mean(normal.length ? normal : recent);
}

function legacyGrowthFactor(months: MonthlySales[]): number {
  const recent = months.slice(-5).map((month) => ({
    ...month,
    dailyRate: dailyRate(month),
  }));
  if (recent.length < 4) return 1;
  const reference = median(recent.map((month) => month.dailyRate));
  const normal = recent.filter((month) => {
    if (reference <= 0) return true;
    const ratio = month.dailyRate / reference;
    return ratio < 1.4 && ratio > 0.6;
  });
  if (normal.length < 4) return 1;
  const split = Math.floor(normal.length / 2);
  const previousRate = mean(
    normal.slice(0, split).map((month) => month.dailyRate),
  );
  const recentRate = mean(normal.slice(split).map((month) => month.dailyRate));
  if (previousRate <= 0 || recentRate <= 0) return 1;
  return clamp(recentRate / previousRate);
}

function aggregateMetrics(
  samples: Sample[],
  method: BacktestMethod,
): BacktestMethodMetrics {
  let absoluteError = 0;
  let signedError = 0;
  let actualTotal = 0;
  let under = 0;
  let over = 0;

  for (const sample of samples) {
    const predicted = sample.predicted[method];
    const error = predicted - sample.actual;
    absoluteError += Math.abs(error);
    signedError += error;
    actualTotal += sample.actual;
    if (error < 0) under += 1;
    if (error > 0) over += 1;
  }

  return {
    method,
    label: METHOD_LABELS[method],
    samples: samples.length,
    mae: round(samples.length ? absoluteError / samples.length : 0),
    wape: round(actualTotal > 0 ? absoluteError / actualTotal : 0),
    bias: round(actualTotal > 0 ? signedError / actualTotal : 0),
    underForecastRate: round(samples.length ? under / samples.length : 0),
    overForecastRate: round(samples.length ? over / samples.length : 0),
  };
}

function buildSkuReports(samples: Sample[]): BacktestSkuReport[] {
  const byProduct = new Map<number, Sample[]>();
  for (const sample of samples) {
    const list = byProduct.get(sample.productId) ?? [];
    list.push(sample);
    byProduct.set(sample.productId, list);
  }
  return [...byProduct.entries()].map(([productId, rows]) => {
    const first = rows[0];
    return {
      productId,
      productCode: first.productCode,
      productName: first.productName,
      samples: rows.length,
      metrics: {
        A: aggregateMetrics(rows, 'A'),
        B: aggregateMetrics(rows, 'B'),
        C: aggregateMetrics(rows, 'C'),
      },
    };
  });
}

function dailyRate(month: MonthlySales): number {
  const days = month.validSellingDays ?? month.days;
  return days > 0 ? month.quantity / days : 0;
}

function daysInCalendarMonth(month: string): number {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1.5, Math.max(0.8, value));
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
