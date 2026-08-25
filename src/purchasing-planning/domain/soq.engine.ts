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
  committedDemand?: number;
  /**
   * Nhu cầu cộng thêm ngoài mức nền — hiện dùng cho các đợt khuyến mãi đang
   * chạy hoặc sắp chạy trong horizon đặt hàng.
   */
  extraDemand?: number;
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
  // Mức tồn mục tiêu: đủ bán trong lúc chờ hàng + đệm an toàn + một chu kỳ
  // đặt hàng nữa, cộng phần nhu cầu tăng thêm đã biết trước (khuyến mãi).
  const targetStock =
    Math.max(0, input.forecastDailyDemand) *
      (input.leadTimeDays + input.safetyDays + coverageDays) +
    Math.max(0, input.extraDemand ?? 0);
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
        formula: 'FDD × (chờ hàng + dự phòng + chu kỳ đặt) + nhu cầu khuyến mãi',
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
