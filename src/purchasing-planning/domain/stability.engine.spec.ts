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
  it('dùng trung bình 3 tháng khi không có tháng bất thường', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 310),
      month('2026-03', 295),
      month('2026-04', 300),
      month('2026-05', 305),
      month('2026-06', 298),
    ]);

    expect(result.monthsUsed).toBe(3);
    expect(result.months.map((item) => item.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    expect(result.lookbackMonths).toEqual([]);
    expect(result.stability).toBe('STABLE');
    expect(result.baselineDailyDemand).toBeCloseTo(10, 1);
    expect(result.systemGrowthFactor).toBeCloseTo(0.9978, 3);
  });

  it('tự đề xuất hệ số tăng trưởng từ các tháng bình thường', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 330),
      month('2026-03', 360),
      month('2026-04', 390),
      month('2026-05', 420),
    ]);

    expect(result.systemGrowthFactor).toBeCloseTo(1.2381, 3);
  });

  it('không lấy một tháng SPIKE đơn lẻ làm hệ số tăng trưởng', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 300),
      month('2026-03', 300),
      month('2026-04', 900),
      month('2026-05', 300),
    ]);

    expect(result.systemGrowthFactor).toBe(1);
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

  it('soi tháng 4 và 5 khi 3 tháng gần nhất có bất thường', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 900),
      month('2026-03', 300),
      month('2026-04', 300),
      month('2026-05', 900),
      month('2026-06', 300),
    ]);

    expect(result.lookbackMonths.map((item) => item.month)).toEqual([
      '2026-02',
      '2026-03',
    ]);
    expect(result.lookbackRepeatsAnomaly).toBe(true);
    expect(result.unexplainedAnomaly).toBe(true);
    expect(result.baselineDailyDemand).toBeCloseTo(10, 1);
  });

  it('không coi là nghi trend nếu tháng vọt đã được khai trend', () => {
    const result = analyzeDemandStability(
      [month('2026-04', 300), month('2026-05', 900), month('2026-06', 300)],
      [],
      [
        {
          startDate: new Date('2026-05-01T00:00:00.000Z'),
          endDate: new Date('2026-05-31T00:00:00.000Z'),
          name: 'Mùa hè',
        },
      ],
    );
    const may = result.months.find((item) => item.month === '2026-05');
    expect(may?.hasTrend).toBe(true);
    expect(may?.suspectedTrend).toBe(false);
    expect(result.unexplainedAnomaly).toBe(false);
    expect(result.baselineDailyDemand).toBeCloseTo(10, 1);
  });

  it('giữ tháng không phát sinh hóa đơn bằng 0 trong lịch sử', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 0),
      month('2026-03', 300),
      month('2026-04', 300),
      month('2026-05', 300),
      month('2026-06', 300),
    ]);

    expect(
      result.historyMonths.find((item) => item.month === '2026-02'),
    ).toEqual(
      expect.objectContaining({
        dailyRate: 0,
        anomaly: 'NORMAL',
        validSellingDays: 30,
      }),
    );
    expect(result.growthFactorAnalysis.cleanMonths).toBe(6);
  });

  it('không dùng tháng snapshot đang chạy dở để suy xu hướng', () => {
    const result = analyzeDemandStability([
      month('2026-01', 300),
      month('2026-02', 300),
      month('2026-03', 300),
      { ...month('2026-04', 900, 10), isCurrentMonth: true },
    ]);

    expect(result.growthFactorDataMonths).toBe(3);
    expect(result.historyMonths.at(-1)?.isCurrentMonth).toBe(true);
    expect(result.systemGrowthFactor).toBe(1);
  });

  it('áp dụng mùa vụ sơ bộ khi có ít nhất 12 tháng', () => {
    const months = Array.from({ length: 12 }, (_, index) =>
      month(
        `2025-${String(index + 1).padStart(2, '0')}`,
        index === 9 ? 140 : 100,
      ),
    );
    const result = analyzeDemandStability(months, [], [], 10);

    expect(result.seasonalIndex).toBe(1.4);
    expect(result.seasonalWeight).toBe(0.4);
    expect(result.growthFactorMethod).toBe('6M_TREND+12M_SEASONALITY');
    expect(result.systemGrowthFactor).toBeCloseTo(1.16, 2);
  });

  it('giảm trọng số và gắn cảnh báo khi mùa vụ giữa các năm không ổn định', () => {
    const months = Array.from({ length: 24 }, (_, index) => {
      const year = index < 12 ? 2025 : 2026;
      const monthNumber = (index % 12) + 1;
      const quantity = monthNumber === 10 ? (year === 2025 ? 150 : 50) : 100;
      return month(`${year}-${String(monthNumber).padStart(2, '0')}`, quantity);
    });
    const result = analyzeDemandStability(months, [], [], 10);

    expect(result.growthFactorMethod).toBe('6M_TREND+24M_SEASONALITY');
    expect(result.seasonalWeight).toBe(0.3);
    expect(result.growthFactorWarnings).toContain('SEASONALITY_UNCERTAIN');
    expect(result.growthFactorConfidence).toBe('MEDIUM');
  });

  it('hạ độ tin cậy khi thiếu lịch sử tồn kho theo ngày', () => {
    const result = analyzeDemandStability(
      Array.from({ length: 12 }, (_, index) => ({
        ...month(`2025-${String(index + 1).padStart(2, '0')}`, 300),
        stockDataAvailable: false,
      })),
      [],
      [],
      10,
    );

    expect(result.growthFactorWarnings).toContain('MISSING_STOCK_HISTORY');
    expect(result.growthFactorConfidence).toBe('MEDIUM');
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
