import { Prisma } from '@prisma/client';
import { FinanceAccessService } from '../auth/finance-access.service';
import { InternalFundService } from './internal-fund.service';
import {
  InternalFundLedgerService,
  fundDateKey,
  fundDayStart,
} from './internal-fund-ledger.service';
import { buildFundReceiptForm } from './internal-fund-template.registry';
import { RECEIPT_FIELD_IDS } from '../approval-lifecycle/approval-lifecycle.constants';
import { FinanceAuditService } from '../finance-audit';

// `auditLedger`: sổ quỹ cũng ghi lịch sử (kiểm tra dùng chung opId).
function fixture(options: { auditLedger?: boolean } = {}) {
  const transactions: any[] = [];
  const transfer: any = {
    id: 4,
    sourceBranchId: 6,
    destinationBranchId: 1,
    amount: new Prisma.Decimal(100),
    occurredAt: fundDayStart('2026-10-05'),
    status: 'PENDING',
    createdBy: 7,
  };
  const entry: any = {
    id: 12,
    branchId: 6,
    direction: 'EXPENSE',
    status: 'APPROVED',
    amount: new Prisma.Decimal(125000),
    occurredAt: fundDayStart('2026-10-05'),
    cashFlowId: null,
    cashIssued: false,
    weeklyBatch: {
      status: 'APPROVED',
      approvalRequestId: 55,
      approvalRequest: { status: 'APPROVED' },
    },
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        larkUserId: 'ou_user',
        branchId: null,
        // User của test được truy cập cả 4 chi nhánh tài chính.
        userBranches: [6, 1, 4, 7].map((branchId) => ({ branchId })),
        userRoles: [],
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 7, name: 'Kế toán A', email: null }]),
    },
    auditLog: { createMany: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    internalFundTransaction: {
      groupBy: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(
        async ({ where }: any) =>
          transactions.find(
            (row) => row.sourceKey === where.sourceKey || row.id === where.id,
          ) || null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: transactions.length + 1, ...data };
        transactions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          transactions.find((row) => row.id === where.id),
          data,
        ),
      ),
      updateMany: jest.fn(async ({ data }: any) => {
        transactions.forEach((row) => Object.assign(row, data));
        return { count: transactions.length };
      }),
    },
    internalFinanceEntry: {
      findUnique: jest.fn(async () => entry),
      update: jest.fn(async ({ data }: any) => Object.assign(entry, data)),
    },
    internalFundTransfer: {
      findUnique: jest.fn(async () => transfer),
      update: jest.fn(async ({ data }: any) => Object.assign(transfer, data)),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(async ({ create }: any) =>
        Object.assign(transfer, create),
      ),
    },
    internalFundDailyClosing: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      update: jest.fn(async ({ data }: any) => data),
      upsert: jest.fn(async ({ create }: any) => create),
    },
    approvalRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    cashFlow: {
      create: jest.fn(() => {
        throw new Error('Forbidden CashFlow write');
      }),
    },
  };
  const actions = [
    'view',
    'create_receipt',
    'transfer',
    'submit_approval',
    'mark_issued',
    'mark_received',
    'close',
    'cancel',
    'adjust',
  ];
  const auth: any = {
    getPermissionsForBranch: jest.fn(async (_: number, id: number) =>
      actions.map((action) => `internal_fund:${action}`),
    ),
  };
  const approval: any = {
    create: jest.fn().mockResolvedValue({ id: 10, status: 'PENDING' }),
  };
  const audit = new FinanceAuditService();
  const ledger = options.auditLedger
    ? new InternalFundLedgerService(audit)
    : new InternalFundLedgerService();
  const service = new InternalFundService(
    prisma,
    new FinanceAccessService(prisma, auth),
    approval,
    ledger,
    audit,
  );
  // Mọi dòng audit_logs đã ghi (theo thứ tự).
  const logs = (): any[] =>
    prisma.auditLog.createMany.mock.calls.flatMap(([arg]: any) => arg.data);
  return {
    service,
    logs,
    prisma,
    auth,
    approval,
    ledger,
    transactions,
    entry,
    transfer,
  };
}

describe('Internal fund ledger', () => {
  it('uses a ledger transaction ID, not an expense-entry ID, for post acknowledgement', async () => {
    const f = fixture();
    f.transactions.push({
      id: 3,
      branchId: 6,
      status: 'POSTED',
      transactionType: 'RECEIPT',
    });
    const result = await f.service.postTransaction(3, 7);
    expect(result.id).toBe(3);
    expect(f.prisma.internalFinanceEntry.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.internalFundTransaction.create).not.toHaveBeenCalled();
  });
  it('uses Vietnam midnight rather than UTC midnight', () => {
    expect(fundDayStart('2026-10-05').toISOString()).toBe(
      '2026-10-04T17:00:00.000Z',
    );
    expect(fundDateKey('2026-10-04T18:00:00.000Z')).toBe('2026-10-05');
  });

  it.each(['DELIVERY_FEE', 'FUEL', 'VEHICLE_CARE', 'OTHER_EXPENSE'])(
    'posts %s once without CashFlow',
    async (category) => {
      const f = fixture();
      f.entry.category = category;
      await f.service.postExpenseEntry(12, 7, true);
      await f.service.postExpenseEntry(12, 7, true);
      expect(f.prisma.internalFundTransaction.create).toHaveBeenCalledTimes(1);
      expect(f.transactions[0]).toMatchObject({
        sourceKey: 'EXPENSE:12',
        transactionType: 'EXPENSE',
        branchId: 6,
      });
      // Phiếu trong Approval tuần đã duyệt ghi quỹ theo ngày chi; phiếu 05/10
      // trước mốc quỹ kho lên POS (14/10) nên ghi vào đầu ngày mốc.
      expect(f.transactions[0].occurredAt).toEqual(fundDayStart('2026-10-14'));
      expect(f.entry.cashIssued).toBe(true);
      expect(f.prisma.cashFlow.create).not.toHaveBeenCalled();
      expect(f.prisma.$executeRaw).toHaveBeenCalled();
    },
  );

  it.each(['PENDING', 'REJECTED', 'CANCELLED'])(
    'does not issue %s expenses',
    async (status) => {
      const f = fixture();
      f.entry.status = status;
      await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
        'Approval tuần',
      );
      expect(f.transactions).toHaveLength(0);
    },
  );

  it('refuses Đã chi for Kho HN fuel paid from the fuel advance', async () => {
    const f = fixture();
    f.entry.category = 'FUEL';
    f.entry.occurredAt = new Date('2026-11-20T03:00:00.000Z');
    await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
      'trừ vào tiền ứng xăng',
    );
    expect(f.transactions).toHaveLength(0);
  });

  it('ticks Đã chi without a second fund posting when Lark already deducted it', async () => {
    const f = fixture();
    f.entry.sourceSnapshot = { larkLedgerRecorded: true };
    await f.service.postExpenseEntry(12, 7, true);
    expect(f.prisma.internalFundTransaction.create).not.toHaveBeenCalled();
    expect(f.entry).toMatchObject({
      cashIssued: true,
      cashIssuedReason: 'Đã trừ quỹ trên Lark',
    });
  });

  it('issues an expense outside weekly approval only with a reason', async () => {
    const f = fixture();
    f.entry.status = 'PENDING_ACCOUNTANT';
    f.entry.code = 'TCNB-CHI-1';
    f.entry.weeklyBatch = null;
    await expect(f.service.postExpenseEntry(12, 7, true, '  ')).rejects.toThrow(
      'cần nhập lý do',
    );
    await f.service.postExpenseEntry(12, 7, true, 'Chi gấp cho xe');
    expect(f.transactions[0]).toMatchObject({
      sourceKey: 'EXPENSE:12',
      approvalRequestId: undefined,
      description: 'TCNB-CHI-1 (Lý do: Chi gấp cho xe)',
    });
    expect(f.entry).toMatchObject({
      cashIssued: true,
      cashIssuedReason: 'Chi gấp cho xe',
    });
  });

  it('issues an office manual expense without a reason (no weekly approval)', async () => {
    const f = fixture();
    f.entry.branchId = 4;
    f.entry.status = 'PENDING_ACCOUNTANT';
    f.entry.code = 'TCNB-CHI-2';
    f.entry.weeklyBatch = null;
    await f.service.postExpenseEntry(12, 7, true);
    expect(f.transactions[0]).toMatchObject({
      sourceKey: 'EXPENSE:12',
      branchId: 4,
      description: 'TCNB-CHI-2',
    });
    expect(f.entry.cashIssued).toBe(true);
  });

  it('pays out a VPSG manual expense only through the accountant review', async () => {
    const f = fixture();
    Object.assign(f.entry, {
      branchId: 7,
      status: 'PENDING_ACCOUNTANT',
      sourceType: 'MANUAL_EXPENSE',
      code: 'TCNB-CHI-VPSG-1',
      weeklyBatch: null,
    });
    // Không đi đường Đã chi thường, kể cả có lý do.
    await expect(
      f.service.postExpenseEntry(12, 7, true, 'Chi gấp'),
    ).rejects.toThrow('Kế toán duyệt');
    expect(f.transactions).toHaveLength(0);

    await f.ledger.issueReviewedExpense(f.prisma, f.entry, 8);
    await f.ledger.issueReviewedExpense(f.prisma, f.entry, 8);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      sourceKey: 'EXPENSE:12',
      branchId: 7,
      transactionType: 'EXPENSE',
      description: 'TCNB-CHI-VPSG-1',
    });
    expect(f.entry).toMatchObject({ cashIssued: true, cashIssuedBy: 8 });

    await f.ledger.revertReviewedExpense(f.prisma, f.entry, 8);
    expect(f.transactions[0]).toMatchObject({
      status: 'CANCELLED',
      sourceKey: 'EXPENSE:12:CANCELLED:1',
    });
    // Duyệt lại sau khi bỏ duyệt: ghi một dòng quỹ mới.
    await f.ledger.issueReviewedExpense(f.prisma, f.entry, 8);
    expect(f.transactions).toHaveLength(2);
    expect(f.transactions[1].status).toBe('POSTED');
  });

  it('blocks the VPSG review on a closed day without adjust', async () => {
    const f = fixture();
    Object.assign(f.entry, {
      branchId: 7,
      sourceType: 'MANUAL_EXPENSE',
      weeklyBatch: null,
    });
    f.prisma.internalFundDailyClosing.findFirst.mockResolvedValue({
      id: 8,
      closedAt: new Date(),
    });
    await expect(
      f.ledger.issueReviewedExpense(f.prisma, f.entry, 8),
    ).rejects.toThrow('chốt sổ');
    await f.ledger.issueReviewedExpense(f.prisma, f.entry, 8, true);
    expect(f.transactions).toHaveLength(1);
  });

  it('pulls an entry out of a not-yet-sent batch on manual issue and refuses a batch in approval', async () => {
    const f = fixture();
    f.entry.status = 'READY_FOR_WEEKLY_APPROVAL';
    f.entry.weeklyBatchId = 3;
    f.entry.weeklyBatch = { id: 3, status: 'IN_APPROVAL' };
    await expect(
      f.service.postExpenseEntry(12, 7, true, 'Chi gấp'),
    ).rejects.toThrow('đang chờ duyệt');
    f.entry.weeklyBatch = { id: 3, status: 'READY' };
    f.prisma.internalFinanceEntry.aggregate = jest.fn().mockResolvedValue({
      _sum: { amount: new Prisma.Decimal(50000) },
      _count: { _all: 1 },
    });
    f.prisma.internalFinanceWeeklyBatch = {
      update: jest.fn(),
      delete: jest.fn(),
    };
    await f.service.postExpenseEntry(12, 7, true, 'Chi gấp');
    expect(f.entry.weeklyBatchId).toBeNull();
    expect(f.prisma.internalFinanceWeeklyBatch.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { totalAmount: new Prisma.Decimal(50000) },
    });
    expect(f.transactions).toHaveLength(1);
  });

  it('posts an approved batch on each voucher date, not the approval date', async () => {
    const f = fixture();
    const late = { ...f.entry, id: 13, occurredAt: fundDayStart('2026-11-10') };
    f.prisma.internalFinanceEntry.findMany = jest.fn(async () => [late]);
    f.prisma.approvalRequest.findUnique.mockResolvedValue({
      completedAt: new Date('2026-11-16T03:00:00Z'),
    });
    await f.ledger.issueApprovedBatch(f.prisma, 3, 55, 9);
    expect(f.transactions[0]).toMatchObject({
      entryId: 13,
      occurredAt: fundDayStart('2026-11-10'),
    });
    expect(f.prisma.internalFundDailyClosing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 6,
          closingDate: { gte: new Date('2026-11-10T00:00:00Z') },
        }),
      }),
    );
  });

  it('posts a manual expense outside weekly approval at tick time', async () => {
    const f = fixture();
    f.entry.weeklyBatch = null;
    f.entry.branchId = 4;
    f.entry.occurredAt = fundDayStart('2026-11-10');
    await f.service.postExpenseEntry(12, 7, true, 'Chi gấp');
    expect(f.transactions[0].occurredAt.getTime()).toBeGreaterThan(
      fundDayStart('2026-11-11').getTime(),
    );
  });

  it('auto-issues every entry of an approved batch once and reverts them', async () => {
    const f = fixture();
    f.entry.code = 'TCNB-CHI-1';
    f.prisma.internalFinanceEntry.findMany = jest.fn(async () =>
      f.entry.cashIssued ? [] : [f.entry],
    );
    expect(await f.ledger.issueApprovedBatch(f.prisma, 3, 55, 9)).toBe(1);
    expect(await f.ledger.issueApprovedBatch(f.prisma, 3, 55, 9)).toBe(0);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      approvalRequestId: 55,
      createdBy: 9,
      entryId: 12,
    });
    expect(f.entry).toMatchObject({ cashIssued: true, cashIssuedBy: 9 });

    f.prisma.internalFundTransaction.findMany.mockResolvedValue([
      { ...f.transactions[0] },
    ]);
    await f.ledger.revertApprovedBatch(f.prisma, 3, 55, 9);
    expect(f.transactions[0]).toMatchObject({
      status: 'CANCELLED',
      entryId: null,
    });
    expect(f.entry.cashIssued).toBe(false);
  });

  it('does not re-post legacy cash issued or CashFlow-linked expenses', async () => {
    const f = fixture();
    f.entry.cashFlowId = 22;
    await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
      'lịch sử',
    );
    expect(f.prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('returns a cancelled expense to not-issued so it can be issued again', async () => {
    const f = fixture();
    const first = await f.service.postExpenseEntry(12, 7, true);
    expect(f.entry.cashIssued).toBe(true);
    await f.service.cancelTransaction(
      f.transactions[0].id,
      { reason: 'Ghi nhầm' },
      7,
    );
    expect(f.entry).toMatchObject({ cashIssued: false, cashIssuedAt: null });
    expect(f.transactions[0]).toMatchObject({
      status: 'CANCELLED',
      entryId: null,
      sourceKey: 'EXPENSE:12:CANCELLED:1',
    });
    await f.service.postExpenseEntry(12, 7, true);
    expect(f.transactions).toHaveLength(2);
    expect(f.transactions[1]).toMatchObject({
      sourceKey: 'EXPENSE:12',
      status: 'POSTED',
      entryId: 12,
    });
    expect(first).toBeDefined();
  });

  it('keeps the key of a cancelled Lark-imported expense so re-import cannot repost it', async () => {
    const f = fixture();
    f.entry.sourceType = 'LARK_IMPORT';
    await f.service.postExpenseEntry(12, 7, true);
    // Giao dịch do lần nhập ghi (không phải thao tác trên POS).
    f.entry.posManagedAt = null;
    await f.service.cancelTransaction(1, { reason: 'Sai' }, 7);
    expect(f.transactions[0]).toMatchObject({
      status: 'CANCELLED',
      sourceKey: 'EXPENSE:12',
    });
    expect(f.entry.cashIssued).toBe(true);
  });

  it('cancels the Tài chính nội bộ row of a Lark Approval order with its fund row', async () => {
    const f = fixture();
    await f.service.postExpenseEntry(12, 7, true);
    f.entry.sourceType = 'LARK_APPROVAL';
    f.entry.status = 'POSTED';
    await f.service.cancelTransaction(1, { reason: ' Ghi nhầm quỹ ' }, 7);
    expect(f.entry).toMatchObject({
      status: 'CANCELLED',
      cashIssued: false,
      cancelReason: 'Hủy giao dịch quỹ: Ghi nhầm quỹ',
      cancelledBy: 7,
    });
    expect(f.transactions[0]).toMatchObject({
      status: 'CANCELLED',
      entryId: null,
    });
  });

  it('refuses to cancel warehouse-cash rows from the fund screen', async () => {
    const f = fixture();
    f.transactions.push({
      id: 1,
      branchId: 6,
      status: 'POSTED',
      sourceType: 'WAREHOUSE_CASH_RECEIPT',
      sourceKey: 'a',
    });
    await expect(
      f.service.cancelTransaction(1, { reason: 'x' }, 7),
    ).rejects.toThrow('Tiền mặt kho');
  });

  it('posts an approved Lark payment voucher once and cancels it when reverted', async () => {
    const f = fixture();
    const request = {
      id: 50,
      status: 'APPROVED',
      branchId: 6,
      createdById: 7,
      completedAt: new Date('2026-10-05T03:00:00Z'),
      formSnapshot: { metadata: { amount: 9000000, description: 'Mua bìa' } },
    };
    await f.ledger.applyPaymentVoucher(f.prisma, request);
    await f.ledger.applyPaymentVoucher(f.prisma, request);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'EXPENSE',
      sourceType: 'LARK_PAYMENT_VOUCHER',
      sourceKey: 'PAYMENT_VOUCHER:50',
      branchId: 6,
      approvalRequestId: 50,
    });
    await f.ledger.applyPaymentVoucher(f.prisma, {
      ...request,
      status: 'REVERTED',
    });
    expect(f.transactions[0].status).toBe('CANCELLED');
  });

  it('posts an approved cash salary advance under its own key and cancels it when reverted', async () => {
    const f = fixture();
    const request = {
      id: 60,
      status: 'APPROVED',
      branchId: 1,
      createdById: 7,
      completedAt: new Date('2026-11-05T03:00:00Z'),
      formSnapshot: {
        metadata: {
          amount: 3000000,
          description: 'Tạm ứng lương - Bùi Tấn Thuận',
        },
      },
    };
    await f.ledger.applySalaryAdvance(f.prisma, request);
    await f.ledger.applySalaryAdvance(f.prisma, request);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'EXPENSE',
      sourceType: 'LARK_SALARY_ADVANCE',
      sourceKey: 'SALARY_ADVANCE:60',
      branchId: 1,
      description: 'Tạm ứng lương - Bùi Tấn Thuận',
    });
    await f.ledger.applySalaryAdvance(f.prisma, {
      ...request,
      status: 'REVERTED',
    });
    expect(f.transactions[0].status).toBe('CANCELLED');
  });

  it('writes a receipt automatically and replay is idempotent even after cancellation', async () => {
    const f = fixture();
    const request = {
      id: 10,
      branchId: 6,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      createdById: 7,
      formSnapshot: {
        form: [
          { id: RECEIPT_FIELD_IDS.amount, value: 100 },
          { id: RECEIPT_FIELD_IDS.date, value: '2026-10-05' },
          { id: RECEIPT_FIELD_IDS.description, value: 'Thu khác' },
        ],
      },
    };
    await f.ledger.applyApproval(f.prisma, request);
    f.transactions[0].status = 'CANCELLED';
    await f.ledger.applyApproval(f.prisma, request);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'RECEIPT',
      status: 'CANCELLED',
    });
    expect(f.prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('posts a Lark-created cash receipt on the form date (Vietnam day)', async () => {
    const f = fixture();
    const request = {
      id: 61,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      branchId: 1,
      createdById: 9,
      // Form do Lark trả về: ngày dạng ISO, lựa chọn là chữ kèm option.key.
      formSnapshot: {
        version: 'lark',
        form: [
          { id: RECEIPT_FIELD_IDS.amount, type: 'amount', value: 1500000 },
          {
            id: RECEIPT_FIELD_IDS.date,
            type: 'date',
            value: '2026-10-08T17:00:00Z',
          },
          {
            id: RECEIPT_FIELD_IDS.description,
            type: 'textarea',
            value: 'Thu khác',
          },
        ],
      },
    };
    await f.ledger.applyApproval(f.prisma, request);
    await f.ledger.applyApproval(f.prisma, request);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'RECEIPT',
      branchId: 1,
      sourceKey: 'RECEIPT:61',
      description: 'Thu khác',
      createdBy: 9,
    });
    expect(String(f.transactions[0].amount)).toBe('1500000');
    expect(f.transactions[0].occurredAt).toEqual(fundDayStart('2026-10-09'));
  });

  it('debits the POS fund for a Lark receipt sent to Công Ty, credits it when Công Ty sends', async () => {
    const pick = (id: string, key: string) => ({
      id,
      type: 'radioV2',
      value: 'chữ hiển thị',
      option: { key },
    });
    const form = (from: string, to: string) => [
      pick(RECEIPT_FIELD_IDS.from, from),
      pick(RECEIPT_FIELD_IDS.to, to),
      pick(RECEIPT_FIELD_IDS.method, '$i18n-m3sj1xiv-4ru39bef6i-1'),
      { id: RECEIPT_FIELD_IDS.amount, type: 'amount', value: 2000000 },
      {
        id: RECEIPT_FIELD_IDS.date,
        type: 'date',
        value: '2026-10-18T17:00:00Z',
      },
    ];
    const f = fixture();
    // Kho SG → Công Ty: trừ quỹ Kho SG, ngày thu 19/10, nội dung mặc định.
    await f.ledger.applyApproval(f.prisma, {
      id: 71,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      branchId: 1,
      createdById: 9,
      formSnapshot: {
        version: 'lark',
        form: form('msmnlqej-osblnddobgd-0', 'mwyy86um-qw7ivzlas0c-1'),
      },
    });
    // Công Ty → Kho SG: cộng quỹ Kho SG.
    await f.ledger.applyApproval(f.prisma, {
      id: 72,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      branchId: 1,
      createdById: 9,
      formSnapshot: {
        version: 'lark',
        form: form('mwyx7cp4-6zwzgxhro7u-1', 'msmnlsb8-8wr2wdb09lx-0'),
      },
    });
    expect(f.transactions).toHaveLength(2);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'EXPENSE',
      branchId: 1,
      sourceKey: 'RECEIPT:71',
      description: 'Chuyển về Công Ty',
    });
    expect(String(f.transactions[0].code)).toMatch(/^QF-CHI-/);
    expect(f.transactions[0].occurredAt).toEqual(fundDayStart('2026-10-19'));
    expect(f.transactions[1]).toMatchObject({
      transactionType: 'RECEIPT',
      branchId: 1,
      sourceKey: 'RECEIPT:72',
      description: 'Thu từ Công Ty',
    });
  });

  it('creates both transfer legs with the same group and never CashFlow', async () => {
    const f = fixture();
    const request = {
      id: 10,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
    };
    await f.ledger.applyApproval(f.prisma, request);
    await f.ledger.applyApproval(f.prisma, request);
    expect(f.transactions).toHaveLength(2);
    expect(f.transactions.map((row) => row.transactionType)).toEqual([
      'TRANSFER_OUT',
      'TRANSFER_IN',
    ]);
    expect(
      f.transactions.every(
        (row) => row.transferId === 4 && row.approvalRequestId === 10,
      ),
    ).toBe(true);
    expect(f.transfer.status).toBe('POSTED');
    expect(f.prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('writes only the leg of a fund already on POS when the other is skipped', async () => {
    const f = fixture();
    const request = {
      id: 10,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
    };
    await f.ledger.applyApproval(f.prisma, request, { skipBranchIds: [1] });
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      transactionType: 'TRANSFER_OUT',
      branchId: 6,
    });
    expect(f.transfer.status).toBe('POSTED');
    expect(f.prisma.internalFundDailyClosing.updateMany).toHaveBeenCalledTimes(
      1,
    );
  });

  it('rejected transfer does not create money', async () => {
    const f = fixture();
    await f.ledger.applyApproval(f.prisma, {
      id: 10,
      status: 'REJECTED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
    });
    expect(f.transactions).toHaveLength(0);
    expect(f.transfer.status).toBe('REJECTED');
  });

  it('cancels both transfer legs atomically and callback cannot recreate them', async () => {
    const f = fixture();
    const request = {
      id: 10,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
    };
    await f.ledger.applyApproval(f.prisma, request);
    await f.service.cancelTransfer(4, { reason: 'Đối soát' }, 7);
    await f.ledger.applyApproval(f.prisma, request);
    expect(f.transactions).toHaveLength(2);
    expect(f.transactions.every((row) => row.status === 'CANCELLED')).toBe(
      true,
    );
    expect(f.transfer.status).toBe('CANCELLED');
    expect(f.prisma.$transaction).toHaveBeenCalled();
  });

  it('rejects closing-day posting without adjust and preserves existing snapshots when adjusted', async () => {
    const f = fixture();
    f.prisma.internalFundDailyClosing.findFirst.mockResolvedValue({
      id: 8,
      closedAt: new Date(),
    });
    f.auth.getPermissionsForBranch.mockResolvedValue([
      'internal_fund:mark_issued',
    ]);
    await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
      'chốt sổ',
    );
    f.auth.getPermissionsForBranch.mockResolvedValue([
      'internal_fund:mark_issued',
      'internal_fund:adjust',
    ]);
    await f.service.postExpenseEntry(12, 7, true);
    expect(f.prisma.internalFundDailyClosing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reconciliationStatus: 'PENDING' },
      }),
    );
  });

  it.each([
    ['MATCHED', 30],
    ['MISMATCHED', 151],
  ])(
    'closing computes %s with prior transactions and no prior closing',
    async (status, actualExpense) => {
      const f = fixture();
      f.prisma.internalFundTransaction.groupBy.mockResolvedValue([
        {
          transactionType: 'RECEIPT',
          _sum: { amount: new Prisma.Decimal(1000) },
        },
      ]);
      f.prisma.internalFundTransaction.findMany.mockResolvedValue([
        ...[
          ['RECEIPT', 100],
          ['TRANSFER_IN', 50],
          ['EXPENSE', 20],
          ['TRANSFER_OUT', 10],
        ].map(([type, amount], i) => ({
          id: i + 2,
          code: String(i),
          transactionType: type,
          amount: new Prisma.Decimal(amount),
          occurredAt: fundDayStart('2026-10-05'),
        })),
      ]);
      const closing = await f.service.closeDay(
        {
          branchId: 6,
          closingDate: '2026-10-05',
          actualOpeningBalance: 1000,
          actualReceipt: 150,
          actualExpense,
        },
        7,
      );
      expect(String(closing.systemClosingBalance)).toBe('1120');
      expect(String(closing.systemOpeningBalance)).toBe('1000');
      expect(closing.reconciliationStatus).toBe(status);
      // Cuối kỳ kế toán tự tính: đầu kỳ + thu − chi.
      expect(String(closing.actualClosingBalance)).toBe(
        String(1000 + 150 - actualExpense),
      );
      expect(f.prisma.internalFundTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'POSTED', branchId: 6 }),
        }),
      );
      expect(closing.log).toHaveLength(1);
    },
  );

  it('moves an existing closing to an empty day, keeping its history', async () => {
    const f = fixture();
    const saved = {
      id: 3,
      branchId: 6,
      closingDate: new Date('2026-10-04T00:00:00Z'),
      closedAt: new Date(),
      log: [{ capturedAt: '2026-10-04T10:00:00Z' }],
    };
    f.prisma.internalFundDailyClosing.findUnique.mockImplementation(
      async ({ where }: any) => (where.id === 3 ? saved : null),
    );
    const closing: any = await f.service.closeDay(
      { id: 3, branchId: 6, closingDate: '2026-10-05', notes: 'Nhầm ngày' },
      7,
    );
    expect(f.prisma.internalFundDailyClosing.upsert).not.toHaveBeenCalled();
    expect(f.prisma.internalFundDailyClosing.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3 } }),
    );
    expect(closing.closingDate).toEqual(new Date('2026-10-05T00:00:00Z'));
    expect(closing.snapshot.movedFrom).toBe('2026-10-04');
    expect(closing.log).toHaveLength(2);
  });

  it('refuses to move a closing onto a day that already has one', async () => {
    const f = fixture();
    f.prisma.internalFundDailyClosing.findUnique.mockImplementation(
      async ({ where }: any) =>
        where.id === 3
          ? {
              id: 3,
              branchId: 6,
              closingDate: new Date('2026-10-04T00:00:00Z'),
              closedAt: new Date(),
            }
          : { id: 4, branchId: 6, closedAt: new Date() },
    );
    await expect(
      f.service.closeDay({ id: 3, branchId: 6, closingDate: '2026-10-05' }, 7),
    ).rejects.toThrow('05/10/2026 đã có chốt sổ');
    expect(f.prisma.internalFundDailyClosing.update).not.toHaveBeenCalled();
  });

  it('lists only closings users created, with live system numbers beside them', async () => {
    const f = fixture();
    (f.prisma as any).$queryRaw = jest.fn().mockResolvedValue([
      { branchId: 6, day: '2026-10-04', receipt: 1000, expense: 0 },
      { branchId: 6, day: '2026-10-05', receipt: 150, expense: 30 },
      { branchId: 6, day: '2026-10-06', receipt: 5, expense: 0 },
    ]);
    f.prisma.internalFundDailyClosing.findMany.mockResolvedValue([
      {
        id: 3,
        branchId: 6,
        closingDate: new Date('2026-10-05T00:00:00Z'),
        actualOpeningBalance: new Prisma.Decimal(1000),
        actualReceipt: new Prisma.Decimal(150),
        actualExpense: new Prisma.Decimal(50),
        actualClosingBalance: new Prisma.Decimal(1100),
        notes: 'Lệch 20',
        closedBy: 7,
        closedAt: new Date(),
      },
    ]);
    const result = await f.service.listDailyClosings(
      { branchId: 6, page: 1, limit: 30 },
      { id: 7 },
    );
    // Ngày 04 và 06 có giao dịch nhưng chưa ai tạo chốt sổ nên không hiện.
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      id: 3,
      closingDate: '2026-10-05',
      reconciliationStatus: 'MISMATCHED',
    });
    expect(String(result.data[0].systemOpeningBalance)).toBe('1000');
    expect(String(result.data[0].systemClosingBalance)).toBe('1120');
  });

  it('lists fund rows with their source voucher and finds them by voucher code', async () => {
    const f = fixture();
    f.auth.getPermissionsForBranch.mockResolvedValue(['internal_fund:view']);
    await f.service.listTransactions(
      { branchId: 6, page: 1, limit: 10, search: 'TCNB-CHI-HN' },
      { id: 7 },
    );
    const args = f.prisma.internalFundTransaction.findMany.mock.calls[0][0];
    expect(args.include.entry.select).toMatchObject({
      code: true,
      occurredAt: true,
      weeklyBatch: { select: { code: true } },
    });
    expect(args.where.OR).toContainEqual({
      entry: { code: { contains: 'TCNB-CHI-HN', mode: 'insensitive' } },
    });
  });

  it('rejects cross-branch viewing and cancellation', async () => {
    const f = fixture();
    f.auth.getPermissionsForBranch.mockImplementation(
      async (_: number, id: number) =>
        id === 6 ? ['internal_fund:view', 'internal_fund:cancel'] : [],
    );
    await expect(
      f.service.listTransactions(
        { branchId: 1, page: 1, limit: 10 },
        { id: 7 },
      ),
    ).rejects.toThrow(ForbiddenErrorPattern);
    await expect(
      f.service.cancelTransfer(4, { reason: 'Hủy' }, 7),
    ).rejects.toThrow('Thiếu quyền');
    expect(f.prisma.internalFundTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('requires submit and transfer permissions before any Lark request', async () => {
    const f = fixture();
    f.auth.getPermissionsForBranch.mockResolvedValue([
      'internal_fund:create_receipt',
    ]);
    await expect(
      f.service.createReceiptApproval(
        {
          clientUuid: '6297b342-3506-40ee-b7a8-7b5e956fd4c8',
          branchId: 6,
          amount: 100,
          occurredAt: '2026-10-05',
          attachmentCodes: ['code'],
        },
        7,
      ),
    ).rejects.toThrow('Thiếu quyền');
    expect(f.approval.create).not.toHaveBeenCalled();
  });
});

const ForbiddenErrorPattern = /Không có quyền/;

describe('Server-side Approval form registry', () => {
  it('maps domain fields, branch locations and document codes without Base', () => {
    const form = buildFundReceiptForm(
      {
        clientUuid: 'test',
        branchId: 6,
        destinationBranchId: 1,
        amount: 100,
        classification: 'INTERNAL_TRANSFER',
        occurredAt: '2026-10-04T18:00:00Z',
        attachmentCodes: ['doc'],
      },
      'ou_user',
    );
    expect(form.find((row) => row.id === RECEIPT_FIELD_IDS.date)?.value).toBe(
      '2026-10-05',
    );
    expect(
      form.find((row) => row.id === RECEIPT_FIELD_IDS.payer)?.value,
    ).toEqual(['ou_user']);
    expect(
      form.find((row) => row.id === RECEIPT_FIELD_IDS.from)?.value,
    ).toBeTruthy();
    expect(
      form.find((row) => row.id === RECEIPT_FIELD_IDS.to)?.value,
    ).toBeTruthy();
  });
  it('rejects same-branch transfers and missing attachments', () => {
    expect(() =>
      buildFundReceiptForm(
        {
          clientUuid: 'x',
          branchId: 6,
          destinationBranchId: 6,
          amount: 100,
          classification: 'INTERNAL_TRANSFER',
          occurredAt: '2026-10-05',
          attachmentCodes: ['doc'],
        },
        'user',
      ),
    ).toThrow('khác nhau');
    expect(() =>
      buildFundReceiptForm(
        { clientUuid: 'x', branchId: 6, amount: 100, occurredAt: '2026-10-05' },
        'user',
      ),
    ).toThrow('chứng từ');
  });
});

describe('Internal fund audit log (Cài đặt → Lịch sử)', () => {
  const codes = (rows: any[]) => rows.map((row) => row.actionCode);

  it('logs Đã chi once, sharing the opId with the fund row written by the ledger', async () => {
    const f = fixture({ auditLedger: true });
    f.entry.code = 'TCNB-CHI-1';
    f.entry.category = 'OTHER_EXPENSE';
    await f.service.postExpenseEntry(12, 7, true);
    await f.service.postExpenseEntry(12, 7, true);
    const rows = f.logs();
    expect(codes(rows)).toEqual(['FIN_FUND_TXN_POST', 'FIN_ENTRY_CASH_ISSUE']);
    const issue = rows[1];
    expect(issue).toMatchObject({
      category: 'internal_finance',
      entityType: 'internal_finance_entries',
      entityId: '12',
      entityCode: 'TCNB-CHI-1',
      branchId: 6,
      userId: 7,
      userName: 'Kế toán A',
      message: 'Đánh dấu Đã chi TCNB-CHI-1',
      changes: [expect.objectContaining({ field: 'cashIssued', to: 'Có' })],
    });
    expect(issue.metadata).toMatchObject({
      actorKind: 'USER',
      fundTransactionCode: f.transactions[0].code,
    });
    expect(issue.requestId).toBe(rows[0].requestId);
  });

  it('uses the caller actor for Đã chi so the page action keeps one opId', async () => {
    const f = fixture();
    f.entry.code = 'TCNB-CHI-1';
    await f.service.postExpenseEntry(12, 7, true, undefined, {
      userId: 7,
      userName: 'Kho HN',
      kind: 'USER',
      trigger: 'http',
      opId: 'op-from-page',
    });
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_ENTRY_CASH_ISSUE',
        requestId: 'op-from-page',
        userName: 'Kho HN',
      }),
    ]);
  });

  it('cancelling a POS expense row logs the fund cancel and the Đã chi revert with the old issue info', async () => {
    const f = fixture({ auditLedger: true });
    f.entry.code = 'TCNB-CHI-1';
    await f.service.postExpenseEntry(12, 7, true);
    f.prisma.auditLog.createMany.mockClear();
    const issuedAt = f.entry.cashIssuedAt;
    await f.service.cancelTransaction(1, { reason: ' Ghi nhầm ' }, 7);
    const rows = f.logs();
    // Fund row cancel comes from the ledger, the Đã chi revert from the service.
    expect(codes(rows)).toEqual([
      'FIN_FUND_TXN_CANCEL',
      'FIN_ENTRY_CASH_ISSUE_REVERT',
    ]);
    const revert = rows[1];
    expect(revert).toMatchObject({
      actionType: 'PUT',
      entityId: '12',
      message: 'Bỏ Đã chi TCNB-CHI-1: Ghi nhầm',
      changes: [expect.objectContaining({ from: 'Có', to: 'Không' })],
    });
    expect(revert.snapshot).toMatchObject({
      cashIssuedAt: issuedAt.toISOString(),
      cashIssuedBy: 7,
      cashIssuedReason: null,
    });
    expect(revert.requestId).toBe(rows[0].requestId);
  });

  it('logs a direct fund cancel (Lark-imported row keeps its key) and flags closings with the cause', async () => {
    const f = fixture();
    f.entry.sourceType = 'LARK_IMPORT';
    await f.service.postExpenseEntry(12, 7, true);
    f.entry.posManagedAt = null;
    const invalidate = jest.spyOn(f.ledger, 'invalidateClosings');
    f.prisma.auditLog.createMany.mockClear();
    await f.service.cancelTransaction(1, { reason: 'Sai' }, 7);
    const rows = f.logs();
    expect(codes(rows)).toEqual(['FIN_FUND_TXN_CANCEL']);
    expect(rows[0]).toMatchObject({
      actionType: 'DELETE',
      entityType: 'internal_fund_transactions',
      entityId: '1',
      message: `Hủy dòng quỹ ${f.transactions[0].code} 125.000 đ: Sai`,
    });
    expect(rows[0].metadata).toMatchObject({
      keptSourceKey: true,
      sourceKey: 'EXPENSE:12',
    });
    expect(invalidate).toHaveBeenCalledWith(
      f.prisma,
      6,
      expect.any(Date),
      `hủy dòng quỹ ${f.transactions[0].code}`,
      expect.objectContaining({ kind: 'USER', userId: 7 }),
    );
  });

  it('logs the Lark Approval row cancel alongside its fund row', async () => {
    const f = fixture();
    f.entry.code = 'TCNB-LARK-1';
    f.entry.category = 'CASH_FUND_EXPENSE';
    await f.service.postExpenseEntry(12, 7, true);
    f.entry.sourceType = 'LARK_APPROVAL';
    f.entry.status = 'POSTED';
    f.prisma.auditLog.createMany.mockClear();
    await f.service.cancelTransaction(1, { reason: 'Ghi nhầm quỹ' }, 7);
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_ENTRY_CANCEL',
        entityId: '12',
        message:
          'Hủy phiếu chi quỹ TCNB-LARK-1: Hủy giao dịch quỹ: Ghi nhầm quỹ',
      }),
    ]);
  });

  it('logs a transfer cancel and each cancelled leg in one write', async () => {
    const f = fixture();
    f.transfer.code = 'CQ-1';
    await f.ledger.applyApproval(f.prisma, {
      id: 10,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_TRANSFER',
      sourceId: 4,
    });
    f.prisma.internalFundTransaction.findMany.mockImplementation(
      async ({ where }: any) =>
        f.transactions.filter(
          (row) =>
            row.transferId === where.transferId && row.status === where.status,
        ),
    );
    await f.service.cancelTransfer(4, { reason: 'Đối soát' }, 7);
    expect(f.prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    const rows = f.logs();
    expect(codes(rows)).toEqual([
      'FIN_FUND_TRANSFER_CANCEL',
      'FIN_FUND_TXN_CANCEL',
      'FIN_FUND_TXN_CANCEL',
    ]);
    expect(rows[0]).toMatchObject({
      entityId: '4',
      entityCode: 'CQ-1',
      message: 'Hủy chuyển quỹ CQ-1: Đối soát',
      changes: [expect.objectContaining({ from: 'Đã ghi quỹ', to: 'Đã hủy' })],
    });
    expect(rows.slice(1).map((row) => row.entityId)).toEqual(['1', '2']);
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
  });

  it('logs a description adjustment with its reason', async () => {
    const f = fixture();
    f.transactions.push({
      id: 3,
      code: 'QF-THU-3',
      branchId: 6,
      status: 'POSTED',
      transactionType: 'RECEIPT',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      amount: new Prisma.Decimal(100),
      description: 'Thu khác',
    });
    await f.service.updateTransaction(
      3,
      { reason: 'Ghi rõ người nộp', description: 'Thu của anh B' },
      7,
    );
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_FUND_TXN_ADJUST',
        entityCode: 'QF-THU-3',
        message: 'Điều chỉnh dòng quỹ QF-THU-3: Ghi rõ người nộp',
        changes: [
          expect.objectContaining({
            field: 'description',
            from: 'Thu khác',
            to: 'Thu của anh B\nĐiều chỉnh: Ghi rõ người nộp',
          }),
        ],
      }),
    ]);
  });

  it('logs a new transfer request once per clientUuid', async () => {
    const f = fixture();
    let saved: any = null;
    f.prisma.internalFundTransfer.findUnique.mockImplementation(
      async () => saved,
    );
    f.prisma.internalFundTransfer.upsert.mockImplementation(
      async ({ create }: any) => {
        saved ??= {
          ...create,
          id: 4,
          amount: new Prisma.Decimal(create.amount),
        };
        return saved;
      },
    );
    const dto = {
      clientUuid: '6297b342-3506-40ee-b7a8-7b5e956fd4c8',
      branchId: 6,
      destinationBranchId: 1,
      amount: 250000,
      occurredAt: '2026-10-05',
      classification: 'INTERNAL_TRANSFER',
      attachmentCodes: ['doc'],
    };
    await f.service.createReceiptApproval(dto, 7);
    await f.service.createReceiptApproval(dto, 7);
    expect(f.approval.create).toHaveBeenCalledTimes(2);
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_FUND_TRANSFER_REQUEST',
        actionType: 'POST',
        entityType: 'internal_fund_transfers',
        entityId: '4',
        message: `Tạo chuyển quỹ ${saved.code} 250.000 đ: Kho HN → Kho SG`,
      }),
    ]);
    // Đơn Approval tạo cùng lần dùng chung opId với dòng chuyển quỹ.
    expect(f.approval.create.mock.calls[0][2]).toMatchObject({
      kind: 'USER',
      userId: 7,
      opId: f.logs()[0].requestId,
    });
  });

  it('posts an approved receipt from POS as the user, logging the approval post once', async () => {
    const f = fixture({ auditLedger: true });
    const request = {
      id: 10,
      kind: 'RECEIPT',
      instanceCode: 'INS-10',
      branchId: 6,
      status: 'APPROVED',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      createdById: 9,
      // Đã duyệt: Lark trả số đơn → cùng mã với các dòng đơn khác.
      detailSnapshot: { serial_number: '202610050001' },
      formSnapshot: {
        form: [
          { id: RECEIPT_FIELD_IDS.amount, value: 300000 },
          { id: RECEIPT_FIELD_IDS.date, value: '2026-10-05' },
          { id: RECEIPT_FIELD_IDS.description, value: 'Thu khác' },
        ],
      },
    };
    f.prisma.approvalRequest.findUnique.mockResolvedValue(request);
    f.prisma.internalFundTransaction.findMany.mockImplementation(
      async ({ where }: any) =>
        f.transactions.filter(
          (row) => row.approvalRequestId === where.approvalRequestId,
        ),
    );
    await f.service.postApprovedApproval(10, 7);
    await f.service.postApprovedApproval(10, 7);
    const rows = f.logs();
    expect(codes(rows)).toEqual(['FIN_FUND_TXN_POST', 'FIN_APPROVAL_POST']);
    expect(rows[0]).toMatchObject({ userId: 7, userName: 'Kế toán A' });
    expect(rows[0].metadata.actorKind).toBe('USER');
    expect(rows[1]).toMatchObject({
      entityType: 'approval_requests',
      entityId: '10',
      entityCode: '202610050001',
      message: 'Ghi quỹ đơn thu quỹ 202610050001 – 300.000 đ',
      metadata: expect.objectContaining({ instanceCode: 'INS-10' }),
    });
    expect(rows[1].requestId).toBe(rows[0].requestId);
  });

  it('logs a first closing, skips an unchanged re-close and records a date move', async () => {
    const f = fixture();
    f.prisma.internalFundDailyClosing.upsert.mockImplementation(
      async ({ create }: any) => ({ id: 9, ...create }),
    );
    const dto = {
      branchId: 6,
      closingDate: '2026-10-05',
      actualOpeningBalance: 0,
      actualReceipt: 0,
      actualExpense: 0,
    };
    const first = await f.service.closeDay(dto, 7);
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_FUND_CLOSING_SAVE',
        entityType: 'internal_fund_daily_closings',
        entityId: '9',
        message: 'Lưu chốt sổ Kho HN ngày 05/10/2026',
      }),
    ]);

    f.prisma.auditLog.createMany.mockClear();
    f.prisma.internalFundDailyClosing.findUnique.mockResolvedValue({
      ...first,
      notes: null,
    });
    f.prisma.internalFundDailyClosing.upsert.mockImplementation(
      async ({ update }: any) => ({ ...first, ...update }),
    );
    await f.service.closeDay(dto, 7);
    expect(f.logs()).toEqual([]);

    await f.service.closeDay({ ...dto, actualReceipt: 50 }, 7);
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_FUND_CLOSING_SAVE',
        changes: expect.arrayContaining([
          expect.objectContaining({
            field: 'actualReceipt',
            from: '0 đ',
            to: '50 đ',
          }),
        ]),
      }),
    ]);
  });

  it('records the moved date of a closing', async () => {
    const f = fixture();
    const saved = {
      id: 3,
      branchId: 6,
      closingDate: new Date('2026-10-04T00:00:00Z'),
      closedAt: new Date(),
      log: [],
    };
    f.prisma.internalFundDailyClosing.findUnique.mockImplementation(
      async ({ where }: any) => (where.id === 3 ? saved : null),
    );
    await f.service.closeDay(
      { id: 3, branchId: 6, closingDate: '2026-10-05', notes: 'Nhầm ngày' },
      7,
    );
    expect(f.logs()[0].changes).toEqual([
      expect.objectContaining({
        field: 'closingDate',
        from: '04/10/2026',
        to: '05/10/2026',
      }),
    ]);
  });
});
