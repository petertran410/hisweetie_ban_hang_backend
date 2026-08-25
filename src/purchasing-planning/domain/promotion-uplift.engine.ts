/**
 * Nhu cầu tăng thêm do các đợt khuyến mãi đang chạy hoặc sắp chạy.
 *
 * Đặt hàng chỉ nhìn quá khứ sẽ luôn thiếu hàng đúng vào lúc cần nhất: đợt
 * khuyến mãi tháng sau đã nằm trên lịch, nhưng lịch sử bán ba tháng qua không
 * hề biết tới nó.
 *
 * Cách tính:
 *
 *   1. Lấy các đợt KM có phần giao với horizon đặt hàng
 *      (`leadtime + safety + coverage` ngày tới).
 *   2. Đếm số ngày thực sự nằm trong horizon của các đợt đó, không đếm trùng
 *      ngày khi hai đợt chồng nhau.
 *   3. Nhân số ngày đó với phần nhu cầu **dôi ra** so với ngày thường:
 *      `nhu cầu nền × (uplift − 1)`.
 *
 * Hệ số `uplift` không bịa: lấy từ chính lịch sử SKU đó — các tháng từng chạy
 * KM đã bán gấp bao nhiêu lần mức nền. SKU chưa từng chạy KM thì uplift = 1,
 * tức không cộng gì, thay vì đoán một con số chung cho mọi mặt hàng.
 */

import type { MonthAssessment, PromotionWindow } from './stability.engine';

const DAY_MS = 86_400_000;

/** Trần hệ số để một tháng dị thường không thổi bay số lượng đặt. */
const MAX_UPLIFT = 3;

export interface PromotionUpliftInput {
  today: Date;
  /** Số ngày tính từ hôm nay mà lượng hàng đặt lần này phải phủ. */
  horizonDays: number;
  /** Nhu cầu nền theo ngày, đã khử đột biến. */
  baselineDailyDemand: number;
  /** Các đợt khuyến mãi áp dụng cho SKU này. */
  promotions: PromotionWindow[];
  /** Đánh giá theo tháng từ `analyzeDemandStability`, để suy hệ số uplift. */
  months: MonthAssessment[];
}

export interface PromotionUpliftResult {
  /** Số lượng cộng thêm vào nhu cầu trong horizon. */
  extraDemand: number;
  /** Số ngày trong horizon có khuyến mãi (đã khử trùng lặp). */
  promotionDays: number;
  /** Hệ số bán vượt mức nền, suy từ lịch sử chính SKU này. */
  upliftFactor: number;
  /** Các đợt đang/sắp chạy, để hiển thị cho người mua. */
  windows: Array<{ name: string | null; startDate: Date; endDate: Date }>;
}

export function calculatePromotionUplift(
  input: PromotionUpliftInput,
): PromotionUpliftResult {
  const empty: PromotionUpliftResult = {
    extraDemand: 0,
    promotionDays: 0,
    upliftFactor: 1,
    windows: [],
  };

  if (input.baselineDailyDemand <= 0 || input.horizonDays <= 0) return empty;

  const horizonEnd = addDays(input.today, input.horizonDays);
  const active = input.promotions.filter(
    (promotion) =>
      promotion.endDate >= input.today && promotion.startDate <= horizonEnd,
  );
  if (active.length === 0) return empty;

  const promotionDays = countCoveredDays(active, input.today, horizonEnd);
  if (promotionDays <= 0) return empty;

  const upliftFactor = deriveUplift(input.months);
  // Chỉ cộng phần dôi ra: những ngày này vốn đã được nhu cầu nền tính một lần.
  const extraDemand = Math.round(
    input.baselineDailyDemand * (upliftFactor - 1) * promotionDays,
  );

  return {
    extraDemand: Math.max(0, extraDemand),
    promotionDays,
    upliftFactor,
    windows: active.map((promotion) => ({
      name: promotion.name ?? null,
      startDate: promotion.startDate,
      endDate: promotion.endDate,
    })),
  };
}

/**
 * Số ngày có ít nhất một đợt KM đang chạy, trong phạm vi horizon.
 *
 * Hai đợt chồng nhau vẫn chỉ là một ngày khuyến mãi — cộng dồn sẽ thổi phồng
 * nhu cầu lên gấp đôi mà không có cơ sở nào.
 */
function countCoveredDays(
  promotions: PromotionWindow[],
  from: Date,
  to: Date,
): number {
  const ranges = promotions
    .map((promotion) => ({
      start: Math.max(promotion.startDate.getTime(), from.getTime()),
      end: Math.min(promotion.endDate.getTime(), to.getTime()),
    }))
    .filter((range) => range.end >= range.start)
    .sort((a, b) => a.start - b.start);

  let days = 0;
  let cursor = -Infinity;

  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    if (range.end < start) continue;
    days += Math.floor((range.end - start) / DAY_MS) + 1;
    cursor = range.end + DAY_MS;
  }

  return days;
}

/**
 * Hệ số bán vượt mức nền trong các đợt KM đã qua của chính SKU này.
 *
 * Dùng trung bình `ratio` của các tháng vừa bán vọt vừa có KM — đó là những
 * tháng mà nguyên nhân đột biến đã được giải thích chắc chắn.
 */
function deriveUplift(months: MonthAssessment[]): number {
  const promoted = months.filter(
    (month) => month.hasPromotion && month.anomaly === 'SPIKE',
  );
  if (promoted.length === 0) return 1;

  const average =
    promoted.reduce((sum, month) => sum + month.ratio, 0) / promoted.length;

  if (!Number.isFinite(average) || average <= 1) return 1;
  return Math.round(Math.min(average, MAX_UPLIFT) * 100) / 100;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
