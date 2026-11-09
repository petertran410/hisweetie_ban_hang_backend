import { BadRequestException } from '@nestjs/common';
import {
  DEBT_TICKET_LINE_STATUS,
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_TYPE,
} from '../debt-tracking/debt-tracking.constants';

export const STOP_DELIVERY_INVOICE_MESSAGE =
  'Khách hàng đang có phiếu ngừng đi hàng chưa kết thúc nên không thể tạo hóa đơn. Vui lòng thanh toán đủ số tiền cần thu hoặc kết thúc phiếu ngừng đi hàng trước.';

export const STOP_DELIVERY_DELIVERY_MESSAGE =
  'Khách hàng đang có phiếu ngừng đi hàng chưa kết thúc nên chưa thể đi hàng. Vui lòng thanh toán đủ số tiền cần thu hoặc kết thúc phiếu ngừng đi hàng trước.';

/**
 * Guard dùng chung cho mọi luồng tạo hóa đơn/giao hàng. Nhận transaction
 * client để quyết định được thực hiện atomically ngay trước side effect.
 */
export async function hasOpenStopDeliveryHold(
  db: any,
  customerId: number | null | undefined,
): Promise<boolean> {
  if (!customerId) return false;

  const line = await db.debtTicketCustomer.findFirst({
    where: {
      customerId,
      status: { not: DEBT_TICKET_LINE_STATUS.PAID },
      ticket: {
        ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY,
        status: { in: DEBT_TICKET_OPEN_STATUSES },
      },
    },
    select: { id: true },
  });

  return Boolean(line);
}

export async function assertCanCreateInvoiceForCustomer(
  db: any,
  customerId: number | null | undefined,
): Promise<void> {
  if (await hasOpenStopDeliveryHold(db, customerId)) {
    throw new BadRequestException(STOP_DELIVERY_INVOICE_MESSAGE);
  }
}

export async function assertCanDeliverForCustomer(
  db: any,
  customerId: number | null | undefined,
): Promise<void> {
  if (await hasOpenStopDeliveryHold(db, customerId)) {
    throw new BadRequestException(STOP_DELIVERY_DELIVERY_MESSAGE);
  }
}

export async function assertCanDeliverForCustomers(
  db: any,
  customerIds: Array<number | null | undefined>,
): Promise<void> {
  for (const customerId of [...new Set(customerIds.filter(Boolean))]) {
    await assertCanDeliverForCustomer(db, customerId as number);
  }
}

export const STOP_DELIVERY_CONFIRM_ORDER_MESSAGE =
  'Khách hàng đang có phiếu ngừng đi hàng chưa kết thúc nên không thể xác nhận đơn hàng. Vui lòng thanh toán đủ số tiền cần thu hoặc kết thúc phiếu ngừng đi hàng trước.';

export const PREPAID_CONFIRM_ORDER_MESSAGE =
  'Khách hàng không được phép phát sinh công nợ. Đơn hàng chưa được thanh toán đủ nên không thể xác nhận. Vui lòng thanh toán đủ trước khi xác nhận đơn hàng.';

/** Sai số làm tròn khi so tiền đã trả với tiền cần trả. */
export const PREPAID_PAYMENT_EPSILON = 1;

export interface PrepaidPolicyInput {
  policy:
    | {
        isActive?: boolean | null;
        requireFullPaymentForInvoice?: boolean | null;
      }
    | null
    | undefined;
  paidAmount: number;
  grandTotal: number;
  /** Công nợ hiện tại của khách; số âm là tiền trả trước chưa phân bổ. */
  currentCustomerDebt?: number;
  paymentMethod?: 'cash' | 'transfer' | string | null;
  /** Câu mở đầu của thông báo lỗi (phần số tiền được nối thêm phía sau). */
  message: string;
}

/**
 * Chỉ đọc cờ requireFullPaymentForInvoice, không suy diễn lại từ
 * debtForm/debtRuleType. Khách mới mặc định PREPAID + NONE và được tạo với
 * cờ = true; khách cũ giữ nguyên giá trị đã lưu.
 */
export function requiresFullPayment(
  policy: PrepaidPolicyInput['policy'],
): boolean {
  return !!(
    policy?.isActive !== false && policy?.requireFullPaymentForInvoice === true
  );
}

/**
 * Khách "không công nợ" phải thanh toán đủ trước khi ra hóa đơn / xác nhận
 * đơn. Thu tiền mặt khi giao thì không chặn.
 */
export function assertPrepaidPolicySatisfied(input: PrepaidPolicyInput): void {
  if (!requiresFullPayment(input.policy)) return;
  if (input.paymentMethod === 'cash') return;
  // Công nợ âm là tiền khách đã trả trước nhưng chưa phân bổ. Chỉ dùng
  // giá trị này để so sánh điều kiện; tuyệt đối không ghi vào đơn/hóa đơn.
  const advanceCredit = Math.max(0, -(input.currentCustomerDebt ?? 0));
  const effectivePaid = input.paidAmount + advanceCredit;
  if (effectivePaid + PREPAID_PAYMENT_EPSILON < input.grandTotal) {
    throw new BadRequestException(
      `${input.message} Đã thanh toán: ${Math.round(
        input.paidAmount,
      ).toLocaleString('vi-VN')} đ (gồm trả trước chưa phân bổ: ${Math.round(
        advanceCredit,
      ).toLocaleString('vi-VN')} đ) / Cần thanh toán: ${Math.round(
        input.grandTotal,
      ).toLocaleString('vi-VN')} đ.`,
    );
  }
}

/**
 * Đơn chỉ được chuyển sang "Đã xác nhận" khi khách đủ điều kiện ra hóa đơn
 * từ đơn này — cùng điều kiện với InvoicesService.createFromOrder.
 */
export async function assertCanConfirmOrder(
  db: any,
  orderId: number,
): Promise<void> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      customerId: true,
      grandTotal: true,
      payments: { select: { amount: true, status: true } },
      paymentNotes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { paymentType: true },
      },
      customer: {
        select: {
          totalDebt: true,
          debtPolicy: {
            select: { isActive: true, requireFullPaymentForInvoice: true },
          },
        },
      },
    },
  });
  if (!order?.customerId) return;

  if (await hasOpenStopDeliveryHold(db, order.customerId)) {
    throw new BadRequestException(STOP_DELIVERY_CONFIRM_ORDER_MESSAGE);
  }

  const paidAmount = (order.payments ?? [])
    .filter((payment: any) => payment.status !== 2)
    .reduce((sum: number, payment: any) => sum + Number(payment.amount), 0);

  assertPrepaidPolicySatisfied({
    policy: order.customer?.debtPolicy,
    paidAmount,
    grandTotal: Number(order.grandTotal),
    currentCustomerDebt: Number(order.customer?.totalDebt || 0),
    paymentMethod: order.paymentNotes?.[0]?.paymentType,
    message: PREPAID_CONFIRM_ORDER_MESSAGE,
  });
}
