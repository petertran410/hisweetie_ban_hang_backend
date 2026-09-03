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
    select: {
      id: true,
      requiredPaymentAmount: true,
      provisionalPaymentAmount: true,
      provisionalSepayTxId: true,
    },
  });

  if (!line) return false;

  const provisionalAmount = Number(line.provisionalPaymentAmount ?? 0);
  if (
    !line.provisionalSepayTxId ||
    provisionalAmount < Number(line.requiredPaymentAmount) - 1
  ) {
    return true;
  }

  const transaction = await db.sepayTransaction.findUnique({
    where: { id: line.provisionalSepayTxId },
    select: { amountIn: true, hiddenAt: true },
  });
  if (!transaction || transaction.hiddenAt) return true;

  const allocations = await db.sepayAllocation.findMany({
    where: { sepayTransactionId: line.provisionalSepayTxId },
    select: { customerId: true, cashFlowId: true },
  });
  const isSingleUnconfirmedCustomer =
    allocations.length === 1 &&
    allocations[0].customerId === customerId &&
    allocations[0].cashFlowId === null;

  return !(
    isSingleUnconfirmedCustomer &&
    Number(transaction.amountIn) >= Number(line.requiredPaymentAmount) - 1
  );
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
