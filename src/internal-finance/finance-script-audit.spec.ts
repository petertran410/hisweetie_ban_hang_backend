import { Prisma } from '@prisma/client';
import type { FinanceAuditDb } from '../finance-audit';
import {
  flushScriptLog,
  pushEntryScriptUpdate,
  pushFundRestore,
  pushFundScriptUpdate,
  pushScriptRun,
  scriptRun,
} from './finance-script-audit';

type Change = { label: string; from: string; to: string };
type Row = Omit<
  Prisma.AuditLogCreateManyInput,
  'changes' | 'snapshot' | 'metadata'
> & {
  changes: Change[];
  snapshot: {
    lines: { label: string; value: string }[];
    cancelledBefore?: unknown;
  };
  metadata: Record<string, unknown>;
};

function fakeDb() {
  const createMany = jest.fn((args: { data: Row[] }) =>
    Promise.resolve({ count: args.data.length }),
  );
  const findMany = jest.fn(() => Promise.resolve([]));
  const db = {
    auditLog: { createMany },
    user: { findMany },
  } as unknown as FinanceAuditDb;
  const rows = () => createMany.mock.calls.flatMap(([args]) => args.data);
  return { db, createMany, findMany, rows };
}

const entry = {
  id: 80,
  code: 'TCNB-80',
  category: 'CASH_FUND_EXPENSE',
  branchId: 7,
  cashIssued: true,
  cashIssuedReason: 'Lark Approval đã duyệt',
  sourceSnapshot: { formKind: 'PHIEU_CHI' },
};

describe('finance-script-audit', () => {
  it('writes one FIN_SCRIPT_RUN with counts, args and the script actor', async () => {
    const f = fakeDb();
    const run = scriptRun('balance-vpsg-fund', 9, ['--apply', '--user=9']);
    pushScriptRun(
      run,
      'Quỹ VPSG: ghi CHI 300.000',
      [
        { key: 'posted', label: 'Ghi dòng cân bằng mới', value: 1 },
        { key: 'actual', label: 'Tiền đếm', value: '3.500.000' },
      ],
      { branchId: 7, metadata: { at: new Date('2026-11-19T16:59:59Z') } },
    );
    await flushScriptLog(f.db, run);

    expect(f.createMany).toHaveBeenCalledTimes(1);
    const [row] = f.rows();
    expect(row).toMatchObject({
      actionType: 'POST',
      actionCode: 'FIN_SCRIPT_RUN',
      category: 'internal_finance',
      severity: 'critical',
      entityType: 'finance_scripts',
      entityId: `balance-vpsg-fund:${run.startedAt.toISOString()}`,
      entityCode: 'balance-vpsg-fund',
      branchId: 7,
      userId: 9,
      userName: 'Script balance-vpsg-fund',
      requestId: run.actor.opId,
      message:
        'Chạy script balance-vpsg-fund --apply: Quỹ VPSG: ghi CHI 300.000',
    });
    expect(row.snapshot.lines).toEqual([
      { label: 'Ghi dòng cân bằng mới', value: '1' },
      { label: 'Tiền đếm', value: '3.500.000' },
      { label: 'Tham số', value: '--apply --user=9' },
    ]);
    expect(row.metadata).toMatchObject({
      script: 'balance-vpsg-fund',
      counts: { posted: 1, actual: '3.500.000' },
      args: ['--apply', '--user=9'],
      at: '2026-11-19T16:59:59.000Z',
      actorKind: 'SCRIPT',
      trigger: 'script:balance-vpsg-fund',
    });
    // Ghi xong thì hàng đợi rỗng: gọi lại không ghi thêm.
    await flushScriptLog(f.db, run);
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('logs entry and fund row edits only when something changed, with Vietnamese labels', async () => {
    const f = fakeDb();
    const run = scriptRun('import-office-ledger', 5);
    pushEntryScriptUpdate(run, entry, { cashIssued: true });
    pushFundScriptUpdate(
      run,
      { id: 60, code: 'QF-CHI-60', branchId: 7 },
      { description: 'A' },
      { description: 'A' },
    );
    expect(run.log).toEqual([]);

    pushEntryScriptUpdate(run, entry, {
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
      sourceSnapshot: { ...entry.sourceSnapshot, larkLedgerRecorded: true },
    });
    pushFundScriptUpdate(
      run,
      { id: 60, code: 'QF-CHI-60', branchId: 7 },
      { entryId: null },
      { entryId: 80 },
      'Gắn phiếu',
    );
    await flushScriptLog(f.db, run);

    const [entryRow, fundRow] = f.rows();
    expect(entryRow).toMatchObject({
      actionCode: 'FIN_ENTRY_UPDATE',
      entityType: 'internal_finance_entries',
      entityId: '80',
      entityCode: 'TCNB-80',
      message: 'Sửa phiếu chi quỹ TCNB-80 (script import-office-ledger)',
    });
    expect(
      entryRow.changes.map((change) => [change.label, change.from, change.to]),
    ).toEqual([
      ['Lý do Đã chi', 'Lark Approval đã duyệt', 'Đã trừ quỹ trên Lark'],
      ['Đã trừ quỹ trên Lark', 'Không', 'Có'],
    ]);
    expect(fundRow).toMatchObject({
      actionCode: 'FIN_FUND_TXN_SCRIPT_UPDATE',
      entityId: '60',
      message: 'Script cập nhật dòng quỹ QF-CHI-60',
      snapshot: { lines: [{ label: 'Ghi chú', value: 'Gắn phiếu' }] },
    });
    expect(fundRow.changes).toEqual([
      expect.objectContaining({
        label: 'Phiếu gắn với dòng quỹ',
        from: '—',
        to: '#80',
      }),
    ]);
  });

  it('keeps the old cancel info when restoring a fund row', async () => {
    const f = fakeDb();
    const run = scriptRun('import-office-ledger', 5);
    pushFundRestore(
      run,
      {
        id: 40,
        code: 'SQ-1s1',
        branchId: 7,
        status: 'CANCELLED',
        sourceKey: 'LARK_LEDGER:rec-s1:CANCELLED:40',
        amount: new Prisma.Decimal(100000),
        occurredAt: new Date('2026-10-20T02:00:00Z'),
        cancelledAt: new Date('2026-11-05T02:00:00Z'),
        cancelledBy: 3,
        cancelReason: 'Bỏ sổ quỹ Lark Base',
      },
      { status: 'POSTED', sourceKey: 'LARK_LEDGER:rec-s1' },
      'Nhập lại sổ quỹ Lark',
    );
    await flushScriptLog(f.db, run);
    const [row] = f.rows();
    expect(row).toMatchObject({
      actionCode: 'FIN_FUND_TXN_RESTORE',
      severity: 'critical',
      message: 'Khôi phục dòng quỹ SQ-1s1: Nhập lại sổ quỹ Lark',
    });
    expect(row.metadata.cancelReasonBefore).toBe('Bỏ sổ quỹ Lark Base');
    expect(row.snapshot.cancelledBefore).toEqual({
      status: 'CANCELLED',
      sourceKey: 'LARK_LEDGER:rec-s1:CANCELLED:40',
      cancelledAt: '2026-11-05T02:00:00.000Z',
      cancelledBy: 3,
      cancelReason: 'Bỏ sổ quỹ Lark Base',
    });
    expect(row.snapshot.lines).toEqual(
      expect.arrayContaining([
        { label: 'Lý do hủy cũ', value: 'Bỏ sổ quỹ Lark Base' },
        { label: 'Người hủy', value: '#3' },
      ]),
    );
  });
});
