import { BadRequestException } from '@nestjs/common';
import { InternalFinanceService } from './internal-finance.service';

describe('InternalFinanceService', () => {
  const makeService = (overrides: any = {}) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ userRoles: [] }),
      },
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
      createInternalFinanceCashFlowInTransaction: jest.fn(),
      createCustomerPayment: jest.fn(),
      createStandaloneCashReceipt: jest.fn(),
      cancelInTransaction: jest.fn(),
      logCancellation: jest.fn(),
    };
    const approvalLifecycle = { create: jest.fn(), findOne: jest.fn() };
    const config = { get: jest.fn() };
    const authService = {
      getPermissionsForBranch: jest.fn().mockResolvedValue([]),
    };
    const internalFund = {
      postExpenseEntry: jest.fn(),
      lockBranch: jest.fn(),
    };
    const codeService = {
      nextCode: jest.fn().mockResolvedValue('TCNB-CHI-HN-20260930-000001'),
    };
    const vehicles = {
      assertPermission: jest.fn(),
      allowedBranches: jest.fn().mockResolvedValue([6, 1]),
      requireForBranch: jest.fn().mockResolvedValue({
        id: 3,
        branchId: 6,
        label: '29D - 223.09 - Xăng',
      }),
      fuelMetrics: jest.fn().mockResolvedValue(new Map()),
    };
    return {
      service: new InternalFinanceService(
        prisma as any,
        cashFlowsService as any,
        approvalLifecycle as any,
        config as any,
        codeService as any,
        authService as any,
        internalFund as any,
        vehicles as any,
      ),
      prisma,
      vehicles,
      cashFlowsService,
      authService,
      internalFund,
      approvalLifecycle,
    };
  };

  it('freezes the weekly batch before calling Lark and does not overwrite callback status', async () => {
    const batch = {
      id: 4,
      branchId: 6,
      status: 'READY',
      approvalRequestId: null,
      totalAmount: 100,
      weekStart: new Date('2026-10-04T17:00:00Z'),
      weekEnd: new Date('2026-10-11T16:59:59Z'),
      updatedAt: new Date(),
    };
    const update = jest.fn().mockResolvedValue({});
    const { service, approvalLifecycle } = makeService({
      internalFinanceWeeklyBatch: {
        findUnique: jest.fn().mockResolvedValue(batch),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update,
      },
    });
    approvalLifecycle.create.mockResolvedValue({ id: 55 });
    await service.createWeeklyApproval(4, 7);
    expect(update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { approvalRequestId: 55 },
    });
    expect(approvalLifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'EXPENSE_HN',
        clientUuid: 'INTERNAL_FINANCE_WEEK:6:2026-10-05:2026-10-11',
      }),
      7,
    );
  });

  it('releases a claimed weekly batch when Approval submission fails', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service, approvalLifecycle, prisma } = makeService({
      internalFinanceWeeklyBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 4,
          branchId: 6,
          status: 'READY',
          totalAmount: 100,
          weekStart: new Date('2026-10-04T17:00:00Z'),
          weekEnd: new Date('2026-10-11T16:59:59Z'),
        }),
        updateMany,
      },
    });
    approvalLifecycle.create.mockRejectedValue(new Error('Offline Lark'));
    await expect(service.createWeeklyApproval(4, 7)).rejects.toThrow(
      'Offline Lark',
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 4, status: 'IN_APPROVAL', approvalRequestId: null },
        data: { status: 'READY' },
      }),
    );
    expect(prisma.internalFinanceEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'READY_FOR_WEEKLY_APPROVAL' },
      }),
    );
  });

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
    expect(
      cashFlowsService.createInternalFinanceCashFlow,
    ).not.toHaveBeenCalled();
  });

  it('does not create CashFlow when posting a weekly expense batch', async () => {
    const { service, cashFlowsService } = makeService({
      internalFinanceWeeklyBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 4,
          status: 'APPROVED',
          entries: [
            { id: 1, branchId: 6, amount: 100, occurredAt: new Date() },
          ],
        }),
        update: jest.fn(),
      },
    });

    await expect(service.postWeeklyBatch(4, 7)).rejects.toThrow(
      'Phiếu chi chưa có thao tác ghi CashFlow',
    );
    expect(
      cashFlowsService.createInternalFinanceCashFlow,
    ).not.toHaveBeenCalled();
  });

  it('delegates approved expense issuance to internal fund, not CashFlow', async () => {
    const update = jest.fn().mockResolvedValue({ id: 15, cashIssued: true });
    const { service, prisma, internalFund } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 15,
          direction: 'EXPENSE',
          status: 'APPROVED',
          cashFlowId: null,
          cashIssued: false,
          weeklyBatch: { status: 'APPROVED' },
          branchId: 6,
          amount: 100,
          occurredAt: new Date('2026-09-30T00:00:00.000Z'),
          code: 'TCNB-CHI-HN-20260930-000001',
          description: 'Chi phí giao hàng',
        }),
        update,
        updateMany: jest.fn(),
      },
    });

    await service.updateCashIssued(15, true, 7);

    expect(internalFund.postExpenseEntry).toHaveBeenCalledWith(15, 7, true);
  });

  it('filters warehouse expenses by the branches allowed with warehouse_expense permissions', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const { service, authService } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn(),
        findMany,
        count,
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });
    authService.getPermissionsForBranch.mockImplementation(
      async (_userId: number, branchId: number) =>
        branchId === 6 ? ['warehouse_expense:view_hn'] : [],
    );
    const user = { id: 7, roles: [], permissions: [] };

    await service.listWarehouseExpenses(
      { branchId: 6, page: 1, limit: 50 },
      user,
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { branchId: { in: [6] } },
            {
              category: {
                in: ['DELIVERY_FEE', 'FUEL', 'VEHICLE_CARE', 'OTHER_EXPENSE'],
              },
            },
          ]),
        },
      }),
    );
    await expect(
      service.listWarehouseExpenses({ branchId: 1, page: 1, limit: 50 }, user),
    ).rejects.toThrow('Không có quyền xem phiếu chi của chi nhánh này');
  });

  it('requires mark_issued permission before confirming a warehouse expense', async () => {
    const { service, prisma, authService } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({ id: 77, branchId: 6 }),
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:mark_issued_hn',
    ]);
    const updateCashIssued = jest
      .spyOn(service, 'updateCashIssued')
      .mockResolvedValue({ id: 77 } as any);

    await service.markWarehouseExpenseIssued(
      77,
      { id: 7, roles: [], permissions: [] },
      { cashIssued: true },
    );

    expect(updateCashIssued).toHaveBeenCalledWith(77, true, 7);
    expect(prisma.internalFinanceEntry.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { id: true, branchId: true },
    });
  });

  it('updates only an open manual warehouse expense', async () => {
    const update = jest.fn().mockResolvedValue({ id: 88 });
    const { service, authService } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 88,
          direction: 'EXPENSE',
          sourceType: 'MANUAL_EXPENSE',
          branchId: 6,
          cashFlowId: null,
          cashIssued: false,
          weeklyBatchId: null,
          status: 'PENDING_ACCOUNTANT',
        }),
        update,
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:update_hn',
    ]);

    await service.updateWarehouseExpense(
      88,
      {
        amount: 250000,
        description: 'Mua vật tư đóng gói',
      },
      { id: 7, roles: [], permissions: [] },
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 88 },
        data: expect.objectContaining({
          amount: 250000,
          description: 'Mua vật tư đóng gói',
        }),
      }),
    );
  });

  it('rechecks the expense after taking the branch lock', async () => {
    const update = jest.fn();
    const { service, prisma, authService, internalFund } = makeService({
      internalFinanceEntry: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 89, branchId: 6 })
          .mockResolvedValueOnce({
            id: 89,
            direction: 'EXPENSE',
            sourceType: 'MANUAL_EXPENSE',
            branchId: 6,
            cashFlowId: null,
            cashIssued: false,
            weeklyBatchId: 12,
            status: 'READY_FOR_WEEKLY_APPROVAL',
          }),
        update,
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:update_hn',
    ]);

    await expect(
      service.updateWarehouseExpense(
        89,
        { amount: 250000 },
        { id: 7, roles: [], permissions: [] },
      ),
    ).rejects.toThrow('đã được tổng hợp');

    expect(internalFund.lockBranch).toHaveBeenCalledWith(prisma, [6]);
    expect(update).not.toHaveBeenCalled();
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
    const { service, prisma, authService } = makeService();
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:update_hn',
    ]);
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 11,
      direction: 'EXPENSE',
      branchId: 6,
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

  it('blocks legacy internal receipt CashFlow posting', async () => {
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

    await expect(service.postEntry(13, 7)).rejects.toThrow(
      'Phiếu thu nội bộ dùng Approval',
    );
    expect(
      cashFlowsService.createInternalFinanceCashFlow,
    ).not.toHaveBeenCalled();
  });

  it('closes an evidence exception when attachments are added', async () => {
    const { service, prisma, authService } = makeService();
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:update_hn',
    ]);
    prisma.internalFinanceEntry.findUnique.mockResolvedValue({
      id: 12,
      direction: 'EXPENSE',
      branchId: 6,
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
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(entries.get(where.sourceKey) || null),
        ),
        create: jest.fn(({ data }: any) => {
          const entry = { id: entries.size + 1, ...data };
          entries.set(data.sourceKey, entry);
          return Promise.resolve(entry);
        }),
        update: jest.fn(({ where, data }: any) => {
          const entry = [...entries.values()].find(
            (item) => item.id === where.id,
          );
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

    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      packingSlip,
      7,
    );
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      packingSlip,
      7,
    );

    expect(db.internalFinanceEntry.create).toHaveBeenCalledTimes(3);
    expect(entries.size).toBe(3);
    expect(
      [...entries.values()].every(
        (entry) => entry.occurredAt === packingSlip.createdAt,
      ),
    ).toBe(true);
    const receipt = [...entries.values()].find(
      (entry) => entry.category === 'CUSTOMER_RECEIPT',
    );
    expect(receipt.sourceSnapshot.customerIds).toEqual([55]);
    const expenses = [...entries.values()].filter(
      (entry) => entry.category === 'DELIVERY_FEE',
    );
    expect(expenses.every((entry) => entry.payerId === 9)).toBe(true);
    expect(
      expenses.every((entry) => entry.expenseItem?.startsWith('Cước gửi hàng')),
    ).toBe(true);
    expect(receipt.payerId).toBeUndefined();
  });

  it('computes the amount of a manual warehouse expense from quantity and unit price', async () => {
    const create = jest.fn().mockResolvedValue({ id: 91 });
    const { service, authService } = makeService({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
      },
      internalFinanceEntry: { create },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:create_hn',
    ]);

    await service.createWarehouseExpense(
      {
        branchId: 6,
        occurredAt: '2026-10-09T00:00:00+07:00',
        description: 'Băng keo',
        quantity: 12,
        unitPrice: 15000,
        expenseItem:
          'Mua bao bì, CCDC phục vụ đóng gói hàng hóa: carton, xốp, băng keo...',
      },
      { id: 7, roles: [], permissions: [] },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 180000,
          quantity: 12,
          unitPrice: 15000,
          payerId: 7,
        }),
      }),
    );
    await expect(
      service.createWarehouseExpense(
        {
          branchId: 6,
          occurredAt: '2026-10-09T00:00:00+07:00',
          description: 'Thiếu đơn giá',
          quantity: 2,
        },
        { id: 7, roles: [], permissions: [] },
      ),
    ).rejects.toThrow('số lượng và đơn giá');
  });

  it('creates a fuel entry linked to a vehicle and derives liters from the unit price', async () => {
    const create = jest.fn().mockResolvedValue({ id: 92 });
    const { service, vehicles } = makeService({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
      },
      internalFinanceEntry: { create },
    });
    const user = { id: 7, roles: [], permissions: [] };

    await service.createFuel(
      {
        branchId: 6,
        vehicleId: 3,
        occurredAt: '2026-10-07T08:00:00+07:00',
        amount: 750000,
        unitPrice: 27180,
        odo: 58674,
      },
      user,
    );

    expect(vehicles.assertPermission).toHaveBeenCalledWith(user, 6, 'create');
    expect(vehicles.requireForBranch).toHaveBeenCalledWith(3, 6);
    const data = create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        category: 'FUEL',
        vehicleId: 3,
        vehicleName: '29D - 223.09 - Xăng',
        vehicleOdo: 58674,
        payerId: 7,
        expenseItem: 'Xăng xe: oto, xe tại kho',
      }),
    );
    expect(data.vehicleLiters).toBeCloseTo(27.5938, 4);
  });

  it('blocks editing or cancelling a vehicle entry already in a weekly batch', async () => {
    const update = jest.fn();
    const locked = {
      id: 93,
      direction: 'EXPENSE',
      category: 'FUEL',
      sourceType: 'FUEL',
      branchId: 6,
      cashFlowId: null,
      cashIssued: false,
      weeklyBatchId: 12,
      status: 'READY_FOR_WEEKLY_APPROVAL',
    };
    const { service } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue(locked),
        update,
      },
    });
    const user = { id: 7, roles: [], permissions: [] };

    await expect(
      service.updateVehicleEntry(93, { amount: 500000 }, user),
    ).rejects.toThrow('đã được tổng hợp');
    await expect(service.cancelVehicleEntry(93, user)).rejects.toThrow(
      'đã được tổng hợp',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('does not treat a Lark-imported row as an editable vehicle entry', async () => {
    const { service } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 94,
          direction: 'EXPENSE',
          category: 'FUEL',
          sourceType: 'LARK_IMPORT',
          branchId: 6,
          status: 'PENDING_ACCOUNTANT',
        }),
        update: jest.fn(),
      },
    });

    await expect(
      service.updateVehicleEntry(
        94,
        { amount: 1 },
        { id: 7, roles: [], permissions: [] },
      ),
    ).rejects.toThrow('Không tìm thấy phiếu xe');
  });

  it('does not create a warehouse receipt for transfer, zero cash, or a non-warehouse branch', async () => {
    const db = memoryFinanceDb();
    const { service } = makeService();
    const base = {
      id: 21,
      code: 'BD-21',
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
      hasFeeGuiBen: true,
      feeGuiBen: 10000,
      hasFeeGrab: false,
      feeGrab: 0,
      hasCuocGuiHang: false,
      cuocGuiHang: 0,
      hasCuocNhanHang: false,
      cuocNhanHang: 0,
      invoices: [{ invoiceId: 1, invoice: { customerId: 8 } }],
      expenseFiles: [],
      images: [],
    };

    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...base,
        branchId: 6,
        paymentMethod: 'transfer',
        cashAmount: 50000,
      },
      7,
    );
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...base,
        id: 22,
        branchId: 4,
        paymentMethod: 'cash',
        cashAmount: 50000,
      },
      7,
    );
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...base,
        id: 23,
        branchId: 1,
        paymentMethod: 'cash',
        cashAmount: 0,
      },
      7,
    );

    expect(
      [...db.entries.values()].some(
        (entry) => entry.category === 'CUSTOMER_RECEIPT',
      ),
    ).toBe(false);
  });

  it('updates an open cash receipt, keeps a posted one, and cancels when cash is removed', async () => {
    const db = memoryFinanceDb();
    const { service } = makeService();
    const slip = {
      id: 24,
      code: 'BD-24',
      branchId: 1,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
      paymentMethod: 'cash',
      cashAmount: 80000,
      hasFeeGuiBen: false,
      feeGuiBen: 0,
      hasFeeGrab: false,
      feeGrab: 0,
      hasCuocGuiHang: false,
      cuocGuiHang: 0,
      hasCuocNhanHang: false,
      cuocNhanHang: 0,
      invoices: [{ invoiceId: 3, invoice: { customerId: 9 } }],
      expenseFiles: [],
      images: [],
    };
    await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7);
    const receipt = [...db.entries.values()][0];
    expect(receipt.amount).toBe(80000);

    receipt.description = 'Nội dung đã sửa';
    receipt.sourceSnapshot = { ...receipt.sourceSnapshot, contentEdited: true };
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      { ...slip, cashAmount: 90000 },
      7,
    );
    expect(receipt.amount).toBe(90000);
    expect(receipt.description).toBe('Nội dung đã sửa');

    const posted = {
      ...receipt,
      id: 99,
      sourceKey: 'PACKING_SLIP:25:CUSTOMER_RECEIPT',
      status: 'POSTED',
      cashFlowId: 5,
      amount: 1000,
      packingSlipId: 25,
    };
    db.entries.set(posted.sourceKey, posted);
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...slip,
        id: 25,
        cashAmount: 50000,
      },
      7,
    );
    expect(posted.amount).toBe(1000);

    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...slip,
        paymentMethod: 'transfer',
        cashAmount: 0,
      },
      7,
    );
    expect(receipt.status).toBe('CANCELLED');
    expect(posted.status).toBe('POSTED');
  });

  it('rejects an allocation that does not match the cash amount or invoice debt', async () => {
    const { service, prisma, cashFlowsService } = makeService({
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 55, code: 'KH', name: 'An' }]),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 30, code: 'HD1', customerId: 55, debtAmount: 40000 },
          { id: 31, code: 'HD2', customerId: 56, debtAmount: 100000 },
        ]),
      },
    });
    prisma.internalFinanceEntry.findUnique.mockResolvedValue(warehouseEntry());
    await expect(
      service.postWarehouseReceipt(
        4,
        {
          allocations: [{ customerId: 55, amount: 50000, invoices: [] }],
        },
        7,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.postWarehouseReceipt(
        4,
        {
          allocations: [
            {
              customerId: 55,
              amount: 100000,
              invoices: [{ invoiceId: 30, amount: 50000 }],
            },
          ],
        },
        7,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
    await expect(
      service.postWarehouseReceipt(
        4,
        {
          allocations: [
            {
              customerId: 55,
              amount: 100000,
              invoices: [{ invoiceId: 31, amount: 10000 }],
            },
          ],
        },
        7,
      ),
    ).rejects.toThrow('không thuộc khách hàng');
    expect(cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
  });

  it('creates one cash receipt per customer and does not create another on retry', async () => {
    const state = warehouseEntry();
    const { service, prisma, cashFlowsService } = makeService({
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 55, code: 'KH1', name: 'An' },
          { id: 56, code: 'KH2', name: 'Binh' },
        ]),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 30, code: 'HD1', customerId: 55, debtAmount: 40000 },
          { id: 31, code: 'HD2', customerId: 56, debtAmount: 70000 },
        ]),
      },
    });
    state.sourceSnapshot = { customerIds: [55, 56] };
    state.invoiceLinks = [
      { invoice: { id: 30, customerId: 55, code: 'HD1', debtAmount: 40000 } },
      { invoice: { id: 31, customerId: 56, code: 'HD2', debtAmount: 70000 } },
    ];
    prisma.internalFinanceEntry.findUnique.mockImplementation(async () => ({
      ...state,
    }));
    prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 1 });
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    cashFlowsService.createCustomerPayment
      .mockResolvedValueOnce({ cashFlow: { id: 9, code: 'PT000009' } })
      .mockResolvedValueOnce({ cashFlow: { id: 10, code: 'PT000010' } });

    await service.postWarehouseReceipt(
      4,
      {
        allocations: [
          {
            customerId: 55,
            amount: 40000,
            invoices: [{ invoiceId: 30, amount: 40000 }],
          },
          {
            customerId: 56,
            amount: 60000,
            invoices: [{ invoiceId: 31, amount: 50000 }],
          },
        ],
      },
      7,
    );

    expect(cashFlowsService.createCustomerPayment).toHaveBeenCalledTimes(2);
    expect(state.status).toBe('POSTED');
    expect(state.cashFlowId).toBe(9);
    expect((state.sourceSnapshot as any).postedCashFlows).toHaveLength(2);
    await expect(
      service.postWarehouseReceipt(
        4,
        {
          allocations: [
            { customerId: 55, amount: 40000, invoices: [] },
            { customerId: 56, amount: 60000, invoices: [] },
          ],
        },
        7,
      ),
    ).rejects.toThrow('Phiếu thu đã được lập');
    expect(cashFlowsService.createCustomerPayment).toHaveBeenCalledTimes(2);
  });

  it('allocates a customer cash receipt to another unpaid invoice of the same customer', async () => {
    const state = warehouseEntry();
    const { service, prisma, cashFlowsService } = makeService({
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 55, code: 'KH', name: 'An' }]),
      },
      invoice: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 99, code: 'HD99', customerId: 55, debtAmount: 100000 },
          ]),
      },
    });
    prisma.internalFinanceEntry.findUnique.mockImplementation(async () => ({
      ...state,
    }));
    prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 1 });
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    cashFlowsService.createCustomerPayment.mockResolvedValue({
      cashFlow: { id: 11, code: 'TT000011' },
    });

    await service.postWarehouseReceipt(
      4,
      {
        allocations: [
          {
            customerId: 55,
            amount: 100000,
            invoices: [{ invoiceId: 99, amount: 60000 }],
          },
        ],
      },
      7,
    );

    expect(cashFlowsService.createCustomerPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 55,
        totalAmount: 100000,
        invoices: [{ invoiceId: 99, amount: 60000 }],
      }),
      7,
    );
    expect(state.status).toBe('POSTED');
  });

  it('posts a warehouse item sale without a customer or invoice allocation', async () => {
    const state = {
      ...warehouseEntry(),
      subCategory: 'WAREHOUSE_ITEM_SALE',
      customerId: null,
      sourceSnapshot: { receiptKind: 'WAREHOUSE_SALE' },
      invoiceLinks: [],
    };
    const { service, prisma, cashFlowsService } = makeService({
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { findMany: jest.fn() },
    });
    prisma.internalFinanceEntry.findUnique.mockImplementation(async () => ({
      ...state,
    }));
    prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 1 });
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    cashFlowsService.createStandaloneCashReceipt.mockResolvedValue({
      cashFlow: { id: 12, code: 'TT000012' },
    });

    await service.postWarehouseReceipt(4, { allocations: [] }, 7);

    expect(cashFlowsService.createStandaloneCashReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 6, amount: 100000, userId: 7 }),
    );
    expect(cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(state.status).toBe('POSTED');
    expect(state.cashFlowId).toBe(12);

    await expect(
      service.postWarehouseReceipt(4, { allocations: [] }, 7),
    ).rejects.toThrow('Phiếu thu đã được lập');
    expect(cashFlowsService.createStandaloneCashReceipt).toHaveBeenCalledTimes(
      1,
    );
    expect(cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
  });

  it('cancels a warehouse receipt without cashflows', async () => {
    const state = { ...warehouseEntry(), status: 'PENDING_ACCOUNTANT' } as any;
    const { service, prisma, cashFlowsService } = makeService();
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    jest.spyOn(service, 'getWarehouseReceipt').mockResolvedValue(state);

    const result = await service.cancelWarehouseReceipt(
      4,
      { cancelCashFlows: true },
      7,
    );

    expect(result.status).toBe('CANCELLED');
    expect(cashFlowsService.cancelInTransaction).not.toHaveBeenCalled();
    expect(cashFlowsService.logCancellation).not.toHaveBeenCalled();
  });

  it('keeps linked cashflows when cancelling a posted warehouse receipt', async () => {
    const state = {
      ...warehouseEntry(),
      status: 'POSTED',
      cashFlowId: 9,
      sourceSnapshot: {
        customerIds: [55],
        postedCashFlows: [
          { id: 9, code: 'PT000009', customerId: 55, amount: 100000 },
        ],
      },
    } as any;
    const { service, prisma, cashFlowsService } = makeService();
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    jest.spyOn(service, 'getWarehouseReceipt').mockResolvedValue(state);

    await service.cancelWarehouseReceipt(4, { cancelCashFlows: false }, 7);

    expect(cashFlowsService.cancelInTransaction).not.toHaveBeenCalled();
    expect(state.status).toBe('CANCELLED');
  });

  it('cancels every linked cashflow when requested', async () => {
    const state = {
      ...warehouseEntry(),
      status: 'POSTED',
      cashFlowId: 9,
      sourceSnapshot: {
        customerIds: [55, 56],
        postedCashFlows: [
          { id: 9, code: 'PT000009', customerId: 55, amount: 40000 },
          { id: 10, code: 'PT000010', customerId: 56, amount: 60000 },
        ],
      },
    } as any;
    const { service, prisma, cashFlowsService } = makeService();
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    cashFlowsService.cancelInTransaction
      .mockResolvedValueOnce({ cashFlow: { id: 9 }, updated: { id: 9 } })
      .mockResolvedValueOnce({ cashFlow: { id: 10 }, updated: { id: 10 } });
    jest.spyOn(service, 'getWarehouseReceipt').mockResolvedValue(state);

    await service.cancelWarehouseReceipt(4, { cancelCashFlows: true }, 7);

    expect(cashFlowsService.cancelInTransaction).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      9,
    );
    expect(cashFlowsService.cancelInTransaction).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      10,
    );
    expect(cashFlowsService.logCancellation).toHaveBeenCalledTimes(2);
    expect(state.status).toBe('CANCELLED');
  });

  it('rejects cancelling a warehouse receipt twice', async () => {
    const { service, cashFlowsService } = makeService();
    jest.spyOn(service, 'getWarehouseReceipt').mockResolvedValue({
      ...warehouseEntry(),
      status: 'CANCELLED',
    } as any);

    await expect(
      service.cancelWarehouseReceipt(4, { cancelCashFlows: false }, 7),
    ).rejects.toThrow('đã hủy');
    expect(cashFlowsService.cancelInTransaction).not.toHaveBeenCalled();
  });
});

function warehouseEntry() {
  return {
    id: 4,
    code: 'TCNB-THU-HN-20261002-000001',
    direction: 'RECEIPT',
    category: 'CUSTOMER_RECEIPT',
    sourceType: 'PACKING_SLIP',
    sourceKey: 'PACKING_SLIP:9:CUSTOMER_RECEIPT',
    branchId: 6,
    amount: 100000,
    occurredAt: new Date('2026-10-02T00:00:00.000Z'),
    status: 'PENDING_ACCOUNTANT',
    cashFlowId: null,
    customerId: 55,
    description: 'Thu tiền mặt',
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    accountantReviewedBy: null,
    accountantReviewedAt: null,
    sourceSnapshot: { customerIds: [55] },
    invoiceLinks: [
      { invoice: { id: 30, customerId: 55, code: 'HD1', debtAmount: 40000 } },
    ],
  };
}

function memoryFinanceDb() {
  const entries = new Map<string, any>();
  return {
    entries,
    internalFinanceEntry: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(entries.get(where.sourceKey) || null),
      ),
      create: jest.fn(({ data }: any) => {
        const entry = { id: entries.size + 1, ...data };
        entries.set(data.sourceKey, entry);
        return Promise.resolve(entry);
      }),
      update: jest.fn(({ where, data }: any) => {
        const entry = [...entries.values()].find(
          (item) => item.id === where.id,
        );
        Object.assign(entry, data);
        return Promise.resolve(entry);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        let count = 0;
        for (const entry of entries.values()) {
          if (entry.packingSlipId !== where.packingSlipId) continue;
          if (where.sourceKey?.notIn?.includes(entry.sourceKey)) continue;
          if (where.status?.in && !where.status.in.includes(entry.status))
            continue;
          Object.assign(entry, data);
          count += 1;
        }
        return Promise.resolve({ count });
      }),
    },
  };
}
