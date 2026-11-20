import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEBT_TICKET_LINE_STATUS,
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_TYPE,
} from '../debt-tracking/debt-tracking.constants';
import { ORDER_STATUS } from '../orders/dto/order-status.constants';

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
  /**
   * Công nợ hiện tại của khách; số âm là tiền trả trước chưa phân bổ.
   * Kiểm tra theo ĐƠN (paidAmount = tiền đã trả trên đơn, đã là phiếu thu nằm
   * trong totalDebt) phải truyền customerDebtForOrderPrepaidCheck(), không
   * truyền thẳng customer.totalDebt, để không tính tiền đơn 2 lần.
   */
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
 * "Chưa thiết lập" công nợ: khách cũ chưa có policy, hoặc NONE mà không bắt
 * trả đủ. Dùng để nhắc người dùng thiết lập, không dùng để chặn.
 */
export function isDebtRuleUnset(
  policy:
    | {
        debtRuleType?: string | null;
        requireFullPaymentForInvoice?: boolean | null;
      }
    | null
    | undefined,
): boolean {
  if (!policy) return true;
  return (
    (policy.debtRuleType ?? 'NONE') === 'NONE' &&
    policy.requireFullPaymentForInvoice !== true
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

/** Trạng thái "đã hủy" của hóa đơn, phiếu thanh toán đơn và phiếu thu. */
const CANCELLED_DOCUMENT_STATUS = 2;

/**
 * Công nợ dùng cho kiểm tra "khách không công nợ phải trả đủ" của MỘT ĐƠN
 * (xác nhận đơn, tạo hóa đơn từ đơn), để truyền vào currentCustomerDebt.
 *
 * customer.totalDebt (Formula A, customer-debt.util.ts) đã trừ MỌI phiếu thu,
 * kể cả phiếu thu của các lần thanh toán trên đơn (`TT<mã đơn>-n`): tiền đó
 * giảm công nợ ngay cả khi đơn chưa ra hóa đơn. Phép kiểm tra lại cộng riêng
 * tiền đã trả trên đơn (paidAmount), nên dùng thẳng totalDebt sẽ tính 2 lần.
 *
 * Trả về công nợ đã:
 * - bỏ toàn bộ phần của chính đơn này: HĐ còn hiệu lực của đơn và phiếu thu
 *   các lần thanh toán đơn (đã được tính riêng qua paidAmount);
 * - bỏ phiếu thu đang gắn với ĐƠN KHÁC chưa hủy, chưa có HĐ còn hiệu lực:
 *   tiền đó để dành cho đơn kia, không tính là trả trước cho đơn này.
 * Phần âm còn lại mới là tiền trả trước tự do của khách. Phiếu thu được ghép
 * với lần thanh toán đơn theo mã (orderPayment.code = cashFlow.code).
 */
export async function customerDebtForOrderPrepaidCheck(
  db: Prisma.TransactionClient,
  input: { orderId: number; customerId: number; totalDebt: number },
): Promise<number> {
  const { orderId, customerId } = input;

  const thisOrderInvoices = await db.invoice.aggregate({
    where: {
      orderId,
      customerId,
      status: { not: CANCELLED_DOCUMENT_STATUS },
    },
    _sum: { grandTotal: true },
  });

  const tiedPayments = await db.orderPayment.findMany({
    where: {
      status: { not: CANCELLED_DOCUMENT_STATUS },
      OR: [
        { orderId },
        {
          order: {
            customerId,
            status: { not: ORDER_STATUS.CANCELLED },
            invoices: {
              none: { status: { not: CANCELLED_DOCUMENT_STATUS } },
            },
          },
        },
      ],
    },
    select: { code: true },
  });

  let tiedReceipts = 0;
  if (tiedPayments.length > 0) {
    // Cùng điều kiện phiếu thu của Formula A để chỉ cộng lại đúng phần đã trừ.
    const receipts = await db.cashFlow.aggregate({
      where: {
        code: { in: tiedPayments.map((payment) => payment.code) },
        partnerType: 'C',
        partnerId: customerId,
        isReceipt: true,
        status: { not: CANCELLED_DOCUMENT_STATUS },
      },
      _sum: { amount: true },
    });
    tiedReceipts = Number(receipts._sum.amount || 0);
  }

  return (
    input.totalDebt -
    Number(thisOrderInvoices._sum.grandTotal || 0) +
    tiedReceipts
  );
}

/** Dữ liệu đơn mà assertCanConfirmOrder đọc (đúng phần `select` bên dưới). */
interface ConfirmOrderRow {
  customerId: number | null;
  grandTotal: unknown;
  payments?: Array<{ amount: unknown; status: number }>;
  paymentNotes?: Array<{ paymentType: string }>;
  customer?: {
    totalDebt: unknown;
    debtPolicy: PrepaidPolicyInput['policy'];
  } | null;
}

/**
 * Đơn chỉ được chuyển sang "Đã xác nhận" khi khách đủ điều kiện ra hóa đơn
 * từ đơn này — cùng điều kiện với InvoicesService.createFromOrder.
 */
export async function assertCanConfirmOrder(
  db: any,
  orderId: number,
): Promise<void> {
  const order: ConfirmOrderRow | null = await db.order.findUnique({
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

  const policy = order.customer?.debtPolicy;
  const paymentMethod = order.paymentNotes?.[0]?.paymentType;
  const totalDebt = Number(order.customer?.totalDebt || 0);
  // Chỉ tính công nợ điều chỉnh (thêm truy vấn) khi thật sự phải kiểm tra trả đủ.
  const currentCustomerDebt =
    requiresFullPayment(policy) && paymentMethod !== 'cash'
      ? await customerDebtForOrderPrepaidCheck(db as Prisma.TransactionClient, {
          orderId,
          customerId: order.customerId,
          totalDebt,
        })
      : totalDebt;

  assertPrepaidPolicySatisfied({
    policy,
    paidAmount,
    grandTotal: Number(order.grandTotal),
    currentCustomerDebt,
    paymentMethod,
    message: PREPAID_CONFIRM_ORDER_MESSAGE,
  });
}
