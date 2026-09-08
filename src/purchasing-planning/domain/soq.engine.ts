import { round } from './date';
import { SoqResult } from './models';
import {
  MoqProductInfo,
  MoqSpec,
  measureLine,
  netWeightKgPerPack,
} from '../../common/moq.util';

/**
 * Quy MOQ có đơn vị về **số gói lẻ** để engine SOQ (vốn làm việc thuần theo
 * số lượng) dùng được mà không phải đổi logic.
 *
 * Trả `null` khi thiếu dữ liệu quy đổi (sản phẩm chưa khai khối lượng /
 * quy cách) — nơi gọi nên gắn cờ cảnh báo thay vì coi như không có MOQ.
 */
export function moqSpecToPacks(
  spec: MoqSpec | null,
  product: MoqProductInfo,
): number | null {
  if (!spec) return 0;

  switch (spec.unit) {
    case 'PACK':
      return spec.value;
    case 'CARTON': {
      const conv = Number(product.conversionValue);
      if (!Number.isFinite(conv) || conv <= 0) return null;
      return spec.value * conv;
    }
    case 'KG':
    case 'TON': {
      const perPack = netWeightKgPerPack(product);
      if (perPack.value == null) return null;
      const kg = spec.unit === 'TON' ? spec.value * 1000 : spec.value;
      return kg / perPack.value;
    }
    default:
      return null;
  }
}

/** Diễn giải lại số gói lẻ sang đơn vị của MOQ — dùng để hiển thị. */
export function packsToMoqUnit(
  packs: number,
  spec: MoqSpec,
  product: MoqProductInfo,
): number | null {
  return measureLine(packs, spec.unit, product).value;
}

export interface SoqInput {
  forecastDailyDemand: number;
  leadTimeDays: number;
  safetyDays: number;
  availableStock: number;
  usableIncoming?: number;
  customerOrders?: number;
  companyNeed?: number;
  extraDemand?: number;
  riskIncoming?: number;
  daysOfSupply?: number | null;
  packSize: number;
  moq: number;
  purchaseMultiple?: number;
  moqTolerance?: number;
  needsOrder?: boolean;
}

/**
 * Số ngày một đợt đặt cần phủ, suy thẳng từ thời gian chờ hàng.
 *
 * Lý do không để người dùng khai: nhịp đặt hàng không phải một lựa chọn tùy
 * thích, nó bị chính leadtime quyết định. Nếu mỗi đợt chỉ đủ dùng đúng bằng
 * thời gian chờ, thì vừa nhận hàng xong đã phải đặt tiếp — không có khoảng
 * thở nào để xử lý biến động. Nhân đôi cho ra nhịp đặt hợp lý: hàng đợt này
 * còn đang bán thì đợt sau đã kịp về.
 *
 * Chặn dưới 30 ngày để hàng nội địa (leadtime ngắn) không bị đặt vụn.
 */
export function coverageDaysFor(leadTimeDays: number): number {
  return Math.max(30, Math.round(leadTimeDays * 2));
}

export function calculateSoq(input: SoqInput): SoqResult {
  const coverageDays = coverageDaysFor(input.leadTimeDays);
  const salesDemand =
    Math.max(0, input.forecastDailyDemand) *
    (input.leadTimeDays + input.safetyDays + coverageDays);
  const customerOrders = Math.max(0, input.customerOrders ?? 0);
  const companyNeed = Math.max(0, input.companyNeed ?? 0);
  const extraDemand = Math.max(0, input.extraDemand ?? 0);
  const totalDemand = salesDemand + customerOrders + companyNeed + extraDemand;
  const confirmedIncoming = Math.max(0, input.usableIncoming ?? 0);
  const riskIncoming = Math.max(0, input.riskIncoming ?? 0);
  const firmSupply = input.availableStock + confirmedIncoming;
  const scenarioSupply = firmSupply + riskIncoming;
  const rawQuantity = round(Math.max(0, totalDemand - firmSupply));
  const scenarioRawQuantity = round(Math.max(0, totalDemand - scenarioSupply));
  const multiple =
    Math.max(1, input.packSize) * Math.max(1, input.purchaseMultiple ?? 1);
  const roundedQuantity =
    rawQuantity > 0 ? Math.ceil(rawQuantity / multiple) * multiple : 0;
  const roundedScenario =
    scenarioRawQuantity > 0
      ? Math.ceil(scenarioRawQuantity / multiple) * multiple
      : 0;
  const moq = Math.max(0, input.moq);
  const tolerance = Math.max(0, input.moqTolerance ?? 0.5);
  let suggestedQuantity = input.needsOrder === false ? 0 : roundedQuantity;
  let scenarioQuantity = input.needsOrder === false ? 0 : roundedScenario;
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
  if (scenarioQuantity > 0 && scenarioQuantity < moq && suggestedQuantity === 0) {
    scenarioQuantity = 0;
  }

  suggestedQuantity = round(suggestedQuantity);
  scenarioQuantity = round(scenarioQuantity);
  return {
    rawQuantity,
    suggestedQuantity,
    suggestedPackCount: round(
      suggestedQuantity / Math.max(1, input.packSize),
      2,
    ),
    scenarioQuantity,
    moqApplied,
    deferredByMoq,
    steps: [
      {
        code: 'SALES_DEMAND',
        formula: 'FDD × (chờ hàng + dự phòng + chu kỳ đặt)',
        value: round(salesDemand),
      },
      {
        code: 'TOTAL_DEMAND',
        formula: 'bán dự kiến + khách đặt + công ty cần + KM/trend',
        value: round(totalDemand),
      },
      {
        code: 'SOQ_RAW',
        formula: 'max(0, totalDemand - tồn khả dụng - hàng về chắc chắn)',
        value: rawQuantity,
      },
      {
        code: 'SOQ_SCENARIO',
        formula: 'max(0, totalDemand - tồn - hàng về chắc chắn - ghép xe rủi ro)',
        value: scenarioRawQuantity,
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
