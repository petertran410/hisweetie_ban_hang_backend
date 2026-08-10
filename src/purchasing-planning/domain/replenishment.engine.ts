import { round } from './date';
import { ReplenishmentResult } from './models';

export interface ReplenishmentInput {
  forecastDailyDemand: number;
  leadTimeDays: number;
  safetyDays: number;
  availableStock: number;
  incomingTotal?: number;
}

export function calculateReplenishment(
  input: ReplenishmentInput,
): ReplenishmentResult {
  const demand = Math.max(0, input.forecastDailyDemand);
  // PRD §6.4: ROP protects lead time plus the safety period.
  const leadTimeDemand = round(demand * input.leadTimeDays);
  const safetyBuffer = round(demand * input.safetyDays);
  const reorderPoint = round(leadTimeDemand + safetyBuffer);
  const inventoryPosition = round(
    input.availableStock + (input.incomingTotal ?? 0),
  );
  const reorderGap = round(Math.max(0, reorderPoint - inventoryPosition));
  return {
    leadTimeDemand,
    safetyBuffer,
    reorderPoint,
    inventoryPosition,
    reorderGap,
    needsOrder: reorderGap > 0,
  };
}
