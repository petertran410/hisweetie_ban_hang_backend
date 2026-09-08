import { calculateTrendUplift, trendsForProduct } from './trend.engine';

describe('calculateTrendUplift', () => {
  const today = new Date('2026-08-01T00:00:00.000Z');

  it('chỉ áp dụng trend giao với horizon đặt hàng', () => {
    const result = calculateTrendUplift({
      today,
      horizonDays: 40,
      baselineDailyDemand: 10,
      trends: [
        {
          startDate: new Date('2026-06-01T00:00:00.000Z'),
          endDate: new Date('2026-06-30T00:00:00.000Z'),
          upliftFactor: 2,
          name: 'Đã hết',
        },
        {
          startDate: new Date('2026-08-10T00:00:00.000Z'),
          endDate: new Date('2026-08-19T00:00:00.000Z'),
          upliftFactor: 2,
          name: 'Sắp tới',
        },
      ],
    });
    expect(result.trendDays).toBe(10);
    expect(result.extraDemand).toBe(100);
    expect(result.windows).toHaveLength(1);
  });

  it('chia đều số lượng tăng thêm theo số ngày giao với horizon', () => {
    const result = calculateTrendUplift({
      today,
      horizonDays: 10,
      baselineDailyDemand: 10,
      trends: [
        {
          startDate: new Date('2026-08-01T00:00:00.000Z'),
          endDate: new Date('2026-08-20T00:00:00.000Z'),
          extraQuantity: 200,
          name: 'Tết',
        },
      ],
    });
    // Horizon 10 ngày từ 01/08 kết thúc 11/08 → 11 ngày giao / 20 ngày trend.
    expect(result.extraDemand).toBe(110);
  });

  it('bỏ qua trend không giao với horizon', () => {
    const result = calculateTrendUplift({
      today,
      horizonDays: 20,
      baselineDailyDemand: 10,
      trends: [
        {
          startDate: new Date('2026-10-01T00:00:00.000Z'),
          endDate: new Date('2026-10-15T00:00:00.000Z'),
          extraQuantity: 500,
        },
      ],
    });
    expect(result.extraDemand).toBe(0);
  });
});

describe('trendsForProduct', () => {
  it('lọc theo SKU hoặc nhóm hàng', () => {
    const product = {
      id: 9,
      parentName: 'Đồ uống',
      middleName: 'Trà',
      childName: 'Trà sữa',
    };
    const matched = trendsForProduct(product, [
      {
        productId: 9,
        startDate: new Date(),
        endDate: new Date(),
      },
      {
        productId: 8,
        startDate: new Date(),
        endDate: new Date(),
      },
      {
        categoryName: 'Trà sữa',
        startDate: new Date(),
        endDate: new Date(),
      },
    ]);
    expect(matched).toHaveLength(2);
  });
});
