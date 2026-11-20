import { Prisma } from '@prisma/client';
import {
  VPSG_BALANCE_KEY,
  VPSG_BALANCE_REPLACED,
  applyVpsgBalance,
  countedDayEnd,
  planVpsgBalance,
} from './vpsg-fund-balance';

const DAY = 86400000;
// Đếm tiền hết ngày 19/11/2026 (giờ Việt Nam).
const COUNT_DATE = '2026-11-19';
const DAY_END = new Date('2026-11-19T17:00:00Z');
const AT = new Date(DAY_END.getTime() - 1000);
const daysBefore = (days: number) => new Date(DAY_END.getTime() - days * DAY);

function fakeDb() {
  const rows: any[] = [
    {
      id: 1,
      branchId: 7,
      transactionType: 'RECEIPT',
      amount: new Prisma.Decimal(5000000),
      occurredAt: daysBefore(10),
      sourceKey: 'LARK_LEDGER:rec-1',
      status: 'POSTED',
    },
    {
      id: 2,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(1200000),
      occurredAt: daysBefore(5),
      sourceKey: 'PAYMENT_VOUCHER:1',
      status: 'POSTED',
    },
    // Sau ngày đếm: không tính.
    {
      id: 3,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(999),
      occurredAt: new Date(DAY_END.getTime() + DAY),
      sourceKey: 'PAYMENT_VOUCHER:2',
      status: 'POSTED',
    },
  ];
  const db: any = {
    internalFundTransaction: {
      groupBy: jest.fn(async ({ where }: any) => {
        const sums = new Map<string, Prisma.Decimal>();
        for (const row of rows.filter(
          (item) =>
            item.branchId === where.branchId &&
            item.status === where.status &&
            item.occurredAt < where.occurredAt.lt &&
            item.sourceKey !== where.NOT.sourceKey,
        ))
          sums.set(
            row.transactionType,
            (sums.get(row.transactionType) || new Prisma.Decimal(0)).plus(
              row.amount,
            ),
          );
        return [...sums].map(([transactionType, sum]) => ({
          transactionType,
          _sum: { amount: sum },
        }));
      }),
      findUnique: jest.fn(
        async ({ where }: any) =>
          rows.find((row) => row.sourceKey === where.sourceKey) || null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: rows.length + 1, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          rows.find((row) => row.id === where.id),
          data,
        ),
      ),
    },
    internalFundDailyClosing: {
      updateMany: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    auditLog: { createMany: jest.fn() },
    user: { findMany: jest.fn(async () => []) },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  return { db, rows };
}

/** Dòng lịch sử của mỗi lần createMany. */
const auditCalls = (db: any): any[][] =>
  db.auditLog.createMany.mock.calls.map(([args]: any) => args.data);
const codes = (rows: any[]) => rows.map((row) => row.actionCode);

const balanceRows = (rows: any[]) =>
  rows.filter(
    (row) => row.sourceKey === VPSG_BALANCE_KEY && row.status === 'POSTED',
  );

describe('VPSG fund balance by counted cash', () => {
  it('needs the counted day, read as the end of a Vietnam day', () => {
    expect(countedDayEnd(COUNT_DATE)).toEqual(DAY_END);
    expect(() => countedDayEnd()).toThrow('--date');
    expect(() => countedDayEnd('19/11/2026')).toThrow('--date');
  });

  it('plans the difference against the POS balance up to the counted day', async () => {
    const { db } = fakeDb();
    const plan = await planVpsgBalance(db, 3500000, COUNT_DATE);
    expect(Number(plan.system)).toBe(3800000);
    expect(Number(plan.difference)).toBe(-300000);
    expect(plan.transactionType).toBe('EXPENSE');
    expect(plan.at).toEqual(AT);
    await expect(planVpsgBalance(db, -1, COUNT_DATE)).rejects.toThrow(
      'không âm',
    );
  });

  it('writes one balance row on the counted day, replaces it on re-run, and skips when nothing changes', async () => {
    const { db, rows } = fakeDb();

    await applyVpsgBalance(db, 3500000, 9, COUNT_DATE);
    expect(balanceRows(rows)).toHaveLength(1);
    expect(balanceRows(rows)[0]).toMatchObject({
      branchId: 7,
      transactionType: 'EXPENSE',
      sourceType: 'BALANCE_ADJUSTMENT',
      occurredAt: AT,
    });
    expect(String(balanceRows(rows)[0].amount)).toBe('300000');

    // Cùng số đếm: không tạo lại.
    const same = await applyVpsgBalance(db, 3500000, 9, COUNT_DATE);
    expect(same.unchanged).toBe(true);
    expect(
      rows.filter((row) => row.sourceType === 'BALANCE_ADJUSTMENT'),
    ).toHaveLength(1);

    // Đếm lại: hủy dòng cũ, ghi dòng THU mới tính từ số dư không có dòng cũ.
    await applyVpsgBalance(db, 4000000, 9, COUNT_DATE);
    expect(rows.find((row) => row.id === 4)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: VPSG_BALANCE_REPLACED,
    });
    expect(balanceRows(rows)).toHaveLength(1);
    expect(balanceRows(rows)[0].transactionType).toBe('RECEIPT');
    expect(String(balanceRows(rows)[0].amount)).toBe('200000');
  });

  it('logs one FIN_SCRIPT_RUN per --apply run, with ledger rows under the same run', async () => {
    const { db } = fakeDb();
    const args = ['--actual=3500000', `--date=${COUNT_DATE}`, '--apply'];

    await applyVpsgBalance(db, 3500000, 9, COUNT_DATE, args);
    let history = auditCalls(db).flat();
    expect(codes(history)).toEqual(['FIN_FUND_TXN_POST', 'FIN_SCRIPT_RUN']);
    const run = history[1];
    expect(run).toMatchObject({
      entityType: 'finance_scripts',
      entityCode: 'balance-vpsg-fund',
      branchId: 7,
      userId: 9,
      userName: 'Script balance-vpsg-fund',
    });
    expect(run.entityId).toMatch(/^balance-vpsg-fund:/);
    expect(run.message).toBe(
      'Chạy script balance-vpsg-fund --apply: Quỹ VPSG ngày 19/11/2026: đếm 3.500.000, sổ 3.800.000, ghi CHI 300.000',
    );
    expect(run.metadata).toMatchObject({
      counts: { replaced: 0, posted: 1 },
      args,
    });
    expect(history[0].requestId).toBe(run.requestId);
    expect(history[0].metadata.actorKind).toBe('SCRIPT');

    // Không đổi gì: vẫn một dòng chạy script, không có dòng quỹ.
    db.auditLog.createMany.mockClear();
    await applyVpsgBalance(db, 3500000, 9, COUNT_DATE);
    history = auditCalls(db).flat();
    expect(codes(history)).toEqual(['FIN_SCRIPT_RUN']);
    expect(history[0].message).toContain('không có gì thay đổi');

    // Đếm lại: hủy dòng cũ + ghi dòng mới, cùng opId với dòng chạy script.
    db.auditLog.createMany.mockClear();
    await applyVpsgBalance(db, 4000000, 9, COUNT_DATE);
    history = auditCalls(db).flat();
    expect(codes(history)).toEqual([
      'FIN_FUND_TXN_CANCEL',
      'FIN_FUND_TXN_POST',
      'FIN_SCRIPT_RUN',
    ]);
    expect(new Set(history.map((row) => row.requestId)).size).toBe(1);
    expect(history[2].metadata.counts).toMatchObject({
      replaced: 1,
      posted: 1,
    });
  });

  it('dry runs write no history', async () => {
    const { db } = fakeDb();
    await planVpsgBalance(db, 3500000, COUNT_DATE);
    expect(db.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('removes the balance row when the count matches the books', async () => {
    const { db, rows } = fakeDb();
    await applyVpsgBalance(db, 3500000, 9, COUNT_DATE);
    const plan = await applyVpsgBalance(db, 3800000, 9, COUNT_DATE);
    expect(plan.difference.isZero()).toBe(true);
    expect(balanceRows(rows)).toHaveLength(0);
  });
});
