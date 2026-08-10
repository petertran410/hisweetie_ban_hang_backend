import { projectInventory } from './projection.engine';

describe('projectInventory', () => {
  it('projects daily incoming before demand and defaults to 180 days', () => {
    const result = projectInventory({
      snapshotDate: '2026-08-08',
      availableStock: 5,
      forecastDailyDemand: 3,
      incoming: [{ date: '2026-08-09', quantity: 4, overdue: false }],
    });
    expect(result.days).toHaveLength(180);
    expect(result.days.slice(0, 3).map((day) => day.closingStock)).toEqual([
      6, 3, 0,
    ]);
    expect(result.projectedStockoutDate).toBe('2026-08-11');
    expect(result.daysUntilStockout).toBe(3);
  });
});
