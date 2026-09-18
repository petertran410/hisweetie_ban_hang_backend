import { runForecastBacktest } from './backtest.engine';
import { MonthlySales } from './stability.engine';

function months(count: number): MonthlySales[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2024, index, 1));
    const month = date.toISOString().slice(0, 7);
    const seasonal = Number(month.slice(5, 7)) === 10 ? 1.2 : 1;
    return {
      month,
      quantity: (300 + index * 8) * seasonal,
      days: 30,
      daysInMonth: 30,
      validSellingDays: 30,
      hadStock: true,
      stockDataAvailable: true,
      isCurrentMonth: false,
    };
  });
}

describe('runForecastBacktest', () => {
  it('returns MAE/WAPE/Bias for methods A, B and C', () => {
    const result = runForecastBacktest([
      {
        productId: 1,
        productCode: 'SP001',
        productName: 'Sản phẩm 1',
        categoryName: 'Nhóm A',
        months: months(30),
      },
      {
        productId: 2,
        productCode: 'SP002',
        productName: 'Sản phẩm 2',
        categoryName: 'Nhóm A',
        months: months(30).map((month) => ({
          ...month,
          quantity: month.quantity * 0.7,
        })),
      },
    ]);

    expect(result.evaluatedProducts).toBe(2);
    expect(result.evaluatedSamples).toBeGreaterThan(0);
    expect(result.methods.map((item) => item.method)).toEqual(['A', 'B', 'C']);
    for (const metric of result.methods) {
      expect(metric.samples).toBe(result.evaluatedSamples);
      expect(metric.mae).toBeGreaterThanOrEqual(0);
      expect(metric.wape).toBeGreaterThanOrEqual(0);
      expect(
        metric.underForecastRate + metric.overForecastRate,
      ).toBeLessThanOrEqual(1);
    }
    expect(
      result.improvedVsLegacy + result.worseThanLegacy,
    ).toBeLessThanOrEqual(result.evaluatedProducts);
    expect(result.categoryReports).toEqual([
      expect.objectContaining({
        categoryName: 'Nhóm A',
        evaluatedProducts: 2,
        evaluatedSamples: result.evaluatedSamples,
      }),
    ]);
    expect(['PASS', 'WARN']).toContain(result.acceptance.status);
  });

  it('does not evaluate a current partial month', () => {
    const history = months(14);
    history[13] = { ...history[13], isCurrentMonth: true };
    const result = runForecastBacktest([
      {
        productId: 1,
        productCode: 'SP001',
        productName: 'Sản phẩm 1',
        months: history,
      },
    ]);

    expect(result.evaluatedSamples).toBe(1);
  });
});
