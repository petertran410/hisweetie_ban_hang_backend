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
