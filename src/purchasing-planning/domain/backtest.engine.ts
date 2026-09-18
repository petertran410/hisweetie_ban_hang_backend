import {
  MonthlySales,
  analyzeDemandStability,
  calculateLegacyForecast,
} from './stability.engine';

export type BacktestMethod = 'A' | 'B' | 'C';

export interface BacktestProductHistory {
  productId: number;
  productCode: string;
  productName: string;
  categoryName?: string | null;
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
  categoryName: string | null;
  samples: number;
  metrics: Record<BacktestMethod, BacktestMethodMetrics>;
}

export interface BacktestCategoryReport {
  categoryName: string;
  evaluatedProducts: number;
  evaluatedSamples: number;
  methods: BacktestMethodMetrics[];
  improvedVsLegacy: number;
  worseThanLegacy: number;
}

export interface BacktestAcceptance {
  status: 'PASS' | 'WARN' | 'INSUFFICIENT';
  reasons: string[];
}

export interface ForecastBacktestResult {
  evaluatedProducts: number;
  evaluatedSamples: number;
  methods: BacktestMethodMetrics[];
  categoryReports: BacktestCategoryReport[];
  acceptance: BacktestAcceptance;
  improvedVsLegacy: number;
  worseThanLegacy: number;
  skuReports: BacktestSkuReport[];
}

interface Sample {
  productId: number;
  productCode: string;
  productName: string;
  categoryName: string | null;
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
      const legacy = calculateLegacyForecast(training);
      const factorB = clamp(stability.shortTermTrend);
      const factorC = clamp(stability.systemGrowthFactor);
      samples.push({
        productId: product.productId,
        productCode: product.productCode,
        productName: product.productName,
        categoryName: product.categoryName ?? null,
        actual: Math.max(0, actualMonth.quantity),
        predicted: {
          A: legacy.baselineDailyDemand * legacy.growthFactor * days,
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
  const categoryReports = buildCategoryReports(samples);
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
    categoryReports,
    acceptance: buildAcceptance(methods),
    improvedVsLegacy,
    worseThanLegacy,
    skuReports,
  };
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
      categoryName: first.categoryName,
      samples: rows.length,
      metrics: {
        A: aggregateMetrics(rows, 'A'),
        B: aggregateMetrics(rows, 'B'),
        C: aggregateMetrics(rows, 'C'),
      },
    };
  });
}

function buildCategoryReports(samples: Sample[]): BacktestCategoryReport[] {
  const byCategory = new Map<string, Sample[]>();
  for (const sample of samples) {
    const categoryName = sample.categoryName || 'Chưa phân nhóm';
    const list = byCategory.get(categoryName) ?? [];
    list.push(sample);
    byCategory.set(categoryName, list);
  }
  return [...byCategory.entries()]
    .map(([categoryName, rows]) => {
      const methods = (['A', 'B', 'C'] as BacktestMethod[]).map((method) =>
        aggregateMetrics(rows, method),
      );
      const productIds = new Set(rows.map((row) => row.productId));
      const skuReports = buildSkuReports(rows);
      return {
        categoryName,
        evaluatedProducts: productIds.size,
        evaluatedSamples: rows.length,
        methods,
        improvedVsLegacy: skuReports.filter(
          (report) => report.metrics.C.wape < report.metrics.A.wape,
        ).length,
        worseThanLegacy: skuReports.filter(
          (report) => report.metrics.C.wape > report.metrics.A.wape,
        ).length,
      };
    })
    .sort((a, b) => b.evaluatedSamples - a.evaluatedSamples);
}

function buildAcceptance(methods: BacktestMethodMetrics[]): BacktestAcceptance {
  const legacy = methods.find((method) => method.method === 'A');
  const seasonal = methods.find((method) => method.method === 'C');
  if (!legacy || !seasonal || seasonal.samples === 0) {
    return {
      status: 'INSUFFICIENT',
      reasons: ['Chưa đủ mẫu để so sánh công thức mùa vụ với công thức cũ.'],
    };
  }
  const reasons: string[] = [];
  if (seasonal.wape > legacy.wape) {
    reasons.push(
      `WAPE công thức mùa vụ (${seasonal.wape}) cao hơn công thức cũ (${legacy.wape}).`,
    );
  }
  if (seasonal.underForecastRate > legacy.underForecastRate) {
    reasons.push(
      `Tỷ lệ dự báo thiếu tăng từ ${legacy.underForecastRate} lên ${seasonal.underForecastRate}.`,
    );
  }
  if (
    seasonal.underForecastRate < legacy.underForecastRate &&
    seasonal.overForecastRate > legacy.overForecastRate + 0.1
  ) {
    reasons.push(
      `Giảm dự báo thiếu nhưng tỷ lệ dự báo dư tăng từ ${legacy.overForecastRate} lên ${seasonal.overForecastRate}.`,
    );
  }
  return {
    status: reasons.length ? 'WARN' : 'PASS',
    reasons: reasons.length
      ? reasons
      : ['WAPE và tỷ lệ dự báo thiếu không xấu hơn công thức cũ.'],
  };
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
