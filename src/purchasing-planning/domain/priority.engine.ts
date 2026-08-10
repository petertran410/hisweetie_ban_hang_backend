import { PRIORITY_RANK } from './constants';
import { ForecastConfidence, PriorityResult } from './models';

export interface PriorityInput {
  confidence: ForecastConfidence;
  forecastDailyDemand: number;
  availableStock: number;
  inventoryPosition: number;
  reorderPoint: number;
  leadTimeDays: number;
  safetyDays: number;
  overstockDays: number;
  needsOrder: boolean;
  daysUntilStockout: number | null;
}

export function calculatePriority(input: PriorityInput): PriorityResult {
  const demand = Math.max(0, input.forecastDailyDemand);
  const daysOfSupply = demand > 0 ? input.availableStock / demand : null;
  // PRD §10.2: urgency = thời gian còn hàng / leadtime hiệu lực.
  const urgencyRatio =
    input.daysUntilStockout !== null && input.leadTimeDays > 0
      ? input.daysUntilStockout / input.leadTimeDays
      : null;
  let priority: PriorityResult['priority'];

  // PRD §6.6: classify by stockout timing against replenishment protection bands.
  if (input.confidence === 'NO_DATA' || demand === 0) priority = 'NO_DATA';
  else if (
    input.availableStock <= 0 ||
    (urgencyRatio !== null && urgencyRatio < 1)
  )
    priority = 'CRITICAL';
  else if (urgencyRatio !== null && urgencyRatio < 1.3) priority = 'HIGH';
  else if ((urgencyRatio !== null && urgencyRatio < 2) || input.needsOrder)
    priority = 'MEDIUM';
  else if (daysOfSupply !== null && daysOfSupply > input.overstockDays)
    priority = 'OVERSTOCK';
  else if (urgencyRatio !== null && urgencyRatio < 3) priority = 'LOW';
  else priority = 'HEALTHY';

  return {
    priority,
    rank: PRIORITY_RANK[priority],
    daysOfSupply,
    urgencyRatio,
  };
}
