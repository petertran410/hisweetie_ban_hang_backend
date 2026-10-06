import { Prisma } from '@prisma/client';
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
      findUnique: jest
        .fn()
        .mockResolvedValue({ larkUserId: 'ou_user', userRoles: [] }),
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
    'create_expense',
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
      actions.map(
        (action) =>
          `internal_fund:${action}_${id === 6 ? 'hn' : id === 1 ? 'sg' : 'vp'}`,
      ),
    ),
  };
  const approval: any = {
    create: jest.fn().mockResolvedValue({ id: 10, status: 'PENDING' }),
  };
  const ledger = new InternalFundLedgerService();
  const service = new InternalFundService(prisma, auth, approval, ledger);
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

  it('does not re-post legacy cash issued or CashFlow-linked expenses', async () => {
    const f = fixture();
    f.entry.cashFlowId = 22;
    await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
      'lịch sử',
    );
    expect(f.prisma.cashFlow.create).not.toHaveBeenCalled();
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
      'internal_fund:mark_issued_hn',
    ]);
    await expect(f.service.postExpenseEntry(12, 7, true)).rejects.toThrow(
      'chốt sổ',
    );
    f.auth.getPermissionsForBranch.mockResolvedValue([
      'internal_fund:mark_issued_hn',
      'internal_fund:adjust_hn',
    ]);
    await f.service.postExpenseEntry(12, 7, true);
    expect(f.prisma.internalFundDailyClosing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reconciliationStatus: 'PENDING' },
      }),
    );
  });

  it.each([
    ['MATCHED', 1120],
    ['MISMATCHED', 999],
  ])(
    'closing computes %s with prior transactions and no prior closing',
    async (status, actualClosing) => {
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
          actualExpense: 30,
          actualClosingBalance: actualClosing,
        },
        7,
      );
      expect(String(closing.systemClosingBalance)).toBe('1120');
      expect(String(closing.systemOpeningBalance)).toBe('1000');
      expect(closing.reconciliationStatus).toBe(status);
      expect(f.prisma.internalFundTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'POSTED', branchId: 6 }),
        }),
      );
      expect(closing.log).toHaveLength(1);
    },
  );

  it('rejects cross-branch viewing and cancellation', async () => {
    const f = fixture();
    f.auth.getPermissionsForBranch.mockImplementation(
      async (_: number, id: number) =>
        id === 6 ? ['internal_fund:view_hn', 'internal_fund:cancel_hn'] : [],
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
      'internal_fund:create_receipt_hn',
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
