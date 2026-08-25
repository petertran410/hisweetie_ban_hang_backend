/**
 * Leadtime pipeline — tính khoảng thời gian từ lúc đặt nhà máy tới lúc hàng
 * sẵn sàng bán tại một chi nhánh cụ thể.
 *
 * Mô hình mạng lưới (đã chốt với nghiệp vụ):
 *
 *   Nhà máy ──SX──▶ Thông quan ──▶ Về công ty
 *   (mỗi NM khác)   (dùng chung)   (dùng chung)
 *
 * Hàng về là về **của công ty**, không phân biệt chi nhánh nào nhận. Việc điều
 * chuyển nội bộ sau đó không còn được tính vào leadtime đặt hàng: nó là bài
 * toán phân phối, không phải bài toán mua hàng.
 *
 * Đây là **tham số dự báo**, không phải mốc thực tế của đơn hàng nào. Người
 * dùng không nhập ngày sản xuất/thông quan cho từng đơn; họ chỉ khai báo
 * khoảng nhanh nhất–chậm nhất một lần cho mỗi nhà máy.
 *
 * Mỗi chặng chỉ có 2 số (nhanh nhất / chậm nhất) đúng như cách nghiệp vụ mô
 * tả: "sản xuất khoảng 10-15 ngày", "thông quan rơi 7-10 ngày".
 * `max` là con số dùng để ra quyết định — đặt theo cận dưới là chấp nhận rủi
 * ro đứt hàng mỗi khi nhà máy chạy chậm hơn thường lệ.
 */

/** Loại hàng — giữ lại cho mục đích phân loại/hiển thị. */
export type CargoType = 'COLD' | 'NORMAL';

export type LeadtimeStageCode = 'PRODUCTION' | 'CUSTOMS' | 'INBOUND';

/** Khoảng thời gian của một chặng, đơn vị ngày. */
export interface LeadtimeRange {
  min: number;
  max: number;
}

export interface LeadtimeStage extends LeadtimeRange {
  code: LeadtimeStageCode;
  label: string;
  /** Nguồn số liệu — để UI giải thích vì sao ra con số này. */
  source: 'FACTORY' | 'SKU_OVERRIDE' | 'SYSTEM_DEFAULT';
}

export interface LeadtimePipeline extends LeadtimeRange {
  stages: LeadtimeStage[];
}

/** Cấu hình chung toàn hệ thống: thông quan + về công ty. */
export interface NetworkLeadtimeConfig {
  customs: LeadtimeRange;
  inbound: LeadtimeRange;
}

/** Thời gian sản xuất khai báo trên từng nhà máy. */
export interface FactoryLeadtimeConfig {
  factoryId: number;
  factoryName: string;
  production: LeadtimeRange | null;
}

const STAGE_LABEL: Record<LeadtimeStageCode, string> = {
  PRODUCTION: 'Sản xuất tại nhà máy',
  CUSTOMS: 'Thông quan',
  INBOUND: 'Về công ty',
};

/**
 * Chuẩn hoá một khoảng về trạng thái hợp lệ: min ≤ max, không âm.
 *
 * Cố ý đảo lại thay vì ném lỗi — dữ liệu cấu hình do người dùng nhập tay, một
 * con số đảo thứ tự không nên làm sập cả lần chạy tính toán.
 */
export function normalizeRange(range: LeadtimeRange): LeadtimeRange {
  const min = Number.isFinite(range.min) ? Math.max(0, range.min) : 0;
  const max = Number.isFinite(range.max) ? Math.max(0, range.max) : 0;
  return min <= max ? { min, max } : { min: max, max: min };
}

/** Dựng khoảng từ 2 số có thể null; trả null nếu chưa khai báo gì. */
export function buildRange(
  min: number | null | undefined,
  max: number | null | undefined,
): LeadtimeRange | null {
  if (min == null && max == null) return null;
  // Chỉ khai một đầu → coi như khoảng chụm về đúng con số đó.
  const fallback = (min ?? max) as number;
  return normalizeRange({ min: min ?? fallback, max: max ?? fallback });
}

export interface ResolvePipelineInput {
  network: NetworkLeadtimeConfig;
  factory: FactoryLeadtimeConfig | null;
  /** `factory_products.leadtimeDays` — override thời gian SX theo từng SKU. */
  skuProductionOverrideDays?: number | null;
}

/**
 * Ghép các chặng thành pipeline hoàn chỉnh cho một SKU.
 *
 * Thứ tự ưu tiên cho chặng sản xuất:
 *   1. Override theo SKU (`factory_products.leadtimeDays`)
 *   2. Khoảng nhanh nhất–chậm nhất khai trên nhà máy
 *   3. 0 — kèm cờ để engine cảnh báo thiếu cấu hình
 */
export function resolveLeadtimePipeline(
  input: ResolvePipelineInput,
): LeadtimePipeline {
  const stages: LeadtimeStage[] = [];

  stages.push(resolveProductionStage(input));

  stages.push({
    code: 'CUSTOMS',
    label: STAGE_LABEL.CUSTOMS,
    ...normalizeRange(input.network.customs),
    source: 'SYSTEM_DEFAULT',
  });

  stages.push({
    code: 'INBOUND',
    label: STAGE_LABEL.INBOUND,
    ...normalizeRange(input.network.inbound),
    source: 'SYSTEM_DEFAULT',
  });

  return {
    stages,
    min: sum(stages, 'min'),
    max: sum(stages, 'max'),
  };
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
    return { ...base, min: days, max: days, source: 'SKU_OVERRIDE' };
  }

  if (input.factory?.production) {
    return {
      ...base,
      ...normalizeRange(input.factory.production),
      source: 'FACTORY',
    };
  }

  // Chưa cấu hình: trả 0 thay vì đoán bừa. Engine sẽ gắn cờ MISSING_LEADTIME
  // để người dùng biết con số đang thiếu cơ sở, thay vì âm thầm dùng 30 ngày
  // cho mọi nhà máy như cách làm cũ.
  return { ...base, min: 0, max: 0, source: 'SYSTEM_DEFAULT' };
}

function sum(stages: LeadtimeStage[], key: keyof LeadtimeRange): number {
  return stages.reduce((total, stage) => total + stage[key], 0);
}
