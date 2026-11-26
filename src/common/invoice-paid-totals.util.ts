import {
  INVOICE_STATUS,
  getStatusLabel,
} from '../invoices/dto/invoice-status.constants';

export type InvoicePaidTotals = {
  paidAmount: number;
  debtAmount: number;
  status?: number;
  statusValue?: string;
};

/**
 * "Khách đã trả" / "Còn nợ" của hóa đơn từ tổng phiếu còn hiệu lực + CTN.
 * Hết nợ: Giao thành công → Hoàn thành; còn nợ: Hoàn thành → Giao thành công.
 * Hóa đơn đã hủy giữ nguyên trạng thái.
 */
export function nextInvoicePaidTotals(
  invoice: { grandTotal: unknown; status: number },
  sumPayments: number,
  sumCtns: number,
): InvoicePaidTotals {
  const paidAmount = sumPayments + sumCtns;
  const debtAmount = Math.max(0, Number(invoice.grandTotal) - paidAmount);
  if (invoice.status === INVOICE_STATUS.CANCELLED) {
    return { paidAmount, debtAmount };
  }

  let status: number = invoice.status;
  if (debtAmount <= 0) {
    if (status === INVOICE_STATUS.DELIVERED) status = INVOICE_STATUS.COMPLETED;
  } else if (status === INVOICE_STATUS.COMPLETED) {
    status = INVOICE_STATUS.DELIVERED;
  }
  return {
    paidAmount,
    debtAmount,
    status,
    statusValue: getStatusLabel(status),
  };
}

/** Tính lại và lưu số đã trả / còn nợ / trạng thái của hóa đơn trong `tx`. */
export async function recalcInvoicePaidTotals(
  tx: any,
  invoiceId: number,
): Promise<InvoicePaidTotals | null> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { grandTotal: true, status: true },
  });
  if (!invoice) return null;

  const activePayments = await tx.invoicePayment.findMany({
    where: { invoiceId, status: { not: 2 } },
    select: { amount: true },
  });
  const sumPayments = activePayments.reduce(
    (sum: number, p: any) => sum + Number(p.amount),
    0,
  );

  const activeCtns = await tx.returnOrder.findMany({
    where: { invoiceId, refundType: 'manual_offset', status: 4 },
    select: { refundAmount: true },
  });
  const sumCtns = activeCtns.reduce(
    (sum: number, c: any) => sum + Number(c.refundAmount),
    0,
  );

  const totals = nextInvoicePaidTotals(invoice, sumPayments, sumCtns);
  await tx.invoice.update({ where: { id: invoiceId }, data: totals });
  return totals;
}
