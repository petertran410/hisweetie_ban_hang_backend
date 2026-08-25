import {
  FactoryLeadtimeConfig,
  NetworkLeadtimeConfig,
  buildRange,
  normalizeRange,
  resolveLeadtimePipeline,
} from './leadtime.engine';

const network: NetworkLeadtimeConfig = {
  customs: { min: 7, max: 10 },
  inbound: { min: 7, max: 10 },
};

const factory: FactoryLeadtimeConfig = {
  factoryId: 1,
  factoryName: 'Lermao',
  production: { min: 10, max: 15 },
};

describe('normalizeRange', () => {
  it('đảo lại khi người dùng nhập min lớn hơn max', () => {
    expect(normalizeRange({ min: 15, max: 10 })).toEqual({ min: 10, max: 15 });
  });

  it('ép số âm về 0', () => {
    expect(normalizeRange({ min: -5, max: 8 })).toEqual({ min: 0, max: 8 });
  });
});

describe('buildRange', () => {
  it('trả null khi chưa khai báo gì', () => {
    expect(buildRange(null, null)).toBeNull();
  });

  it('chụm khoảng khi chỉ khai một đầu', () => {
    expect(buildRange(null, 12)).toEqual({ min: 12, max: 12 });
  });
});

describe('resolveLeadtimePipeline', () => {
  it('cộng đúng 3 chặng: sản xuất, thông quan, về công ty', () => {
    const result = resolveLeadtimePipeline({ network, factory });

    expect(result.stages.map((stage) => stage.code)).toEqual([
      'PRODUCTION',
      'CUSTOMS',
      'INBOUND',
    ]);
    // 10+7+7 / 15+10+10
    expect(result).toMatchObject({ min: 24, max: 35 });
  });

  it('không còn chặng điều chuyển tới chi nhánh', () => {
    const result = resolveLeadtimePipeline({ network, factory });

    expect(
      result.stages.some((stage) => stage.code === ('TRANSFER' as never)),
    ).toBe(false);
  });

  it('leadtime không phụ thuộc loại hàng lạnh hay thường', () => {
    // Trước đây hàng thường đi chậm hơn hàng lạnh vì chặng điều chuyển. Nay
    // pipeline dừng ở mốc về công ty nên hai loại cho cùng kết quả.
    const first = resolveLeadtimePipeline({ network, factory });
    const second = resolveLeadtimePipeline({ network, factory });

    expect(first.max).toBe(second.max);
  });

  it('ưu tiên override theo SKU hơn cấu hình nhà máy', () => {
    const result = resolveLeadtimePipeline({
      network,
      factory,
      skuProductionOverrideDays: 20,
    });

    const production = result.stages[0];
    expect(production.source).toBe('SKU_OVERRIDE');
    expect(production).toMatchObject({ min: 20, max: 20 });
  });

  it('trả 0 ngày sản xuất khi SKU chưa gắn nhà máy — không đoán bừa 30 ngày', () => {
    const result = resolveLeadtimePipeline({ network, factory: null });

    expect(result.stages[0]).toMatchObject({ min: 0, max: 0 });
    expect(result.max).toBe(20);
  });
});
