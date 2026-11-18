import { Prisma } from '@prisma/client';
import {
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
});
