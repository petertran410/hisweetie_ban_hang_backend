import { Prisma } from '@prisma/client';
import {
  FinanceAuditService,
  auditActor,
  type FinanceAuditEntry,
} from '../finance-audit';
import { cancelWeeklyBatchInTx } from './weekly-batch-cancel';

describe('cancelWeeklyBatchInTx', () => {
  const asTx = (tx: unknown) => tx as Prisma.TransactionClient;
  type WriteSpy = jest.SpyInstance<
    Promise<void>,
    Parameters<FinanceAuditService['write']>
  >;
  const rowsOf = (write: WriteSpy, call = 0) =>
    write.mock.calls[call][1] as FinanceAuditEntry[];
  const makeTx = () => ({
    internalFinanceEntry: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 11,
          code: 'TCNB-11',
          branchId: 6,
          status: 'IN_WEEKLY_APPROVAL',
          cashIssued: false,
          managerReviewedAt: new Date(),
          accountantReviewedAt: new Date(),
        },
        {
          id: 12,
          code: 'TCNB-12',
          branchId: 6,
          status: 'IN_WEEKLY_APPROVAL',
          cashIssued: false,
          managerReviewedAt: new Date(),
          accountantReviewedAt: null,
        },
        {
          id: 13,
          code: 'TCNB-13',
          branchId: 6,
          status: 'APPROVED',
          cashIssued: true,
          managerReviewedAt: new Date(),
          accountantReviewedAt: new Date(),
        },
      ]),
      updateMany: jest.fn(),
    },
    internalFinanceWeeklyBatch: {
      findUnique: jest.fn().mockResolvedValue({
        code: 'TUAN-4',
        branchId: 6,
        status: 'IN_APPROVAL',
        totalAmount: 300000,
        cancelReason: null,
      }),
      update: jest.fn().mockResolvedValue({
        id: 4,
        code: 'TUAN-4',
        branchId: 6,
      }),
    },
  });

  it('keeps the old behaviour without an audit service', async () => {
    const tx = makeTx();
    expect(
      await cancelWeeklyBatchInTx(asTx(tx), 4, {
        cancelledBy: null,
        reason: 'Lark Approval từ chối',
      }),
    ).toBe(3);
    expect(tx.internalFinanceWeeklyBatch.findUnique).not.toHaveBeenCalled();
    const [[update]] = tx.internalFinanceWeeklyBatch.update.mock.calls as [
      [{ where: unknown; data: Record<string, unknown> }],
    ];
    expect(update).toMatchObject({
      where: { id: 4 },
      data: {
        status: 'CANCELLED',
        cancelledBy: null,
        cancelReason: 'Lark Approval từ chối',
        cancelledEntryIds: [11, 12, 13],
      },
    });
    expect(update.data.cancelledAt).toBeInstanceOf(Date);
  });

  it('logs the batch cancel and every released entry in the same transaction', async () => {
    const tx = makeTx();
    const audit = new FinanceAuditService();
    const write = jest.spyOn(audit, 'write').mockResolvedValue(undefined);
    await cancelWeeklyBatchInTx(
      asTx(tx),
      4,
      { cancelledBy: null, reason: 'Lark Approval từ chối: sai số' },
      audit,
    );
    expect(write.mock.calls[0][0]).toBe(tx);
    const rows = rowsOf(write);
    expect(rows.map((row) => [row.action, row.entityId])).toEqual([
      ['FIN_BATCH_CANCEL', 4],
      ['FIN_ENTRY_BATCH_REMOVE', 11],
      ['FIN_ENTRY_BATCH_REMOVE', 12],
      ['FIN_ENTRY_BATCH_REMOVE', 13],
    ]);
    // Hệ thống hủy (Lark từ chối): actor Lark, không phải user.
    expect(rows[0].actor).toMatchObject({
      kind: 'LARK',
      trigger: 'lark-approval',
    });
    expect(rows[0]).toMatchObject({
      entityCode: 'TUAN-4',
      branchId: 6,
      params: {
        batchCode: 'TUAN-4',
        reasonSuffix: ': Lark Approval từ chối: sai số',
      },
      metadata: { cancelledEntryIds: [11, 12, 13], released: 3 },
    });
    expect(rows[0].changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'status', to: 'Đã hủy' }),
      ]),
    );
    expect(rows[1].metadata).toMatchObject({
      batchId: 4,
      statusBefore: 'IN_WEEKLY_APPROVAL',
    });
    // Đủ hai tick → Đã kiểm tra; thiếu tick → Chờ kiểm tra; Đã chi giữ nguyên.
    const statusTo = (row: FinanceAuditEntry) =>
      row.changes?.find((change) => change.field === 'status')?.to;
    expect(statusTo(rows[1])).toBe('Đã kiểm tra');
    expect(statusTo(rows[2])).toBe('Chờ kiểm tra');
    expect(statusTo(rows[3])).toBeUndefined();
    expect(new Set(rows.map((row) => row.actor.opId)).size).toBe(1);
  });

  it('uses the given actor, else the user who cancelled', async () => {
    const audit = new FinanceAuditService();
    const write = jest.spyOn(audit, 'write').mockResolvedValue(undefined);
    const actor = auditActor.user({ id: 7, name: 'Quản lý' });
    await cancelWeeklyBatchInTx(
      asTx(makeTx()),
      4,
      { cancelledBy: 7, reason: 'Trùng tuần', actor },
      audit,
    );
    expect(rowsOf(write)[0].actor).toBe(actor);

    await cancelWeeklyBatchInTx(
      asTx(makeTx()),
      4,
      { cancelledBy: 9, reason: 'Trùng tuần' },
      audit,
    );
    expect(rowsOf(write, 1)[0].actor).toMatchObject({
      kind: 'USER',
      userId: 9,
    });
  });
});
