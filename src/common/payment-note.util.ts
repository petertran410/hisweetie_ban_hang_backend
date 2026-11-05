/**
 * Ghi chú thanh toán mới nhất của hóa đơn: khách trả tiền mặt (kèm số tiền cần
 * thu) hay chuyển khoản. Dùng làm select lồng trong `invoice`.
 */
export const LATEST_PAYMENT_NOTE = {
  // Cùng thời điểm thì lấy ghi chú tạo sau (id lớn hơn), khớp câu SQL lọc cảnh báo.
  orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  take: 1,
  select: { paymentType: true, amount: true },
};

export interface InvoicePaymentNote {
  paymentType: string;
  amount: number | null;
}

/** Lấy ghi chú mới nhất từ kết quả select `paymentNotes: LATEST_PAYMENT_NOTE`. */
export function latestPaymentNote(
  notes?: { paymentType: string; amount: unknown }[] | null,
): InvoicePaymentNote | null {
  const note = notes?.[0];
  if (!note) return null;
  return {
    paymentType: note.paymentType,
    amount: note.amount == null ? null : Number(note.amount),
  };
}

/**
 * Các dòng chứng từ của 1 phiếu báo đơn: đổi `invoice.paymentNotes` thành
 * `invoice.paymentNote` (ghi chú mới nhất hoặc null). Dòng ký gửi giữ nguyên.
 */
export function withInvoicePaymentNote<T>(entries?: readonly T[] | null): T[] {
  return (entries ?? []).map((entry) => {
    const invoice = (entry as { invoice?: Record<string, unknown> | null })
      ?.invoice;
    if (!invoice || !('paymentNotes' in invoice)) return entry;
    const { paymentNotes, ...rest } = invoice;
    return {
      ...entry,
      invoice: {
        ...rest,
        paymentNote: latestPaymentNote(
          paymentNotes as { paymentType: string; amount: unknown }[] | null,
        ),
      },
    };
  });
}

/** Lệch dưới mức này (đồng) coi như khớp: số tiền lưu 2 chữ số thập phân. */
export const CASH_WARNING_EPSILON = 0.5;

/**
 * Cảnh báo thu tiền mặt của phiếu giao hàng so với hóa đơn:
 * - `transfer`: hóa đơn ghi khách trả tiền mặt nhưng phiếu chọn chuyển khoản.
 * - `amount`: tiền mặt cần thu trên phiếu khác tổng tiền mặt ghi trên các hóa đơn.
 */
export interface PackingCashWarning {
  kind: 'transfer' | 'amount';
  /** Tổng tiền mặt các hóa đơn ghi thu. */
  invoiceCash: number;
  /** Tiền mặt cần thu ghi trên phiếu (0 khi phiếu chuyển khoản). */
  slipCash: number;
  /** Mã các hóa đơn ghi thu tiền mặt. */
  codes: string[];
}

/**
 * So tiền mặt cần thu của phiếu giao hàng với ghi chú thanh toán mới nhất của
 * các hóa đơn trong phiếu (nhiều hóa đơn thì cộng dồn). Phiếu đã hủy, hoặc chưa
 * hóa đơn nào có ghi chú, thì không cảnh báo. Câu SQL lọc trong AllPackingService
 * phải giữ đúng quy tắc này.
 */
export function packingCashWarning(
  slip: {
    paymentMethod?: string | null;
    cashAmount?: unknown;
    cancelledAt?: Date | string | null;
  },
  entries?: readonly unknown[] | null,
): PackingCashWarning | null {
  if (slip.cancelledAt) return null;
  const invoices = (entries ?? []).flatMap((entry) => {
    const invoice = (
      entry as {
        invoice?: { code?: string; paymentNote?: InvoicePaymentNote | null };
      } | null
    )?.invoice;
    return invoice?.paymentNote ? [invoice] : [];
  });
  if (invoices.length === 0) return null;
  const cash = invoices.filter((i) => i.paymentNote?.paymentType === 'cash');
  const invoiceCash = cash.reduce(
    (sum, i) => sum + (Number(i.paymentNote?.amount) || 0),
    0,
  );
  const codes = cash.map((i) => i.code ?? '').filter(Boolean);
  if (slip.paymentMethod !== 'cash') {
    return cash.length > 0
      ? { kind: 'transfer', invoiceCash, slipCash: 0, codes }
      : null;
  }
  const slipCash = Number(slip.cashAmount) || 0;
  return Math.abs(slipCash - invoiceCash) > CASH_WARNING_EPSILON
    ? { kind: 'amount', invoiceCash, slipCash, codes }
    : null;
}
