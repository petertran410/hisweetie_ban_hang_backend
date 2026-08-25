import {
  OperationalPlanningDefaults,
  PlanningConfig,
  PlanningPriority,
} from './models';

export const DEFAULT_PLANNING_CONFIG: PlanningConfig = Object.freeze({
  safetyDays: 14,
  coverageDays: 30,
});

export const OPERATIONAL_PLANNING_DEFAULTS: OperationalPlanningDefaults =
  Object.freeze({
    purchaseMultiple: 1,
    moqTolerance: 0.5,
    minDays: 14,
    overstockDays: 180,
    projectionDays: 180,
  });

export const PRIORITY_RANK: Record<PlanningPriority, number> = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  HEALTHY: 5,
  OVERSTOCK: 6,
  NO_DATA: 7,
};

export const INCLUDED_DEMAND_TYPES = new Set([
  'SALE',
  'SALE_OUT',
  'INTERNAL_USE',
  'PRODUCTION_OUT',
  'CONSIGNMENT_OUT',
]);

export const RETURN_DEMAND_TYPES = new Set([
  'RETURN_IN',
  'CONSIGNMENT_RETURN_IN',
]);
