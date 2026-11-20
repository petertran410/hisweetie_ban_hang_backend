import { Prisma } from '@prisma/client';
import {
  EMPTY_BATCH_CANCEL_REASON,
  InternalFundLedgerService,
  fundDayStart,
} from './internal-fund-ledger.service';
import { FinanceAuditService } from '../finance-audit/finance-audit.service';
import { auditActor } from '../finance-audit/finance-audit.actor';

// Sổ quỹ trên dữ liệu trong bộ nhớ: kiểm tra lịch sử (audit_logs) ghi cùng tx,
// batch tuần rỗng được hủy (không xóa) và trạng thái phiếu rời batch.

interface EntryRow {
  id: number;
  code: string;
  branchId: number;
  direction: string;
  status: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  description: string | null;
  sourceType: string;
  sourceSnapshot: unknown;
  weeklyBatchId: number | null;
  managerReviewedAt: Date | null;
  accountantReviewedAt: Date | null;
  cashIssued: boolean;
  cashIssuedAt: Date | null;
  cashIssuedBy: number | null;
  cashIssuedReason: string | null;
  cashFlowId: number | null;
}
interface BatchRow {
  id: number;
  code: string;
  branchId: number;
  status: string;
  totalAmount: Prisma.Decimal;
  approvalRequestId: number | null;
  approvalStatus?: string;
  cancelReason: string | null;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  cancelledEntryIds: number[];
}
interface TxnRow {
  id: number;
  code: string;
  branchId: number;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  sourceKey: string;
  approvalRequestId: number | null;
  transferId: number | null;
  entryId: number | null;
  status: string;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  cancelReason: string | null;
  createdBy: number;
}
interface TransferRow {
  id: number;
  code: string;
  sourceBranchId: number;
  destinationBranchId: number;
  amount: Prisma.Decimal;
  occurredAt: Date;
  description: string | null;
  status: string;
  approvalRequestId: number | null;
  createdBy: number;
}
interface ClosingRow {
  id: number;
  branchId: number;
  closingDate: Date;
  closedAt: Date | null;
  reconciliationStatus: string;
}
interface ClosingWhere {
  branchId: number;
  closingDate: { gte: Date };
  reconciliationStatus?: { not: string };
}

const DAY = new Date('2026-10-05T00:00:00+07:00');

function entry(id: number, extra: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    code: `TCNB-HN-${id}`,
    branchId: 6,
    direction: 'EXPENSE',
    status: 'READY_FOR_WEEKLY_APPROVAL',
    amount: new Prisma.Decimal(100000),
    occurredAt: DAY,
    description: `Phiếu ${id}`,
    sourceType: 'MANUAL_EXPENSE',
    sourceSnapshot: null,
    weeklyBatchId: 50,
    managerReviewedAt: DAY,
    accountantReviewedAt: DAY,
    cashIssued: false,
    cashIssuedAt: null,
    cashIssuedBy: null,
    cashIssuedReason: null,
    cashFlowId: null,
    ...extra,
  };
}

function batch(extra: Partial<BatchRow> = {}): BatchRow {
  return {
    id: 50,
    code: 'AT-HN-2026-W41',
    branchId: 6,
    status: 'READY',
    totalAmount: new Prisma.Decimal(100000),
    approvalRequestId: null,
    cancelReason: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelledEntryIds: [],
    ...extra,
  };
}

function fundRow(id: number, extra: Partial<TxnRow> = {}): TxnRow {
  return {
    id,
    code: `QF-CHI-${id}`,
    branchId: 6,
    transactionType: 'EXPENSE',
    amount: new Prisma.Decimal(100000),
    occurredAt: DAY,
    description: 'Chi',
    sourceType: 'INTERNAL_FINANCE_ENTRY',
    sourceId: null,
    sourceKey: `EXPENSE:${id}`,
    approvalRequestId: null,
    transferId: null,
    entryId: null,
    status: 'POSTED',
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    createdBy: 7,
    ...extra,
  };
}

function fakeTx(
  seed: {
    entries?: EntryRow[];
    batches?: BatchRow[];
    txns?: TxnRow[];
    transfers?: TransferRow[];
    closings?: ClosingRow[];
  } = {},
  withAuditLog = true,
) {
  const entries = seed.entries ?? [];
  const batches = seed.batches ?? [];
  const txns = seed.txns ?? [];
  const transfers = seed.transfers ?? [];
  const closings = seed.closings ?? [];
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  let nextTxnId = 900;

  const findEntry = (id: number) => entries.find((row) => row.id === id);
  const findBatch = (id: number | null) => batches.find((row) => row.id === id);
  const closingHit = (row: ClosingRow, where: ClosingWhere) =>
    row.branchId === where.branchId &&
    row.closingDate >= where.closingDate.gte &&
    row.closedAt !== null &&
    (!where.reconciliationStatus ||
      row.reconciliationStatus !== where.reconciliationStatus.not);

  const createMany = jest.fn(
    (args: { data: Prisma.AuditLogCreateManyInput[] }) => {
      audit.push(...args.data);
      return Promise.resolve({ count: args.data.length });
    },
  );
  const batchDelete = jest.fn(() =>
    Promise.reject(new Error('Không được xóa cứng batch tuần')),
  );
  const tx = {
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    internalFinanceEntry: {
      findUnique: jest.fn((args: { where: { id: number } }) => {
        const row = findEntry(args.where.id);
        if (!row) return Promise.resolve(null);
        const linked = findBatch(row.weeklyBatchId);
        return Promise.resolve({
          ...row,
          weeklyBatch: linked
            ? {
                ...linked,
                approvalRequest: linked.approvalStatus
                  ? { status: linked.approvalStatus }
                  : null,
              }
            : null,
        });
      }),
      findMany: jest.fn((args: { where: { weeklyBatchId: number } }) =>
        Promise.resolve(
          entries.filter(
            (row) =>
              row.weeklyBatchId === args.where.weeklyBatchId &&
              !row.cashIssued &&
              !txns.some((txn) => txn.entryId === row.id),
          ),
        ),
      ),
      update: jest.fn(
        (args: { where: { id: number }; data: Partial<EntryRow> }) => {
          const row = findEntry(args.where.id)!;
          Object.assign(row, args.data);
          return Promise.resolve({ ...row });
        },
      ),
      aggregate: jest.fn((args: { where: { weeklyBatchId: number } }) => {
        const rest = entries.filter(
          (row) => row.weeklyBatchId === args.where.weeklyBatchId,
        );
        return Promise.resolve({
          _sum: {
            amount: rest.length
              ? rest.reduce(
                  (sum, row) => sum.plus(row.amount),
                  new Prisma.Decimal(0),
                )
              : null,
          },
          _count: { _all: rest.length },
        });
      }),
    },
    internalFinanceWeeklyBatch: {
      findUnique: jest.fn((args: { where: { id: number } }) => {
        const row = findBatch(args.where.id);
        return Promise.resolve(row ? { ...row } : null);
      }),
      update: jest.fn(
        (args: { where: { id: number }; data: Partial<BatchRow> }) => {
          const row = findBatch(args.where.id)!;
          Object.assign(row, args.data);
          return Promise.resolve({ ...row });
        },
      ),
      delete: batchDelete,
    },
    internalFundTransaction: {
      findUnique: jest.fn(
        (args: { where: { sourceKey?: string; id?: number } }) => {
          const row = txns.find((item) =>
            args.where.id !== undefined
              ? item.id === args.where.id
              : item.sourceKey === args.where.sourceKey,
          );
          return Promise.resolve(row ? { ...row } : null);
        },
      ),
      findMany: jest.fn(
        (args: {
          where: {
            approvalRequestId: number;
            status: string;
            entry: { weeklyBatchId: number };
          };
        }) =>
          Promise.resolve(
            txns
              .filter(
                (row) =>
                  row.approvalRequestId === args.where.approvalRequestId &&
                  row.status === args.where.status &&
                  findEntry(row.entryId ?? 0)?.weeklyBatchId ===
                    args.where.entry.weeklyBatchId,
              )
              .map((row) => ({ ...row })),
          ),
      ),
      create: jest.fn((args: { data: Partial<TxnRow> }) => {
        if (txns.some((row) => row.sourceKey === args.data.sourceKey))
          return Promise.reject(new Error('Unique sourceKey'));
        const row = fundRow(nextTxnId++, {
          sourceId: null,
          approvalRequestId: null,
          transferId: null,
          entryId: null,
          ...args.data,
        });
        txns.push(row);
        return Promise.resolve({ ...row });
      }),
      update: jest.fn(
        (args: { where: { id: number }; data: Partial<TxnRow> }) => {
          const row = txns.find((item) => item.id === args.where.id)!;
          Object.assign(row, args.data);
          return Promise.resolve({ ...row });
        },
      ),
    },
    internalFundTransfer: {
      findUnique: jest.fn((args: { where: { id: number } }) => {
        const row = transfers.find((item) => item.id === args.where.id);
        return Promise.resolve(row ? { ...row } : null);
      }),
      update: jest.fn(
        (args: { where: { id: number }; data: Partial<TransferRow> }) => {
          const row = transfers.find((item) => item.id === args.where.id)!;
          Object.assign(row, args.data);
          return Promise.resolve({ ...row });
        },
      ),
    },
    internalFundDailyClosing: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn((args: { where: ClosingWhere }) =>
        Promise.resolve(
          closings
            .filter((row) => closingHit(row, args.where))
            .map((row) => ({ ...row })),
        ),
      ),
      updateMany: jest.fn(
        (args: { where: ClosingWhere; data: Partial<ClosingRow> }) => {
          const hit = closings.filter((row) => closingHit(row, args.where));
          hit.forEach((row) => Object.assign(row, args.data));
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
    ...(withAuditLog
      ? {
          auditLog: { createMany },
          user: {
            findMany: jest.fn(() =>
              Promise.resolve([
                { id: 3, name: 'Kế toán Hà', email: 'ha@example.test' },
              ]),
            ),
          },
        }
      : {}),
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    raw: tx,
    entries,
    batches,
    txns,
    transfers,
    closings,
    audit,
    createMany,
    batchDelete,
  };
}

const ledger = () => new InternalFundLedgerService(new FinanceAuditService());

describe('InternalFundLedgerService.detachFromBatch', () => {
  it('soft-cancels an emptied batch, restores the entry status and logs both rows in one write', async () => {
    const f = fakeTx({ entries: [entry(1)], batches: [batch()] });
    const actor = auditActor.user(
      { id: 3, name: 'Kế toán Hà' },
      'http',
      'op-1',
    );

    const result = await ledger().detachFromBatch(f.tx, f.entries[0], {
      actor,
      reason: 'Hủy phiếu: nhập nhầm',
    });

    expect(result).toEqual({
      batchId: 50,
      batchCode: 'AT-HN-2026-W41',
      batchCancelled: true,
      remainingTotal: 0,
    });
    expect(f.batchDelete).not.toHaveBeenCalled();
    expect(f.batches[0]).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 3,
      cancelReason: 'Hủy phiếu: nhập nhầm',
      cancelledEntryIds: [1],
    });
    expect(f.batches[0].cancelledAt).toBeInstanceOf(Date);
    // Đủ hai tick: phiếu về "Đã kiểm tra", không kẹt ở "Đã gom tuần".
    expect(f.entries[0]).toMatchObject({
      weeklyBatchId: null,
      status: 'MANAGER_APPROVED',
    });

    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.map((row) => row.actionCode)).toEqual([
      'FIN_ENTRY_BATCH_REMOVE',
      'FIN_BATCH_CANCEL',
    ]);
    expect(f.audit.every((row) => row.requestId === 'op-1')).toBe(true);
    const [remove, cancel] = f.audit;
    expect(remove).toMatchObject({
      entityType: 'internal_finance_entries',
      entityId: '1',
      entityCode: 'TCNB-HN-1',
      branchId: 6,
      userId: 3,
      userName: 'Kế toán Hà',
      message:
        'Bỏ phiếu TCNB-HN-1 khỏi Approval tuần AT-HN-2026-W41: Hủy phiếu: nhập nhầm',
    });
    expect(remove.changes).toEqual([
      expect.objectContaining({
        field: 'weeklyBatchId',
        from: 'AT-HN-2026-W41',
        to: '—',
      }),
      expect.objectContaining({
        field: 'status',
        from: 'Đã gom tuần',
        to: 'Đã kiểm tra',
      }),
    ]);
    expect(cancel).toMatchObject({
      actionType: 'DELETE',
      entityType: 'internal_finance_weekly_batches',
      entityId: '50',
      entityCode: 'AT-HN-2026-W41',
      message: 'Hủy Approval tuần AT-HN-2026-W41: Hủy phiếu: nhập nhầm',
      metadata: expect.objectContaining({
        autoCancelled: true,
        cancelledEntryIds: [1],
        statusBefore: 'READY',
      }) as unknown,
    });
  });

  it('recomputes the total when entries remain and sends a half-ticked entry back to checking', async () => {
    const f = fakeTx({
      entries: [
        entry(1, { accountantReviewedAt: null }),
        entry(2, { amount: new Prisma.Decimal(40000) }),
      ],
      batches: [batch({ totalAmount: new Prisma.Decimal(140000) })],
    });
    const result = await ledger().detachFromBatch(f.tx, f.entries[0], {
      actor: auditActor.user({ id: 3, name: 'Hà' }),
    });
    expect(result).toEqual({
      batchId: 50,
      batchCode: 'AT-HN-2026-W41',
      batchCancelled: false,
      remainingTotal: 40000,
    });
    expect(f.batches[0].status).toBe('READY');
    expect(f.batches[0].totalAmount.toString()).toBe('40000');
    expect(f.entries[0].status).toBe('PENDING_ACCOUNTANT');
    expect(f.audit.map((row) => row.actionCode)).toEqual([
      'FIN_ENTRY_BATCH_REMOVE',
    ]);
    expect(f.audit[0].message).toBe(
      'Bỏ phiếu TCNB-HN-1 khỏi Approval tuần AT-HN-2026-W41',
    );
  });

  it('keeps the status for callers that set it right after, and cancels as system without actor', async () => {
    const f = fakeTx({ entries: [entry(1)], batches: [batch()] });
    await ledger().detachFromBatch(f.tx, f.entries[0], { keepStatus: true });
    expect(f.entries[0].status).toBe('READY_FOR_WEEKLY_APPROVAL');
    expect(f.batches[0]).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: null,
      cancelReason: EMPTY_BATCH_CANCEL_REASON,
    });
    expect(f.audit[0].metadata).toMatchObject({ actorKind: 'SYSTEM' });
    expect(f.audit[0].changes).toHaveLength(1);
  });

  it('returns null for an entry outside any batch', async () => {
    const f = fakeTx({ entries: [entry(1, { weeklyBatchId: null })] });
    expect(await ledger().detachFromBatch(f.tx, f.entries[0])).toBeNull();
    expect(f.raw.internalFinanceEntry.update).not.toHaveBeenCalled();
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it('still soft-cancels without FinanceAuditService (scripts, bare specs)', async () => {
    const f = fakeTx({ entries: [entry(1)], batches: [batch()] }, false);
    const result = await new InternalFundLedgerService().detachFromBatch(
      f.tx,
      f.entries[0],
    );
    expect(result?.batchCancelled).toBe(true);
    expect(f.batches[0].status).toBe('CANCELLED');
    expect(f.entries[0].status).toBe('MANAGER_APPROVED');
    expect(f.raw.internalFinanceWeeklyBatch.findUnique).not.toHaveBeenCalled();
  });
});

describe('InternalFundLedgerService fund history', () => {
  it('logs a created system fund row and the closings it reopens, but nothing on an idempotent re-call', async () => {
    const f = fakeTx({
      closings: [
        {
          id: 1,
          branchId: 6,
          closingDate: new Date('2026-10-05T00:00:00Z'),
          closedAt: DAY,
          reconciliationStatus: 'MATCHED',
        },
        {
          id: 2,
          branchId: 6,
          closingDate: new Date('2026-10-06T00:00:00Z'),
          closedAt: DAY,
          reconciliationStatus: 'PENDING',
        },
      ],
    });
    const input = {
      branchId: 6,
      transactionType: 'RECEIPT' as const,
      codeKind: 'THU',
      amount: 125000,
      occurredAt: DAY,
      description: 'Thu tiền mặt kho',
      sourceType: 'WAREHOUSE_CASH_RECEIPT',
      sourceKey: 'WAREHOUSE_RECEIPT:9',
      entryId: 9,
      userId: 3,
    };
    const row = await ledger().postSystemTransaction(f.tx, input);
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.map((log) => log.actionCode)).toEqual([
      'FIN_FUND_TXN_POST',
      'FIN_FUND_CLOSING_INVALIDATE',
    ]);
    expect(f.audit[0]).toMatchObject({
      actionType: 'POST',
      entityType: 'internal_fund_transactions',
      entityId: String(row.id),
      entityCode: row.code,
      message: `Ghi quỹ thu ${row.code} 125.000 đ – tiền mặt kho`,
      userId: 3,
    });
    // Chỉ ngày đang MATCHED chuyển sang cần đối soát; ngày PENDING bỏ qua.
    expect(f.audit[1]).toMatchObject({
      entityId: '1',
      message: `Chốt sổ Kho HN ngày 05/10/2026 cần đối soát lại (ghi dòng quỹ ${row.code})`,
      snapshot: {
        lines: [
          { label: 'Quỹ', value: 'Kho HN' },
          { label: 'Ngày chốt', value: '05/10/2026' },
        ],
      },
    });
    expect(f.audit[0].requestId).toBe(f.audit[1].requestId);

    await ledger().postSystemTransaction(f.tx, input);
    expect(f.createMany).toHaveBeenCalledTimes(1);
  });

  it('logs a fund cancel with the entry link and source key before release', async () => {
    const f = fakeTx({
      txns: [fundRow(5, { entryId: 1, sourceKey: 'EXPENSE:1' })],
    });
    await ledger().releaseCancelled(
      f.tx,
      f.txns[0],
      3,
      'Kế toán bỏ duyệt phiếu chi',
    );
    expect(f.txns[0]).toMatchObject({
      status: 'CANCELLED',
      entryId: null,
      sourceKey: 'EXPENSE:1:CANCELLED:5',
    });
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({
      actionCode: 'FIN_FUND_TXN_CANCEL',
      actionType: 'DELETE',
      entityCode: 'QF-CHI-5',
      message: 'Hủy dòng quỹ QF-CHI-5 100.000 đ: Kế toán bỏ duyệt phiếu chi',
      metadata: expect.objectContaining({
        entryIdBefore: 1,
        sourceKeyBefore: 'EXPENSE:1',
      }) as unknown,
    });
    const snapshot = f.audit[0].snapshot as { before: { entryId: number } };
    expect(snapshot.before.entryId).toBe(1);
  });

  it('logs both transfer legs and the transfer status as Lark on behalf of the requester', async () => {
    const f = fakeTx({
      transfers: [
        {
          id: 4,
          code: 'CQ-4',
          sourceBranchId: 6,
          destinationBranchId: 1,
          amount: new Prisma.Decimal(300000),
          occurredAt: fundDayStart('2026-10-05'),
          description: 'Chuyển quỹ',
          status: 'PENDING',
          approvalRequestId: null,
          createdBy: 7,
        },
      ],
    });
    await ledger().applyApproval(f.tx, {
      id: 70,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
      createdById: 3,
    });
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.map((log) => log.actionCode)).toEqual([
      'FIN_FUND_TXN_POST',
      'FIN_FUND_TXN_POST',
      'FIN_FUND_TRANSFER_STATUS',
    ]);
    expect(f.audit[2]).toMatchObject({
      entityCode: 'CQ-4',
      message: 'Chuyển quỹ CQ-4: Đã ghi quỹ',
      userName: 'Hệ thống (Lark Approval)',
      metadata: expect.objectContaining({
        actorKind: 'LARK',
        onBehalfOfUserId: 3,
      }) as unknown,
    });

    // Lark từ chối một đơn khác: chỉ ghi khi trạng thái thật sự đổi.
    const g = fakeTx({
      transfers: [{ ...f.transfers[0], status: 'PENDING' }],
    });
    const rejected = {
      id: 71,
      status: 'REJECTED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
      createdById: 3,
    };
    await ledger().applyApproval(g.tx, rejected);
    await ledger().applyApproval(g.tx, rejected);
    expect(g.audit.map((log) => log.message)).toEqual([
      'Chuyển quỹ CQ-4: Từ chối',
    ]);
  });

  it('logs fund rows and Đã chi per entry when a weekly approval is approved, then reverts them', async () => {
    const f = fakeTx({
      entries: [
        entry(1, { status: 'APPROVED' }),
        entry(2, {
          status: 'APPROVED',
          sourceSnapshot: { larkLedgerRecorded: true },
        }),
      ],
      batches: [batch({ status: 'APPROVED', approvalRequestId: 80 })],
    });
    const service = ledger();
    expect(await service.issueApprovedBatch(f.tx, 50, 80, 7)).toBe(2);
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.map((log) => log.actionCode)).toEqual([
      'FIN_FUND_TXN_POST',
      'FIN_ENTRY_CASH_ISSUE',
      'FIN_ENTRY_CASH_ISSUE',
    ]);
    expect(f.audit[1].message).toBe(
      'Đánh dấu Đã chi TCNB-HN-1: Approval tuần đã duyệt',
    );
    expect(f.audit[2].message).toBe(
      'Đánh dấu Đã chi TCNB-HN-2: Đã trừ quỹ trên Lark',
    );
    expect(
      f.audit.every((log) => log.userName === 'Hệ thống (Lark Approval)'),
    ).toBe(true);

    f.audit.length = 0;
    expect(await service.revertApprovedBatch(f.tx, 50, 80, 7)).toBe(1);
    expect(f.audit.map((log) => log.actionCode)).toEqual([
      'FIN_FUND_TXN_CANCEL',
      'FIN_ENTRY_CASH_ISSUE_REVERT',
    ]);
    expect(f.audit[1]).toMatchObject({
      entityCode: 'TCNB-HN-1',
      message: 'Bỏ Đã chi TCNB-HN-1: Approval tuần bị thu hồi trên Lark',
    });
    expect(f.entries[0].cashIssued).toBe(false);
  });

  it('issues an expense outside the weekly approval: leaves the batch, fixes the status and logs one operation', async () => {
    const f = fakeTx({ entries: [entry(1)], batches: [batch()] });
    const actor = auditActor.user({ id: 3, name: 'Hà' }, 'http', 'op-9');
    const row = await ledger().issueExpense(
      f.tx,
      { id: 1, branchId: 6 },
      3,
      false,
      'Chi gấp',
      actor,
    );
    expect(row).toMatchObject({ sourceKey: 'EXPENSE:1', entryId: 1 });
    expect(f.entries[0]).toMatchObject({
      weeklyBatchId: null,
      status: 'MANAGER_APPROVED',
      cashIssued: true,
      cashIssuedReason: 'Chi gấp',
    });
    expect(f.batches[0]).toMatchObject({ status: 'CANCELLED', cancelledBy: 3 });
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.audit.map((log) => log.actionCode)).toEqual([
      'FIN_ENTRY_BATCH_REMOVE',
      'FIN_BATCH_CANCEL',
      'FIN_FUND_TXN_POST',
    ]);
    expect(f.audit.every((log) => log.requestId === 'op-9')).toBe(true);
    expect(f.audit[0].message).toBe(
      'Bỏ phiếu TCNB-HN-1 khỏi Approval tuần AT-HN-2026-W41: Đã chi ngoài Approval tuần: Chi gấp',
    );
  });

  it('cancels a reverted Lark payment voucher as the Lark system', async () => {
    const f = fakeTx({
      txns: [
        fundRow(6, {
          sourceKey: 'PAYMENT_VOUCHER:90',
          sourceType: 'LARK_PAYMENT_VOUCHER',
        }),
      ],
    });
    await ledger().applyPaymentVoucher(f.tx, {
      id: 90,
      status: 'REVERTED',
      branchId: 6,
      createdById: 3,
      completedAt: null,
      formSnapshot: null,
    });
    expect(f.txns[0]).toMatchObject({ status: 'CANCELLED', cancelledBy: 3 });
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({
      actionCode: 'FIN_FUND_TXN_CANCEL',
      message:
        'Hủy dòng quỹ QF-CHI-6 100.000 đ: Đơn PHIẾU CHI bị thu hồi trên Lark',
      userName: 'Hệ thống (Lark Approval)',
    });
  });

  it('skips history entirely when constructed without FinanceAuditService', async () => {
    const f = fakeTx({ txns: [fundRow(5, { entryId: 1 })] }, false);
    await new InternalFundLedgerService().releaseCancelled(
      f.tx,
      f.txns[0],
      3,
      'x',
    );
    expect(f.txns[0].status).toBe('CANCELLED');
    // Không đọc thêm chốt sổ khi không ghi lịch sử (giữ hành vi cũ).
    expect(f.raw.internalFundDailyClosing.findMany).not.toHaveBeenCalled();
  });
});
