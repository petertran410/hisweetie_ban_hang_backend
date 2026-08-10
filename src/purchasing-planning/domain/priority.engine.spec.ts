import { calculatePriority } from './priority.engine';
import { PRIORITY_RANK } from './constants';

describe('calculatePriority', () => {
  it('classifies BCRTG as HIGH', () => {
    const result = calculatePriority({
      confidence: 'HIGH',
      forecastDailyDemand: 11.72,
      availableStock: 548,
      inventoryPosition: 548,
      reorderPoint: 773.52,
      leadTimeDays: 45,
      safetyDays: 21,
      overstockDays: 180,
      needsOrder: true,
      daysUntilStockout: 47,
    });
    expect(result.priority).toBe('HIGH');
    expect(result.rank).toBe(2);
  });

  it('classifies out-of-stock SP000781 as CRITICAL', () => {
    const result = calculatePriority({
      confidence: 'LOW',
      forecastDailyDemand: 3.6,
      availableStock: 0,
      inventoryPosition: 0,
      reorderPoint: 158.4,
      leadTimeDays: 30,
      safetyDays: 14,
      overstockDays: 180,
      needsOrder: true,
      daysUntilStockout: 0,
    });
    expect(result.priority).toBe('CRITICAL');
    expect(result.rank).toBe(1);
  });

  it('supports all seven priority levels', () => {
    const levels = [
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
      'HEALTHY',
      'OVERSTOCK',
      'NO_DATA',
    ];
    expect(Object.keys(PRIORITY_RANK)).toEqual(levels);
  });
});
