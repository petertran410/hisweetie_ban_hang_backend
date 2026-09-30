import { BadRequestException } from '@nestjs/common';
import { InternalFinanceService } from './internal-finance.service';

describe('InternalFinanceService', () => {
  const makeService = (overrides: any = {}) => {
    const prisma = {
      internalFinanceEntry: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      internalFinanceAttachment: {
        createMany: jest.fn(),
      },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
      ...overrides,
    };
    const cashFlowsService = {
      createInternalFinanceCashFlow: jest.fn(),
    };
    const approvalLifecycle = {};
    const config = { get: jest.fn() };
    const codeService = {
      nextCode: jest.fn().mockResolvedValue('TCNB-CHI-HN-20260930-000001'),
    };
    return {
      service: new InternalFinanceService(
        prisma as any,
        cashFlowsService as any,
        approvalLifecycle as any,
        config as any,
        codeService as any,
      ),
      prisma,
      cashFlowsService,
    };
  };

  it('does not post an expense directly before weekly approval', async () => {
    const { service, prisma, cashFlowsService } = makeService();
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 10,
      direction: 'EXPENSE',
      status: 'MANAGER_APPROVED',
      cashFlowId: null,
      branchId: 6,
    });

    await expect(service.postEntry(10, 7)).rejects.toThrow(
      'Khoản chi phải được ghi nhận theo batch Approval tuần',
    );
    expect(cashFlowsService.createInternalFinanceCashFlow).not.toHaveBeenCalled();
  });

  it('does not create CashFlow when posting a weekly expense batch', async () => {
    const { service, cashFlowsService } = makeService({
      internalFinanceWeeklyBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 4,
          status: 'APPROVED',
          entries: [{ id: 1, branchId: 6, amount: 100, occurredAt: new Date() }],
        }),
        update: jest.fn(),
      },
    });

    await expect(service.postWeeklyBatch(4, 7)).rejects.toThrow(
      'Phiếu chi chưa có thao tác ghi CashFlow',
    );
    expect(cashFlowsService.createInternalFinanceCashFlow).not.toHaveBeenCalled();
  });

  it('marks an approved weekly expense as cash issued without creating CashFlow', async () => {
    const update = jest.fn().mockResolvedValue({ id: 15, cashIssued: true });
    const { service, prisma, cashFlowsService } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 15,
          direction: 'EXPENSE',
          status: 'APPROVED',
          cashFlowId: null,
          cashIssued: false,
          weeklyBatch: { status: 'APPROVED' },
        }),
        update,
        updateMany: jest.fn(),
      },
    });

    await service.updateCashIssued(15, true, 7);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 15 },
        data: expect.objectContaining({
          cashIssued: true,
          cashIssuedBy: 7,
        }),
      }),
    );
    expect(cashFlowsService.createInternalFinanceCashFlow).not.toHaveBeenCalled();
    expect(prisma.internalFinanceEntry.findUnique).toHaveBeenCalled();
  });

  it('records the default accountant review for a manual cash receipt', async () => {
    const entryCreate = jest.fn().mockResolvedValue({ id: 21 });
    const { service } = makeService({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      internalFinanceEntry: {
        findUnique: jest.fn(),
        create: entryCreate,
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });

    await service.createManualReceipt(
      {
        branchId: 6,
        amount: 125000,
        occurredAt: '2026-09-29T00:00:00.000Z',
        method: 'cash',
        cashSource: 'Kho Hà Nội',
      },
      7,
    );

    expect(entryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceSnapshot: {
            method: 'cash',
            cashSource: 'Kho Hà Nội',
          },
          status: 'ACCOUNTANT_APPROVED',
          reviews: {
            create: expect.objectContaining({
              role: 'ACCOUNTANT',
              decision: 'APPROVE',
              reviewerId: 7,
            }),
          },
        }),
      }),
    );
  });

  it('requires a reason and due date for a missing-evidence exception', async () => {
    const { service, prisma } = makeService();
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 11,
      direction: 'EXPENSE',
      status: 'PENDING_MANAGER',
      accountantReviewedBy: 7,
      evidenceStatus: 'MISSING',
    });

    await expect(
      service.review(
        11,
        'manager',
        { decision: 'EXCEPTION_APPROVE', reason: 'Bổ sung hóa đơn sau' },
        8,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.internalFinanceReview).toBeUndefined();
  });

  it('keeps the manual receipt payment method when posting CashFlow', async () => {
    const { service, prisma, cashFlowsService } = makeService();
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 13,
      direction: 'RECEIPT',
      status: 'ACCOUNTANT_APPROVED',
      cashFlowId: null,
      branchId: 6,
      amount: 250000,
      occurredAt: new Date('2026-09-29T00:00:00.000Z'),
      sourceSnapshot: { method: 'transfer' },
      description: 'Thu chuyển khoản',
    });
    cashFlowsService.createInternalFinanceCashFlow.mockResolvedValue({
      cashFlow: { id: 90 },
    });

    await service.postEntry(13, 7);

    expect(cashFlowsService.createInternalFinanceCashFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'transfer',
        isReceipt: true,
      }),
      7,
    );
  });

  it('closes an evidence exception when attachments are added', async () => {
    const { service, prisma } = makeService();
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 12,
      status: 'MANAGER_APPROVED',
      evidenceStatus: 'EXCEPTION_APPROVED',
    });
    prisma.internalFinanceEntry.update.mockResolvedValue({
      id: 12,
      evidenceStatus: 'COMPLETE',
      exceptionReason: null,
      exceptionDueAt: null,
    });

    await service.addAttachments(
      12,
      {
        attachments: [
          {
            fileUrl: 'https://files.example/evidence.pdf',
            fileName: 'evidence.pdf',
          },
        ],
      },
      8,
    );

    expect(prisma.internalFinanceAttachment.createMany).toHaveBeenCalledWith({
      data: [
        {
          entryId: 12,
          kind: 'EVIDENCE',
          fileUrl: 'https://files.example/evidence.pdf',
          fileName: 'evidence.pdf',
          fileType: undefined,
          fileSize: undefined,
          createdBy: 8,
        },
      ],
    });
    expect(prisma.internalFinanceEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 12 },
        data: expect.objectContaining({
          evidenceStatus: 'COMPLETE',
          exceptionReason: null,
          exceptionDueAt: null,
        }),
      }),
    );
  });

  it('creates one entry per delivery expense and remains idempotent on retry', async () => {
    const entries = new Map<string, any>();
    const db = {
      internalFinanceEntry: {
        findUnique: jest.fn(({ where }: any) => Promise.resolve(entries.get(where.sourceKey) || null)),
        create: jest.fn(({ data }: any) => {
          const entry = { id: entries.size + 1, ...data };
          entries.set(data.sourceKey, entry);
          return Promise.resolve(entry);
        }),
        update: jest.fn(({ where, data }: any) => {
          const entry = [...entries.values()].find((item) => item.id === where.id);
          return Promise.resolve({ ...entry, ...data });
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const { service } = makeService();
    const packingSlip = {
      id: 20,
      code: 'BD-20',
      branchId: 6,
      createdAt: new Date('2026-09-28T10:00:00.000Z'),
      paymentMethod: 'cash',
      cashAmount: 100000,
      hasFeeGuiBen: true,
      feeGuiBen: 20000,
      hasFeeGrab: true,
      feeGrab: 30000,
      hasCuocGuiHang: false,
      cuocGuiHang: 0,
      hasCuocNhanHang: false,
      cuocNhanHang: 0,
      expensePayerId: 9,
      invoices: [{ invoiceId: 30, invoice: { customerId: 55 } }],
      expenseFiles: [{ fileUrl: 'https://files.example/receipt.jpg' }],
      images: [],
    };

    await service.syncPackingSlipEntriesInTransaction(db as any, packingSlip, 7);
    await service.syncPackingSlipEntriesInTransaction(db as any, packingSlip, 7);

    expect(db.internalFinanceEntry.create).toHaveBeenCalledTimes(3);
    expect(entries.size).toBe(3);
    expect([...entries.values()].every((entry) => entry.occurredAt === packingSlip.createdAt)).toBe(true);
  });
});
