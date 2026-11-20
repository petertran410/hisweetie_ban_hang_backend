import { Prisma } from '@prisma/client';
import {
  applyApprovedFundDates,
  closingImpact,
  closingMatched,
  planApprovedFundDates,
} from './approved-fund-dates';
import { fundDayStart } from './internal-fund-ledger.service';

const fundRow = (id: number, entryDay: string, overrides: any = {}) => ({
  id,
  code: `QF-CHI-${id}`,
  branchId: 1,
  amount: new Prisma.Decimal(100),
  occurredAt: fundDayStart('2026-11-05'),
  approvalRequestId: 55,
  entry: {
    code: `TCNB-${id}`,
    branchId: 1,
    occurredAt: fundDayStart(entryDay),
    weeklyBatch: { code: 'W43', approvalRequestId: 55 },
  },
  ...overrides,
});

describe('approved-fund-dates', () => {
  it('moves approval-week rows to the voucher date and clamps old vouchers to the cutoff', async () => {
    const db: any = {
      internalFundTransaction: {
        findMany: jest.fn().mockResolvedValue([
          fundRow(1, '2026-10-20'),
          fundRow(2, '2026-10-05'),
          fundRow(3, '2026-11-05'),
          // Dòng do Approval khác ghi: không đụng.
          fundRow(4, '2026-10-20', { approvalRequestId: 99 }),
        ]),
      },
    };
    const fixes = await planApprovedFundDates(db);
    expect(fixes.map((fix) => [fix.id, fix.to, fix.clamped])).toEqual([
      [1, fundDayStart('2026-10-20'), false],
      [2, fundDayStart('2026-10-14'), true],
    ]);
    const kept = await planApprovedFundDates(db, { skipBeforeCutoff: true });
    expect(kept.map((fix) => fix.id)).toEqual([1]);
  });

  it('reports closing balances before and after moving an expense earlier', async () => {
    const db: any = {
      internalFundDailyClosing: {
        findMany: jest.fn().mockResolvedValue([
          // Kế toán đếm đã trừ khoản chi ngày 20/10.
          {
            closingDate: new Date('2026-10-20T00:00:00Z'),
            actualClosingBalance: new Prisma.Decimal(900),
          },
          {
            closingDate: new Date('2026-11-05T00:00:00Z'),
            actualClosingBalance: new Prisma.Decimal(900),
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { day: '2026-10-01', net: new Prisma.Decimal(1000) },
        { day: '2026-11-05', net: new Prisma.Decimal(-100) },
      ]),
    };
    const impact = await closingImpact(db, [
      {
        id: 1,
        code: 'QF-CHI-1',
        branchId: 1,
        amount: 100,
        entryCode: 'TCNB-1',
        batchCode: 'W43',
        from: fundDayStart('2026-11-05'),
        to: fundDayStart('2026-10-20'),
        clamped: false,
      },
    ]);
    // 05/11 không đổi số dư nên không có trong kết quả.
    expect(impact).toEqual([
      expect.objectContaining({
        branchId: 1,
        day: '2026-10-20',
        actual: 900,
        before: 1000,
        after: 900,
        synced: false,
      }),
    ]);
    expect(closingMatched(900, impact[0].before)).toBe(false);
    expect(closingMatched(900, impact[0].after)).toBe(true);
  });

  it('applies the new dates and logs one redate per row, closing flips to PENDING and one script run', async () => {
    const closing = (day: string, actual: number | null) => ({
      closingDate: new Date(`${day}T00:00:00Z`),
      actualClosingBalance: actual === null ? null : new Prisma.Decimal(actual),
      closedAt: new Date(`${day}T12:00:00Z`),
      sourceKey: null,
      posManagedAt: null,
      closer: { name: 'Kế toán' },
    });
    const tx: any = {
      internalFundTransaction: {
        findMany: jest.fn(async (args: any) =>
          args.distinct
            ? [{ branchId: 1 }]
            : [
                fundRow(1, '2026-10-20'),
                fundRow(2, '2026-10-05'),
                fundRow(3, '2026-11-05'),
              ],
        ),
        update: jest.fn(),
      },
      internalFundDailyClosing: {
        findMany: jest.fn(async (args: any) =>
          args.where.OR
            ? [
                {
                  id: 501,
                  branchId: 1,
                  closingDate: new Date('2026-10-20T00:00:00Z'),
                  reconciliationStatus: 'MISMATCHED',
                },
                {
                  id: 502,
                  branchId: 1,
                  closingDate: new Date('2026-10-25T00:00:00Z'),
                  reconciliationStatus: 'MATCHED',
                },
              ]
            : [closing('2026-10-20', 800), closing('2026-10-25', null)],
        ),
        updateMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { day: '2026-10-01', net: new Prisma.Decimal(1000) },
        { day: '2026-11-05', net: new Prisma.Decimal(-300) },
      ]),
      $executeRaw: jest.fn(),
      auditLog: { createMany: jest.fn() },
      user: { findMany: jest.fn(async () => []) },
    };
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };
    const args = ['--apply', '--user=7'];

    const { fixes } = await applyApprovedFundDates(prisma, {}, 7, args);

    expect(fixes.map((fix) => fix.id)).toEqual([1, 2]);
    expect(
      tx.internalFundTransaction.update.mock.calls.map(([call]: any) => [
        call.where.id,
        call.data.occurredAt,
      ]),
    ).toEqual([
      [1, fundDayStart('2026-10-20')],
      [2, fundDayStart('2026-10-14')],
    ]);
    expect(
      tx.internalFundDailyClosing.updateMany.mock.calls.map(
        ([call]: any) => call.data.reconciliationStatus,
      ),
    ).toEqual(['MATCHED', 'PENDING']);

    // Lịch sử ghi một lần, trong transaction.
    expect(tx.auditLog.createMany).toHaveBeenCalledTimes(1);
    const rows = tx.auditLog.createMany.mock.calls[0][0].data;
    expect(rows.map((row: any) => [row.actionCode, row.entityId])).toEqual([
      ['FIN_FUND_TXN_REDATE', '1'],
      ['FIN_FUND_TXN_REDATE', '2'],
      ['FIN_FUND_CLOSING_INVALIDATE', '502'],
      ['FIN_SCRIPT_RUN', expect.stringMatching(/^fix-approval-fund-dates:/)],
    ]);
    expect(rows[0]).toMatchObject({
      entityCode: 'QF-CHI-1',
      branchId: 1,
      userId: 7,
      severity: 'critical',
      message: 'Đổi ngày dòng quỹ QF-CHI-1: 05/11/2026 → 20/10/2026',
    });
    expect(rows[0].changes).toEqual([
      expect.objectContaining({
        field: 'occurredAt',
        from: '05/11/2026',
        to: '20/10/2026',
      }),
    ]);
    expect(rows[1].metadata).toMatchObject({ clamped: true, batchCode: 'W43' });
    expect(rows[2].message).toBe(
      'Chốt sổ Kho SG ngày 25/10/2026 cần đối soát lại (dời ngày dòng quỹ Approval tuần)',
    );
    expect(rows[3].metadata).toMatchObject({
      counts: expect.objectContaining({ redated: 2, clamped: 1 }),
      args,
      closingStatusChanges: [
        { branchId: 1, day: '2026-10-20', from: 'MISMATCHED', to: 'MATCHED' },
        { branchId: 1, day: '2026-10-25', from: 'MATCHED', to: 'PENDING' },
      ],
    });
    expect(new Set(rows.map((row: any) => row.requestId)).size).toBe(1);
  });

  it('dry runs write no history', async () => {
    const db: any = {
      internalFundTransaction: {
        findMany: jest.fn().mockResolvedValue([fundRow(1, '2026-10-20')]),
      },
      auditLog: { createMany: jest.fn() },
    };
    await planApprovedFundDates(db);
    expect(db.auditLog.createMany).not.toHaveBeenCalled();
  });
});
