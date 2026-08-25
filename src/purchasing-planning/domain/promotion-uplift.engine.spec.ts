import { calculatePromotionUplift } from './promotion-uplift.engine';
import type { MonthAssessment } from './stability.engine';

const today = new Date('2026-08-01T00:00:00.000Z');

function month(
  overrides: Partial<MonthAssessment> & { month: string },
): MonthAssessment {
  return {
    dailyRate: 10,
    anomaly: 'NORMAL',
    ratio: 1,
    hasPromotion: false,
    promotionNames: [],
    suspectedTrend: false,
    ...overrides,
  };
}

/** Tháng từng chạy KM và bán vọt gấp đôi mức nền. */
const historyWithPromo: MonthAssessment[] = [
  month({ month: '2026-05' }),
  month({
    month: '2026-06',
    anomaly: 'SPIKE',
    ratio: 2,
    hasPromotion: true,
    promotionNames: ['Hè rực rỡ'],
  }),
  month({ month: '2026-07' }),
];

describe('calculatePromotionUplift', () => {
  it('không cộng gì khi không có đợt nào trong horizon', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          endDate: new Date('2026-01-31T00:00:00.000Z'),
          name: 'Đợt đã qua',
        },
      ],
      months: historyWithPromo,
    });

    expect(result.extraDemand).toBe(0);
    expect(result.windows).toHaveLength(0);
  });

  it('cộng nhu cầu cho đợt khuyến mãi SẮP chạy trong horizon', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-10T00:00:00.000Z'),
          name: 'Quốc khánh',
        },
      ],
      months: historyWithPromo,
    });

    // 10 ngày KM × nhu cầu nền 10 × phần dôi ra (2 - 1) = 100.
    expect(result.promotionDays).toBe(10);
    expect(result.upliftFactor).toBe(2);
    expect(result.extraDemand).toBe(100);
  });

  it('không đếm trùng ngày khi hai đợt chồng nhau', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-10T00:00:00.000Z'),
          name: 'A',
        },
        {
          startDate: new Date('2026-09-05T00:00:00.000Z'),
          endDate: new Date('2026-09-12T00:00:00.000Z'),
          name: 'B',
        },
      ],
      months: historyWithPromo,
    });

    // 01→12 tháng 9 là 12 ngày, không phải 10 + 8.
    expect(result.promotionDays).toBe(12);
  });

  it('cắt phần đợt nằm ngoài horizon', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 10, // horizon tới 11/08
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-08-05T00:00:00.000Z'),
          endDate: new Date('2026-12-31T00:00:00.000Z'),
          name: 'Đợt dài',
        },
      ],
      months: historyWithPromo,
    });

    // Chỉ 05→11 tháng 8 nằm trong horizon.
    expect(result.promotionDays).toBe(7);
  });

  it('uplift = 1 khi SKU chưa từng chạy khuyến mãi — không đoán bừa', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-10T00:00:00.000Z'),
          name: 'Lần đầu chạy',
        },
      ],
      months: [month({ month: '2026-06' }), month({ month: '2026-07' })],
    });

    expect(result.upliftFactor).toBe(1);
    expect(result.extraDemand).toBe(0);
  });

  it('chặn trần uplift để một tháng dị thường không thổi bay số lượng đặt', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 10,
      promotions: [
        {
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-10T00:00:00.000Z'),
          name: 'X',
        },
      ],
      months: [
        month({
          month: '2026-06',
          anomaly: 'SPIKE',
          ratio: 50,
          hasPromotion: true,
        }),
      ],
    });

    expect(result.upliftFactor).toBe(3);
  });

  it('không cộng gì khi SKU chưa phát sinh bán', () => {
    const result = calculatePromotionUplift({
      today,
      horizonDays: 60,
      baselineDailyDemand: 0,
      promotions: [
        {
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-10T00:00:00.000Z'),
          name: 'X',
        },
      ],
      months: historyWithPromo,
    });

    expect(result.extraDemand).toBe(0);
  });
});
