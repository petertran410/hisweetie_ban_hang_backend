// ====================================================================
// ENGINE TÍNH TUỔI NỢ (AGEING) — hàm thuần, không chạm DB, có unit test.
//
// BỐI CẢNH QUAN TRỌNG:
// `invoice.debtAmount` trong DB KHÔNG đáng tin để tính công nợ. Kiểm chứng
// trên dữ liệu thật: 1256/1690 khách có nợ bị lệch giữa `customer.totalDebt`
// (Formula A) và tổng nợ trên từng hóa đơn. Lý do: `recalcCustomerDebt` trừ
// các phiếu thu ở CẤP KHÁCH HÀNG, không phân bổ ngược về từng hóa đơn.
//
// Vì vậy ở đây KHÔNG cộng dồn `debtAmount`. Thay vào đó:
//   1. Lấy tổng nợ từ `customer.totalDebt` — nguồn chân lý duy nhất.
//   2. Phân bổ tổng nợ đó xuống các hóa đơn theo quy ước FIFO: tiền khách
//      đã trả luôn cấn hóa đơn CŨ NHẤT trước, nên phần nợ còn lại nằm ở các
//      hóa đơn MỚI NHẤT.
//   3. Nhờ vậy tổng phần nợ phân bổ LUÔN khớp Formula A, đồng thời biết được
//      từng phần nợ phát sinh từ lần giao hàng nào để tính hạn.
//
// HAI CHIỀU CÔNG NỢ ĐỘC LẬP (bám đúng dữ liệu vận hành):
//   - hasTermDays   : nợ tối đa N ngày kể từ ngày GIAO HÀNG ĐẦU TIÊN
//   - hasCreditLimit: nợ tới hạn mức thì phải thanh toán
//   Bật cả hai ⇒ chỉ tính quá hạn khi thỏa CẢ HAI (AND).
//   Tắt cả hai ⇒ khách không công nợ.
// ====================================================================

import {
  DEBT_GRACE_DAYS,
  DEBT_STATUS,
  DUE_THRESHOLD_DAYS,
  CREDIT_LIMIT_WARN_RATIO,
  MONEY_EPSILON,
  type DebtStatus,
} from './debt-tracking.constants';

// ---------------------------------------------------------------- types

export interface AgingInvoiceInput {
  id: number;
  code: string;
  grandTotal: number;
  /**
   * Mốc giao hàng ĐẦU TIÊN (báo đơn thành công). `null` = chưa báo đơn.
   * Hóa đơn chưa báo đơn thì CHƯA phát sinh hạn nợ theo ngày.
   */
  deliveredAt: Date | null;
  purchaseDate: Date;
}

export interface DebtPolicyInput {
  hasCreditLimit: boolean;
  creditLimit?: number | null;
  hasTermDays: boolean;
  termDays?: number | null;
  /** Cam kết số lần trả tiền mỗi tháng. Không sinh hạn thanh toán. */
  paymentFrequency?: number | null;
}

export interface OutstandingInvoice {
  id: number;
  code: string;
  grandTotal: number;
  /** Phần nợ được phân bổ cho hóa đơn này theo FIFO. */
  outstanding: number;
  deliveredAt: Date | null;
  purchaseDate: Date;
  /** null khi chưa báo đơn hoặc khách không áp hạn theo ngày. */
  dueDate: Date | null;
  daysOverdue: number;
  daysUntilDue: number | null;
  isOverdue: boolean;
}

export interface AgingResult {
  totalDebt: number;
  outstandingInvoices: OutstandingInvoice[];
  /** Nợ đã quá hạn (đã tính ân hạn, đã áp quy tắc AND nếu bật cả hai chiều). */
  overdueAmount: number;
  /** Nợ tới hạn hoặc sắp tới hạn trong DUE_THRESHOLD_DAYS ngày. */
  dueAmount: number;
  /** Nợ chưa tới hạn. */
  notDueAmount: number;
  /** Nợ thuộc hóa đơn CHƯA báo đơn → chưa khởi tạo hạn. */
  undeliveredAmount: number;
  /**
   * Nợ KHÔNG gắn được vào hóa đơn nào (nợ cũ phát sinh trước khi hệ thống
   * chạy, hoặc hóa đơn đã bị xóa). Không tính được hạn nên tách riêng.
   */
  unallocatedAmount: number;
  /** Hạn gần nhất trong số các khoản chưa quá hạn. */
  nearestDueDate: Date | null;
  /** Số ngày quá hạn lớn nhất. 0 nếu chưa quá hạn. */
  maxDaysOverdue: number;
  creditLimit: number | null;
  /** totalDebt / creditLimit. null khi không áp hạn mức. */
  creditUsageRatio: number | null;
  limitReached: boolean;
  /** Số tiền vượt hạn mức. 0 nếu chưa vượt hoặc không áp hạn mức. */
  overLimitAmount: number;
  debtStatus: DebtStatus;
}

// ------------------------------------------------------------ date utils

/** Về 00:00:00 cùng ngày (giờ server). Mọi so sánh hạn đều theo NGÀY. */
export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** Số ngày nguyên giữa hai mốc (b - a). Chuẩn hóa về đầu ngày trước khi trừ. */
export function diffDays(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86400000);
}

// ------------------------------------------------------------ due date

/**
 * Hạn thanh toán của MỘT hóa đơn, đã cộng ân hạn.
 * Trả null khi hóa đơn chưa báo đơn hoặc khách không áp hạn theo ngày.
 */
export function resolveInvoiceDueDate(
  invoice: Pick<AgingInvoiceInput, 'deliveredAt'>,
  policy: DebtPolicyInput,
  graceDays: number = DEBT_GRACE_DAYS,
): Date | null {
  // Không áp hạn theo ngày ⇒ không có hạn theo từng hóa đơn.
  if (!policy.hasTermDays) return null;

  // Chưa báo đơn giao hàng ⇒ chưa bắt đầu tính hạn.
  if (!invoice.deliveredAt) return null;

  const term = policy.termDays;
  if (term === null || term === undefined || term < 0) return null;

  return addDays(startOfDay(invoice.deliveredAt), term + graceDays);
}

// ------------------------------------------------------------ FIFO

/**
 * Phân bổ tổng nợ xuống từng hóa đơn theo FIFO.
 *
 * Quy ước: khách trả tiền thì cấn hóa đơn cũ nhất trước. Do đó phần nợ còn
 * lại thuộc về các hóa đơn mới nhất → duyệt NGƯỢC từ mới về cũ và rót
 * `totalDebt` vào cho tới khi hết.
 *
 * Trả kèm `unallocated` = phần nợ không còn hóa đơn nào để gắn (nợ cũ phát
 * sinh trước khi hệ thống chạy). Phần này không tính được hạn.
 */
export function allocateDebtFifo(
  invoices: AgingInvoiceInput[],
  totalDebt: number,
): {
  allocated: Array<AgingInvoiceInput & { outstanding: number }>;
  unallocated: number;
} {
  if (totalDebt <= MONEY_EPSILON) return { allocated: [], unallocated: 0 };

  // Cũ → mới. Hóa đơn chưa báo đơn dùng purchaseDate để xếp thứ tự
  // (chỉ để sắp xếp, KHÔNG dùng làm gốc tính hạn).
  const sorted = [...invoices].sort((a, b) => {
    const ta = (a.deliveredAt ?? a.purchaseDate).getTime();
    const tb = (b.deliveredAt ?? b.purchaseDate).getTime();
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });

  let remaining = totalDebt;
  const result: Array<AgingInvoiceInput & { outstanding: number }> = [];

  // Duyệt ngược: mới nhất trước.
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (remaining <= MONEY_EPSILON) break;
    const inv = sorted[i];
    const amount = Math.min(remaining, inv.grandTotal);
    if (amount <= MONEY_EPSILON) continue;
    result.push({ ...inv, outstanding: amount });
    remaining -= amount;
  }

  return {
    allocated: result.reverse(), // trả về cũ → mới cho dễ đọc
    unallocated: remaining > MONEY_EPSILON ? remaining : 0,
  };
}

// ------------------------------------------------------------ main

/**
 * Tính toàn bộ thông tin tuổi nợ của một khách hàng.
 *
 * @param totalDebt  LẤY TỪ customer.totalDebt (Formula A). Không tính lại.
 * @param invoices   Hóa đơn CHƯA HỦY của khách.
 * @param policy     Chính sách công nợ đang áp.
 * @param now        Thời điểm tham chiếu (cho phép inject để test).
 */
export function computeCustomerAging(
  totalDebt: number,
  invoices: AgingInvoiceInput[],
  policy: DebtPolicyInput,
  now: Date = new Date(),
  graceDays: number = DEBT_GRACE_DAYS,
): AgingResult {
  const today = startOfDay(now);

  const creditLimit =
    policy.hasCreditLimit &&
    policy.creditLimit !== null &&
    policy.creditLimit !== undefined
      ? Number(policy.creditLimit)
      : null;

  const usesLimit = creditLimit !== null && creditLimit > 0;

  const limitReached = usesLimit
    ? totalDebt >= creditLimit - MONEY_EPSILON
    : false;

  const overLimitAmount =
    usesLimit && limitReached ? Math.max(0, totalDebt - creditLimit) : 0;

  const creditUsageRatio = usesLimit ? totalDebt / creditLimit : null;

  const { allocated, unallocated } = allocateDebtFifo(invoices, totalDebt);

  const outstandingInvoices: OutstandingInvoice[] = allocated.map((inv) => {
    const dueDate = resolveInvoiceDueDate(inv, policy, graceDays);

    let isOverdue = false;
    let daysOverdue = 0;
    let daysUntilDue: number | null = null;

    if (dueDate) {
      const delta = diffDays(today, dueDate); // > 0: còn hạn, < 0: đã quá
      if (delta < 0) {
        isOverdue = true;
        daysOverdue = -delta;
      } else {
        daysUntilDue = delta;
      }
    }

    return {
      id: inv.id,
      code: inv.code,
      grandTotal: inv.grandTotal,
      outstanding: inv.outstanding,
      deliveredAt: inv.deliveredAt,
      purchaseDate: inv.purchaseDate,
      dueDate,
      daysOverdue,
      daysUntilDue,
      isOverdue,
    };
  });

  // ---- Phân loại tiền theo hai chiều chính sách ----

  let overdueAmount = 0;
  let dueAmount = 0;
  let notDueAmount = 0;
  let undeliveredAmount = 0;

  if (!policy.hasTermDays && !policy.hasCreditLimit) {
    // Không công nợ — về nguyên tắc không hiện trong danh sách theo dõi.
    notDueAmount = totalDebt - unallocated;
  } else if (!policy.hasTermDays && usesLimit) {
    // CHỈ hạn mức: không xét hạn theo từng hóa đơn.
    // Cán mốc ⇒ toàn bộ dư nợ tới hạn.
    if (limitReached) overdueAmount = totalDebt - unallocated;
    else notDueAmount = totalDebt - unallocated;
  } else {
    // Có chiều SỐ NGÀY. Nếu bật thêm hạn mức thì áp quy tắc AND:
    // chỉ coi là quá hạn khi ĐỒNG THỜI cán hạn mức VÀ hóa đơn hết hạn ngày.
    const limitGate = usesLimit ? limitReached : true;

    for (const inv of outstandingInvoices) {
      if (!inv.dueDate) {
        undeliveredAmount += inv.outstanding;
        continue;
      }
      if (inv.isOverdue && limitGate) {
        overdueAmount += inv.outstanding;
      } else if (
        inv.daysUntilDue !== null &&
        inv.daysUntilDue <= DUE_THRESHOLD_DAYS
      ) {
        dueAmount += inv.outstanding;
      } else {
        notDueAmount += inv.outstanding;
      }
    }
  }

  // Hạn gần nhất trong các khoản CHƯA quá hạn.
  const upcoming = outstandingInvoices
    .filter((i) => i.dueDate && !i.isOverdue)
    .map((i) => i.dueDate as Date)
    .sort((a, b) => a.getTime() - b.getTime());

  const nearestDueDate = upcoming.length > 0 ? upcoming[0] : null;

  const limitGateForDays =
    usesLimit && policy.hasTermDays ? limitReached : true;

  const maxDaysOverdue = outstandingInvoices
    .filter((i) => i.isOverdue && limitGateForDays)
    .reduce((m, i) => Math.max(m, i.daysOverdue), 0);

  const debtStatus = resolveDebtStatus({
    overdueAmount,
    dueAmount,
    nearestDueDate,
    today,
    creditUsageRatio,
    limitReached,
  });

  return {
    totalDebt,
    outstandingInvoices,
    overdueAmount,
    dueAmount,
    notDueAmount,
    undeliveredAmount,
    unallocatedAmount: unallocated,
    nearestDueDate,
    maxDaysOverdue,
    creditLimit,
    creditUsageRatio,
    limitReached,
    overLimitAmount,
    debtStatus,
  };
}

export function resolveDebtStatus(input: {
  overdueAmount: number;
  dueAmount: number;
  nearestDueDate: Date | null;
  today: Date;
  creditUsageRatio: number | null;
  limitReached: boolean;
}): DebtStatus {
  const {
    overdueAmount,
    dueAmount,
    nearestDueDate,
    today,
    creditUsageRatio,
    limitReached,
  } = input;

  if (overdueAmount > MONEY_EPSILON || limitReached) {
    return DEBT_STATUS.OVERDUE;
  }

  if (dueAmount > MONEY_EPSILON) return DEBT_STATUS.DUE;

  if (nearestDueDate && diffDays(today, nearestDueDate) <= DUE_THRESHOLD_DAYS) {
    return DEBT_STATUS.DUE;
  }

  // Chưa tới hạn ngày nhưng đã dùng gần hết hạn mức → vẫn cần chú ý.
  if (
    creditUsageRatio !== null &&
    creditUsageRatio >= CREDIT_LIMIT_WARN_RATIO
  ) {
    return DEBT_STATUS.DUE;
  }

  return DEBT_STATUS.NORMAL;
}

// ------------------------------------------- tần suất thanh toán / tháng

export interface PaymentFrequencyResult {
  /** Số lần khách đã thanh toán trong tháng đang xét. */
  paymentsThisMonth: number;
  /** Số lần cam kết mỗi tháng. */
  required: number;
  /** Đã đạt cam kết chưa. */
  met: boolean;
  /** Còn thiếu bao nhiêu lần. */
  remaining: number;
}

/**
 * Đánh giá cam kết TẦN SUẤT trả tiền (ví dụ "1 tháng 2 lần").
 *
 * Cố ý KHÔNG sinh hạn thanh toán: thực tế khách không báo ngày cụ thể, có
 * thể chuyển hai lần liền nhau trong cùng tuần. Vì vậy chỉ đếm số lần đã
 * trả trong tháng để nhắc khi chưa đạt, không dùng để tính quá hạn.
 *
 * @param paymentDates Ngày các lần thanh toán (CashFlow thu) của khách.
 */
export function evaluatePaymentFrequency(
  paymentDates: Date[],
  paymentFrequency: number | null | undefined,
  now: Date = new Date(),
): PaymentFrequencyResult | null {
  if (!paymentFrequency || paymentFrequency <= 0) return null;

  const y = now.getFullYear();
  const m = now.getMonth();

  const count = paymentDates.filter((d) => {
    const dd = new Date(d);
    return dd.getFullYear() === y && dd.getMonth() === m;
  }).length;

  return {
    paymentsThisMonth: count,
    required: paymentFrequency,
    met: count >= paymentFrequency,
    remaining: Math.max(0, paymentFrequency - count),
  };
}

/** Khách có bật công nợ hay không (một trong hai chiều). */
export function hasAnyDebtPolicy(policy: DebtPolicyInput): boolean {
  return !!policy.hasTermDays || !!policy.hasCreditLimit;
}
