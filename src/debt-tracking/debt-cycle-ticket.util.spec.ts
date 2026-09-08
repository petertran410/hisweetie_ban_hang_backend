import {
  findOpenStopDeliveryTicket,
} from './debt-cycle-ticket.util';

describe('debt-cycle-ticket.util', () => {
  it('returns the open stop-delivery ticket of the customer', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({ ticketId: 9 }),
      },
    };
    await expect(findOpenStopDeliveryTicket(db, 3)).resolves.toEqual({
      ticketId: 9,
    });
  });

  it('returns null when the customer has no open stop-delivery ticket', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    await expect(findOpenStopDeliveryTicket(db, 3)).resolves.toBeNull();
  });
});
