import { buildDecisionTimeline } from './decision-timeline.engine';
import { ProjectionResult } from './models';

const projection = (closingStock: number[]): ProjectionResult => ({
  days: closingStock.map((stock, index) => ({
    date: `2026-09-${String(index + 2).padStart(2, '0')}`,
    openingStock: index === 0 ? 100 : closingStock[index - 1],
    incoming: index === 1 ? 50 : 0,
    demand: 10,
    closingStock: stock,
  })),
  projectedStockoutDate: closingStock.some((stock) => stock <= 0)
    ? '2026-09-04'
    : null,
  daysUntilStockout: closingStock.some((stock) => stock <= 0) ? 2 : null,
  minProjectedStock: Math.min(...closingStock),
  minStockDate: '2026-09-04',
});

describe('buildDecisionTimeline', () => {
  it('ghép lịch sử, projection hai kịch bản và các mốc quyết định', () => {
    const result = buildDecisionTimeline({
      history: [
        {
          month: '2026-08',
          quantity: 300,
          dailyRate: 10,
          baseline: 300,
          anomaly: 'NORMAL',
          hasPromotion: false,
          hasTrend: false,
          promotionNames: [],
          trendNames: [],
        },
      ],
      firmProjection: projection([90, 130, 120]),
      scenarioProjection: projection([90, 180, 170]),
      demandDaily: 10,
      todayStock: 100,
      confirmedIncomingByDate: new Map([['2026-09-03', 50]]),
      vehicleIncomingByDate: new Map([['2026-09-03', 50]]),
      today: '2026-09-01',
      latestOrderDate: '2026-09-02',
      orderArrivalDate: '2026-09-21',
      reorderPoint: 120,
      safetyStock: 30,
      events: [
        {
          type: 'VEHICLE_SHIPMENT',
          name: 'GH-01',
          startDate: '2026-09-03',
          endDate: null,
          quantity: 50,
          etaType: 'CONFIRMED',
        },
      ],
      firmSuggestedQuantity: 100,
      vehicleScenarioQuantity: 50,
    });

    expect(result.history).toHaveLength(1);
    expect(result.projection[0]).toMatchObject({
      date: '2026-09-01',
      stockWithFirmSupply: 100,
      stockWithVehicleScenario: 100,
    });
    expect(result.projection[2]).toMatchObject({
      date: '2026-09-03',
      stockWithFirmSupply: 130,
      stockWithVehicleScenario: 180,
      confirmedIncoming: 50,
      vehicleIncoming: 50,
    });
    expect(result.markers).toMatchObject({
      latestOrderDate: '2026-09-02',
      orderArrivalDate: '2026-09-21',
      reorderPoint: 120,
    });
    expect(result.quantities).toEqual({
      firmSuggestedQuantity: 100,
      vehicleScenarioQuantity: 50,
    });
  });
});
