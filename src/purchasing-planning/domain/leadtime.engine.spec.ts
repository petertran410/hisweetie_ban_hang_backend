import {
  FactoryLeadtimeConfig,
  CUSTOMS_LEADTIME_DAYS,
  INBOUND_LEADTIME_DAYS,
  resolveLeadtimePipeline,
  singleLeadtimeDays,
} from './leadtime.engine';

const factory: FactoryLeadtimeConfig = {
  factoryId: 1,
  factoryName: 'Lermao',
  production: { min: 30, max: 30 },
  productionDays: 30,
};

describe('singleLeadtimeDays', () => {
  it('ưu tiên số đơn rồi mới lấy cận trên dữ liệu cũ', () => {
    expect(singleLeadtimeDays(10, 15, 12)).toBe(12);
    expect(singleLeadtimeDays(10, 15)).toBe(15);
    expect(singleLeadtimeDays(10, null)).toBe(10);
    expect(singleLeadtimeDays(null, null)).toBeNull();
  });
});

describe('resolveLeadtimePipeline', () => {
  it('cộng sản xuất + 10 ngày thông quan + 10 ngày về kho gốc', () => {
    const result = resolveLeadtimePipeline({ factory });
    expect(result.stages.map((stage) => stage.code)).toEqual([
      'PRODUCTION',
      'CUSTOMS',
      'INBOUND',
    ]);
    expect(result.days).toBe(30 + CUSTOMS_LEADTIME_DAYS + INBOUND_LEADTIME_DAYS);
    expect(result.min).toBe(result.max);
    expect(result.stages[1].days).toBe(10);
    expect(result.stages[2].days).toBe(10);
  });

  it('bỏ qua cấu hình min-max cũ của thông quan / inbound', () => {
    const result = resolveLeadtimePipeline({
      factory,
      network: {
        customs: { min: 7, max: 12 },
        inbound: { min: 3, max: 9 },
      },
    });
    expect(result.stages[1].days).toBe(10);
    expect(result.stages[2].days).toBe(10);
  });

  it('ưu tiên override theo SKU hơn cấu hình nhà máy', () => {
    const result = resolveLeadtimePipeline({
      factory,
      skuProductionOverrideDays: 20,
    });
    expect(result.stages[0]).toMatchObject({
      source: 'SKU_OVERRIDE',
      days: 20,
    });
    expect(result.days).toBe(40);
  });

  it('trả 0 ngày sản xuất khi chưa gắn nhà máy — tổng vẫn còn 20 ngày logistics', () => {
    const result = resolveLeadtimePipeline({ factory: null });
    expect(result.stages[0].days).toBe(0);
    expect(result.days).toBe(20);
  });
});
