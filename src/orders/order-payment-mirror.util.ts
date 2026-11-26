// Khi lập hóa đơn từ đơn, mỗi phiếu thanh toán của đơn (TTDH…) được sao thành
// một phiếu TTTU<mã HĐ>-n trên hóa đơn (invoices.service createFromOrder), cùng
// số tiền và cùng paymentDate. Hai phiếu không có khóa nối: khớp theo
// (đơn, số tiền, paymentDate) như getPaymentHistory. Bản sao không tính công nợ
// (customer-debt.util bỏ TTTUHD) nên hủy phiếu gốc mà quên bản sao thì hóa đơn
// vẫn hiện "Khách đã trả" khoản đã hủy.

import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';

export const ORDER_PAYMENT_MIRROR_PREFIX = 'TTTU';

const CANCELLED = 2;

export type OrderPaymentSource = {
  id?: number;
  orderId: number;
  amount: unknown;
  paymentDate: Date | string;
  status?: number;
};

export type MirrorCandidate = {
  id: number;
  invoiceId: number;
  orderId: number | null;
  cashFlowId: number | null;
  code: string;
  amount: unknown;
  paymentDate: Date | string;
};

const sameMoney = (a: unknown, b: unknown) =>
  Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const sameTime = (a: Date | string, b: Date | string) =>
  new Date(a).getTime() === new Date(b).getTime();

/**
 * Ghép mỗi phiếu gốc với một bản sao chưa dùng (cùng đơn, số tiền, paymentDate).
 * Trả về theo thứ tự `sources`; phiếu không có bản sao thì là null.
 */
export function matchOrderPaymentMirrors<C extends MirrorCandidate>(
  sources: OrderPaymentSource[],
  candidates: C[],
): (C | null)[] {
  const used = new Set<number>();
  return sources.map((source) => {
    const mirror = candidates.find(
      (c) =>
        !used.has(c.id) &&
        c.orderId === source.orderId &&
        sameMoney(c.amount, source.amount) &&
        sameTime(c.paymentDate, source.paymentDate),
    );
    if (!mirror) return null;
    used.add(mirror.id);
    return mirror;
  });
}

/**
 * Bản sao còn hiệu lực mà phiếu gốc đã hủy. Phiếu còn hiệu lực được ghép
 * trước, để đơn có 2 phiếu giống nhau (1 hủy, 1 còn) không hủy nhầm bản sao
 * của phiếu còn hiệu lực.
 */
export function findOrphanOrderPaymentMirrors<
  S extends OrderPaymentSource,
  C extends MirrorCandidate,
>(sources: S[], candidates: C[]): { mirror: C; source: S }[] {
  const ordered = [
    ...sources.filter((s) => s.status !== CANCELLED),
    ...sources.filter((s) => s.status === CANCELLED),
  ];
  const matches = matchOrderPaymentMirrors(ordered, candidates);
  return ordered.flatMap((source, i) => {
    const mirror = matches[i];
    return mirror && source.status === CANCELLED ? [{ mirror, source }] : [];
  });
}

/** Bản sao còn hiệu lực (trên hóa đơn chưa hủy) của các đơn trong `orderIds`. */
export async function loadOrderPaymentMirrorCandidates(
  db: any,
  orderIds: number[],
): Promise<MirrorCandidate[]> {
  if (orderIds.length === 0) return [];
  const rows = await db.invoicePayment.findMany({
    where: {
      code: { startsWith: ORDER_PAYMENT_MIRROR_PREFIX },
      status: { not: CANCELLED },
      invoice: {
        orderId: { in: [...new Set(orderIds)] },
        status: { not: INVOICE_STATUS.CANCELLED },
      },
    },
    select: {
      id: true,
      invoiceId: true,
      cashFlowId: true,
      code: true,
      amount: true,
      paymentDate: true,
      invoice: { select: { orderId: true } },
    },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ invoice, ...row }: any) => ({
    ...row,
    orderId: invoice?.orderId ?? null,
  }));
}

/**
 * Bản sao trên hóa đơn của các phiếu thanh toán đơn sắp bị hủy. Bản sao đã
 * được phiếu khác (còn hiệu lực, cùng đơn/số tiền/ngày) giữ thì không trả về.
 */
export async function findInvoiceMirrorsOfOrderPayments(
  db: any,
  payments: OrderPaymentSource[],
): Promise<MirrorCandidate[]> {
  if (payments.length === 0) return [];
  const orderIds = [...new Set(payments.map((p) => p.orderId))];
  const candidates = await loadOrderPaymentMirrorCandidates(db, orderIds);
  if (candidates.length === 0) return [];

  // Phiếu khác của các đơn này đang còn hiệu lực giữ bản sao của chúng trước.
  const others = await db.orderPayment.findMany({
    where: { orderId: { in: orderIds }, status: { not: CANCELLED } },
    select: { id: true, orderId: true, amount: true, paymentDate: true },
  });
  const cancelling = new Set(
    payments.map((p) => p.id).filter((id): id is number => id != null),
  );
  const kept = others.filter((p: any) => !cancelling.has(p.id));

  return findOrphanOrderPaymentMirrors(
    [
      ...kept.map((p: any) => ({ ...p, status: 1 })),
      ...payments.map((p) => ({ ...p, status: CANCELLED })),
    ],
    candidates,
  ).map(({ mirror }) => mirror);
}
