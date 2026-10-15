import { BadRequestException } from '@nestjs/common';
import { FinanceAccessService } from '../auth/finance-access.service';
import { InternalFinanceService } from './internal-finance.service';

describe('InternalFinanceService', () => {
  const makeService = (overrides: any = {}) => {
    const prisma = {
      user: {
        // User mặc định của test thuộc cả hai kho, không phải Super Admin.
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          userBranches: [{ branchId: 6 }, { branchId: 1 }],
          userRoles: [],
        }),
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
    const fundLedger = {
      postSystemTransaction: jest.fn().mockResolvedValue({ id: 1 }),
      cancelBySource: jest.fn().mockResolvedValue(null),
      detachFromBatch: jest.fn(),
    };
    return {
      fundLedger,
      service: new InternalFinanceService(
        prisma as any,
        cashFlowsService as any,
        approvalLifecycle as any,
        config as any,
        codeService as any,
        new FinanceAccessService(prisma as any, authService as any),
        internalFund as any,
        vehicles as any,
        fundLedger as any,
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
        clientUuid: 'INTERNAL_FINANCE_WEEK:4:6:2026-10-05:2026-10-11',
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
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });
    authService.getPermissionsForBranch.mockImplementation(
      async (_userId: number, branchId: number) =>
        branchId === 6 ? ['warehouse_expense:view'] : [],
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
    const { service, prisma, authService, internalFund } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({ id: 77, branchId: 6 }),
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:mark_issued',
    ]);
    await service.markWarehouseExpenseIssued(
      77,
      { id: 7, roles: [], permissions: [] },
      { cashIssued: true, reason: 'Chi gấp' },
    );

    expect(internalFund.postExpenseEntry).toHaveBeenCalledWith(
      77,
      7,
      true,
      'Chi gấp',
    );
    expect(prisma.internalFinanceEntry.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { id: true, branchId: true },
    });
  });

  it('does not tick entries from a Lark Approval order', async () => {
    const entry: any = {
      id: 78,
      branchId: 6,
      direction: 'EXPENSE',
      sourceType: 'LARK_APPROVAL',
      status: 'POSTED',
      cashIssued: true,
      cashFlowId: null,
      weeklyBatch: null,
    };
    const update = jest.fn();
    const { service, authService } = makeService({
      internalFinanceEntry: { findUnique: jest.fn(async () => entry), update },
      internalFinanceReview: { create: jest.fn() },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:check_manager',
    ]);
    await expect(
      service.checkWarehouseExpense(
        78,
        { id: 7, roles: [] },
        {
          role: 'manager',
          checked: true,
        },
      ),
    ).rejects.toThrow('Lark Approval');
    expect(update).not.toHaveBeenCalled();
  });

  it('ticks manager and accountant checks independently and derives the status', async () => {
    const entry: any = {
      id: 77,
      branchId: 6,
      direction: 'EXPENSE',
      sourceType: 'PACKING_SLIP',
      status: 'PENDING_ACCOUNTANT',
      cashIssued: false,
      cashFlowId: null,
      weeklyBatchId: null,
      weeklyBatch: null,
      managerReviewedBy: null,
      accountantReviewedBy: null,
    };
    const { service, authService, fundLedger } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn(async () => entry),
        update: jest.fn(async ({ data }: any) => Object.assign(entry, data)),
      },
      internalFinanceReview: { create: jest.fn() },
    });
    const user = { id: 7, roles: [] };
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:check_manager',
    ]);
    await expect(
      service.checkWarehouseExpense(77, user, {
        role: 'accountant',
        checked: true,
      }),
    ).rejects.toThrow('Không có quyền');
    await service.checkWarehouseExpense(77, user, {
      role: 'manager',
      checked: true,
    });
    expect(entry).toMatchObject({
      managerReviewedBy: 7,
      status: 'PENDING_ACCOUNTANT',
    });

    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:check_accountant',
    ]);
    await service.checkWarehouseExpense(
      77,
      { id: 8, roles: [] },
      {
        role: 'accountant',
        checked: true,
      },
    );
    expect(entry).toMatchObject({
      managerReviewedBy: 7,
      accountantReviewedBy: 8,
      status: 'MANAGER_APPROVED',
    });

    // Đã vào batch chưa gửi: bỏ tick thì rút khỏi batch.
    entry.weeklyBatchId = 3;
    entry.weeklyBatch = { id: 3, status: 'READY' };
    await service.checkWarehouseExpense(
      77,
      { id: 8, roles: [] },
      {
        role: 'accountant',
        checked: false,
      },
    );
    expect(fundLedger.detachFromBatch).toHaveBeenCalled();
    expect(entry).toMatchObject({
      accountantReviewedBy: null,
      status: 'PENDING_ACCOUNTANT',
    });

    entry.weeklyBatch = { id: 3, status: 'IN_APPROVAL' };
    await expect(
      service.checkWarehouseExpense(
        77,
        { id: 8, roles: [] },
        {
          role: 'accountant',
          checked: true,
        },
      ),
    ).rejects.toThrow('đã gửi Approval tuần');
  });

  describe('carry-over of expenses missed by earlier weeks', () => {
    const setup = (existing: any = null) => {
      const findMany = jest.fn().mockResolvedValue([{ id: 5, amount: 100 }]);
      const updateMany = jest.fn();
      const update = jest.fn().mockResolvedValue({ id: 9 });
      const create = jest.fn().mockResolvedValue({ id: 10 });
      const findFirst = jest.fn().mockResolvedValue(existing);
      const codes = jest.fn().mockResolvedValue([]);
      const ctx = makeService({
        branch: {
          findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
        },
        internalFinanceWeeklyBatch: {
          findFirst,
          findMany: codes,
          update,
          create,
        },
        internalFinanceEntry: { findMany, updateMany },
      });
      ctx.authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);
      return { ...ctx, findMany, updateMany, update, create, findFirst, codes };
    };
    const user = { id: 7, roles: [] };
    const week = {
      branchId: 6,
      weekStart: '2026-10-20',
      weekEnd: '2026-10-26',
    };

    it('prepares only the week, keeping carry-over entries already added', async () => {
      const { service, findMany } = setup({
        id: 9,
        status: 'READY',
        entries: [{ id: 5 }],
      });
      await service.prepareWarehouseExpenseBatch(week, user);
      const or = findMany.mock.calls[0][0].where.OR;
      // Không tự gộp phiếu sót mới; chỉ giữ phiếu sót đã thêm vào batch này.
      expect(or).toContainEqual({
        occurredAt: { lt: new Date('2026-10-20T00:00:00+07:00') },
        weeklyBatchId: 9,
      });
      expect(JSON.stringify(or)).not.toContain('2026-10-12T17:00:00');
    });

    it('adds chosen carry-over entries to a batch not yet sent to Lark', async () => {
      const updateMany = jest.fn();
      const update = jest.fn();
      const { service, authService } = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue({
            id: 9,
            branchId: 6,
            status: 'READY',
            approvalRequestId: null,
            weekStart: new Date('2026-10-20T00:00:00+07:00'),
          }),
          update,
        },
        internalFinanceEntry: {
          findMany: jest.fn().mockResolvedValue([{ id: 5 }]),
          updateMany,
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 150 } }),
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);
      expect(await service.addCarryOverEntries(9, [5, 6], user)).toEqual({
        added: 1,
        skipped: 1,
      });
      expect(updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: { in: [5] } },
        data: { weeklyBatchId: 9, status: 'READY_FOR_WEEKLY_APPROVAL' },
      });
      expect(update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { totalAmount: 150 },
      });
    });

    it('removes a wrongly added entry, keeping its ticks, and deletes an empty batch', async () => {
      const updateMany = jest.fn();
      const remove = jest.fn();
      const { service, authService } = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue({
            id: 9,
            branchId: 6,
            status: 'READY',
            approvalRequestId: null,
          }),
          delete: remove,
        },
        internalFinanceEntry: {
          count: jest.fn().mockResolvedValue(1),
          updateMany,
          aggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }),
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);
      expect(await service.removeWeeklyBatchEntries(9, [5], user)).toEqual({
        removed: 1,
        batchDeleted: true,
      });
      expect(updateMany.mock.calls[0][0]).toMatchObject({
        data: { weeklyBatchId: null, status: 'MANAGER_APPROVED' },
      });
      expect(remove).toHaveBeenCalledWith({ where: { id: 9 } });
    });

    it('refuses to add entries to a batch already sent to Lark', async () => {
      const { service, authService } = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue({
            id: 9,
            branchId: 6,
            status: 'IN_APPROVAL',
            approvalRequestId: 3,
          }),
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);
      await expect(service.addCarryOverEntries(9, [5], user)).rejects.toThrow(
        'chưa gửi Approval Lark',
      );
    });

    it('returns entries dropped from a re-prepared batch to waiting state', async () => {
      const { service, updateMany } = setup({
        id: 9,
        status: 'READY',
        entries: [{ id: 5 }, { id: 4 }],
      });
      await service.prepareWarehouseExpenseBatch(week, user);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: [4] }, status: 'READY_FOR_WEEKLY_APPROVAL' },
        data: { status: 'MANAGER_APPROVED' },
      });
    });

    it('creates a new batch beside a cancelled one, suffixing a taken code', async () => {
      const { service, findFirst, create, codes } = setup();
      codes.mockResolvedValue([
        { code: 'TCNB-TUAN-HN-2026-W43-2026-10-20-2026-10-26' },
      ]);
      await service.prepareWarehouseExpenseBatch(week, user);
      expect(findFirst.mock.calls[0][0].where.status).toEqual({
        not: 'CANCELLED',
      });
      expect(create.mock.calls[0][0].data.code).toBe(
        'TCNB-TUAN-HN-2026-W43-2026-10-20-2026-10-26-L2',
      );
    });

    it('lists carry-over candidates for the preview', async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValueOnce([
        { id: 5, code: 'A', amount: 100 },
        { id: 6, code: 'B', amount: 50 },
      ]);
      expect(
        await service.warehouseCarryOver(user, 6, '2026-10-20'),
      ).toMatchObject({ total: 150 });
      expect(findMany.mock.calls[0][0].where).toMatchObject({
        weeklyBatchId: null,
        cashIssued: false,
        managerReviewedAt: { not: null },
        accountantReviewedAt: { not: null },
      });
    });
  });

  it('needs the Approval tuần permission, not Phiếu chi kho, to prepare a week', async () => {
    const { service, authService } = makeService({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
      },
    });
    // Đủ quyền Phiếu chi kho nhưng chưa có quyền Approval tuần.
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:view',
      'warehouse_expense:check_manager',
      'weekly_approval:view',
    ]);
    await expect(
      service.prepareWarehouseExpenseBatch(
        { branchId: 6, weekStart: '2026-10-05', weekEnd: '2026-10-11' },
        { id: 7, roles: [] },
      ),
    ).rejects.toThrow('Không có quyền tổng hợp tuần');
  });

  it('prepares a warehouse batch only from entries ticked by both roles', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    // Thứ tự đếm: thuộc batch khác, đã chi, chưa đủ tick.
    const count = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5);
    const { service, authService } = makeService({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
      },
      internalFinanceWeeklyBatch: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      internalFinanceEntry: { findMany, count },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'weekly_approval:prepare',
    ]);
    await expect(
      service.prepareWarehouseExpenseBatch(
        { branchId: 6, weekStart: '2026-10-05', weekEnd: '2026-10-11' },
        { id: 7, roles: [] },
      ),
    ).rejects.toThrow(
      'Không có khoản chi đủ điều kiện để tổng hợp tuần 05/10/2026–11/10/2026: 5 phiếu chưa đủ tick Quản lý kho/Kế toán kho, 3 phiếu đã chi',
    );
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ['MANAGER_APPROVED', 'READY_FOR_WEEKLY_APPROVAL'] },
      managerReviewedAt: { not: null },
      accountantReviewedAt: { not: null },
    });
    // Dòng đồng bộ về cũng được gom khi đã đủ hai tick.
    expect(findMany.mock.calls[0][0].where.sourceType).toBeUndefined();
  });

  it('bulk-ticks entries, keeping already-ticked ones and reporting failures', async () => {
    const { service } = makeService({
      internalFinanceEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            code: 'A',
            managerReviewedAt: null,
            accountantReviewedAt: null,
          },
          {
            id: 2,
            code: 'B',
            managerReviewedAt: new Date(),
            accountantReviewedAt: null,
          },
          {
            id: 3,
            code: 'C',
            managerReviewedAt: null,
            accountantReviewedAt: null,
          },
        ]),
      },
    });
    const single = jest
      .spyOn(service, 'checkWarehouseExpense')
      .mockResolvedValueOnce({ id: 1 } as any)
      .mockRejectedValueOnce(new Error('Khoản chi đã chi hoặc đã hủy'));
    const result = await service.bulkCheckWarehouseExpenses(
      { id: 7, roles: [] },
      { ids: [1, 2, 3, 3, 4], role: 'manager' },
    );
    expect(single).toHaveBeenCalledTimes(2);
    expect(single).toHaveBeenCalledWith(1, expect.anything(), {
      role: 'manager',
      checked: true,
    });
    expect(result.updated).toEqual([{ id: 1 }]);
    expect(result.alreadyChecked).toBe(1);
    expect(result.skipped).toEqual([
      { id: 3, code: 'C', reason: 'Khoản chi đã chi hoặc đã hủy' },
      { id: 4, code: '4', reason: 'Không tìm thấy phiếu' },
    ]);
  });

  describe('cancelWarehouseExpense', () => {
    const open = {
      id: 9,
      branchId: 6,
      direction: 'EXPENSE',
      status: 'MANAGER_APPROVED',
      cashIssued: false,
      cashFlowId: null,
      weeklyBatchId: null,
      weeklyBatch: null,
    };
    const setup = (entry: any, permissions = ['warehouse_expense:cancel']) => {
      const update = jest.fn().mockResolvedValue({ id: entry.id });
      const reviewCreate = jest.fn();
      const ctx = makeService({
        internalFinanceEntry: {
          findUnique: jest.fn().mockResolvedValue(entry),
          update,
        },
        internalFinanceReview: { create: reviewCreate },
      });
      ctx.authService.getPermissionsForBranch.mockResolvedValue(permissions);
      return { ...ctx, update, reviewCreate };
    };
    const user = { id: 7, roles: [] };

    it('cancels an open entry with reason, canceller and history', async () => {
      const { service, update, reviewCreate, internalFund } = setup(open);
      await service.cancelWarehouseExpense(9, user, '  Sai số tiền ');
      expect(internalFund.lockBranch).toHaveBeenCalled();
      expect(update.mock.calls[0][0].data).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Sai số tiền',
        cancelledBy: 7,
        cancelledAt: expect.any(Date),
      });
      expect(reviewCreate.mock.calls[0][0].data).toMatchObject({
        entryId: 9,
        decision: 'CANCEL',
        reason: 'Sai số tiền',
        reviewerId: 7,
      });
    });

    it('detaches an entry from a batch not yet sent to Lark', async () => {
      const entry = {
        ...open,
        weeklyBatchId: 3,
        weeklyBatch: { status: 'READY' },
      };
      const { service, fundLedger } = setup(entry);
      await service.cancelWarehouseExpense(9, user, 'Trùng phiếu');
      expect(fundLedger.detachFromBatch).toHaveBeenCalledWith(
        expect.anything(),
        entry,
      );
    });

    it.each([
      ['an issued entry', { cashIssued: true }, 'hủy giao dịch ở Quỹ nội bộ'],
      [
        'an entry in a submitted weekly approval',
        { weeklyBatchId: 3, weeklyBatch: { status: 'IN_APPROVAL' } },
        'Approval tuần',
      ],
      ['a cancelled entry', { status: 'CANCELLED' }, 'đã được hủy'],
      [
        'an entry from a Lark Approval order',
        { sourceType: 'LARK_APPROVAL', cashIssued: true },
        'Lark Approval',
      ],
    ])('refuses %s', async (_label, patch, message) => {
      const { service, update } = setup({ ...open, ...patch });
      await expect(
        service.cancelWarehouseExpense(9, user, 'Lý do'),
      ).rejects.toThrow(message);
      expect(update).not.toHaveBeenCalled();
    });

    it('requires a reason and the cancel permission', async () => {
      const { service } = setup(open);
      await expect(
        service.cancelWarehouseExpense(9, user, '   '),
      ).rejects.toThrow('lý do');
      const denied = setup(open, ['warehouse_expense:view']);
      await expect(
        denied.service.cancelWarehouseExpense(9, user, 'Lý do'),
      ).rejects.toThrow('Không có quyền');
    });
  });

  it('sorts warehouse expenses by amount and returns totals for the whole filter', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { amount: 1500000 } })
      .mockResolvedValueOnce({ _sum: { amount: 400000 } });
    const { service, authService } = makeService({
      internalFinanceEntry: {
        findMany,
        count: jest.fn().mockResolvedValue(3),
        aggregate,
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:view',
    ]);
    const result = await service.listWarehouseExpenses(
      { orderBy: 'amount', orderDirection: 'asc' } as any,
      { id: 7, roles: [] },
    );
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({ amount: 'asc' });
    expect(aggregate.mock.calls[1][0].where.AND).toContainEqual({
      cashIssued: true,
    });
    expect(result.totals).toEqual({ amount: 1500000, issuedAmount: 400000 });
  });

  it('sums warehouse expenses by payer with the same filters as the list', async () => {
    const groupBy = jest.fn().mockResolvedValue([
      { payerId: 2, _sum: { amount: 850000 }, _count: { _all: 3 } },
      { payerId: null, _sum: { amount: 100000 }, _count: { _all: 1 } },
      { payerId: 1, _sum: { amount: 1100000 }, _count: { _all: 2 } },
    ]);
    const { service, authService } = makeService({
      internalFinanceEntry: { groupBy },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          userBranches: [{ branchId: 6 }, { branchId: 1 }],
          userRoles: [],
        }),
        findMany: jest.fn().mockResolvedValue([
          { id: 1, name: 'Bùi Tấn Thuận' },
          { id: 2, name: 'Bùi Vũ Thành' },
        ]),
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:view',
    ]);
    const result = await service.warehouseExpensePayerSummary(
      { status: 'APPROVED' } as any,
      { id: 7, roles: [] },
    );
    expect(groupBy.mock.calls[0][0].where.AND).toContainEqual({
      status: 'APPROVED',
    });
    expect(result.rows.map((row) => row.name)).toEqual([
      'Bùi Tấn Thuận',
      'Bùi Vũ Thành',
      'Chưa có người chi',
    ]);
    expect(result.total).toBe(2050000);
    expect(result.count).toBe(6);
  });

  it('hides cancelled expenses unless filtered or searched', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service, authService } = makeService({
      internalFinanceEntry: {
        findMany,
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:view',
    ]);
    const user = { id: 7, roles: [] };
    const hidden = { status: { not: 'CANCELLED' } };
    await service.listWarehouseExpenses({} as any, user);
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual(hidden);
    await service.listWarehouseExpenses({ status: 'CANCELLED' } as any, user);
    expect(findMany.mock.calls[1][0].where.AND).not.toContainEqual(hidden);
    await service.listWarehouseExpenses(
      { search: 'TCNB-CHI-HN-1' } as any,
      user,
    );
    expect(findMany.mock.calls[2][0].where.AND).not.toContainEqual(hidden);
  });

  describe('cancelWarehouseExpenseBatch', () => {
    const setup = (batch: any, permissions = ['weekly_approval:prepare']) => {
      const updateMany = jest.fn();
      const remove = jest.fn();
      const update = jest.fn();
      const ctx = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue(batch),
          delete: remove,
          update,
        },
        internalFinanceEntry: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }]),
          updateMany,
        },
      });
      ctx.authService.getPermissionsForBranch.mockResolvedValue(permissions);
      return { ...ctx, updateMany, remove, update };
    };
    const user = { id: 7, roles: [] };

    it('releases entries and keeps the batch as CANCELLED with the reason', async () => {
      const { service, updateMany, remove, update, internalFund } = setup({
        id: 4,
        code: 'TUAN-4',
        branchId: 6,
        status: 'READY',
        approvalRequest: null,
      });
      expect(
        await service.cancelWarehouseExpenseBatch(4, user, ' Trùng tuần 37 '),
      ).toEqual({
        id: 4,
        code: 'TUAN-4',
        released: 3,
      });
      expect(internalFund.lockBranch).toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          weeklyBatchId: 4,
          cashIssued: false,
          managerReviewedAt: { not: null },
          accountantReviewedAt: { not: null },
        },
        data: { status: 'MANAGER_APPROVED' },
      });
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'PENDING_ACCOUNTANT' },
        }),
      );
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { weeklyBatchId: 4 },
        data: { weeklyBatchId: null },
      });
      expect(remove).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelledBy: 7,
          cancelReason: 'Trùng tuần 37',
          cancelledEntryIds: [11, 12, 13],
        }),
      });
    });

    it('requires a reason and refuses a batch already cancelled', async () => {
      const { service, update } = setup({
        id: 4,
        code: 'TUAN-4',
        branchId: 6,
        status: 'CANCELLED',
        approvalRequest: null,
      });
      await expect(
        service.cancelWarehouseExpenseBatch(4, user, '  '),
      ).rejects.toThrow('lý do');
      await expect(
        service.cancelWarehouseExpenseBatch(4, user, 'x'),
      ).rejects.toThrow('đã hủy');
      expect(update).not.toHaveBeenCalled();
    });

    it.each(['CANCELED', 'REJECTED', 'DELETED', 'REVERTED'])(
      'allows cancelling when the Lark Approval is %s',
      async (approvalStatus) => {
        const { service, update } = setup({
          id: 4,
          code: 'TUAN-4',
          branchId: 1,
          status: 'REJECTED',
          approvalRequest: { status: approvalStatus },
        });
        await service.cancelWarehouseExpenseBatch(4, user, 'Lark từ chối');
        expect(update).toHaveBeenCalled();
      },
    );

    it.each([
      ['IN_APPROVAL', { status: 'PENDING' }],
      ['APPROVED', { status: 'APPROVED' }],
      ['IN_APPROVAL', null],
      ['REJECTED', { status: 'PENDING' }],
    ])(
      'refuses a batch %s with Approval %j',
      async (status, approvalRequest) => {
        const { service, updateMany, remove } = setup({
          id: 4,
          code: 'TUAN-4',
          branchId: 6,
          status,
          approvalRequest,
        });
        await expect(
          service.cancelWarehouseExpenseBatch(4, user, 'x'),
        ).rejects.toThrow('không thể hủy batch');
        expect(updateMany).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      },
    );

    it('requires the prepare permission', async () => {
      const { service, remove } = setup(
        {
          id: 4,
          code: 'TUAN-4',
          branchId: 6,
          status: 'READY',
          approvalRequest: null,
        },
        ['warehouse_expense:view'],
      );
      await expect(
        service.cancelWarehouseExpenseBatch(4, user, 'x'),
      ).rejects.toThrow();
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('cancels packing-slip entries, asking about cashflows only when a receipt exists', async () => {
    const receipt: any = {
      id: 1,
      direction: 'RECEIPT',
      status: 'POSTED',
      cashFlowId: 40,
      sourceSnapshot: {},
    };
    const fee: any = {
      id: 2,
      direction: 'EXPENSE',
      status: 'READY_FOR_WEEKLY_APPROVAL',
      weeklyBatchId: 3,
      weeklyBatch: { id: 3, status: 'READY' },
    };
    const update = jest.fn();
    const { service, prisma, cashFlowsService, fundLedger } = makeService({
      internalFinanceEntry: {
        findMany: jest.fn().mockResolvedValue([receipt, fee]),
        update,
      },
    });
    cashFlowsService.cancelInTransaction.mockResolvedValue({ cashFlow: {} });
    expect(await service.packingSlipCancelCheck(9)).toEqual({
      receiptCashFlowCount: 1,
      blockedReason: null,
    });
    await expect(
      service.cancelPackingSlipEntriesInTransaction(
        prisma as any,
        { id: 9, branchId: 6 },
        7,
      ),
    ).rejects.toThrow('cần chọn hủy kèm hay giữ phiếu thu');
    const cancelled = await service.cancelPackingSlipEntriesInTransaction(
      prisma as any,
      { id: 9, branchId: 6 },
      7,
      true,
    );
    expect(cancelled).toHaveLength(1);
    expect(cashFlowsService.cancelInTransaction).toHaveBeenCalledWith(
      prisma,
      40,
    );
    expect(fundLedger.cancelBySource).toHaveBeenCalled();
    expect(fundLedger.detachFromBatch).toHaveBeenCalledWith(prisma, fee);
    expect(update).toHaveBeenCalledTimes(2);

    fee.weeklyBatch.status = 'IN_APPROVAL';
    expect((await service.packingSlipCancelCheck(9)).blockedReason).toContain(
      'đã gửi Approval tuần',
    );
  });

  it('keeps a user assigned to one warehouse out of the other warehouse', async () => {
    const { service, prisma, authService, internalFund } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({ id: 77, branchId: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
    });
    // Vai trò có đủ quyền, nhưng user chỉ được truy cập Kho Hà Nội (6).
    prisma.user.findUnique.mockResolvedValue({
      branchId: 6,
      userBranches: [{ branchId: 6 }],
      userRoles: [],
    });
    authService.getPermissionsForBranch.mockResolvedValue([
      'warehouse_expense:view',
      'warehouse_expense:mark_issued',
      'warehouse_expense:check_manager',
      'warehouse_cash:view',
      'warehouse_cash:post',
      'internal_finance:view',
    ]);
    const user = { id: 7 };

    await service.listWarehouseExpenses({ page: 1, limit: 50 }, user);
    const where = prisma.internalFinanceEntry.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([{ branchId: { in: [6] } }]),
    );
    await expect(
      service.listWarehouseExpenses({ branchId: 1, page: 1, limit: 50 }, user),
    ).rejects.toThrow('Không có quyền xem phiếu chi của chi nhánh này');
    await expect(
      service.markWarehouseExpenseIssued(77, user, { cashIssued: true }),
    ).rejects.toThrow('Không có quyền mark_issued');
    await expect(
      service.checkWarehouseExpense(77, user, {
        role: 'manager',
        checked: true,
      }),
    ).rejects.toThrow('Không có quyền check_manager');
    expect(internalFund.postExpenseEntry).not.toHaveBeenCalled();

    expect(await service.warehouseCashBranches(user, 'view')).toEqual([6]);
    await expect(
      service.assertWarehouseCashEntry(user, 'post', 77),
    ).rejects.toThrow('Không có quyền post tiền mặt kho');
    expect(await service.financeViewBranches(user)).toEqual([6]);
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
      'warehouse_expense:update',
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
      'warehouse_expense:update',
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
      'warehouse_expense:update',
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
      'warehouse_expense:update',
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
      'warehouse_expense:create',
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
      weeklyBatch: { status: 'IN_APPROVAL' },
      status: 'IN_WEEKLY_APPROVAL',
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
    await expect(
      service.cancelVehicleEntry(93, user, 'Sai ngày'),
    ).rejects.toThrow('Approval tuần đã gửi duyệt');
    expect(update).not.toHaveBeenCalled();
  });

  it('edits an open Lark-imported vehicle entry but keeps its original content', async () => {
    const update = jest.fn().mockResolvedValue({ id: 94 });
    const { service } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 94,
          direction: 'EXPENSE',
          category: 'FUEL',
          sourceType: 'LARK_IMPORT',
          branchId: 6,
          amount: 500000,
          description: 'Đổ xăng xe 29D (Lark)',
          cashFlowId: null,
          cashIssued: false,
          weeklyBatchId: null,
          status: 'PENDING_ACCOUNTANT',
          sourceSnapshot: {},
        }),
        update,
      },
    });

    await service.updateVehicleEntry(
      94,
      {
        occurredAt: '2026-10-13T08:00:00+07:00',
        attachments: [{ fileUrl: 'https://cdn/hoa-don.jpg' }],
      } as any,
      { id: 7, roles: [], permissions: [] },
    );
    const data = update.mock.calls[0][0].data;
    expect(data.description).toBeUndefined();
    expect(data.occurredAt).toEqual(new Date('2026-10-13T01:00:00.000Z'));
    expect(data.attachments.create[0].fileUrl).toBe('https://cdn/hoa-don.jpg');
  });

  it('cancels a vehicle entry only with a reason and records who cancelled', async () => {
    const update = jest.fn().mockResolvedValue({ id: 95 });
    const reviewCreate = jest.fn();
    const { service } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 95,
          direction: 'EXPENSE',
          category: 'FUEL',
          sourceType: 'LARK_IMPORT',
          branchId: 6,
          cashFlowId: null,
          cashIssued: false,
          weeklyBatchId: null,
          weeklyBatch: null,
          status: 'PENDING_ACCOUNTANT',
        }),
        update,
      },
      internalFinanceReview: { create: reviewCreate },
    });
    const user = { id: 7, roles: [], permissions: [] };

    await expect(service.cancelVehicleEntry(95, user, '  ')).rejects.toThrow(
      'lý do',
    );
    await service.cancelVehicleEntry(95, user, 'Nhập trùng');
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Nhập trùng',
      cancelledBy: 7,
    });
    expect(reviewCreate.mock.calls[0][0].data).toMatchObject({
      decision: 'CANCEL',
      reason: 'Nhập trùng',
    });
  });

  it('asks the warehouse accountant to confirm again when the packing-slip cash changes', async () => {
    const db = memoryFinanceDb();
    const { service } = makeService();
    const slip = {
      id: 24,
      code: 'BD-24',
      branchId: 6,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
      paymentMethod: 'cash',
      cashAmount: 100000,
      hasFeeGuiBen: false,
      feeGuiBen: 0,
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
    await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7);
    const receipt = db.entries.get('PACKING_SLIP:24:CUSTOMER_RECEIPT');
    Object.assign(receipt, {
      confirmedAmount: 100000,
      confirmedMode: 'MATCH',
      confirmedBy: 9,
    });
    await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7);
    expect(receipt.confirmedAmount).toBe(100000);
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      { ...slip, cashAmount: 80000 },
      7,
    );
    expect(receipt).toMatchObject({
      amount: 80000,
      confirmedAmount: null,
      confirmedMode: null,
      confirmedBy: null,
    });
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

  it('reports fee entries locked in a weekly batch when the packing slip changes', async () => {
    const db = memoryFinanceDb();
    const { service } = makeService();
    const slip = {
      id: 30,
      code: 'BD-30',
      branchId: 6,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
      paymentMethod: 'transfer',
      cashAmount: 0,
      hasFeeGuiBen: true,
      feeGuiBen: 20000,
      hasFeeGrab: false,
      feeGrab: 0,
      hasCuocGuiHang: false,
      cuocGuiHang: 0,
      hasCuocNhanHang: false,
      cuocNhanHang: 0,
      invoices: [],
      expenseFiles: [],
      images: [],
    };
    await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7);
    const fee = [...db.entries.values()][0];
    Object.assign(fee, {
      weeklyBatchId: 3,
      weeklyBatch: { code: 'TCNB-TUAN-HN-W41', status: 'READY' },
      attachments: [],
    });

    // Không đổi gì: không báo.
    expect(
      await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7),
    ).toEqual({ locked: [] });

    const result = await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        ...slip,
        expenseFiles: [{ fileUrl: 'https://cdn/hoa-don.jpg' }],
      },
      7,
    );
    expect(result.locked).toEqual([
      {
        code: fee.code,
        reason: expect.stringContaining('TCNB-TUAN-HN-W41'),
      },
    ]);
    // Phiếu chi giữ nguyên khi đang khóa.
    expect(fee.attachments).toEqual([]);
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
    const { service, prisma, cashFlowsService, fundLedger } = makeService({
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
    expect(fundLedger.postSystemTransaction).toHaveBeenCalledTimes(1);
    expect(fundLedger.postSystemTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        transactionType: 'RECEIPT',
        sourceType: 'WAREHOUSE_CASH_RECEIPT',
        sourceKey: 'WAREHOUSE_RECEIPT:4',
        entryId: 4,
      }),
    );
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

  describe('warehouse accountant confirmed amount', () => {
    const setup = (patch: Record<string, unknown> = {}) => {
      const state: any = { ...warehouseEntry(), ...patch };
      const reviewCreate = jest.fn();
      const ctx = makeService({
        customer: {
          findMany: jest.fn(async ({ where }: any) =>
            (where?.id?.in || [55]).map((id: number) => ({
              id,
              code: `KH${id}`,
              name: `Khách ${id}`,
            })),
          ),
        },
        invoice: {
          findMany: jest.fn().mockResolvedValue([
            { id: 30, code: 'HD1', customerId: 55, debtAmount: 40000 },
            { id: 77, code: 'HD77', customerId: 66, debtAmount: 500000 },
          ]),
        },
        internalFinanceReview: { create: reviewCreate },
      });
      ctx.prisma.internalFinanceEntry.findUnique.mockImplementation(
        async () => ({ ...state }),
      );
      ctx.prisma.internalFinanceEntry.updateMany.mockResolvedValue({
        count: 1,
      });
      ctx.prisma.internalFinanceEntry.update.mockImplementation(
        async ({ data }: any) => {
          Object.assign(state, data);
          return { ...state };
        },
      );
      ctx.cashFlowsService.createCustomerPayment.mockResolvedValue({
        cashFlow: { id: 12, code: 'TT000012' },
      });
      return { ...ctx, state, reviewCreate };
    };

    it('copies the packing-slip amount, takes a typed amount, and clears it', async () => {
      const f = setup({ confirmedAmount: null });
      await f.service.confirmWarehouseReceiptAmount(4, { mode: 'MATCH' }, 9);
      expect(f.state).toMatchObject({
        confirmedAmount: 100000,
        confirmedMode: 'MATCH',
        confirmedBy: 9,
      });
      await f.service.confirmWarehouseReceiptAmount(
        4,
        { mode: 'MANUAL', amount: 60000 },
        9,
      );
      expect(f.state).toMatchObject({
        confirmedAmount: 60000,
        confirmedMode: 'MANUAL',
      });
      await f.service.confirmWarehouseReceiptAmount(4, { mode: 'CLEAR' }, 9);
      expect(f.state).toMatchObject({
        confirmedAmount: null,
        confirmedMode: null,
        confirmedBy: null,
      });
      expect(f.reviewCreate).toHaveBeenCalledTimes(3);
    });

    it('does not change the confirmation of a posted receipt', async () => {
      const f = setup({ status: 'POSTED', cashFlowId: 3 });
      await expect(
        f.service.confirmWarehouseReceiptAmount(4, { mode: 'MATCH' }, 9),
      ).rejects.toThrow('đã lập');
    });

    it.each([
      ['unconfirmed', null, 'chưa xác nhận'],
      ['confirmed as nothing received', 0, 'chưa thu được tiền'],
    ])('refuses to post an %s receipt', async (_label, amount, message) => {
      const f = setup({ confirmedAmount: amount });
      await expect(
        f.service.postWarehouseReceipt(
          4,
          { allocations: [{ customerId: 55, amount: 100000, invoices: [] }] },
          7,
        ),
      ).rejects.toThrow(message);
      expect(f.cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
    });

    it('posts only the confirmed amount, also to another customer, and books it to the fund', async () => {
      const f = setup({ confirmedAmount: 60000 });
      await expect(
        f.service.postWarehouseReceipt(
          4,
          { allocations: [{ customerId: 55, amount: 100000, invoices: [] }] },
          7,
        ),
      ).rejects.toThrow('kế toán kho xác nhận');

      await f.service.postWarehouseReceipt(
        4,
        {
          allocations: [
            {
              customerId: 55,
              amount: 40000,
              invoices: [{ invoiceId: 30, amount: 40000 }],
            },
            {
              customerId: 66,
              amount: 20000,
              invoices: [{ invoiceId: 77, amount: 20000 }],
            },
          ],
        },
        7,
      );
      expect(f.cashFlowsService.createCustomerPayment).toHaveBeenCalledTimes(2);
      expect(f.cashFlowsService.createCustomerPayment).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 66, totalAmount: 20000 }),
        7,
      );
      expect(f.fundLedger.postSystemTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 60000 }),
      );
      expect(f.state.status).toBe('POSTED');
    });

    it('rejects an invoice that belongs to another customer', async () => {
      const f = setup();
      await expect(
        f.service.postWarehouseReceipt(
          4,
          {
            allocations: [
              {
                customerId: 55,
                amount: 100000,
                invoices: [{ invoiceId: 77, amount: 10000 }],
              },
            ],
          },
          7,
        ),
      ).rejects.toThrow('không thuộc khách hàng');
    });
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

  it('does not credit the fund again when posting a receipt synced from the cash ledger', async () => {
    const state = {
      ...warehouseEntry(),
      subCategory: 'WAREHOUSE_ITEM_SALE',
      customerId: null,
      sourceKey: 'LARK_CASH:base:tbl:rec1',
      sourceSnapshot: { receiptKind: 'WAREHOUSE_SALE' },
      invoiceLinks: [],
    };
    const { service, prisma, cashFlowsService, fundLedger } = makeService({
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

    expect(state.status).toBe('POSTED');
    expect((state as any).posManagedAt).toBeInstanceOf(Date);
    expect(fundLedger.postSystemTransaction).not.toHaveBeenCalled();
  });

  it('does not credit the fund again for a receipt already on the Lark Base ledger', async () => {
    const state = {
      ...warehouseEntry(),
      subCategory: 'WAREHOUSE_ITEM_SALE',
      customerId: null,
      sourceSnapshot: {
        receiptKind: 'WAREHOUSE_SALE',
        larkLedgerRecorded: true,
        larkLedgerCode: 'SQ-18088',
      },
      invoiceLinks: [],
    };
    const { service, prisma, cashFlowsService, fundLedger } = makeService({
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
      cashFlow: { id: 13, code: 'TT000013' },
    });

    await service.postWarehouseReceipt(4, { allocations: [] }, 7);

    expect(state.status).toBe('POSTED');
    expect(fundLedger.postSystemTransaction).not.toHaveBeenCalled();
    expect((state as any).sourceSnapshot).toMatchObject({
      larkLedgerRecorded: true,
    });
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

    expect(result!.status).toBe('CANCELLED');
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
    const { service, prisma, cashFlowsService, fundLedger } = makeService();
    prisma.internalFinanceEntry.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(state, data);
        return { ...state };
      },
    );
    jest.spyOn(service, 'getWarehouseReceipt').mockResolvedValue(state);

    await service.cancelWarehouseReceipt(4, { cancelCashFlows: false }, 7);

    expect(cashFlowsService.cancelInTransaction).not.toHaveBeenCalled();
    expect(fundLedger.cancelBySource).not.toHaveBeenCalled();
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
    const { service, prisma, cashFlowsService, fundLedger } = makeService();
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
    expect(fundLedger.cancelBySource).toHaveBeenCalledWith(
      expect.anything(),
      'WAREHOUSE_RECEIPT:4',
      7,
      expect.any(String),
    );
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
    // Kế toán kho đã xác nhận đúng số báo đơn.
    confirmedAmount: 100000,
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
