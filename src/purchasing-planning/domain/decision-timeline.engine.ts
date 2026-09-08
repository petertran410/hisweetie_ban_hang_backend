import { ProjectionResult } from './models';

export type DecisionAnomaly = 'NORMAL' | 'SPIKE' | 'DROP';
export type DecisionEventType =
  | 'PROMOTION'
  | 'TREND'
  | 'INCOMING'
  | 'VEHICLE_SHIPMENT';

export interface DecisionHistoryPoint {
  month: string;
  quantity: number;
  dailyRate: number;
  baseline: number;
  anomaly: DecisionAnomaly;
  hasPromotion: boolean;
  hasTrend: boolean;
  promotionNames: string[];
  trendNames: string[];
}

export interface DecisionProjectionPoint {
  date: string;
  stockWithFirmSupply: number;
  stockWithVehicleScenario: number;
  demand: number;
  confirmedIncoming: number;
  vehicleIncoming: number;
}

export interface DecisionTimelineEvent {
  type: DecisionEventType;
  name: string | null;
  startDate: string;
  endDate: string | null;
  quantity: number | null;
  etaType: string | null;
}

export interface DecisionTimeline {
  history: DecisionHistoryPoint[];
  projection: DecisionProjectionPoint[];
  markers: {
    today: string;
    latestOrderDate: string | null;
    projectedStockoutDate: string | null;
    scenarioStockoutDate: string | null;
    orderArrivalDate: string | null;
    reorderPoint: number;
    safetyStock: number;
  };
  events: DecisionTimelineEvent[];
  quantities: {
    firmSuggestedQuantity: number;
    vehicleScenarioQuantity: number;
  };
}

export interface DecisionTimelineInput {
  history: DecisionHistoryPoint[];
  firmProjection: ProjectionResult;
  scenarioProjection: ProjectionResult;
  demandDaily: number;
  todayStock: number;
  confirmedIncomingByDate: Map<string, number>;
  vehicleIncomingByDate: Map<string, number>;
  today: string;
  latestOrderDate: string | null;
  orderArrivalDate: string | null;
  reorderPoint: number;
  safetyStock: number;
  events: DecisionTimelineEvent[];
  firmSuggestedQuantity: number;
  vehicleScenarioQuantity: number;
}

export function buildDecisionTimeline(
  input: DecisionTimelineInput,
): DecisionTimeline {
  const scenarioByDate = new Map(
    input.scenarioProjection.days.map((day) => [day.date, day]),
  );

  return {
    history: input.history,
    projection: [
      {
        date: input.today,
        stockWithFirmSupply: round(input.todayStock),
        stockWithVehicleScenario: round(input.todayStock),
        demand: 0,
        confirmedIncoming: 0,
        vehicleIncoming: 0,
      },
      ...input.firmProjection.days.map((day) => {
        const scenario = scenarioByDate.get(day.date);
        return {
          date: day.date,
          stockWithFirmSupply: round(day.closingStock),
          stockWithVehicleScenario: round(
            scenario?.closingStock ?? day.closingStock,
          ),
          demand: round(day.demand || input.demandDaily),
          confirmedIncoming: round(input.confirmedIncomingByDate.get(day.date) ?? 0),
          vehicleIncoming: round(input.vehicleIncomingByDate.get(day.date) ?? 0),
        };
      }),
    ],
    markers: {
      today: input.today,
      latestOrderDate: input.latestOrderDate,
      projectedStockoutDate: input.firmProjection.projectedStockoutDate,
      scenarioStockoutDate: input.scenarioProjection.projectedStockoutDate,
      orderArrivalDate: input.orderArrivalDate,
      reorderPoint: round(input.reorderPoint),
      safetyStock: round(input.safetyStock),
    },
    events: input.events,
    quantities: {
      firmSuggestedQuantity: round(input.firmSuggestedQuantity),
      vehicleScenarioQuantity: round(input.vehicleScenarioQuantity),
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
