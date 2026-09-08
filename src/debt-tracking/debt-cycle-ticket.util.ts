import {
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_TYPE,
} from './debt-tracking.constants';

export const OPEN_STOP_DELIVERY_BLOCKS_CYCLE_MESSAGE =
  'Khách hàng đang có phiếu ngừng đi hàng chưa kết thúc. Hãy kết thúc phiếu ngừng đi hàng trước khi làm mới chu kỳ.';

export async function findOpenStopDeliveryTicket(
  db: any,
  customerId: number,
): Promise<{ ticketId: number } | null> {
  return db.debtTicketCustomer.findFirst({
    where: {
      customerId,
      ticket: {
        ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY,
        status: { in: DEBT_TICKET_OPEN_STATUSES },
      },
    },
    select: { ticketId: true },
  });
}
