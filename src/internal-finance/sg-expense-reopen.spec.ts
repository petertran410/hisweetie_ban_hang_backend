import { Prisma } from '@prisma/client';
import { applySgReopen, shouldMarkLedger } from './sg-expense-reopen';

describe('sg-expense-reopen', () => {
  it('marks only entries up to 13/10 that Lark already paid', () => {
    const base = {
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
      sourceSnapshot: {},
    };
    expect(
      shouldMarkLedger({
        ...base,
        occurredAt: new Date('2026-10-13T10:00:00+07:00'),
      }),
    ).toBe(true);
    expect(
      shouldMarkLedger({
        ...base,
        occurredAt: new Date('2026-10-14T08:00:00+07:00'),
      }),
    ).toBe(false);
    expect(
      shouldMarkLedger({
        occurredAt: new Date('2026-10-12T10:00:00+07:00'),
        cashIssuedReason: null,
        sourceSnapshot: {},
      }),
    ).toBe(false);
    // Đã có dấu thì không gắn lại.
    expect(
      shouldMarkLedger({
        ...base,
        occurredAt: new Date('2026-10-12T10:00:00+07:00'),
        sourceSnapshot: { larkLedgerRecorded: true },
      }),
    ).toBe(false);
  });

  it('clears ticks and Đã chi, cancels the POS fund row, keeps sent weeks out', async () => {
    const entry = {
      id: 7,
      code: 'TCNB-CHI-SG-20261013-000034',
      occurredAt: new Date('2026-10-13T10:00:00+07:00'),
      description: 'Phí gửi bến',
      amount: new Prisma.Decimal(20000),
      status: 'MANAGER_APPROVED',
      managerReviewedAt: new Date(),
      accountantReviewedAt: new Date(),
      cashIssued: true,
      cashIssuedReason: 'Đã chi trên Lark',
      sourceSnapshot: { note: 'x' },
      weeklyBatchId: null,
      weeklyBatch: null,
    };
    const fundRow = {
      id: 90,
      code: 'QF-CHI-1',
      amount: new Prisma.Decimal(20000),
      occurredAt: entry.occurredAt,
      branchId: 1,
      sourceKey: 'EXPENSE:7',
      entryId: 7,
    };
    const tx: any = {
      $executeRaw: jest.fn(),
      internalFinanceEntry: {
        findMany: jest.fn().mockResolvedValue([entry]),
        update: jest.fn(),
      },
      internalFundTransaction: {
        findMany: jest.fn().mockResolvedValue([fundRow]),
        update: jest.fn(),
      },
      internalFundDailyClosing: { updateMany: jest.fn() },
      internalFinanceReview: { create: jest.fn() },
      cashAdvanceAllocation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };

    await applySgReopen(prisma, 5);

    const where = tx.internalFinanceEntry.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      branchId: 1,
      sourceType: 'LARK_IMPORT',
      direction: 'EXPENSE',
    });
    expect(where.AND[0].OR[1]).toEqual({
      weeklyBatch: { status: { notIn: ['IN_APPROVAL', 'APPROVED'] } },
    });
    expect(tx.internalFundTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 90 },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(tx.internalFinanceEntry.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        status: 'PENDING_ACCOUNTANT',
        managerReviewedAt: null,
        accountantReviewedAt: null,
        cashIssued: false,
        cashIssuedReason: null,
        sourceSnapshot: { note: 'x', larkLedgerRecorded: true },
      }),
    });
    expect(tx.internalFinanceReview.create).toHaveBeenCalled();
  });
});
