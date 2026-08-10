import { round } from './date';
import { SoqResult } from './models';

export interface SoqInput {
  forecastDailyDemand: number;
  leadTimeDays: number;
  safetyDays: number;
  coverageDays: number;
  availableStock: number;
  usableIncoming?: number;
  committedDemand?: number;
  daysOfSupply?: number | null;
  packSize: number;
  moq: number;
  purchaseMultiple?: number;
  moqTolerance?: number;
  needsOrder?: boolean;
}

export function calculateSoq(input: SoqInput): SoqResult {
  const targetStock =
    Math.max(0, input.forecastDailyDemand) *
    (input.leadTimeDays + input.safetyDays + input.coverageDays);
  // PRD §6.5: replenish to lead-time + safety + coverage stock.
  const rawQuantity = round(
    Math.max(
      0,
      targetStock -
        input.availableStock -
        (input.usableIncoming ?? 0) -
        (input.committedDemand ?? 0),
    ),
  );
  const multiple =
    Math.max(1, input.packSize) * Math.max(1, input.purchaseMultiple ?? 1);
  const roundedQuantity =
    rawQuantity > 0 ? Math.ceil(rawQuantity / multiple) * multiple : 0;
  const moq = Math.max(0, input.moq);
  const tolerance = Math.max(0, input.moqTolerance ?? 0.5);
  let suggestedQuantity = input.needsOrder === false ? 0 : roundedQuantity;
  let moqApplied: number | null = null;
  let deferredByMoq = false;

  if (suggestedQuantity > 0 && suggestedQuantity < moq) {
    if (rawQuantity >= moq * tolerance) {
      suggestedQuantity = Math.ceil(moq / multiple) * multiple;
      moqApplied = moq;
    } else if ((input.daysOfSupply ?? 0) <= input.leadTimeDays) {
      suggestedQuantity = Math.ceil(moq / multiple) * multiple;
      moqApplied = moq;
    } else {
      suggestedQuantity = 0;
      deferredByMoq = true;
    }
  }

  suggestedQuantity = round(suggestedQuantity);
  return {
    rawQuantity,
    suggestedQuantity,
    suggestedPackCount: round(
      suggestedQuantity / Math.max(1, input.packSize),
      2,
    ),
    moqApplied,
    deferredByMoq,
    steps: [
      {
        code: 'TARGET_STOCK',
        formula: 'FDD × (leadTimeDays + safetyDays + coverageDays)',
        value: round(targetStock),
      },
      {
        code: 'SOQ_RAW',
        formula:
          'max(0, targetStock - available - usableIncoming - committedDemand)',
        value: rawQuantity,
      },
      {
        code: 'ROUND_TO_PURCHASE_MULTIPLE',
        formula: 'ceil(SOQ raw / (packSize × purchaseMultiple)) × multiple',
        value: round(roundedQuantity),
      },
      {
        code: 'MOQ_POLICY',
        formula: 'apply MOQ only within moqTolerance; otherwise defer',
        value: suggestedQuantity,
      },
    ],
    flags: deferredByMoq
      ? ['ORDER_DEFERRED']
      : moqApplied !== null && rawQuantity < moq * tolerance
        ? ['MOQ_OVERSHOOT']
        : [],
  };
}
