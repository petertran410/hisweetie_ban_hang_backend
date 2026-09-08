import { DebtTrackingCycleService } from './debt-tracking-cycle.service';
import { BadRequestException } from '@nestjs/common';

describe('DebtTrackingCycleService', () => {
  const makeService = (prisma: any) => new DebtTrackingCycleService(prisma);

  it('rejects a manual close when the current cycle has no data', async () => {
    const tx = {
      $queryRaw: jest.fn(),
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          name: 'A',
          debtNote: null,
        }),
      },
      customerDebtTrackingCycle: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      customerDebtCollectionAttempt: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      debtTicketCustomer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const prisma = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = makeService(prisma);

    await expect(
      service.closeCurrentCycle(1, { mode: 'MANUAL', userId: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('snapshots attempts and clears the current note on manual close', async () => {
    const attempts = [
      {
        id: 11,
        role: 'ACCOUNTANT',
        attemptDate: new Date('2026-09-01T00:00:00.000Z'),
        recordedAt: new Date('2026-09-01T03:00:00.000Z'),
        recordedBy: { id: 9, name: 'KT' },
        isActive: true,
      },
    ];
    const openCycle = {
      id: 4,
      customerId: 1,
      status: 'OPEN',
      requiredPaymentAtStart: 100000,
    };
    const tx = {
      $queryRaw: jest.fn(),
      customer: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 1,
            name: 'A',
            debtNote: {
              note: 'Đã gọi khách',
              noteAt: new Date('2026-09-02T00:00:00.000Z'),
              noteBy: 9,
            },
          })
          .mockResolvedValueOnce({
            id: 1,
            totalDebt: 150000,
            debtPolicy: {
              hasCreditLimit: true,
              creditLimit: 50000,
              hasTermDays: false,
              termDays: null,
              paymentFrequency: null,
            },
          }),
      },
      customerDebtTrackingCycle: {
        findFirst: jest.fn().mockResolvedValue(openCycle),
        update: jest.fn().mockResolvedValue({ ...openCycle, status: 'CLOSED' }),
      },
      customerDebtCollectionAttempt: {
        findMany: jest.fn().mockResolvedValue(attempts),
        updateMany: jest.fn(),
      },
      debtTicketCustomer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      customerDebtNote: {
        update: jest.fn(),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const prisma = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = makeService(prisma);

    const closed = await service.closeCurrentCycle(1, {
      mode: 'MANUAL',
      userId: 9,
    });

    expect(closed?.status).toBe('CLOSED');
    expect(tx.customerDebtCollectionAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [11] } },
      data: { cycleId: 4 },
    });
    expect(tx.customerDebtNote.update).toHaveBeenCalledWith({
      where: { customerId: 1 },
      data: { note: null, noteAt: null, noteBy: null },
    });
  });

  it('does not auto-close when the cycle never had a required payment', async () => {
    const prisma = {
      customerDebtTrackingCycle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 4,
          requiredPaymentAtStart: 0,
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.maybeAutoClose(1)).resolves.toBeNull();
  });
});
