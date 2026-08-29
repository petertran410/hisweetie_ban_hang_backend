// ====================================================================
// Hằng số cho tính năng THEO DÕI CÔNG NỢ KHÁCH HÀNG
//
// Các enum dưới đây bám sát quy trình đang vận hành thực tế (file quản lý
// công nợ + bảng theo dõi thu hồi nợ), không phải do thiết kế tự đặt ra.
// ====================================================================

// -------------------------------------------------- Hình thức công nợ

/** "Hình Thức Công Nợ" — cách khách thanh toán. */
export const DEBT_FORM = {
  /** Công Nợ Tín Nhiệm — cho nợ dựa trên uy tín, không có hợp đồng. */
  TRUST: 'TRUST',
  /** Hợp Đồng Công Nợ — có hợp đồng ràng buộc kỳ hạn. */
  CONTRACT: 'CONTRACT',
  /** Thanh Toán Khi Nhận Hàng. */
  COD: 'COD',
  /** Chuyển khoản ngay. */
  PREPAID: 'PREPAID',
} as const;

export const DEBT_FORMS: string[] = Object.values(DEBT_FORM);

export const DEBT_FORM_LABELS: Record<string, string> = {
  TRUST: 'Công Nợ Tín Nhiệm',
  CONTRACT: 'Hợp Đồng Công Nợ',
  COD: 'Thanh Toán Khi Nhận Hàng',
  PREPAID: 'Chuyển khoản ngay',
};

// -------------------------------------------------- Đánh giá lịch sử thanh toán

/**
 * Đánh giá dựa trên 6 tháng gần nhất. Giá trị AUTO không lưu DB; chỉ lưu
 * override khi người dùng cần điều chỉnh kết luận của hệ thống.
 */
export const PAYMENT_HISTORY = {
  ON_TIME: 'ON_TIME',
  SLIGHT_LATE: 'SLIGHT_LATE',
  OFTEN_LATE: 'OFTEN_LATE',
  HIGH_RISK: 'HIGH_RISK',
} as const;

export type PaymentHistory =
  (typeof PAYMENT_HISTORY)[keyof typeof PAYMENT_HISTORY];

export const PAYMENT_HISTORIES: string[] = Object.values(PAYMENT_HISTORY);

export const PAYMENT_HISTORY_LABELS: Record<string, string> = {
  ON_TIME: 'Thanh toán đúng hạn',
  SLIGHT_LATE: 'Thanh toán trễ nhẹ',
  OFTEN_LATE: 'Thường xuyên chậm trễ',
  HIGH_RISK: 'Có rủi ro cao',
};

/** Chỉ số mặc định của 6 tháng: trễ tối đa ≤ 7 ngày được coi là trễ nhẹ. */
export const PAYMENT_HISTORY_SLIGHT_LATE_MAX_DAYS = 7;

/** Trễ > 2 lần trong 6 tháng ⇒ thường xuyên chậm trễ. */
export const PAYMENT_HISTORY_OFTEN_LATE_COUNT = 2;

/** Có bất kỳ khoản quá hạn > 30 ngày ⇒ rủi ro cao. */
export const PAYMENT_HISTORY_HIGH_RISK_OVERDUE_DAYS = 30;

/** Thời gian quan sát lịch sử thanh toán. */
export const PAYMENT_HISTORY_LOOKBACK_MONTHS = 6;

// -------------------------------------------------- Ân hạn & ngưỡng

/**
 * Số ngày ân hạn sau khi cán mốc nợ. Áp dụng CHUNG cho mọi khách.
 * Khách hết hạn ngày thì còn thêm 5 ngày nữa mới bị coi là quá hạn.
 */
export const DEBT_GRACE_DAYS = 5;

/** Còn <= số ngày này tới hạn thì coi là ĐẾN HẠN (cần chú ý). */
export const DUE_THRESHOLD_DAYS = 7;

/**
 * Tỉ lệ sử dụng hạn mức bắt đầu coi là đến hạn, kể cả khi chưa cán mốc.
 * Ví dụ hạn mức 100tr, đã nợ 80tr → cảnh báo sớm.
 */
export const CREDIT_LIMIT_WARN_RATIO = 0.8;

/**
 * Số tiền tối thiểu khi đi đòi nợ không nên thấp hơn tỉ lệ này so với nợ
 * đầu kì. CHỈ CẢNH BÁO, không chặn — thực tế vận hành có khoảng 23% phiếu
 * thấp hơn ngưỡng này (gồm cả trường hợp cấn trừ ra số âm).
 */
export const MIN_PAYMENT_RATIO_WARN = 0.3;

// -------------------------------------------------- Trạng thái nợ

/**
 * "Trạng Thái Nợ" — ba mức theo đúng quy trình đang dùng.
 * FE tô màu dòng theo mức này.
 */
export const DEBT_STATUS = {
  /** Quá Hạn — đã vượt hạn thanh toán (đỏ). */
  OVERDUE: 'OVERDUE',
  /** Đến Hạn — tới hạn hoặc sắp tới trong DUE_THRESHOLD_DAYS ngày (cam). */
  DUE: 'DUE',
  /** Bình Thường (xám). */
  NORMAL: 'NORMAL',
} as const;

export type DebtStatus = (typeof DEBT_STATUS)[keyof typeof DEBT_STATUS];

export const DEBT_STATUSES: string[] = Object.values(DEBT_STATUS);

export const DEBT_STATUS_LABELS: Record<string, string> = {
  OVERDUE: 'Quá Hạn',
  DUE: 'Đến Hạn',
  NORMAL: 'Bình Thường',
};

/** Thứ tự sắp xếp: nghiêm trọng nhất lên đầu. */
export const DEBT_STATUS_WEIGHT: Record<string, number> = {
  OVERDUE: 0,
  DUE: 1,
  NORMAL: 2,
};

// -------------------------------------------------- Quá trình thu hồi nợ

/** "Quá Trình Thu Hồi Nợ" — vòng đời một phiếu đòi nợ. */
export const DEBT_TICKET_STATUS = {
  REQUESTED: 'REQUESTED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  PAID: 'PAID',
  DONE: 'DONE',
  ENDED: 'ENDED',
} as const;

export const DEBT_TICKET_STATUSES: string[] = Object.values(DEBT_TICKET_STATUS);

export const DEBT_TICKET_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Yêu Cầu Thu Hồi Nợ',
  IN_PROGRESS: 'Đang Tiến Hành',
  WAITING: 'Chờ Thanh Toán',
  PAID: 'Đã Thanh Toán',
  DONE: 'Done',
  ENDED: 'Ended',
};

/**
 * Các trạng thái coi là phiếu CÒN HOẠT ĐỘNG (chưa kết thúc).
 * Dùng để lọc "phiếu đang mở" và để quyết định có tự đóng hay không.
 */
export const DEBT_TICKET_OPEN_STATUSES: string[] = [
  DEBT_TICKET_STATUS.REQUESTED,
  DEBT_TICKET_STATUS.IN_PROGRESS,
  DEBT_TICKET_STATUS.WAITING,
];

/** Các trạng thái coi là ĐÃ KẾT THÚC. */
export const DEBT_TICKET_CLOSED_STATUSES: string[] = [
  DEBT_TICKET_STATUS.PAID,
  DEBT_TICKET_STATUS.DONE,
  DEBT_TICKET_STATUS.ENDED,
];

/** Trạng thái từng dòng khách trong phiếu. */
export const DEBT_TICKET_LINE_STATUS = {
  /** Chưa có tiền về. */
  PENDING: 'PENDING',
  /** Đã có tiền về nhưng chưa đủ mốc đối chiếu → chờ kế toán phân bổ. */
  PARTIAL: 'PARTIAL',
  /** Đã đủ. */
  PAID: 'PAID',
} as const;

export const DEBT_TICKET_LINE_STATUSES: string[] = Object.values(
  DEBT_TICKET_LINE_STATUS,
);

export const DEBT_TICKET_LINE_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chưa thu',
  PARTIAL: 'Có tiền về, chờ phân bổ',
  PAID: 'Đã thu đủ',
};

/** Cách phiếu được kết thúc. */
export const DEBT_TICKET_CLOSE_MODE = {
  AUTO: 'AUTO',
  MANUAL: 'MANUAL',
} as const;

/** Tiền tố mã phiếu thu hồi nợ. */
export const DEBT_TICKET_CODE_PREFIX = 'TCN';

// -------------------------------------------------- Khác

/**
 * Sai số cho phép khi so sánh tiền (VND). Decimal của Prisma trả về chuỗi,
 * sau khi Number() có thể lệch vài phần nghìn — 1 đồng là đủ an toàn.
 */
export const MONEY_EPSILON = 1;

/** Hóa đơn đã hủy — loại khỏi mọi phép tính công nợ. */
export const INVOICE_STATUS_CANCELLED = 2;
