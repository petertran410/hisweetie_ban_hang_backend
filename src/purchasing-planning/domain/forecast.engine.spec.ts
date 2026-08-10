import { DemandDay } from './models';
import { forecastDemand } from './forecast.engine';

function stockDays(count: number, totalDemand: number): DemandDay[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    demand: index === 0 ? totalDemand : 0,
    source: 'INVOICE_DETAIL',
    hadStock: true,
  }));
}

describe('forecastDemand', () => {
  it('uses a conservative calendar-day fallback for sparse B2B sales', () => {
    const result = forecastDemand({
      asOfDate: '2026-08-08',
      firstActivityDate: '2026-05-11',
      days: Array.from({ length: 90 }, (_, index) => ({
        date: new Date(Date.UTC(2026, 4, 11 + index))
          .toISOString()
          .slice(0, 10),
        demand: index === 10 ? 90 : 0,
        source: index === 10 ? 'INVOICE_DETAIL' : 'NONE',
      })),
    });
    expect(result.forecastDailyDemand).toBe(1);
    expect(result.ma90).toBe(1);
    expect(result.confidence).toBe('VERY_LOW');
    expect(result.flags).toContain('LOW_CONFIDENCE_FORECAST');
  });
  it('calculates SP000781 using demand divided by valid stock days', () => {
    const days = Array.from({ length: 35 }, (_, index) => {
      const date = new Date('2026-06-28T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        demand: index === 0 ? 126 : 0,
        source: 'INVOICE_DETAIL' as const,
        hadStock: true,
      };
    });
    const result = forecastDemand({
      days,
      asOfDate: '2026-08-01',
      firstActivityDate: '2026-06-28',
    });

    expect(result.forecastDailyDemand).toBe(3.6);
    expect(result.windowDays).toBe(35);
    expect(result.validStockDays).toBe(35);
    expect(result.confidence).toBe('LOW');
  });

  it('uses sales-day stock heuristic and lowers confidence one level', () => {
    const result = forecastDemand({
      days: stockDays(20, 40).map(({ hadStock: _, ...day }) => day),
      asOfDate: '2026-07-20',
      firstActivityDate: '2026-07-01',
    });

    expect(result.validStockDays).toBe(1);
    expect(result.confidence).toBe('VERY_LOW');
    expect(result.flags).toContain('LOW_CONFIDENCE_FORECAST');
  });

  it('returns NO_DATA when fewer than minimum valid days exist', () => {
    const result = forecastDemand({
      days: stockDays(10, 100),
      asOfDate: '2026-07-10',
      firstActivityDate: '2026-07-01',
    });

    expect(result.forecastDailyDemand).toBe(0);
    expect(result.confidence).toBe('NO_DATA');
    expect(result.flags).toContain('NO_DATA');
  });
});
