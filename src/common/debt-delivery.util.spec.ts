import {
  assertCanCreateInvoiceForCustomer,
  hasOpenStopDeliveryHold,
} from './debt-delivery.util';

describe('debt delivery provisional payment guard', () => {
  it('keeps the hold when one customer payment is insufficient', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
          requiredPaymentAmount: 100,
          provisionalPaymentAmount: 50,
          provisionalSepayTxId: 21,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
  });

  it('releases the hold for one unconfirmed customer when amount is enough', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
          requiredPaymentAmount: 100,
          provisionalPaymentAmount: 100,
          provisionalSepayTxId: 21,
        }),
      },
      sepayTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          amountIn: 100,
          hiddenAt: null,
        }),
      },
      sepayAllocation: {
        findMany: jest.fn().mockResolvedValue([
          { customerId: 3, cashFlowId: null },
        ]),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(false);
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
