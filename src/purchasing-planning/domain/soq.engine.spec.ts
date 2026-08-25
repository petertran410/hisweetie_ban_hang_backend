import { calculateSoq, coverageDaysFor, moqSpecToPacks } from './soq.engine';

describe('coverageDaysFor', () => {
  it('nhân đôi thời gian chờ hàng để đợt sau kịp về', () => {
    expect(coverageDaysFor(40)).toBe(80);
  });

  it('chặn dưới 30 ngày để hàng leadtime ngắn không bị đặt vụn', () => {
    expect(coverageDaysFor(5)).toBe(30);
    expect(coverageDaysFor(0)).toBe(30);
  });
});

describe('calculateSoq', () => {
  it('tính đủ nhu cầu chờ hàng + dự phòng + một chu kỳ đặt', () => {
    const result = calculateSoq({
      forecastDailyDemand: 10,
      leadTimeDays: 40,
      safetyDays: 8,
      availableStock: 0,
      packSize: 20,
      moq: 0,
      moqTolerance: 0.5,
    });
    // coverage = max(30, 40×2) = 80 → 10 × (40+8+80) = 1280
    expect(result.rawQuantity).toBe(1280);
    expect(result.suggestedQuantity).toBe(1280);
    expect(result.steps).toHaveLength(4);
  });

  it('trừ tồn kho và hàng đang về khỏi nhu cầu', () => {
    const result = calculateSoq({
      forecastDailyDemand: 10,
      leadTimeDays: 40,
      safetyDays: 8,
      availableStock: 500,
      usableIncoming: 300,
      packSize: 20,
      moq: 0,
      moqTolerance: 0.5,
    });
    // 1280 - 500 - 300 = 480
    expect(result.rawQuantity).toBe(480);
  });

  it('hoãn đặt khi nhu cầu quá nhỏ so với MOQ', () => {
    const result = calculateSoq({
      forecastDailyDemand: 1,
      leadTimeDays: 10,
      safetyDays: 0,
      availableStock: 0,
      daysOfSupply: 100,
      packSize: 20,
      moq: 4000,
      moqTolerance: 0.5,
    });
    expect(result.suggestedQuantity).toBe(0);
    expect(result.deferredByMoq).toBe(true);
    expect(result.flags).toEqual(['ORDER_DEFERRED']);
  });

  it('đôn lên đúng MOQ khi nhu cầu đã gần chạm ngưỡng', () => {
    const result = calculateSoq({
      forecastDailyDemand: 10,
      leadTimeDays: 10,
      safetyDays: 0,
      availableStock: 0,
      daysOfSupply: 20,
      packSize: 40,
      moq: 400,
      moqTolerance: 0.5,
    });
    // coverage = max(30, 20) = 30 → 10 × (10+0+30) = 400
    expect(result.rawQuantity).toBe(400);
    expect(result.suggestedQuantity).toBe(400);
  });
});

describe('moqSpecToPacks — quy MOQ có đơn vị về số gói lẻ', () => {
  // 1 thùng = 20 gói, mỗi gói 500g tịnh.
  const product = {
    productId: 1,
    conversionValue: 20,
    weight: 500,
    weightUnit: 'g',
  };

  it('MOQ 100 thùng → 2000 gói', () => {
    expect(
      moqSpecToPacks(
        {
          value: 100,
          basis: 'QUANTITY',
          unit: 'CARTON',
          scope: 'PER_LINE',
          increment: null,
        },
        product,
      ),
    ).toBe(2000);
  });

  it('MOQ 2 tấn → 4000 gói', () => {
    expect(
      moqSpecToPacks(
        {
          value: 2,
          basis: 'WEIGHT',
          unit: 'TON',
          scope: 'PER_LINE',
          increment: null,
        },
        product,
      ),
    ).toBe(4000);
  });

  it('MOQ 500 kg → 1000 gói', () => {
    expect(
      moqSpecToPacks(
        {
          value: 500,
          basis: 'WEIGHT',
          unit: 'KG',
          scope: 'PER_LINE',
          increment: null,
        },
        product,
      ),
    ).toBe(1000);
  });

  it('không khai MOQ → 0, không ràng buộc', () => {
    expect(moqSpecToPacks(null, product)).toBe(0);
  });

  it('thiếu khối lượng → null để nơi gọi gắn cờ cảnh báo', () => {
    expect(
      moqSpecToPacks(
        {
          value: 2,
          basis: 'WEIGHT',
          unit: 'TON',
          scope: 'PER_LINE',
          increment: null,
        },
        { ...product, weight: null },
      ),
    ).toBeNull();
  });

  it('MOQ khối lượng quy đổi xong chạy đúng qua engine SOQ', () => {
    const moq = moqSpecToPacks(
      {
        value: 2,
        basis: 'WEIGHT',
        unit: 'TON',
        scope: 'PER_LINE',
        increment: null,
      },
      product,
    )!;
    const result = calculateSoq({
      forecastDailyDemand: 50,
      leadTimeDays: 10,
      safetyDays: 5,
      availableStock: 0,
      daysOfSupply: 20,
      packSize: 1,
      moq,
      moqTolerance: 0.5,
    });
    // coverage = max(30, 20) = 30 → 50 × 45 = 2250, chưa tới MOQ 4000
    // nhưng còn trong ngưỡng dung sai nên đôn lên đúng MOQ.
    expect(result.moqApplied).toBe(4000);
    expect(result.suggestedQuantity).toBe(4000);
  });
});
