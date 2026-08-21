import {
  PAYMENT_HISTORY,
  PAYMENT_HISTORY_HIGH_RISK_OVERDUE_DAYS,
  PAYMENT_HISTORY_LOOKBACK_MONTHS,
  PAYMENT_HISTORY_OFTEN_LATE_COUNT,
  PAYMENT_HISTORY_SLIGHT_LATE_MAX_DAYS,
  type PaymentHistory,
} from './debt-tracking.constants';

/**
 * Kết quả đánh giá tự động. Toàn bộ dựa trên dữ liệu 6 tháng gần nhất.
 * `sampleSize` = số hóa đơn đã giao có thể quan sát trong kỳ.
 */
export interface AutoPaymentHistoryResult {
  history: PaymentHistory;
  sampleSize: number;
  lateCount: number;
  maxDaysOverdue: number;
  currentOverdueDays: number;
  reason: string;
}

/**
 * Đánh giá lịch sử thanh toán tự động.
 *
 * LƯU Ý: Tiền thu hiện được quản lý ở cấp KHÁCH HÀNG, không phân bổ chắc chắn
 * cho từng hóa đơn. Vì vậy đây là GỢI Ý có thể bị kế toán/sale override.
 *
 * Quy tắc theo thứ tự nghiêm trọng:
 *   1. HIGH_RISK: bất kỳ khoản nào quá hạn > 30 ngày, hoặc hiện quá hạn >30.
 *   2. OFTEN_LATE: quá 2 khoản trễ, hoặc có khoản trễ 8–30 ngày.
 *   3. SLIGHT_LATE: có trễ nhưng tất cả ≤ 7 ngày và ≤ 2 lần.
 *   4. ON_TIME: không có khoản quá hạn quan sát được.
 */
export function evaluateAutoPaymentHistory(input: {
  lateCount: number;
  maxDaysOverdue: number;
  currentOverdueDays: number;
  sampleSize: number;
}): AutoPaymentHistoryResult {
  const { lateCount, maxDaysOverdue, currentOverdueDays, sampleSize } = input;

  if (
    maxDaysOverdue > PAYMENT_HISTORY_HIGH_RISK_OVERDUE_DAYS ||
    currentOverdueDays > PAYMENT_HISTORY_HIGH_RISK_OVERDUE_DAYS
  ) {
    return {
      history: PAYMENT_HISTORY.HIGH_RISK,
      sampleSize,
      lateCount,
      maxDaysOverdue,
      currentOverdueDays,
      reason: `Có khoản quá hạn trên ${PAYMENT_HISTORY_HIGH_RISK_OVERDUE_DAYS} ngày`,
    };
  }

  if (
    lateCount > PAYMENT_HISTORY_OFTEN_LATE_COUNT ||
    maxDaysOverdue > PAYMENT_HISTORY_SLIGHT_LATE_MAX_DAYS
  ) {
    return {
      history: PAYMENT_HISTORY.OFTEN_LATE,
      sampleSize,
      lateCount,
      maxDaysOverdue,
      currentOverdueDays,
      reason:
        lateCount > PAYMENT_HISTORY_OFTEN_LATE_COUNT
          ? `Có ${lateCount} lần trễ trong ${PAYMENT_HISTORY_LOOKBACK_MONTHS} tháng`
          : `Có khoản trễ ${maxDaysOverdue} ngày`,
    };
  }

  if (lateCount > 0) {
    return {
      history: PAYMENT_HISTORY.SLIGHT_LATE,
      sampleSize,
      lateCount,
      maxDaysOverdue,
      currentOverdueDays,
      reason: `Có ${lateCount} lần trễ, tối đa ${maxDaysOverdue} ngày`,
    };
  }

  return {
    history: PAYMENT_HISTORY.ON_TIME,
    sampleSize,
    lateCount,
    maxDaysOverdue,
    currentOverdueDays,
    reason:
      sampleSize > 0
        ? `Không có khoản trễ trong ${PAYMENT_HISTORY_LOOKBACK_MONTHS} tháng`
        : `Chưa có đủ dữ liệu giao hàng trong ${PAYMENT_HISTORY_LOOKBACK_MONTHS} tháng`,
  };
}
