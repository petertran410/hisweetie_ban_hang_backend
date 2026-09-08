/**
 * Leadtime pipeline — thời gian từ lúc đặt nhà máy tới lúc hàng về công ty.
 *
 *   Nhà máy ──SX──▶ Thông quan ──▶ Về kho gốc
 *   (nhập 1 số)     (cố định 10 ngày)  (cố định 10 ngày)
 *
 * Người dùng chỉ khai báo số ngày sản xuất của nhà máy. Hai chặng còn lại
 * không chỉnh trên giao diện.
 */

export type CargoType = 'COLD' | 'NORMAL';

export type LeadtimeStageCode = 'PRODUCTION' | 'CUSTOMS' | 'INBOUND';

/** @deprecated Giữ để đọc dữ liệu cũ còn lưu min/max. */
export interface LeadtimeRange {
  min: number;
  max: number;
}

export interface LeadtimeStage extends LeadtimeRange {
  code: LeadtimeStageCode;
  label: string;
  days: number;
  source: 'FACTORY' | 'SKU_OVERRIDE' | 'SYSTEM_DEFAULT';
}

export interface LeadtimePipeline extends LeadtimeRange {
  days: number;
  stages: LeadtimeStage[];
}

export interface NetworkLeadtimeConfig {
  customs: LeadtimeRange;
  inbound: LeadtimeRange;
}

export interface FactoryLeadtimeConfig {
  factoryId: number;
  factoryName: string;
  production: LeadtimeRange | null;
  productionDays?: number | null;
}

export const CUSTOMS_LEADTIME_DAYS = 10;
export const INBOUND_LEADTIME_DAYS = 10;

const STAGE_LABEL: Record<LeadtimeStageCode, string> = {
  PRODUCTION: 'Sản xuất tại nhà máy',
  CUSTOMS: 'Thông quan',
  INBOUND: 'Về kho gốc',
};

export function normalizeRange(range: LeadtimeRange): LeadtimeRange {
  const min = Number.isFinite(range.min) ? Math.max(0, range.min) : 0;
  const max = Number.isFinite(range.max) ? Math.max(0, range.max) : 0;
  return min <= max ? { min, max } : { min: max, max: min };
}

export function buildRange(
  min: number | null | undefined,
  max: number | null | undefined,
): LeadtimeRange | null {
  if (min == null && max == null) return null;
  const fallback = (min ?? max) as number;
  return normalizeRange({ min: min ?? fallback, max: max ?? fallback });
}

/** Một ô leadtime nhà máy: ưu tiên số đơn, không thì lấy cận trên của dữ liệu cũ. */
export function singleLeadtimeDays(
  min: number | null | undefined,
  max: number | null | undefined,
  days?: number | null,
): number | null {
  if (days != null && Number.isFinite(days)) return Math.max(0, days);
  if (max != null && Number.isFinite(max)) return Math.max(0, max);
  if (min != null && Number.isFinite(min)) return Math.max(0, min);
  return null;
}

export interface ResolvePipelineInput {
  network?: NetworkLeadtimeConfig | null;
  factory: FactoryLeadtimeConfig | null;
  skuProductionOverrideDays?: number | null;
}

export function resolveLeadtimePipeline(
  input: ResolvePipelineInput,
): LeadtimePipeline {
  const stages: LeadtimeStage[] = [
    resolveProductionStage(input),
    stage('CUSTOMS', CUSTOMS_LEADTIME_DAYS, 'SYSTEM_DEFAULT'),
    stage('INBOUND', INBOUND_LEADTIME_DAYS, 'SYSTEM_DEFAULT'),
  ];
  const days = stages.reduce((total, item) => total + item.days, 0);
  return { stages, days, min: days, max: days };
}

function resolveProductionStage(input: ResolvePipelineInput): LeadtimeStage {
  const base = {
    code: 'PRODUCTION' as const,
    label: input.factory
      ? `${STAGE_LABEL.PRODUCTION} ${input.factory.factoryName}`
      : STAGE_LABEL.PRODUCTION,
  };

  if (input.skuProductionOverrideDays != null) {
    const days = Math.max(0, input.skuProductionOverrideDays);
    return { ...base, min: days, max: days, days, source: 'SKU_OVERRIDE' };
  }

  const factoryDays = singleLeadtimeDays(
    input.factory?.production?.min,
    input.factory?.production?.max,
    input.factory?.productionDays,
  );
  if (factoryDays != null) {
    return {
      ...base,
      min: factoryDays,
      max: factoryDays,
      days: factoryDays,
      source: 'FACTORY',
    };
  }

  return { ...base, min: 0, max: 0, days: 0, source: 'SYSTEM_DEFAULT' };
}

function stage(
  code: LeadtimeStageCode,
  days: number,
  source: LeadtimeStage['source'],
): LeadtimeStage {
  return {
    code,
    label: STAGE_LABEL[code],
    min: days,
    max: days,
    days,
    source,
  };
}
