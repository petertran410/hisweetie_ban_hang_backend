/**
 * Trả lời câu hỏi trung tâm của màn hình dự kiến đặt hàng:
 * **"Tháng sau có phải đặt không, hay vài tháng nữa mới cần?"**
 *
 * Cách nghĩ:
 *
 *   Hàng đặt hôm nay → mất `leadtime` ngày mới về tới công ty.
 *   Vậy hàng phải rời nhà máy TRƯỚC ngày công ty cạn kho `leadtime` ngày.
 *
 *       ngày phải đặt = ngày cạn kho − leadtime(chậm nhất) − đệm an toàn
 *
 * Lấy `leadtime` cận trên chứ không phải cận dưới: đặt theo cận dưới nghĩa là
 * cứ mỗi lần nhà máy chạy chậm hơn thường lệ là đứt hàng.
 *
 * Tồn kho và nhu cầu tính gộp **toàn công ty**. Việc hàng nằm ở kho nào và
 * điều chuyển ra sao là bài toán phân phối nội bộ, không ảnh hưởng tới quyết
 * định mua hàng: mua là mua cho cả công ty.
 */

export type OrderUrgency =
  | 'ORDER_NOW' // Đã quá hạn hoặc sát hạn đặt
  | 'ORDER_THIS_MONTH'
  | 'ORDER_NEXT_MONTH'
  | 'ORDER_LATER' // Còn vài tháng nữa
  | 'NO_ACTION'; // Không bán / không dự báo được

/** Vị thế tồn kho gộp của toàn công ty. */
export interface CompanyStockPosition {
  onHand: number;
  /** Nhu cầu bán bình quân mỗi ngày trên toàn công ty. */
  dailyDemand: number;
  /** Hàng đang trên đường về công ty. */
  incoming: number;
}

export interface OrderTimingInput {
  today: Date;
  position: CompanyStockPosition;
  /** Tổng leadtime cận trên, từ đặt nhà máy tới khi hàng về công ty. */
  leadTimeMaxDays: number;
  /** Đệm an toàn suy từ độ bất ổn doanh số. */
  safetyDays: number;
}

export interface OrderTimingResult {
  urgency: OrderUrgency;
  /** Số ngày tồn hiện có (kể cả hàng đang về) còn đủ bán. */
  daysOfSupply: number | null;
  /** Ngày công ty cạn kho theo tốc độ bán hiện tại. */
  runoutDate: Date | null;
  /** Ngày chậm nhất phải đặt để hàng kịp về. */
  latestOrderDate: Date | null;
  /** Số ngày còn lại tới hạn đặt. Âm nghĩa là đã trễ. */
  daysUntilOrderDeadline: number | null;
  /** Câu trả lời ngắn gọn cho người mua hàng. */
  recommendation: string;
}

const DAY_MS = 86_400_000;

export function calculateOrderTiming(
  input: OrderTimingInput,
): OrderTimingResult {
  const { position } = input;
  const supply = Math.max(0, position.onHand) + Math.max(0, position.incoming);

  // Không phát sinh bán thì không có sức ép đặt hàng nào để tính.
  if (position.dailyDemand <= 0) {
    return {
      urgency: 'NO_ACTION',
      daysOfSupply: null,
      runoutDate: null,
      latestOrderDate: null,
      daysUntilOrderDeadline: null,
      recommendation: 'Chưa phát sinh bán — chưa cần đặt.',
    };
  }

  const rawDaysOfSupply = supply / position.dailyDemand;
  const daysOfSupply = Math.round(rawDaysOfSupply * 10) / 10;
  const runoutDate = addDays(input.today, Math.floor(rawDaysOfSupply));

  // Hàng phải được đặt sớm hơn ngày cạn kho đúng bằng thời gian chờ hàng.
  const bufferDays = input.leadTimeMaxDays + input.safetyDays;
  const daysUntilDeadline = Math.floor(daysOfSupply - bufferDays);
  const latestOrderDate = addDays(input.today, daysUntilDeadline);

  return {
    urgency: classify(daysUntilDeadline, input.today),
    daysOfSupply,
    runoutDate,
    latestOrderDate,
    daysUntilOrderDeadline: daysUntilDeadline,
    recommendation: describe(daysUntilDeadline, runoutDate, input.today),
  };
}

function classify(daysUntilDeadline: number, today: Date): OrderUrgency {
  if (daysUntilDeadline <= 0) return 'ORDER_NOW';

  const deadline = addDays(today, daysUntilDeadline);
  const monthsAhead = monthDiff(today, deadline);

  if (monthsAhead === 0) return 'ORDER_THIS_MONTH';
  if (monthsAhead === 1) return 'ORDER_NEXT_MONTH';
  return 'ORDER_LATER';
}

function describe(
  daysUntilDeadline: number,
  runoutDate: Date,
  today: Date,
): string {
  if (daysUntilDeadline < 0) {
    return `Đã trễ ${Math.abs(daysUntilDeadline)} ngày — hàng sẽ hết trước khi hàng mới kịp về. Đặt ngay.`;
  }
  if (daysUntilDeadline === 0) {
    return 'Hạn đặt là hôm nay để không bị đứt hàng.';
  }

  const deadline = addDays(today, daysUntilDeadline);
  const monthsAhead = monthDiff(today, deadline);

  if (monthsAhead === 0) {
    return `Cần đặt trong tháng này (chậm nhất ${formatDate(deadline)}) — cạn hàng ${formatDate(runoutDate)}.`;
  }
  if (monthsAhead === 1) {
    return `Có thể đợi sang tháng sau, chậm nhất ${formatDate(deadline)} — cạn hàng ${formatDate(runoutDate)}.`;
  }
  return `Chưa cần đặt, còn khoảng ${monthsAhead} tháng nữa (chậm nhất ${formatDate(deadline)}).`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Số tháng lịch chênh lệch — dùng để nói "tháng này / tháng sau". */
function monthDiff(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}
