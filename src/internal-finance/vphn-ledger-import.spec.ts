import { Prisma } from '@prisma/client';
import { VPHN_LEDGER_CUTOFF } from '../approval-lifecycle/approval-lifecycle.constants';
import {
  applyVphnImport,
  planVphnImport,
  untilOf,
  VPHN_VOID_REASON,
} from './vphn-ledger-import';

const vn = (text: string) => Date.parse(`${text}+07:00`);
const lark = (
  recordId: string,
  fields: Record<string, unknown>,
  branch = 'Văn Phòng Hà Nội',
) => ({
  recordId,
  fields: {
    'Chi Nhánh': branch,
    STT: recordId.replace('rec-', '1'),
    ...fields,
  },
  createdAt: new Date(vn('2026-10-01T08:00:00')),
  modifiedAt: null,
});
const posRow = (row: Record<string, any>): any => ({
  id: 1,
  code: 'QF-1',
  branchId: 4,
  status: 'POSTED',
  description: '',
  entryId: null,
  ...row,
  amount: new Prisma.Decimal(row.amount as number),
});

const records = [
  lark('rec-a', {
    Thu: 175000000,
    'Loại Thu Chi': 'Chuyển Tiền Nội Bộ',
    'Ngày Giao Dịch': vn('2026-10-14T00:00:00'),
    'Nội Dung': 'Chuyển tiền mặt từ Kho Hà Nội đến Văn Phòng Hà Nội',
  }),
  lark('rec-b', {
    Chi: 1306000,
    'Ngày Giao Dịch': vn('2026-10-14T10:13:45'),
    'Nội Dung': 'Cước đt T10',
  }),
  lark('rec-c', { Chi: 50000, 'Ngày Giao Dịch': vn('2026-09-20T09:00:00') }),
  lark(
    'rec-d',
    { Chi: 90000, 'Ngày Giao Dịch': vn('2026-09-20T09:00:00') },
    'Kho Hà Nội',
  ),
  lark('rec-e', {
    Chi: 10,
    'Trạng Thái': 'Hủy',
    'Ngày Giao Dịch': vn('2026-09-21T09:00:00'),
  }),
  lark('rec-f', { 'Ngày Giao Dịch': vn('2026-09-22T09:00:00') }),
  lark('rec-g', { Chi: 999, 'Ngày Giao Dịch': vn('2026-11-02T09:00:00') }),
];
const posRows = [
  posRow({
    id: 10,
    code: 'SQ-1c',
    transactionType: 'EXPENSE',
    amount: 50000,
    occurredAt: new Date(vn('2026-09-20T09:00:00')),
    sourceKey: 'LARK_LEDGER:rec-c',
    sourceType: 'LEDGER_HISTORY',
  }),
  posRow({
    id: 11,
    code: 'QF-CHUYEN-1',
    transactionType: 'TRANSFER_IN',
    amount: 175000000,
    occurredAt: new Date(vn('2026-10-14T00:00:00')),
    sourceKey: 'TRANSFER:3:TRANSFER_IN',
    sourceType: 'INTERNAL_FUND_TRANSFER',
  }),
  posRow({
    id: 12,
    code: 'QF-CHI-1',
    transactionType: 'EXPENSE',
    amount: 1306000,
    occurredAt: new Date(vn('2026-10-14T10:13:45')),
    sourceKey: 'PAYMENT_VOUCHER:7',
    sourceType: 'LARK_PAYMENT_VOUCHER',
    entryId: 80,
  }),
  posRow({
    id: 13,
    code: 'QF-CHI-2',
    transactionType: 'EXPENSE',
    amount: 777,
    occurredAt: new Date(vn('2026-10-20T10:00:00')),
    sourceKey: 'PAYMENT_VOUCHER:8',
    sourceType: 'LARK_PAYMENT_VOUCHER',
  }),
  posRow({
    id: 14,
    code: 'QF-CHI-OLD',
    status: 'CANCELLED',
    transactionType: 'EXPENSE',
    amount: 5,
    occurredAt: new Date(vn('2026-10-20T10:00:00')),
    sourceKey: 'PAYMENT_VOUCHER:9:CANCELLED:14',
    sourceType: 'LARK_PAYMENT_VOUCHER',
  }),
];

function fakeDb() {
  return {
    internalFundTransaction: {
      findMany: jest.fn(async ({ where }: any) =>
        where.code
          ? []
          : posRows.filter(
              (row) =>
                row.occurredAt < where.occurredAt.lt && row.branchId === 4,
            ),
      ),
      update: jest.fn(async ({ where, data }: any) => ({
        id: where.id,
        ...data,
      })),
      createMany: jest.fn(),
    },
    internalFundDailyClosing: { updateMany: jest.fn() },
    $executeRaw: jest.fn(),
  };
}

describe('untilOf', () => {
  it('defaults to the VPHN cutoff and reads --to as end of a Vietnam day', () => {
    expect(untilOf()).toEqual(VPHN_LEDGER_CUTOFF);
    expect(untilOf('2026-10-31')).toEqual(new Date('2026-10-31T17:00:00Z'));
    expect(() => untilOf('31/10/2026')).toThrow('YYYY-MM-DD');
  });
});

describe('planVphnImport', () => {
  it('adds missing Lark rows, voids POS live rows with their Lark twin, and matches the Lark balance', async () => {
    const plan = await planVphnImport(fakeDb() as any, records);

    expect(plan.add.map((row) => [row.sourceKey, row.transactionType])).toEqual(
      [
        ['LARK_LEDGER:rec-a', 'TRANSFER_IN'],
        ['LARK_LEDGER:rec-b', 'EXPENSE'],
      ],
    );
    expect(plan.existing.map((row) => row.sourceKey)).toEqual([
      'LARK_LEDGER:rec-c',
    ]);
    expect(plan.skipped.map((row) => row.recordId)).toEqual(['rec-e', 'rec-f']);

    expect(
      plan.voids.map((item) => [item.pos.id, item.twin?.sourceKey ?? null]),
    ).toEqual([
      [11, 'LARK_LEDGER:rec-a'],
      [12, 'LARK_LEDGER:rec-b'],
      [13, null],
    ]);

    expect(Number(plan.larkBalance)).toBe(175000000 - 1306000 - 50000);
    expect(Number(plan.posBefore)).toBe(-50000 + 175000000 - 1306000 - 777);
    expect(Number(plan.posAfter)).toBe(Number(plan.larkBalance));
  });

  it('respects the --to date', async () => {
    const plan = await planVphnImport(
      fakeDb() as any,
      records,
      untilOf('2026-10-13'),
    );
    expect(plan.add).toEqual([]);
    expect(plan.voids).toEqual([]);
    expect(Number(plan.larkBalance)).toBe(-50000);
  });
});

describe('applyVphnImport', () => {
  it('cancels the live rows first, marks their entries, then inserts the Lark rows', async () => {
    const tx = fakeDb();
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };

    const plan = await applyVphnImport(prisma, records, 5);

    expect(plan.add).toHaveLength(2);
    const cancelled = tx.internalFundTransaction.update.mock.calls.map(
      ([args]: any) => [
        args.where.id,
        args.data.status,
        args.data.cancelReason,
      ],
    );
    expect(cancelled).toEqual([
      [11, 'CANCELLED', VPHN_VOID_REASON],
      [12, 'CANCELLED', VPHN_VOID_REASON],
      [13, 'CANCELLED', VPHN_VOID_REASON],
    ]);
    // Dòng quỹ #12 gắn phiếu 80: phiếu mang dấu đã trừ quỹ trên Lark.
    const marks = tx.$executeRaw.mock.calls.filter(([strings]: any) =>
      strings.join('').includes('larkLedgerRecorded'),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].slice(1)).toContain(80);
    expect(tx.internalFundTransaction.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceKey: 'LARK_LEDGER:rec-a',
          branchId: 4,
          transactionType: 'TRANSFER_IN',
          sourceType: 'LEDGER_HISTORY',
          status: 'POSTED',
          createdBy: 5,
        }),
        expect.objectContaining({
          sourceKey: 'LARK_LEDGER:rec-b',
          transactionType: 'EXPENSE',
        }),
      ],
    });
    expect(tx.internalFundDailyClosing.updateMany).toHaveBeenCalled();
  });
});
