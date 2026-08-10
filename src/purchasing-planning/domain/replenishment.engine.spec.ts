import { calculateReplenishment } from './replenishment.engine';

describe('calculateReplenishment', () => {
  it('matches the BCRTG reorder point golden case', () => {
    expect(
      calculateReplenishment({
        forecastDailyDemand: 11.72,
        availableStock: 548,
        leadTimeDays: 45,
        safetyDays: 21,
      }),
    ).toEqual({
      leadTimeDemand: 527.4,
      safetyBuffer: 246.12,
      reorderPoint: 773.52,
      inventoryPosition: 548,
      reorderGap: 225.52,
      needsOrder: true,
    });
  });
});
