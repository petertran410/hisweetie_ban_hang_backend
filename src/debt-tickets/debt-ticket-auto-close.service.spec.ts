import { DebtTicketAutoCloseService } from './debt-ticket-auto-close.service';

describe('DebtTicketAutoCloseService pending Sepay reconciliation', () => {
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const prisma = {
      sepayTransaction: {
        findUnique: jest.fn().mockResolvedValue({ id: 10, amountIn: 100 }),
        findMany: jest.fn(),
      },
      sepayAllocation: {
        findMany: jest.fn(),
      },
      debtTicketCustomer: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      ...overrides,
    };
    const ticketsService = {
      tryAutoCloseTicket: jest.fn(),
      tryReopenTicket: jest.fn(),
      reconcileStopDeliveryForCustomer: jest.fn(),
      reconcileCustomerPayments: jest.fn(),
    };
    const service = new DebtTicketAutoCloseService(
      prisma as any,
      ticketsService as any,
    );
    return { service, prisma, ticketsService };
  };

  it('reconciles tickets when one unconfirmed customer is assigned', async () => {
    const { service, prisma, ticketsService } = makeService();
    prisma.sepayAllocation.findMany.mockResolvedValue([
      { customerId: 7, cashFlowId: null },
    ]);
    prisma.debtTicketCustomer.findMany.mockResolvedValue([]);

    await service.onSepayCustomersAssigned(10, [7]);

    expect(ticketsService.reconcileCustomerPayments).toHaveBeenCalledWith(7);
  });

  it('reconciles each customer while the shared service excludes multi-customer amounts', async () => {
    const { service, prisma, ticketsService } = makeService();
    prisma.sepayAllocation.findMany
      .mockResolvedValueOnce([
        { customerId: 7, cashFlowId: null },
        { customerId: 8, cashFlowId: null },
      ])
      .mockResolvedValueOnce([
        { sepayTransactionId: 10, customerId: 7, cashFlowId: null },
        { sepayTransactionId: 10, customerId: 8, cashFlowId: null },
      ]);
    prisma.debtTicketCustomer.findMany.mockResolvedValue([]);

    await service.onSepayCustomersAssigned(10, [7, 8]);

    expect(ticketsService.reconcileCustomerPayments).toHaveBeenCalledTimes(2);
    expect(ticketsService.reconcileCustomerPayments).toHaveBeenCalledWith(7);
    expect(ticketsService.reconcileCustomerPayments).toHaveBeenCalledWith(8);
  });
});
