import {
  analyzeDemandStability,
  MonthlySales,
  PromotionWindow,
  safetyDaysFromStability,
} from './stability.engine';

const month = (m: string, quantity: number, days = 30): MonthlySales => ({
  month: m,
  quantity,
  days,
});

const promotion = (
  start: string,
  end: string,
  name = 'KM',
): PromotionWindow => ({
  startDate: new Date(`${start}T00:00:00.000Z`),
  endDate: new Date(`${end}T00:00:00.000Z`),
  name,
});

describe('analyzeDemandStability', () => {
  it('nới ra 6 tháng khi 3 tháng gần nhất đều bình thường', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 310),
      month('2026-03', 295),
      month('2026-04', 300),
      month('2026-05', 305),
      month('2026-06', 298),
    ]);

    expect(result.monthsUsed).toBe(6);
    expect(result.stability).toBe('STABLE');
    expect(result.baselineDailyDemand).toBeCloseTo(10, 1);
  });

  it('chỉ dùng 3 tháng khi có tháng bất thường', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 300),
      month('2026-03', 300),
      month('2026-04', 300),
      month('2026-05', 900),
      month('2026-06', 300),
    ]);

    expect(result.monthsUsed).toBe(3);
    expect(result.months.find((m) => m.month === '2026-05')?.anomaly).toBe(
      'SPIKE',
    );
  });

  it('quy đột biến cho khuyến mãi khi có KM trùng tháng', () => {
    const result = analyzeDemandStability(
      [month('2026-04', 300), month('2026-05', 900), month('2026-06', 300)],
      [promotion('2026-05-01', '2026-05-20', 'Sale hè')],
    );

    const may = result.months.find((m) => m.month === '2026-05');
    expect(may?.anomaly).toBe('SPIKE');
    expect(may?.hasPromotion).toBe(true);
    expect(may?.suspectedTrend).toBe(false);
    expect(result.promotionMonths).toEqual(['2026-05']);
    expect(result.trendMonths).toEqual([]);
  });

  it('nghi trend khi bán vọt mà không có khuyến mãi', () => {
    const result = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 900),
      month('2026-06', 300),
    ]);

    expect(result.trendMonths).toEqual(['2026-05']);
    expect(result.stability).toBe('VOLATILE');
  });

  it('không quy tháng bán tụt cho trend vì thường do hết hàng', () => {
    const result = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 30),
      month('2026-06', 300),
    ]);

    expect(result.months.find((m) => m.month === '2026-05')?.anomaly).toBe(
      'DROP',
    );
    expect(result.trendMonths).toEqual([]);
  });

  it('loại tháng nghi trend khỏi mức nền', () => {
    const result = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 1500),
      month('2026-06', 300),
    ]);

    // Nền phải bám 10/ngày của 2 tháng bình thường, không bị tháng 1500 kéo lên.
    expect(result.baselineDailyDemand).toBeCloseTo(10, 1);
  });

  it('báo thiếu dữ liệu khi chưa đủ 2 tháng', () => {
    const result = analyzeDemandStability([month('2026-06', 300)]);
    expect(result.stability).toBe('INSUFFICIENT_DATA');
  });
});

describe('safetyDaysFromStability', () => {
  it('SKU bán đều cần đệm mỏng hơn SKU thất thường', () => {
    const stable = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 305),
      month('2026-06', 298),
    ]);
    const volatile = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 900),
      month('2026-06', 120),
    ]);

    expect(safetyDaysFromStability(stable, 40)).toBeLessThan(
      safetyDaysFromStability(volatile, 40),
    );
  });

  it('leadtime dài hơn thì cần đệm dày hơn', () => {
    const result = analyzeDemandStability([
      month('2026-04', 300),
      month('2026-05', 380),
      month('2026-06', 260),
    ]);

    expect(safetyDaysFromStability(result, 60)).toBeGreaterThan(
      safetyDaysFromStability(result, 20),
    );
  });

  it('dùng đệm mặc định khi thiếu dữ liệu', () => {
    const result = analyzeDemandStability([month('2026-06', 300)]);
    expect(safetyDaysFromStability(result, 40)).toBe(10);
  });
});
