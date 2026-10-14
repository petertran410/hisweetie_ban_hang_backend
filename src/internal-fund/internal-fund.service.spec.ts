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

function fixture() {
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
    },
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
  const ledger = new InternalFundLedgerService();
  const service = new InternalFundService(
    prisma,
    new FinanceAccessService(prisma, auth),
    approval,
    ledger,
  );
  return {
    service,
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
      // Ghi quỹ vào ngày tick Đã chi, không phải ngày của phiếu (05/10).
      expect(f.transactions[0].occurredAt.getTime()).toBeGreaterThan(
        fundDayStart('2026-10-06').getTime(),
      );
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
