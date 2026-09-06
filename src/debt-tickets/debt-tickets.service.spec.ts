import { DebtTicketsService } from './debt-tickets.service';
import {
  DEBT_TICKET_LINE_STATUS,
  DEBT_TICKET_STATUS,
  DEBT_TICKET_TYPE,
} from '../debt-tracking/debt-tracking.constants';

describe('DebtTicketsService STOP quick workflow', () => {
  const makeService = (prisma: any) =>
    new DebtTicketsService(
      prisma,
      { getSuggestedMinimumPayment: jest.fn().mockResolvedValue(100) } as any,
      { notifyStopDeliveryCreatedAsync: jest.fn() } as any,
    );

  it('rejects a duplicate active STOP under the customer lock', async () => {
    const tx = {
      $queryRaw: jest.fn(),
      customer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 3,
            name: 'A',
            totalDebt: 500,
            debtPolicy: null,
          }),
      },
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({ ticketId: 9 }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    await expect(makeService(prisma).createStopDelivery(3, 8)).rejects.toThrow(
      'đang mở',
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('quick creates one STOP ticket with accountant, then sale, then actor assignee', async () => {
    const created = {
      id: 12,
      customers: [],
      status: DEBT_TICKET_STATUS.REQUESTED,
      ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY,
    };
    const tx = {
      $queryRaw: jest.fn(),
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          id: 3,
          name: 'A',
          totalDebt: 500,
          debtPolicy: { accountantPicId: null, salePicId: 7 },
        }),
      },
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
      debtTicket: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
      debtTicket: { findUnique: jest.fn().mockResolvedValue(created) },
    };
    const service = makeService(prisma);
    jest
      .spyOn(service, 'reconcileCustomerPayments')
      .mockResolvedValue(undefined);
    const result = await service.createStopDelivery(3, 8);
    expect(tx.debtTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assigneeId: 7 }),
      }),
    );
    expect(result.ticketType).toBe(DEBT_TICKET_TYPE.STOP_DELIVERY);
  });

  it('auto closes STOP on any new positive single-customer payment', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const db = {
      debtTicket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          code: 'TCN000001',
          status: DEBT_TICKET_STATUS.REQUESTED,
          ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY,
          createdAt: now,
          customers: [
            { id: 11, customerId: 3, status: DEBT_TICKET_LINE_STATUS.PENDING },
          ],
        }),
        update: jest.fn(),
      },
      debtTicketCustomer: {
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValue([{ status: DEBT_TICKET_LINE_STATUS.PAID }]),
      },
      cashFlow: { findMany: jest.fn().mockResolvedValue([]) },
      sepayAllocation: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              customerId: 3,
              cashFlowId: null,
              amount: 10,
              sepayTransactionId: 4,
              createdAt: new Date('2026-01-03'),
            },
          ]),
      },
      sepayTransaction: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            amountIn: 10,
            hiddenAt: null,
            assignedAt: new Date('2026-01-03'),
          }),
        findMany: jest.fn(),
      },
    };
    const closed = await makeService(db).tryAutoCloseTicket(db, 1);
    expect(closed).toBe(true);
    expect(db.debtTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DEBT_TICKET_STATUS.PAID }),
      }),
    );
  });

  it('does not count payments created before the hold', async () => {
    const db = {
      debtTicketCustomer: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 1,
              ticketId: 2,
              customerId: 3,
              status: DEBT_TICKET_LINE_STATUS.PENDING,
              ticket: { createdAt: new Date('2026-01-02') },
            },
          ]),
        update: jest.fn(),
      },
      cashFlow: { findMany: jest.fn().mockResolvedValue([]) },
      sepayAllocation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await expect(
      makeService(db).reconcileStopDeliveryForCustomer(3, db),
    ).resolves.toBe(0);
    expect(db.cashFlow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date('2026-01-02') },
        }),
      }),
    );
  });

  it('does not count an unconfirmed multi-customer assignment', async () => {
    const db = {
      debtTicketCustomer: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 1,
              ticketId: 2,
              customerId: 3,
              status: DEBT_TICKET_LINE_STATUS.PENDING,
              ticket: { createdAt: new Date('2026-01-02') },
            },
          ]),
        update: jest.fn(),
      },
      cashFlow: { findMany: jest.fn().mockResolvedValue([]) },
      sepayAllocation: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ cashFlowId: null, sepayTransactionId: 4 }]),
      },
      sepayTransaction: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            amountIn: 100,
            hiddenAt: null,
            assignedAt: new Date('2026-01-03'),
          }),
        findMany: jest.fn(),
      },
    };
    db.sepayAllocation.findMany
      .mockResolvedValueOnce([{ cashFlowId: null, sepayTransactionId: 4 }])
      .mockResolvedValueOnce([
        { customerId: 3, cashFlowId: null },
        { customerId: 4, cashFlowId: null },
      ]);
    await expect(
      makeService(db).reconcileStopDeliveryForCustomer(3, db),
    ).resolves.toBe(0);
  });

  it('manually closes with a nonblank reason', async () => {
    const prisma = {
      debtTicket: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 1,
            status: DEBT_TICKET_STATUS.REQUESTED,
            customers: [],
          }),
        update: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };
    await expect(
      makeService(prisma).close(
        1,
        { reason: 'Khách xác nhận dừng', finalStatus: 'DONE' },
        8,
      ),
    ).resolves.toEqual({ id: 1 });
  });
});
