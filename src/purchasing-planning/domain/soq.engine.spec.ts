import { calculateSoq } from './soq.engine';

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
