import { calculateSoq, moqSpecToPacks } from './soq.engine';

describe('calculateSoq', () => {
  it('matches BCRTG SOQ and exposes calculation steps', () => {
    const result = calculateSoq({
      forecastDailyDemand: 11.72,
      leadTimeDays: 45,
      safetyDays: 21,
      coverageDays: 30,
      availableStock: 548,
      packSize: 40,
      moq: 400,
      purchaseMultiple: 1,
      moqTolerance: 0.5,
    });
    expect(result.rawQuantity).toBe(577.12);
    expect(result.suggestedQuantity).toBe(600);
    expect(result.suggestedPackCount).toBe(15);
    expect(result.steps).toHaveLength(4);
  });

  it('defers when MOQ overshoot exceeds tolerance', () => {
    const result = calculateSoq({
      forecastDailyDemand: 10,
      leadTimeDays: 10,
      safetyDays: 0,
      coverageDays: 0,
      availableStock: 0,
      daysOfSupply: 20,
      packSize: 20,
      moq: 400,
      moqTolerance: 0.5,
    });
    expect(result.suggestedQuantity).toBe(0);
    expect(result.deferredByMoq).toBe(true);
    expect(result.flags).toEqual(['ORDER_DEFERRED']);
  });

  it('applies MOQ when overshoot is within tolerance', () => {
    const result = calculateSoq({
      forecastDailyDemand: 30,
      leadTimeDays: 10,
      safetyDays: 0,
      coverageDays: 0,
      availableStock: 0,
      daysOfSupply: 20,
      packSize: 40,
      moq: 400,
      moqTolerance: 0.5,
    });
    expect(result.rawQuantity).toBe(300);
    expect(result.suggestedQuantity).toBe(400);
    expect(result.moqApplied).toBe(400);
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
        { value: 100, basis: 'QUANTITY', unit: 'CARTON', scope: 'PER_LINE', increment: null },
        product,
      ),
    ).toBe(2000);
  });

  it('MOQ 2 tấn → 4000 gói', () => {
    expect(
      moqSpecToPacks(
        { value: 2, basis: 'WEIGHT', unit: 'TON', scope: 'PER_LINE', increment: null },
        product,
      ),
    ).toBe(4000);
  });

  it('MOQ 500 kg → 1000 gói', () => {
    expect(
      moqSpecToPacks(
        { value: 500, basis: 'WEIGHT', unit: 'KG', scope: 'PER_LINE', increment: null },
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
        { value: 2, basis: 'WEIGHT', unit: 'TON', scope: 'PER_LINE', increment: null },
        { ...product, weight: null },
      ),
    ).toBeNull();
  });

  it('MOQ khối lượng quy đổi xong chạy đúng qua engine SOQ', () => {
    const moq = moqSpecToPacks(
      { value: 2, basis: 'WEIGHT', unit: 'TON', scope: 'PER_LINE', increment: null },
      product,
    )!;
    const result = calculateSoq({
      forecastDailyDemand: 100,
      leadTimeDays: 10,
      safetyDays: 5,
      coverageDays: 15,
      availableStock: 0,
      packSize: 1,
      moq,
      moqTolerance: 0.5,
    });
    // Nhu cầu 3000 gói đã vượt MOQ 4000? Không — bị đôn lên đúng bằng MOQ.
    expect(result.moqApplied).toBe(4000);
    expect(result.suggestedQuantity).toBe(4000);
  });
});
