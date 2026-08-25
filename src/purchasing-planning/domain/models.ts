export type DemandSource =
  | 'INVOICE_DETAIL'
  | 'INVENTORY_LOG'
  | 'HYBRID'
  | 'NONE';

export type ForecastConfidence =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'VERY_LOW'
  | 'NO_DATA';

export type PlanningFlagCode =
  | 'LOW_CONFIDENCE_FORECAST'
  | 'NO_DATA'
  | 'OVERDUE_SHIPMENT'
  | 'SHIPMENT_STALE'
  | 'ORDER_DEFERRED'
  | 'MOQ_OVERSHOOT';

export interface DemandDay {
  date: string;
  demand: number;
  source: DemandSource;
  hadStock?: boolean;
}

export interface RawInvoiceDemandRecord {
  date: string | Date;
  quantity: number;
  type?: 'SALE' | 'RETURN';
}

export interface RawInventoryDemandRecord {
  date: string | Date;
  quantity: number;
  transactionType: string;
}

export interface ForecastResult {
  forecastDailyDemand: number;
  ma30: number | null;
  ma60: number | null;
  ma90: number | null;
  windowDays: number;
  validStockDays: number;
  skuAgeDays: number;
  growthFactor: number;
  confidence: ForecastConfidence;
  flags: PlanningFlagCode[];
}

export interface IncomingOrderLine {
  id?: string | number;
  status: string | number;
  orderedQuantity: number;
  receivedQuantity?: number;
  expectedArrivalDate?: string | Date | null;
  promisedDate?: string | Date | null;
  orderDate?: string | Date | null;
}

export interface IncomingReceipt {
  id?: string | number;
  date: string;
  quantity: number;
  overdue: boolean;
}

export interface IncomingResolution {
  total: number;
  receipts: IncomingReceipt[];
  flags: PlanningFlagCode[];
}

export interface ProjectionDay {
  date: string;
  openingStock: number;
  incoming: number;
  demand: number;
  closingStock: number;
}

export interface ProjectionResult {
  days: ProjectionDay[];
  projectedStockoutDate: string | null;
  daysUntilStockout: number | null;
  minProjectedStock: number;
  minStockDate: string;
}

export interface ReplenishmentResult {
  leadTimeDemand: number;
  safetyBuffer: number;
  reorderPoint: number;
  inventoryPosition: number;
  reorderGap: number;
  needsOrder: boolean;
}

export interface CalculationStep {
  code: string;
  formula: string;
  value: number;
}

export interface SoqResult {
  rawQuantity: number;
  suggestedQuantity: number;
  suggestedPackCount: number;
  moqApplied: number | null;
  deferredByMoq: boolean;
  steps: CalculationStep[];
  flags: PlanningFlagCode[];
}

export type PlanningPriority =
  | 'CRITICAL'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'HEALTHY'
  | 'OVERSTOCK'
  | 'NO_DATA';

export interface PriorityResult {
  priority: PlanningPriority;
  rank: number;
  daysOfSupply: number | null;
  urgencyRatio: number | null;
}

export type ConfigScope = 'GLOBAL' | 'CATEGORY' | 'SUPPLIER' | 'SKU';

/**
 * Tham số tính toán còn cấu hình được theo cấp GLOBAL/CATEGORY/SUPPLIER/SKU.
 *
 * `leadTimeDays` và `moq` đã bị loại khỏi đây: leadtime nay tính từ pipeline
 * mạng lưới (nhà máy → thông quan → kho gốc → điều chuyển), còn MOQ lấy từ
 * khai báo ở nhà máy / mapping SKU × nhà máy. Giữ chúng ở hai nơi chỉ tạo ra
 * dữ liệu mâu thuẫn.
 */
export interface PlanningConfig {
  safetyDays: number;
  coverageDays: number;
}

export interface OperationalPlanningDefaults {
  purchaseMultiple: number;
  moqTolerance: number;
  minDays: number;
  overstockDays: number;
  projectionDays: number;
}

export type PlanningConfigKey = keyof PlanningConfig;

export interface ConfigValue {
  scope: ConfigScope;
  scopeId?: string | number | null;
  key: PlanningConfigKey;
  value: number;
  active?: boolean;
}

export interface ConfigContext {
  skuId?: string | number | null;
  supplierId?: string | number | null;
  categoryId?: string | number | null;
}

export interface ResolvedConfig {
  config: PlanningConfig;
  sources: Record<PlanningConfigKey, ConfigScope | 'DEFAULT'>;
  sourceValues: Record<PlanningConfigKey, ConfigValue | null>;
}
