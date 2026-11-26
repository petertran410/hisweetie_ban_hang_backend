import { Prisma } from '@prisma/client';
import { VPSG_FUND_START } from '../approval-lifecycle/approval-lifecycle.constants';
import { LARK_APPROVED_REASON } from '../approval-lifecycle/lark-approval-mirror.service';
import { applyVpsgMerge, planVpsgMerge } from './vpsg-ledger-merge';

const DAY = 86400000;
const SG = 'Văn Phòng Sài Gòn';
// Ngày tính lùi từ mốc VPSG (04/11) để test không phụ thuộc ngày mốc.
const at = (days: number, hours = 9) =>
  new Date(VPSG_FUND_START.getTime() - days * DAY + hours * 3600000);

const ledgerRecord = (id: string, fields: Record<string, unknown>) => ({
  recordId: id,
  fields: { 'Chi Nhánh': SG, STT: id.replace('rec-', '1'), ...fields },
  createdAt: at(40),
  modifiedAt: null,
});
const records = [
  // Đơn #1 ghi sổ theo ngày chi tiền (4 ngày trước ngày duyệt).
  ledgerRecord('rec-a', { Chi: 200000, 'Ngày Giao Dịch': at(20).getTime() }),
  // Hai dòng cùng 50.000 gần đơn #3.
  ledgerRecord('rec-b', { Chi: 50000, 'Ngày Giao Dịch': at(15).getTime() }),
  ledgerRecord('rec-c', { Chi: 50000, 'Ngày Giao Dịch': at(14).getTime() }),
  ledgerRecord('rec-d', { Thu: 1000000, 'Ngày Giao Dịch': at(30).getTime() }),
];

const request = (
  id: number,
  amount: number | null,
  completedAt: Date,
  paymentDate?: Date,
) => ({
  id,
  status: 'APPROVED',
  branchId: 7,
  createdById: 9,
  completedAt,
  sourceType: 'LARK_PAYMENT_VOUCHER',
  instanceCode: `I${id}`,
  formSnapshot: {
    form: paymentDate
      ? [{ id: 'w1', name: 'Ngày chi tiền', value: paymentDate.toISOString() }]
      : [],
    metadata: amount ? { amount, description: `Đơn ${id}` } : {},
  },
  detailSnapshot: { start_time: String(completedAt.getTime() - 2 * DAY) },
});

function fakeDb() {
  const rows: any[] = [
    // #1 đang có dòng quỹ (POS tự ghi lúc duyệt).
    {
      id: 60,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(200000),
      occurredAt: at(16),
      sourceKey: 'PAYMENT_VOUCHER:1',
      sourceType: 'LARK_PAYMENT_VOUCHER',
      status: 'POSTED',
      entryId: null,
      cancelReason: null,
      code: 'QF-CHI-60',
      description: '',
    },
    // #4: kế toán hủy tay.
    {
      id: 62,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(75000),
      occurredAt: at(10),
      sourceKey: 'PAYMENT_VOUCHER:4:CANCELLED:62',
      sourceType: 'LARK_PAYMENT_VOUCHER',
      status: 'CANCELLED',
      entryId: null,
      cancelReason: 'Nhập sai',
      code: 'QF-CHI-62',
      description: '',
    },
    // #5 có dòng quỹ, chưa gắn phiếu.
    {
      id: 61,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(90000),
      occurredAt: at(9),
      sourceKey: 'PAYMENT_VOUCHER:5',
      sourceType: 'LARK_PAYMENT_VOUCHER',
      status: 'POSTED',
      entryId: null,
      cancelReason: null,
      code: 'QF-CHI-61',
      description: '',
    },
    // #6: lệnh import sổ trước đây hủy.
    {
      id: 63,
      branchId: 7,
      transactionType: 'EXPENSE',
      amount: new Prisma.Decimal(40000),
      occurredAt: at(8),
      sourceKey: 'PAYMENT_VOUCHER:6:CANCELLED:63',
      sourceType: 'LARK_PAYMENT_VOUCHER',
      status: 'CANCELLED',
      entryId: null,
      cancelReason: 'Thay bằng sổ quỹ Lark tới hết 03/11/2026',
      code: 'QF-CHI-63',
      description: '',
    },
  ];
  const requests = [
    request(1, 200000, at(16), at(20)),
    request(2, 300000, at(12)),
    request(3, 50000, at(14, 10)),
    request(4, 75000, at(10)),
    request(5, 90000, at(9)),
    request(6, 40000, at(8)),
    // Không có tiền mặt: không xét.
    request(7, null, at(7)),
  ];
  const entries: any[] = [
    {
      id: 80,
      code: 'TCNB-80',
      category: 'CASH_FUND_EXPENSE',
      branchId: 7,
      cashIssued: true,
      sourceKey: 'LARK_APPROVAL:I1',
      status: 'POSTED',
      sourceSnapshot: { formKind: 'PHIEU_CHI' },
      cashIssuedReason: LARK_APPROVED_REASON,
    },
    {
      id: 81,
      code: 'TCNB-81',
      category: 'CASH_FUND_EXPENSE',
      branchId: 7,
      cashIssued: true,
      sourceKey: 'LARK_APPROVAL:I2',
      status: 'POSTED',
      sourceSnapshot: { larkLedgerRecorded: true },
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
    },
    {
      id: 82,
      code: 'TCNB-82',
      category: 'CASH_FUND_EXPENSE',
      branchId: 7,
      cashIssued: true,
      sourceKey: 'LARK_APPROVAL:I3',
      status: 'POSTED',
      sourceSnapshot: { larkLedgerRecorded: true },
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
    },
    {
      id: 83,
      code: 'TCNB-83',
      category: 'CASH_FUND_EXPENSE',
      branchId: 7,
      cashIssued: true,
      sourceKey: 'LARK_APPROVAL:I5',
      status: 'POSTED',
      sourceSnapshot: { larkLedgerRecorded: true },
      cashIssuedReason: LARK_APPROVED_REASON,
    },
  ];
  const db: any = {
    internalFundTransaction: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.code) return [];
        if (where.sourceType)
          return rows.filter(
            (row) =>
              row.branchId === where.branchId &&
              row.sourceType === where.sourceType,
          );
        return rows.filter(
          (row) =>
            row.branchId === where.branchId &&
            row.occurredAt < where.occurredAt.lt,
        );
      }),
      findUnique: jest.fn(
        async ({ where }: any) =>
          rows.find((row) =>
            where.id ? row.id === where.id : row.sourceKey === where.sourceKey,
          ) || null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 100 + rows.length,
          entryId: null,
          cancelReason: null,
          ...data,
          amount: new Prisma.Decimal(data.amount),
        };
        rows.push(row);
        return row;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const item of data)
          rows.push({
            id: 200 + rows.length,
            entryId: null,
            cancelReason: null,
            ...item,
          });
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          rows.find((row) => row.id === where.id),
          data,
        ),
      ),
    },
    approvalRequest: { findMany: jest.fn(async () => requests) },
    internalFinanceEntry: {
      findMany: jest.fn(async ({ where }: any) =>
        entries.filter((entry) => where.sourceKey.in.includes(entry.sourceKey)),
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          entries.find((entry) => entry.id === where.id) || null,
      ),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          entries.find((entry) => entry.id === where.id),
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
  return { db, rows, entries };
}

/** Mọi dòng lịch sử đã ghi (gộp các lần createMany). */
const auditRows = (db: any): any[] =>
  db.auditLog.createMany.mock.calls.flatMap(([args]: any) => args.data);
const byCode = (rows: any[], code: string) =>
  rows.filter((row) => row.actionCode === code);

const ids = (items: Array<{ request: { id: number } }>) =>
  items.map((item) => item.request.id);

describe('VPSG ledger + approvals merge', () => {
  it('matches each approval to at most one ledger row by amount and the closest date', async () => {
    const { db } = fakeDb();
    const plan = await planVpsgMerge(db, records);

    expect(ids(plan.approvals)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      plan.matched.map((item) => [
        item.approval.request.id,
        item.lark.sourceKey,
        item.candidates,
      ]),
    ).toEqual([
      // #1 khớp theo ngày chi tiền (lệch 0 ngày), dù ngày duyệt lệch 4 ngày.
      [1, 'LARK_LEDGER:rec-a', 1],
      // #3 có 2 dòng 50.000 trong cửa sổ, lấy dòng gần nhất.
      [3, 'LARK_LEDGER:rec-c', 2],
    ]);
    expect(ids(plan.unmatched)).toEqual([2, 4, 5, 6]);
  });

  it('decides per approval: void the twin, post what the ledger misses, link vouchers, skip hand-cancelled rows', async () => {
    const { db } = fakeDb();
    const plan = await planVpsgMerge(db, records);

    expect(plan.voids.map((item) => item.approval.request.id)).toEqual([1]);
    expect(ids(plan.marks)).toEqual([1]);
    expect(ids(plan.posts)).toEqual([2, 6]);
    expect(ids(plan.attaches)).toEqual([5]);
    expect(
      plan.skipped.map((item) => [item.approval.request.id, item.reason]),
    ).toEqual([[4, 'Dòng quỹ đã hủy: Nhập sai']]);
    // Sổ: 1.000.000 − 200.000 − 50.000 − 50.000; đơn sổ thiếu: #2, #5, #6.
    expect(Number(plan.ledger.larkBalance)).toBe(700000);
    expect(Number(plan.posAfter)).toBe(700000 - 300000 - 90000 - 40000);
  });

  it('applies the merge and changes nothing on a second run', async () => {
    const { db, rows, entries } = fakeDb();
    await applyVpsgMerge(db, records, 5);

    expect(
      db.internalFundTransaction.createMany.mock.calls[0][0].data.map(
        (row: any) => row.sourceKey,
      ),
    ).toEqual([
      'LARK_LEDGER:rec-a',
      'LARK_LEDGER:rec-b',
      'LARK_LEDGER:rec-c',
      'LARK_LEDGER:rec-d',
    ]);
    expect(rows.find((row) => row.id === 60)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Trùng dòng sổ quỹ Lark SQ-1a',
    });
    expect(entries.find((entry) => entry.id === 80)).toMatchObject({
      sourceSnapshot: { formKind: 'PHIEU_CHI', larkLedgerRecorded: true },
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
    });
    const posted2 = rows.find((row) => row.sourceKey === 'PAYMENT_VOUCHER:2');
    expect(posted2).toMatchObject({
      status: 'POSTED',
      occurredAt: at(12),
      entryId: 81,
    });
    expect(entries.find((entry) => entry.id === 81)).toMatchObject({
      sourceSnapshot: {},
      cashIssuedReason: LARK_APPROVED_REASON,
    });
    expect(
      rows.find((row) => row.sourceKey === 'PAYMENT_VOUCHER:6'),
    ).toMatchObject({ status: 'POSTED' });
    expect(rows.find((row) => row.id === 61).entryId).toBe(83);
    expect(rows.some((row) => row.sourceKey === 'PAYMENT_VOUCHER:4')).toBe(
      false,
    );

    // Lịch sử: một dòng chạy script; dòng quỹ thêm/hủy do ledger ghi; script
    // sửa dòng quỹ (gắn phiếu) và phiếu (dấu Lark), tất cả cùng opId.
    const history = auditRows(db);
    const runs = byCode(history, 'FIN_SCRIPT_RUN');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      entityType: 'finance_scripts',
      entityCode: 'import-office-ledger',
      branchId: 7,
      userId: 5,
    });
    expect(runs[0].metadata.counts).toMatchObject({
      added: 4,
      matched: 2,
      approvalVoids: 1,
      marks: 1,
      posts: 2,
      attaches: 1,
    });
    expect(runs[0].message).toContain('ghi quỹ đơn sổ thiếu 2');
    expect(
      byCode(history, 'FIN_FUND_TXN_CANCEL').map((row) => row.entityId),
    ).toEqual(['60']);
    expect(
      byCode(history, 'FIN_FUND_TXN_POST').map((row) => row.metadata.sourceKey),
    ).toEqual(['PAYMENT_VOUCHER:2', 'PAYMENT_VOUCHER:6']);
    const fundUpdates = byCode(history, 'FIN_FUND_TXN_SCRIPT_UPDATE');
    expect(
      fundUpdates.map((row) => [
        row.entityId,
        row.changes[0].label,
        row.changes[0].to,
      ]),
    ).toEqual([
      [String(posted2.id), 'Phiếu gắn với dòng quỹ', '#81'],
      ['61', 'Phiếu gắn với dòng quỹ', '#83'],
    ]);
    const entryUpdates = byCode(history, 'FIN_ENTRY_UPDATE');
    expect(entryUpdates.map((row) => row.entityId)).toEqual(['80', '81', '83']);
    expect(entryUpdates[1].changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Lý do Đã chi',
          from: 'Đã trừ quỹ trên Lark',
          to: LARK_APPROVED_REASON,
        }),
        expect.objectContaining({
          label: 'Đã trừ quỹ trên Lark',
          from: 'Có',
          to: 'Không',
        }),
      ]),
    );
    expect(new Set(history.map((row) => row.requestId)).size).toBe(1);
    expect(new Set(history.map((row) => row.metadata.actorKind))).toEqual(
      new Set(['SCRIPT']),
    );

    const written = db.auditLog.createMany.mock.calls.length;
    const again = await planVpsgMerge(db, records);
    // Chạy thử không ghi lịch sử.
    expect(db.auditLog.createMany.mock.calls.length).toBe(written);
    expect(again.ledger.add).toEqual([]);
    expect(again.voids).toEqual([]);
    expect(again.marks).toEqual([]);
    expect(again.posts).toEqual([]);
    expect(again.attaches).toEqual([]);
    expect(again.matched).toHaveLength(2);
  });

  it('treats approvals the accountant confirms as already in the ledger like matched ones', async () => {
    const { db, rows } = fakeDb();
    const plan = await planVpsgMerge(db, records, undefined, {
      inLedger: [2, 5, 99],
    });
    expect(ids(plan.confirmed)).toEqual([2, 5]);
    expect(plan.unknownConfirm).toEqual([99]);
    expect(
      plan.voids.map((item) => [item.approval.request.id, item.reason]),
    ).toEqual([
      [1, 'Trùng dòng sổ quỹ Lark SQ-1a'],
      [5, 'Trùng dòng sổ quỹ Lark (kế toán xác nhận)'],
    ]);
    expect(ids(plan.posts)).toEqual([6]);
    expect(ids(plan.attaches)).toEqual([]);
    expect(Number(plan.posAfter)).toBe(700000 - 40000);

    // Gõ nhầm số đơn: ghi thật bị chặn, không đổi gì.
    await expect(
      applyVpsgMerge(db, records, 5, undefined, { inLedger: [2, 5, 99] }),
    ).rejects.toThrow('#99');
    expect(rows.find((row) => row.id === 61).status).toBe('POSTED');
    expect(db.auditLog.createMany).not.toHaveBeenCalled();

    await applyVpsgMerge(db, records, 5, undefined, { inLedger: [2, 5] });
    expect(rows.find((row) => row.id === 61)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Trùng dòng sổ quỹ Lark (kế toán xác nhận)',
    });
    expect(rows.some((row) => row.sourceKey === 'PAYMENT_VOUCHER:2')).toBe(
      false,
    );
  });
});
