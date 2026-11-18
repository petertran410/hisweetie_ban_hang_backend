import { Prisma } from '@prisma/client';
import {
  VPHN_LEDGER_CUTOFF,
  VPSG_FUND_START,
} from '../approval-lifecycle/approval-lifecycle.constants';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import {
  applyLedgerImport,
  applyLedgerPlan,
  planLedgerImport,
  untilOf,
  voidReason,
} from './office-ledger-import';

const DAY = 86400000;
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

// Chạy lại: ngày tính lùi từ mốc VPHN.
const HN = 'Văn Phòng Hà Nội';
const beforeStart = (days: number) =>
  new Date(VPHN_LEDGER_CUTOFF.getTime() - days * DAY + 9 * 3600000);
const rerunRecords = [
  // Đã nhập 150.000, Lark sửa thành 200.000.
  lark(
    'rec-h',
    {
      Chi: 200000,
      'Ngày Giao Dịch': beforeStart(30).getTime(),
      'Nội Dung': 'Mua nước',
    },
    HN,
  ),
  // Chỉ sửa nội dung.
  lark(
    'rec-i',
    {
      Thu: 5000000,
      'Ngày Giao Dịch': beforeStart(29).getTime(),
      'Nội Dung': 'Rút tiền TK về quỹ',
    },
    HN,
  ),
  // Đã nhập, nay Hủy trên Lark.
  lark(
    'rec-j',
    {
      Chi: 300000,
      'Trạng Thái': 'Hủy',
      'Ngày Giao Dịch': beforeStart(28).getTime(),
    },
    HN,
  ),
  // Đã nhập, nay dời ngày qua mốc.
  lark(
    'rec-l',
    { Chi: 400000, 'Ngày Giao Dịch': VPHN_LEDGER_CUTOFF.getTime() + DAY },
    HN,
  ),
  // Dòng POS đang hủy (khóa còn nguyên), Lark tính lại.
  lark(
    'rec-m',
    { Chi: 70000, 'Ngày Giao Dịch': beforeStart(26).getTime() },
    HN,
  ),
  // Văn phòng khác: không đụng.
  lark(
    'rec-n',
    { Chi: 90000, 'Ngày Giao Dịch': beforeStart(25).getTime() },
    'Văn Phòng Sài Gòn',
  ),
];
const rerunPosRows = [
  posRow({
    id: 20,
    branchId: 4,
    code: 'SQ-1h',
    transactionType: 'EXPENSE',
    amount: 150000,
    occurredAt: beforeStart(30),
    sourceKey: 'LARK_LEDGER:rec-h',
    sourceType: 'LEDGER_HISTORY',
    description: 'Mua nước',
  }),
  posRow({
    id: 21,
    branchId: 4,
    code: 'SQ-1i',
    transactionType: 'RECEIPT',
    amount: 5000000,
    occurredAt: beforeStart(29),
    sourceKey: 'LARK_LEDGER:rec-i',
    sourceType: 'LEDGER_HISTORY',
    description: 'Rút tiền TK',
  }),
  posRow({
    id: 22,
    branchId: 4,
    code: 'SQ-1j',
    transactionType: 'EXPENSE',
    amount: 300000,
    occurredAt: beforeStart(28),
    sourceKey: 'LARK_LEDGER:rec-j',
    sourceType: 'LEDGER_HISTORY',
  }),
  // Dòng đã bị xóa khỏi sổ Lark.
  posRow({
    id: 23,
    branchId: 4,
    code: 'SQ-1k',
    transactionType: 'EXPENSE',
    amount: 1000,
    occurredAt: beforeStart(28),
    sourceKey: 'LARK_LEDGER:rec-k',
    sourceType: 'LEDGER_HISTORY',
  }),
  posRow({
    id: 24,
    branchId: 4,
    code: 'SQ-1l',
    transactionType: 'EXPENSE',
    amount: 400000,
    occurredAt: beforeStart(27),
    sourceKey: 'LARK_LEDGER:rec-l',
    sourceType: 'LEDGER_HISTORY',
  }),
  posRow({
    id: 25,
    branchId: 4,
    code: 'SQ-1m',
    status: 'CANCELLED',
    transactionType: 'EXPENSE',
    amount: 70000,
    occurredAt: beforeStart(26),
    sourceKey: 'LARK_LEDGER:rec-m',
    sourceType: 'LEDGER_HISTORY',
  }),
  posRow({
    id: 26,
    branchId: 4,
    code: 'QF-CANBANG-1',
    transactionType: 'RECEIPT',
    amount: 12345,
    occurredAt: new Date(VPHN_LEDGER_CUTOFF.getTime() - 1000),
    sourceKey: 'VPSG_BALANCE',
    sourceType: 'BALANCE_ADJUSTMENT',
  }),
  posRow({
    id: 27,
    branchId: 4,
    code: 'QF-CHI-9',
    transactionType: 'EXPENSE',
    amount: 200000,
    occurredAt: new Date(beforeStart(30).getTime() + 6 * 3600000),
    sourceKey: 'PAYMENT_VOUCHER:30',
    sourceType: 'LARK_PAYMENT_VOUCHER',
    entryId: 90,
  }),
];

function fakeDb(rows: any[] = posRows) {
  return {
    internalFundTransaction: {
      findMany: jest.fn(async ({ where }: any) =>
        where.code
          ? []
          : rows.filter(
              (row) =>
                row.occurredAt < where.occurredAt.lt &&
                row.branchId === where.branchId,
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

describe('untilOf / voidReason', () => {
  it('defaults to the office cutoff and reads --to as end of a Vietnam day', () => {
    expect(untilOf(4)).toEqual(VPHN_LEDGER_CUTOFF);
    expect(untilOf(4, '2026-10-31')).toEqual(new Date('2026-10-31T17:00:00Z'));
    expect(() => untilOf(4, '31/10/2026')).toThrow('YYYY-MM-DD');
  });

  it('keeps the VPHN wording for voided rows', () => {
    expect(voidReason(VPHN_LEDGER_CUTOFF)).toBe(
      'Thay bằng sổ quỹ Lark tới hết 31/10/2026',
    );
  });
});

describe('planLedgerImport (VPHN)', () => {
  it('adds missing Lark rows, voids POS live rows with their Lark twin, and matches the Lark balance', async () => {
    const plan = await planLedgerImport(fakeDb() as any, records, 4);

    expect(plan.add.map((row) => [row.sourceKey, row.transactionType])).toEqual(
      [
        ['LARK_LEDGER:rec-a', 'TRANSFER_IN'],
        ['LARK_LEDGER:rec-b', 'EXPENSE'],
      ],
    );
    expect(plan.existing.map((row) => row.sourceKey)).toEqual([
      'LARK_LEDGER:rec-c',
    ]);
    expect(plan.changed).toEqual([]);
    expect(plan.renamed).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.skipped.map((row) => row.recordId)).toEqual(['rec-e', 'rec-f']);
    expect(plan.afterCutoff.map((row) => row.recordId)).toEqual(['rec-g']);

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
    const plan = await planLedgerImport(
      fakeDb() as any,
      records,
      4,
      untilOf(4, '2026-10-13'),
    );
    expect(plan.add).toEqual([]);
    expect(plan.voids).toEqual([]);
    expect(Number(plan.larkBalance)).toBe(-50000);
  });

  it('only imports the offices; VPSG needs the merge mode', async () => {
    await expect(planLedgerImport(fakeDb() as any, records, 6)).rejects.toThrow(
      'văn phòng',
    );
    await expect(planLedgerImport(fakeDb() as any, records, 7)).rejects.toThrow(
      'chế độ kết hợp',
    );
  });
});

describe('planLedgerImport (VPSG merge)', () => {
  const DROP = 'Bỏ sổ quỹ Lark Base: quỹ VPSG ghi theo đơn duyệt';
  const SG = 'Văn Phòng Sài Gòn';
  const before = (days: number, hours = 9) =>
    new Date(VPSG_FUND_START.getTime() - days * DAY + hours * 3600000);
  const sgRecords = [
    lark('rec-s1', { Chi: 100000, 'Ngày Giao Dịch': before(10).getTime() }, SG),
    lark('rec-s2', { Thu: 500000, 'Ngày Giao Dịch': before(8).getTime() }, SG),
    lark('rec-s3', { Chi: 70000, 'Ngày Giao Dịch': before(6).getTime() }, SG),
  ];
  const sgRows = [
    // Hai dòng sổ bị lần "bỏ sổ Lark" hủy: bật lại.
    posRow({
      id: 40,
      branchId: 7,
      code: 'SQ-1s1',
      status: 'CANCELLED',
      cancelReason: DROP,
      transactionType: 'EXPENSE',
      amount: 100000,
      occurredAt: before(10),
      sourceKey: 'LARK_LEDGER:rec-s1:CANCELLED:40',
      sourceType: 'LEDGER_HISTORY',
    }),
    posRow({
      id: 41,
      branchId: 7,
      code: 'SQ-1s2',
      status: 'CANCELLED',
      cancelReason: DROP,
      transactionType: 'RECEIPT',
      amount: 500000,
      occurredAt: before(8),
      sourceKey: 'LARK_LEDGER:rec-s2:CANCELLED:41',
      sourceType: 'LEDGER_HISTORY',
    }),
    // Đơn PHIẾU CHI: đối chiếu riêng theo đơn, không hủy ở đây.
    posRow({
      id: 42,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: 100000,
      occurredAt: before(10, 12),
      sourceKey: 'PAYMENT_VOUCHER:1',
      sourceType: 'LARK_PAYMENT_VOUCHER',
    }),
    // Tiền vào tài khoản trùng dòng thu của sổ: hủy.
    posRow({
      id: 43,
      branchId: 7,
      transactionType: 'RECEIPT',
      amount: 500000,
      occurredAt: before(8, 11),
      sourceKey: 'SEPAY_VPSG:9',
      sourceType: 'SEPAY_VPSG',
    }),
    // Không có dòng sổ cùng khoản: giữ.
    posRow({
      id: 44,
      branchId: 7,
      transactionType: 'TRANSFER_IN',
      amount: 999,
      occurredAt: before(7),
      sourceKey: 'TRANSFER:5:TRANSFER_IN',
      sourceType: 'INTERNAL_FUND_TRANSFER',
    }),
  ];
  const options = { merge: true, restoreReason: DROP };

  it('restores rows dropped earlier and only voids POS rows the ledger already has', async () => {
    const plan = await planLedgerImport(
      fakeDb(sgRows) as any,
      sgRecords,
      7,
      undefined,
      options,
    );
    expect(plan.restored.map((row) => [row.id, row.sourceKey])).toEqual([
      [40, 'LARK_LEDGER:rec-s1'],
      [41, 'LARK_LEDGER:rec-s2'],
    ]);
    expect(plan.existing.map((row) => row.sourceKey)).toEqual([
      'LARK_LEDGER:rec-s1',
      'LARK_LEDGER:rec-s2',
    ]);
    expect(plan.add.map((row) => row.sourceKey)).toEqual([
      'LARK_LEDGER:rec-s3',
    ]);
    expect(
      plan.voids.map((item) => [item.pos.id, item.twin?.sourceKey]),
    ).toEqual([[43, 'LARK_LEDGER:rec-s2']]);
    expect(plan.ledger).toHaveLength(3);
    expect(Number(plan.posBefore)).toBe(-100000 + 500000 + 999);
    expect(Number(plan.posAfter)).toBe(
      Number(plan.posBefore) + 400000 - 70000 - 500000,
    );
  });

  it('turns restored rows back on (same id and code) before anything else', async () => {
    const tx = fakeDb(sgRows);
    const plan = await planLedgerImport(
      tx as any,
      sgRecords,
      7,
      undefined,
      options,
    );
    await applyLedgerPlan(tx as any, plan, 5, new InternalFundLedgerService());
    const updates = tx.internalFundTransaction.update.mock.calls.map(
      ([args]: any) => [args.where.id, args.data],
    );
    expect(updates.slice(0, 2)).toEqual([
      [
        40,
        {
          status: 'POSTED',
          sourceKey: 'LARK_LEDGER:rec-s1',
          cancelledAt: null,
          cancelledBy: null,
          cancelReason: null,
        },
      ],
      [41, expect.objectContaining({ sourceKey: 'LARK_LEDGER:rec-s2' })],
    ]);
    expect(updates[2]).toEqual([
      43,
      expect.objectContaining({ status: 'CANCELLED' }),
    ]);
    expect(
      tx.internalFundTransaction.createMany.mock.calls[0][0].data.map(
        (row: any) => row.sourceKey,
      ),
    ).toEqual(['LARK_LEDGER:rec-s3']);
  });
});

describe('planLedgerImport (re-run follows Lark)', () => {
  it('re-adds edited rows, renames, cancels rows Lark dropped, and keeps the balance row', async () => {
    const plan = await planLedgerImport(
      fakeDb(rerunPosRows) as any,
      rerunRecords,
      4,
    );

    expect(plan.add).toEqual([]);
    expect(
      plan.changed.map((item) => [item.pos.id, Number(item.lark.amount)]),
    ).toEqual([
      [20, 200000],
      [25, 70000],
    ]);
    expect(
      plan.renamed.map((item) => [item.pos.id, item.lark.description]),
    ).toEqual([[21, 'Rút tiền TK về quỹ']]);
    expect(plan.removed.map((item) => item.pos.id)).toEqual([22, 23, 24]);
    expect(plan.removed[0].reason).toBe('Đã hủy trên Lark');
    expect(plan.removed[1].reason).toBe('Dòng sổ quỹ không còn trên Lark');
    expect(plan.removed[2].reason).toContain('Lark đổi ngày sang');
    expect(plan.afterCutoff.map((row) => row.recordId)).toEqual(['rec-l']);
    // Chỉ dòng POS tự ghi bị hủy; dòng lịch sử và dòng cân bằng giữ nguyên.
    expect(
      plan.voids.map((item) => [item.pos.id, item.twin?.sourceKey ?? null]),
    ).toEqual([[27, 'LARK_LEDGER:rec-h']]);

    expect(Number(plan.larkBalance)).toBe(-200000 + 5000000 - 70000);
    // Sau áp dụng: đúng sổ Lark, cộng dòng cân bằng.
    expect(Number(plan.posAfter)).toBe(Number(plan.larkBalance) + 12345);
  });
});

describe('applyLedgerImport', () => {
  it('cancels the live rows first, marks their entries, then inserts the Lark rows', async () => {
    const tx = fakeDb();
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };

    const plan = await applyLedgerImport(prisma, records, 4, 5);

    expect(plan.add).toHaveLength(2);
    const cancelled = tx.internalFundTransaction.update.mock.calls.map(
      ([args]: any) => [
        args.where.id,
        args.data.status,
        args.data.cancelReason,
      ],
    );
    const reason = 'Thay bằng sổ quỹ Lark tới hết 31/10/2026';
    expect(cancelled).toEqual([
      [11, 'CANCELLED', reason],
      [12, 'CANCELLED', reason],
      [13, 'CANCELLED', reason],
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

  it('syncs rows edited on Lark and leaves the balance row alone', async () => {
    const tx = fakeDb(rerunPosRows);
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };

    await applyLedgerImport(prisma, rerunRecords, 4, 5);

    const byId = new Map<number, any>(
      tx.internalFundTransaction.update.mock.calls.map(
        ([args]: any) => [args.where.id, args.data] as [number, any],
      ),
    );
    expect(byId.get(27)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: voidReason(VPHN_LEDGER_CUTOFF),
    });
    expect(byId.get(22)).toMatchObject({
      status: 'CANCELLED',
      sourceKey: 'LARK_LEDGER:rec-j:CANCELLED:22',
    });
    expect(byId.get(20)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Sửa trên sổ quỹ Lark',
    });
    // Dòng đang hủy: chỉ nhả khóa để thêm lại.
    expect(byId.get(25)).toEqual({
      sourceKey: 'LARK_LEDGER:rec-m:CANCELLED:25',
    });
    expect(byId.get(21)).toEqual({ description: 'Rút tiền TK về quỹ' });
    expect(byId.has(26)).toBe(false);

    const inserted =
      tx.internalFundTransaction.createMany.mock.calls[0][0].data;
    expect(
      inserted.map((row: any) => [row.sourceKey, Number(row.amount)]),
    ).toEqual([
      ['LARK_LEDGER:rec-h', 200000],
      ['LARK_LEDGER:rec-m', 70000],
    ]);
    const marks = tx.$executeRaw.mock.calls.filter(([strings]: any) =>
      strings.join('').includes('larkLedgerRecorded'),
    );
    expect(marks[0].slice(1)).toContain(90);
  });

  it('only writes up to the cutoff in code', async () => {
    const tx = fakeDb();
    const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };
    await expect(
      applyLedgerImport(prisma, records, 4, 5, untilOf(4, '2026-10-20')),
    ).rejects.toThrow('mốc');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
