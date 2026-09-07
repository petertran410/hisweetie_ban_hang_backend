import {
  assertCanCreateInvoiceForCustomer,
  hasOpenStopDeliveryHold,
} from './debt-delivery.util';

describe('debt delivery lifecycle guard', () => {
  it('keeps every active stop hold blocked regardless of provisional amount', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
  });

  it('does not release an active hold for a qualifying payment', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
  });

  it('keeps a multi-customer transaction blocked until accounting allocates it', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
          requiredPaymentAmount: 100,
          provisionalPaymentAmount: null,
          provisionalSepayTxId: null,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
    await expect(assertCanCreateInvoiceForCustomer(db, 3)).rejects.toThrow(
      'phiếu ngừng đi hàng chưa kết thúc',
    );
  });
});
