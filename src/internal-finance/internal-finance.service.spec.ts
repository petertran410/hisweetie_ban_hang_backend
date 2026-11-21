import { BadRequestException } from '@nestjs/common';
import { FinanceAccessService } from '../auth/finance-access.service';
import { FinanceAuditService } from '../finance-audit';
import { InternalFinanceService } from './internal-finance.service';
import {
  FUEL_ADVANCE_BATCH_BLOCK,
  fuelAdvanceEntryWhere,
  fuelAdvanceUsedWhere,
} from './fuel-advance';

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
    // Mặc định cho bước đồng bộ dòng quỹ của phiếu Tiền mặt kho.
    prisma.internalFinanceEntry = {
      findMany: jest.fn().mockResolvedValue([]),
      // Gửi Approval tuần đếm phiếu xăng Kho HN còn trong batch.
      count: jest.fn().mockResolvedValue(0),
      ...prisma.internalFinanceEntry,
    };
    prisma.internalFundTransaction = {
      findUnique: jest.fn().mockResolvedValue(null),
      ...prisma.internalFundTransaction,
    };
    // Chứng từ / hóa đơn: gỡ là đặt removedAt (entry-files), không xóa.
    prisma.internalFinanceAttachment = {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(),
      ...prisma.internalFinanceAttachment,
    };
    prisma.internalFinanceInvoiceLink = {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      ...prisma.internalFinanceInvoiceLink,
    };
    prisma.packingSlip = {
      findUnique: jest.fn().mockResolvedValue({ code: 'BD-9' }),
      ...prisma.packingSlip,
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
      issueReviewedExpense: jest.fn(),
      revertReviewedExpense: jest.fn(),
    };
    // Lịch sử: diff thật, write giả (test riêng dùng write thật).
    const financeAudit = new FinanceAuditService();
    const auditWrite = jest
      .spyOn(financeAudit, 'write')
      .mockResolvedValue(undefined);
    return {
      fundLedger,
      financeAudit,
      auditWrite,
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
        financeAudit,
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
      expect.objectContaining({ kind: 'USER', userId: 7 }),
    );
  });

  it('refuses to send a batch still holding Kho HN fuel paid from the fuel advance', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service, approvalLifecycle, prisma } = makeService({
      internalFinanceWeeklyBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 4,
          branchId: 6,
          status: 'READY',
          approvalRequestId: null,
          totalAmount: 100,
          weekStart: new Date('2026-11-15T17:00:00Z'),
          weekEnd: new Date('2026-11-22T16:59:59Z'),
          updatedAt: new Date(),
        }),
        updateMany,
      },
    });
    prisma.internalFinanceEntry.count.mockResolvedValue(2);
    await expect(service.createWeeklyApproval(4, 7)).rejects.toThrow(
      FUEL_ADVANCE_BATCH_BLOCK,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(approvalLifecycle.create).not.toHaveBeenCalled();
  });

  it('reads the Kho HN fuel advance: Lark vouchers in, ticked fuel out', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        id: 1,
        completedAt: new Date('2026-11-15T03:00:00.000Z'),
        amount: 20000000,
        description: 'Ứng xăng',
        requesterName: 'Kế toán',
        form: JSON.stringify([
          { id: 'widget17321752802850001', name: 'Số tiền', value: 20000000 },
          { id: 'a', name: 'Chi phí thuộc phòng ban', value: 'Kho Hà Nội' },
          { id: 'b', name: 'Loại chi phí', value: 'Chi phí kho' },
          {
            id: 'c',
            name: 'Khoản mục chi phí',
            value: 'Xăng xe: oto, xe tại kho',
          },
        ]),
      },
      // Khớp chữ lọc thô nhưng khác khoản mục: bỏ.
      {
        id: 2,
        completedAt: new Date('2026-11-16T03:00:00.000Z'),
        amount: 900000,
        description: null,
        requesterName: null,
        form: JSON.stringify([
          { id: 'a', name: 'Chi phí thuộc phòng ban', value: 'Kho Hà Nội' },
          { id: 'b', name: 'Loại chi phí', value: 'Chi phí kho' },
          {
            id: 'c',
            name: 'Khoản mục chi phí',
            value: 'Sửa chữa, bảo dưỡng; oto xe máy tại kho',
          },
        ]),
      },
    ]);
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 30,
        code: 'TCNB-XD-HN-1',
        amount: 500000,
        occurredAt: new Date('2026-11-16T01:00:00.000Z'),
        vehicleName: '29D',
        managerReviewedAt: new Date('2026-11-16T02:00:00.000Z'),
        accountantReviewedAt: new Date('2026-11-17T02:00:00.000Z'),
        creator: { id: 8, name: 'Lái xe' },
      },
    ]);
    const manualFindMany = jest.fn().mockResolvedValue([
      {
        id: 3,
        branchId: 6,
        occurredAt: new Date('2026-11-13T17:00:00.000Z'),
        amount: 20000000,
        note: 'Ứng trước khi lên POS',
        status: 'ACTIVE',
        createdBy: 4,
      },
    ]);
    const { service, vehicles } = makeService({
      $queryRaw: queryRaw,
      internalFinanceEntry: { findMany },
      fuelAdvanceEntry: { findMany: manualFindMany },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 4, name: 'Kế toán kho' }]),
      },
    });

    const ledger = await service.fuelAdvanceLedger({}, { id: 7 });

    expect(vehicles.assertPermission).toHaveBeenCalledWith(
      { id: 7 },
      6,
      'view',
    );
    expect(findMany.mock.calls[0][0].where.AND[0]).toBe(fuelAdvanceUsedWhere);
    expect(manualFindMany.mock.calls[0][0].where).toMatchObject({
      branchId: 6,
      status: 'ACTIVE',
    });
    // Khoản nhập tay 14/11 + đơn PHIẾU CHI 15/11, trừ phiếu xăng 500.000.
    expect(ledger).toMatchObject({
      opening: 0,
      advanced: 40000000,
      used: 500000,
      closing: 39500000,
    });
    expect(ledger.rows[0]).toMatchObject({
      kind: 'ADVANCE',
      source: 'MANUAL',
      requesterName: 'Kế toán kho',
      balance: 20000000,
    });
    expect(ledger.byCreator).toEqual([
      { creatorId: 8, creatorName: 'Lái xe', count: 1, amount: 500000 },
    ]);
  });

  it('adds a manual fuel advance from 14/11 with the manage permission, and cancels it with a reason', async () => {
    const create = jest.fn(async ({ data }: any) => ({ id: 3, ...data }));
    const update = jest.fn(async ({ data }: any) => ({ id: 3, ...data }));
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ id: 3, status: 'ACTIVE' })
      .mockResolvedValueOnce({ id: 3, status: 'CANCELLED' });
    const { service, vehicles } = makeService({
      fuelAdvanceEntry: { create, update, findUnique },
    });

    await service.createFuelAdvanceEntry(
      { occurredAt: '2026-11-14', amount: 20000000, note: ' Ứng trước ' },
      { id: 7 },
    );
    expect(vehicles.assertPermission).toHaveBeenCalledWith(
      { id: 7 },
      6,
      'manage',
    );
    expect(create.mock.calls[0][0].data).toEqual({
      branchId: 6,
      occurredAt: new Date('2026-11-14T00:00:00+07:00'),
      amount: 20000000,
      note: 'Ứng trước',
      createdBy: 7,
    });
    await expect(
      service.createFuelAdvanceEntry(
        { occurredAt: '2026-11-13', amount: 20000000 },
        { id: 7 },
      ),
    ).rejects.toThrow('14/11/2026');

    await expect(
      service.cancelFuelAdvanceEntry(3, '  ', { id: 7 }),
    ).rejects.toThrow();
    await service.cancelFuelAdvanceEntry(3, 'Nhập sai số', { id: 7 });
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Nhập sai số',
      cancelledBy: 7,
    });
    await expect(
      service.cancelFuelAdvanceEntry(3, 'Lần hai', { id: 7 }),
    ).rejects.toThrow('đã hủy');
  });

  describe('entries ticked after the last prepare (late entries)', () => {
    const batch = {
      id: 4,
      branchId: 6,
      status: 'READY',
      approvalRequestId: null,
      totalAmount: 100,
      weekStart: new Date('2026-11-08T17:00:00Z'),
      weekEnd: new Date('2026-11-15T16:59:59.999Z'),
      updatedAt: new Date(),
    };
    const late = [
      {
        id: 21,
        code: 'TCNB-CHI-HN-20261113-000062',
        occurredAt: new Date('2026-11-12T17:00:00Z'),
        amount: 150000,
        description: 'Mua băng keo',
      },
    ];
    const setup = (rows: any[] = late, row: any = batch) => {
      const findMany = jest.fn(async ({ where }: any) =>
        where?.weeklyBatchId === null ? rows : [],
      );
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const ctx = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue(row),
          updateMany,
          update: jest.fn(),
        },
        internalFinanceEntry: { findMany, updateMany: jest.fn() },
      });
      ctx.approvalLifecycle.create.mockResolvedValue({ id: 55 });
      return { ...ctx, findMany, updateMany };
    };

    it('lists eligible entries of the week that are in no batch yet', async () => {
      const f = setup();
      f.authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:submit',
      ]);
      expect(
        await f.service.warehouseBatchLateEntries(4, { id: 7, roles: [] }),
      ).toEqual({ count: 1, amount: 150000, entries: late });
      const where = f.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        branchId: 6,
        status: { in: ['MANAGER_APPROVED', 'READY_FOR_WEEKLY_APPROVAL'] },
        cashIssued: false,
        cashFlowId: null,
        managerReviewedAt: { not: null },
        accountantReviewedAt: { not: null },
        weeklyBatchId: null,
        occurredAt: { gte: batch.weekStart, lte: batch.weekEnd },
      });
      expect(where.NOT).toEqual(fuelAdvanceEntryWhere);
    });

    it('needs the submit or prepare permission to look', async () => {
      const f = setup();
      await expect(
        f.service.warehouseBatchLateEntries(4, { id: 7, roles: [] }),
      ).rejects.toThrow('Không có quyền');
    });

    it('does not check office batches', async () => {
      const f = setup(late, { ...batch, branchId: 4 });
      f.authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);
      expect(
        await f.service.warehouseBatchLateEntries(4, {
          id: 7,
          roles: [],
          branchIds: [4],
        }),
      ).toMatchObject({ count: 0 });
      expect(f.findMany).not.toHaveBeenCalled();
    });

    it('refuses to send while late entries exist, unless the sender chose to', async () => {
      const blocked = setup();
      await expect(blocked.service.createWeeklyApproval(4, 7)).rejects.toThrow(
        'Có 1 phiếu chi trong tuần đã đủ tick sau lần Tổng hợp',
      );
      expect(blocked.updateMany).not.toHaveBeenCalled();
      expect(blocked.approvalLifecycle.create).not.toHaveBeenCalled();

      const allowed = setup();
      await allowed.service.createWeeklyApproval(
        4,
        7,
        undefined,
        undefined,
        true,
      );
      expect(allowed.approvalLifecycle.create).toHaveBeenCalled();
    });
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
              OR: [
                {
                  category: {
                    in: [
                      'DELIVERY_FEE',
                      'FUEL',
                      'VEHICLE_CARE',
                      'OTHER_EXPENSE',
                    ],
                  },
                },
                // Văn phòng: khoản chi tiền mặt từ đơn PHIẾU CHI Lark.
                { branchId: { in: [4, 7] }, category: 'CASH_FUND_EXPENSE' },
              ],
            },
          ]),
        },
      }),
    );
    await expect(
      service.listWarehouseExpenses({ branchId: 1, page: 1, limit: 50 }, user),
    ).rejects.toThrow('Không có quyền xem phiếu chi của chi nhánh này');
  });

  it('sums warehouse cash receipts (not cancelled) and sorts by difference with unconfirmed last', async () => {
    const keys = [
      { id: 1, amount: 100000, confirmedAmount: 100000 }, // khớp: 0
      { id: 2, amount: 200000, confirmedAmount: null }, // chưa xác nhận
      { id: 3, amount: 300000, confirmedAmount: 250000 }, // thiếu 50.000
      { id: 4, amount: 100000, confirmedAmount: 120000 }, // dư 20.000
    ];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(keys)
      .mockImplementationOnce(({ where }: any) =>
        // Trả lệch thứ tự để kiểm tra service xếp lại theo id đã sắp.
        [...where.id.in].reverse().map((id: number) => ({ id })),
      );
    const aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { amount: 700000 } })
      .mockResolvedValueOnce({
        _sum: { amount: 500000, confirmedAmount: 470000 },
      });
    const { service } = makeService({
      internalFinanceEntry: {
        findMany,
        aggregate,
        count: jest.fn().mockResolvedValue(4),
      },
    });

    const result = await service.listWarehouseReceipts({
      orderBy: 'difference',
      orderDirection: 'desc',
      page: 1,
      limit: 3,
    } as any);

    expect(result.data.map((row: any) => row.id)).toEqual([3, 1, 4]);
    // Không chọn chi nhánh: lấy cả 2 kho và 2 văn phòng.
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({
      branchId: { in: [6, 1, 4, 7] },
    });
    expect(result.totals).toEqual({
      amount: 700000,
      confirmedAmount: 470000,
      difference: 30000,
    });
    expect(aggregate.mock.calls[0][0].where.AND).toContainEqual({
      status: { not: 'CANCELLED' },
    });
    expect(aggregate.mock.calls[1][0].where.AND).toContainEqual({
      confirmedAmount: { not: null },
    });
  });

  it('sorts warehouse cash receipts by confirmed amount with blanks last', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      internalFinanceEntry: {
        findMany,
        aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
        count: jest.fn().mockResolvedValue(0),
      },
    });
    await service.listWarehouseReceipts({
      orderBy: 'confirmedAmount',
      orderDirection: 'asc',
      page: 2,
      limit: 20,
    } as any);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { confirmedAmount: { sort: 'asc', nulls: 'last' } },
          { occurredAt: 'desc' },
          { id: 'desc' },
        ],
        skip: 20,
        take: 20,
      }),
    );
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

  describe('VPSG manual expense: accountant approval is the payout', () => {
    const vpsgEntry = (): any => ({
      id: 90,
      branchId: 7,
      direction: 'EXPENSE',
      sourceType: 'MANUAL_EXPENSE',
      status: 'PENDING_ACCOUNTANT',
      cashIssued: false,
      cashFlowId: null,
      weeklyBatchId: null,
      accountantReviewedAt: null,
      accountantReviewedBy: null,
    });
    const setup = (entry: any) => {
      const review = jest.fn();
      const made = makeService({
        user: {
          findUnique: jest.fn().mockResolvedValue({
            branchId: null,
            userBranches: [{ branchId: 7 }],
            userRoles: [],
          }),
        },
        internalFinanceEntry: {
          findUnique: jest.fn(async () => entry),
          update: jest.fn(async ({ data }: any) => Object.assign(entry, data)),
        },
        internalFinanceReview: { create: review },
      });
      made.authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:check_accountant',
      ]);
      // Bước ghi quỹ (đã có test riêng ở sổ quỹ) đặt Đã chi cho phiếu.
      made.fundLedger.issueReviewedExpense.mockImplementation(async () => {
        entry.cashIssued = true;
      });
      return { ...made, review };
    };
    const user = { id: 8, roles: [] };

    it('approves and pays out on the accountant tick, and reverts on untick', async () => {
      const entry = vpsgEntry();
      const { service, fundLedger, review } = setup(entry);
      await service.checkWarehouseExpense(90, user, {
        role: 'accountant',
        checked: true,
      });
      expect(fundLedger.issueReviewedExpense).toHaveBeenCalledWith(
        expect.anything(),
        entry,
        8,
        false,
        expect.objectContaining({ kind: 'USER', userId: 8 }),
      );
      expect(entry).toMatchObject({
        accountantReviewedBy: 8,
        status: 'APPROVED',
        cashIssued: true,
      });
      expect(review).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: 'ACCOUNTANT',
          decision: 'APPROVE',
        }),
      });

      // Tick lại không ghi quỹ lần nữa.
      await service.checkWarehouseExpense(90, user, {
        role: 'accountant',
        checked: true,
      });
      expect(fundLedger.issueReviewedExpense).toHaveBeenCalledTimes(1);

      await service.checkWarehouseExpense(90, user, {
        role: 'accountant',
        checked: false,
      });
      expect(fundLedger.revertReviewedExpense).toHaveBeenCalledTimes(1);
      expect(entry).toMatchObject({
        accountantReviewedBy: null,
        accountantReviewedAt: null,
        status: 'PENDING_ACCOUNTANT',
        cashIssued: false,
        cashIssuedAt: null,
      });
    });

    it('refuses the manager tick, Lark orders and cancelled entries', async () => {
      const entry = vpsgEntry();
      const { service, fundLedger } = setup(entry);
      await expect(
        service.checkWarehouseExpense(90, user, {
          role: 'manager',
          checked: true,
        }),
      ).rejects.toThrow('chỉ cần Kế toán duyệt');
      entry.sourceType = 'LARK_APPROVAL';
      await expect(
        service.checkWarehouseExpense(90, user, {
          role: 'accountant',
          checked: true,
        }),
      ).rejects.toThrow('Lark Approval');
      entry.sourceType = 'MANUAL_EXPENSE';
      entry.status = 'CANCELLED';
      await expect(
        service.checkWarehouseExpense(90, user, {
          role: 'accountant',
          checked: true,
        }),
      ).rejects.toThrow('đã hủy');
      expect(fundLedger.issueReviewedExpense).not.toHaveBeenCalled();
    });

    it('needs the accountant permission at VPSG', async () => {
      const entry = vpsgEntry();
      const { service, authService, fundLedger } = setup(entry);
      authService.getPermissionsForBranch.mockResolvedValue([]);
      await expect(
        service.checkWarehouseExpense(90, user, {
          role: 'accountant',
          checked: true,
        }),
      ).rejects.toThrow('Không có quyền');
      expect(fundLedger.issueReviewedExpense).not.toHaveBeenCalled();
    });
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
      weekStart: '2026-10-19',
      weekEnd: '2026-10-25',
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
        occurredAt: { lt: new Date('2026-10-19T00:00:00+07:00') },
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
            weekStart: new Date('2026-10-19T00:00:00+07:00'),
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

    it('removes a wrongly added entry, keeping its ticks, and cancels (not deletes) an emptied batch', async () => {
      const updateMany = jest.fn();
      const remove = jest.fn();
      const update = jest.fn();
      const { service, authService, auditWrite } = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue({
            id: 9,
            code: 'TUAN-9',
            branchId: 6,
            status: 'READY',
            approvalRequestId: null,
            totalAmount: 100,
          }),
          delete: remove,
          update,
        },
        internalFinanceEntry: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 5,
              code: 'TCNB-5',
              amount: 100,
              branchId: 6,
              status: 'READY_FOR_WEEKLY_APPROVAL',
              managerReviewedAt: new Date(),
              accountantReviewedAt: new Date(),
            },
          ]),
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
        batchCancelled: true,
        batchDeleted: true,
      });
      expect(updateMany.mock.calls[0][0]).toMatchObject({
        data: { weeklyBatchId: null, status: 'MANAGER_APPROVED' },
      });
      expect(remove).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: {
          status: 'CANCELLED',
          cancelledAt: expect.any(Date),
          cancelledBy: 7,
          cancelReason: 'Tự hủy: đã bỏ hết phiếu khỏi batch',
          cancelledEntryIds: [5],
        },
      });
      const rows = auditWrite.mock.calls[0][1] as any[];
      expect(rows.map((row) => row.action)).toEqual([
        'FIN_BATCH_REMOVE_ENTRIES',
        'FIN_BATCH_CANCEL',
        'FIN_ENTRY_BATCH_REMOVE',
      ]);
      expect(rows[2]).toMatchObject({
        entityId: 5,
        metadata: { batchId: 9, statusBefore: 'READY_FOR_WEEKLY_APPROVAL' },
      });
      expect(new Set(rows.map((row) => row.actor.opId)).size).toBe(1);
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
        { code: 'TCNB-TUAN-HN-2026-W43-2026-10-19-2026-10-25' },
      ]);
      await service.prepareWarehouseExpenseBatch(week, user);
      expect(findFirst.mock.calls[0][0].where.status).toEqual({
        not: 'CANCELLED',
      });
      expect(create.mock.calls[0][0].data.code).toBe(
        'TCNB-TUAN-HN-2026-W43-2026-10-19-2026-10-25-L2',
      );
    });

    it.each([
      ['starts on a Tuesday', '2026-09-29', '2026-10-04'],
      ['is not 7 days', '2026-09-28', '2026-10-05'],
    ])('refuses a week that %s', async (_label, weekStart, weekEnd) => {
      const { service, create, update } = setup();
      await expect(
        service.prepareWarehouseExpenseBatch(
          { branchId: 6, weekStart, weekEnd },
          user,
        ),
      ).rejects.toThrow('đủ 7 ngày, từ Thứ hai đến Chủ nhật');
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('names the batch by the ISO week of its Monday', async () => {
      const { service, create } = setup();
      await service.prepareWarehouseExpenseBatch(
        { branchId: 6, weekStart: '2026-09-28', weekEnd: '2026-10-04' },
        user,
      );
      expect(create.mock.calls[0][0].data.code).toBe(
        'TCNB-TUAN-HN-2026-W40-2026-09-28-2026-10-04',
      );
    });

    it('leaves Kho HN fuel from 14/11 out of the week and the carry-over list', async () => {
      const prepared = setup();
      await prepared.service.prepareWarehouseExpenseBatch(week, user);
      expect(prepared.findMany.mock.calls[0][0].where.NOT).toEqual(
        fuelAdvanceEntryWhere,
      );
      const carry = setup();
      await carry.service.warehouseCarryOver(user, 6, '2026-11-23');
      expect(carry.findMany.mock.calls[0][0].where.NOT).toEqual(
        fuelAdvanceEntryWhere,
      );
    });

    it('offers carry-over entries from any earlier date', async () => {
      const { service, findMany } = setup();
      await service.warehouseCarryOver(user, 6, '2026-10-19');
      expect(findMany.mock.calls[0][0].where.occurredAt).toEqual({
        lt: new Date('2026-10-19T00:00:00+07:00'),
      });
    });

    it('lists carry-over candidates for the preview', async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValueOnce([
        { id: 5, code: 'A', amount: 100 },
        { id: 6, code: 'B', amount: 50 },
      ]);
      expect(
        await service.warehouseCarryOver(user, 6, '2026-10-19'),
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
    expect(single).toHaveBeenCalledWith(
      1,
      expect.anything(),
      { role: 'manager', checked: true },
      expect.any(String),
    );
    // Tick hàng loạt: mỗi phiếu một dòng lịch sử, chung một mã thao tác.
    expect(single.mock.calls[0][3]).toBe(single.mock.calls[1][3]);
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
      // Trạng thái do hủy phiếu đặt: sổ quỹ giữ nguyên trạng thái, cùng người.
      expect(fundLedger.detachFromBatch).toHaveBeenCalledWith(
        expect.anything(),
        entry,
        {
          actor: expect.objectContaining({ kind: 'USER', userId: 7 }),
          reason: expect.stringContaining('Trùng phiếu'),
          keepStatus: true,
        },
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

  describe('replaceWarehouseExpenseAttachments', () => {
    const user = { id: 7, roles: [] };
    const setup = (entry: any) => {
      const ctx = makeService({
        internalFinanceAttachment: {
          deleteMany: jest.fn(),
          createMany: jest.fn(),
        },
        internalFinanceReview: { create: jest.fn() },
      });
      ctx.prisma.internalFinanceEntry.findUnique.mockResolvedValue({
        id: 4,
        branchId: 1,
        direction: 'EXPENSE',
        sourceType: 'LARK_IMPORT',
        category: 'DELIVERY_FEE',
        status: 'PENDING_ACCOUNTANT',
        cashIssued: false,
        cashFlowId: null,
        weeklyBatch: null,
        ...entry,
      });
      ctx.authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:update',
      ]);
      return ctx;
    };
    const files = {
      attachments: [{ fileUrl: 'https://files.example/a.jpg', kind: 'IMAGE' }],
    };

    it('replaces the evidence of a Lark-synced expense, keeping removed files', async () => {
      const { service, prisma, auditWrite } = setup({});
      const old = {
        id: 31,
        entryId: 4,
        kind: 'EVIDENCE',
        fileUrl: 'https://files.example/old.jpg',
        fileName: 'old.jpg',
        removedAt: null,
      };
      prisma.internalFinanceAttachment.findMany
        .mockResolvedValueOnce([old])
        .mockResolvedValueOnce([
          {
            id: 32,
            entryId: 4,
            kind: 'IMAGE',
            fileUrl: files.attachments[0].fileUrl,
          },
        ]);
      await service.replaceWarehouseExpenseAttachments(4, files as any, user);
      expect(
        prisma.internalFinanceAttachment.deleteMany,
      ).not.toHaveBeenCalled();
      expect(prisma.internalFinanceAttachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [31] }, removedAt: null },
        data: { removedAt: expect.any(Date), removedBy: 7 },
      });
      expect(prisma.internalFinanceAttachment.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            entryId: 4,
            fileUrl: 'https://files.example/a.jpg',
            createdBy: 7,
          }),
        ],
      });
      expect(prisma.internalFinanceEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { evidenceStatus: 'COMPLETE' },
        }),
      );
      expect(auditWrite.mock.calls[0][1]).toMatchObject({
        action: 'FIN_ENTRY_ATTACHMENTS_CHANGE',
        entityId: 4,
        params: { added: 1, removed: 1 },
        metadata: {
          removedAttachments: [
            { id: 31, fileUrl: 'https://files.example/old.jpg' },
          ],
        },
      });
    });

    it('logs a status-only change when the same files are saved again', async () => {
      const { service, prisma, auditWrite } = setup({
        evidenceStatus: 'MISSING',
      });
      prisma.internalFinanceAttachment.findMany.mockResolvedValue([
        {
          id: 32,
          entryId: 4,
          kind: 'IMAGE',
          fileUrl: files.attachments[0].fileUrl,
          removedAt: null,
        },
      ]);
      await service.replaceWarehouseExpenseAttachments(4, files as any, user);
      expect(auditWrite).toHaveBeenCalledTimes(1);
      expect(auditWrite.mock.calls[0][1]).toMatchObject({
        action: 'FIN_ENTRY_ATTACHMENTS_CHANGE',
        params: { added: 0, removed: 0 },
        changes: [
          expect.objectContaining({
            field: 'evidenceStatus',
            detail: { from: 'MISSING', to: 'COMPLETE' },
          }),
        ],
      });
    });

    it('writes nothing when files and evidence status are unchanged', async () => {
      const { service, prisma, auditWrite } = setup({
        evidenceStatus: 'COMPLETE',
      });
      prisma.internalFinanceAttachment.findMany.mockResolvedValue([
        {
          id: 32,
          entryId: 4,
          kind: 'IMAGE',
          fileUrl: files.attachments[0].fileUrl,
          removedAt: null,
        },
      ]);
      await service.replaceWarehouseExpenseAttachments(4, files as any, user);
      expect(auditWrite).not.toHaveBeenCalled();
    });

    it.each([
      [{ cashIssued: true }, 'đã chi'],
      [{ weeklyBatch: { status: 'IN_APPROVAL' } }, 'đã gửi duyệt'],
      [{ sourceType: 'PACKING_SLIP' }, 'đồng bộ từ Lark'],
    ])('refuses %j', async (patch, message) => {
      const { service, prisma } = setup(patch);
      await expect(
        service.replaceWarehouseExpenseAttachments(4, files as any, user),
      ).rejects.toThrow(message);
      expect(
        prisma.internalFinanceAttachment.deleteMany,
      ).not.toHaveBeenCalled();
    });
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
    const detachOpts = {
      actor: expect.objectContaining({
        kind: 'USER',
        userId: 7,
        trigger: 'packing-slip',
      }),
      reason: 'Hủy báo đơn BD-9',
      keepStatus: true,
    };
    expect(fundLedger.detachFromBatch).toHaveBeenCalledWith(
      prisma,
      fee,
      detachOpts,
    );
    expect(update).toHaveBeenCalledTimes(2);
    // Hủy báo đơn: mỗi phiếu ghi người hủy + lý do "Hủy báo đơn {mã}".
    for (const call of update.mock.calls)
      expect(call[0].data).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Hủy báo đơn BD-9',
        cancelledBy: 7,
        cancelledAt: expect.any(Date),
      });

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

  it('creates a manual cash receipt at an office and rejects a branch outside the books', async () => {
    const create = jest.fn(async ({ data }: any) => ({ id: 5, ...data }));
    const { service } = makeService({
      internalFinanceEntry: {
        findUnique: jest.fn(),
        create,
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });
    const dto = {
      branchId: 7,
      amount: 250000,
      occurredAt: '2026-11-18T03:00:00.000Z',
      receiptKind: 'WAREHOUSE_SALE',
      description: 'Thu tiền mặt tại văn phòng',
    };

    await service.createWarehouseReceipt(dto as any, 9);
    expect(create.mock.calls[0][0].data).toMatchObject({
      branchId: 7,
      direction: 'RECEIPT',
      sourceType: 'MANUAL_RECEIPT',
    });
    await expect(
      service.createWarehouseReceipt({ ...dto, branchId: 2 } as any, 9),
    ).rejects.toThrow('kho và văn phòng');
  });

  it('lists office branches in the cash receipt scope by role at each branch', async () => {
    const { service, authService } = makeService();
    authService.getPermissionsForBranch.mockImplementation(
      async (_userId: number, branchId: number) =>
        branchId === 7 ? ['warehouse_cash:view'] : [],
    );
    await expect(
      service.warehouseCashBranches(
        { id: 9, roles: [], branchIds: [1, 7] },
        'view',
      ),
    ).resolves.toEqual([7]);
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
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          name: '  Khách buôn Mr Dũng  - Kim Mã, HN (Sale 1 - A1)  ',
        }),
      },
      ...memoryFileTables(),
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
      invoices: [
        { invoiceId: 30, invoice: { code: 'HD131049', customerId: 55 } },
        { invoiceId: 31, invoice: { code: 'HD131050', customerId: 55 } },
      ],
      expenseFiles: [{ fileUrl: 'https://files.example/receipt.jpg' }],
      images: [],
    };

    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      packingSlip,
      7,
    );
    // Nội dung phí giống phiếu đồng bộ từ LarkBase: loại phí - khách - hóa đơn.
    expect(
      [...entries.values()]
        .filter((entry) => entry.category === 'DELIVERY_FEE')
        .map((entry) => entry.description)
        .sort(),
    ).toEqual([
      'Phí Grab - Khách buôn Mr Dũng - Kim Mã, HN (Sale 1 - A1) - HD131049, HD131050',
      'Phí gửi bến - Khách buôn Mr Dũng - Kim Mã, HN (Sale 1 - A1) - HD131049, HD131050',
    ]);
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
    const { service, prisma } = makeService({
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
    // Chứng từ đồng bộ riêng (entry-files), không lồng deleteMany vào update.
    expect(data.attachments).toBeUndefined();
    expect(
      prisma.internalFinanceAttachment.createMany.mock.calls[0][0].data[0],
    ).toMatchObject({ entryId: 94, fileUrl: 'https://cdn/hoa-don.jpg' });
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

  it('does not create a cash receipt for transfer, zero cash, or a branch outside the finance books', async () => {
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
        branchId: 2,
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

  it('creates a cash receipt for an office packing slip paid in cash, without delivery fees', async () => {
    const db = memoryFinanceDb();
    const { service } = makeService();
    await service.syncPackingSlipEntriesInTransaction(
      db as any,
      {
        id: 25,
        code: 'BD-25',
        branchId: 7,
        createdAt: new Date('2026-11-10T03:00:00.000Z'),
        paymentMethod: 'cash',
        cashAmount: 70000,
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
      },
      7,
    );

    expect(db.entries.get('PACKING_SLIP:25:CUSTOMER_RECEIPT')).toMatchObject({
      branchId: 7,
      direction: 'RECEIPT',
      amount: 70000,
    });
    // Phí báo đơn vẫn chỉ ở kho.
    expect(db.entries.has('PACKING_SLIP:25:FEE_GUI_BEN')).toBe(false);
  });

  it('updates the Lark-synced fee entry of the same packing slip instead of creating a twin', async () => {
    const db = memoryFinanceDb();
    db.entries.set('LARK:base:tbl:rec1', {
      id: 99,
      code: 'TCNB-CHI-SG-20261013-000034',
      sourceKey: 'LARK:base:tbl:rec1',
      sourceType: 'LARK_IMPORT',
      direction: 'EXPENSE',
      category: 'DELIVERY_FEE',
      subCategory: 'FEE_GUI_BEN',
      packingSlipId: 31,
      amount: 20000,
      status: 'PENDING_ACCOUNTANT',
      cashIssued: false,
      cashFlowId: null,
      weeklyBatchId: null,
      attachments: [],
      sourceSnapshot: { larkRecordId: 'rec1', larkLedgerRecorded: true },
    });
    const { service } = makeService();
    const slip = {
      id: 31,
      code: 'BD016053',
      branchId: 1,
      createdAt: new Date('2026-10-13T03:00:00.000Z'),
      paymentMethod: 'transfer',
      cashAmount: 0,
      hasFeeGuiBen: true,
      feeGuiBen: 25000,
      hasFeeGrab: false,
      feeGrab: 0,
      hasCuocGuiHang: false,
      cuocGuiHang: 0,
      hasCuocNhanHang: false,
      cuocNhanHang: 0,
      invoices: [],
      expenseFiles: [{ fileUrl: 'https://cdn/chung-tu-moi.jpg' }],
      images: [],
    };

    const result = await service.syncPackingSlipEntriesInTransaction(
      db as any,
      slip,
      7,
    );

    expect(db.internalFinanceEntry.create).not.toHaveBeenCalled();
    const twin = db.entries.get('LARK:base:tbl:rec1');
    expect(twin).toMatchObject({
      amount: 25000,
      status: 'PENDING_ACCOUNTANT',
      evidenceStatus: 'COMPLETE',
      sourceSnapshot: expect.objectContaining({
        larkRecordId: 'rec1',
        larkLedgerRecorded: true,
        packingSlipCode: 'BD016053',
      }),
    });
    expect(
      db.internalFinanceEntry.update.mock.calls[0][0].data,
    ).not.toHaveProperty('attachments');
    expect(db.files.get(99)).toEqual([
      expect.objectContaining({
        fileUrl: 'https://cdn/chung-tu-moi.jpg',
        removedAt: null,
      }),
    ]);
    // Đã trừ trên sổ quỹ Lark theo số cũ: báo để điều chỉnh tay.
    expect(result.locked).toEqual([
      { code: 'TCNB-CHI-SG-20261013-000034', reason: expect.any(String) },
    ]);
    // Không bị hủy ở bước dọn phiếu không còn dùng.
    const dropped = db.internalFinanceEntry.findMany.mock.calls.at(-1)![0];
    expect(dropped.where.sourceKey.notIn).toContain('LARK:base:tbl:rec1');
    expect(db.internalFinanceEntry.updateMany).not.toHaveBeenCalled();
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

  describe('partial receipt posting', () => {
    const setup = () => {
      const state = warehouseEntry();
      const ctx = makeService({
        customer: {
          findMany: jest.fn().mockResolvedValue([
            { id: 55, code: 'KH1', name: 'An' },
            { id: 56, code: 'KH2', name: 'Binh' },
          ]),
        },
        invoice: { findMany: jest.fn().mockResolvedValue([]) },
      });
      state.sourceSnapshot = { customerIds: [55, 56] };
      state.invoiceLinks = [];
      ctx.prisma.internalFinanceEntry.findUnique.mockImplementation(
        async () => ({ ...state }),
      );
      ctx.prisma.internalFinanceEntry.update.mockImplementation(
        async ({ data }: any) => {
          Object.assign(state, data);
          return { ...state };
        },
      );
      return { ...ctx, state };
    };
    const allocations = {
      allocations: [
        { customerId: 55, amount: 40000, invoices: [] },
        { customerId: 56, amount: 60000, invoices: [] },
      ],
    };

    it('logs the claim and the cash receipts already created when a later one fails', async () => {
      const { service, prisma, cashFlowsService, auditWrite, state } = setup();
      prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 1 });
      cashFlowsService.createCustomerPayment
        .mockResolvedValueOnce({ cashFlow: { id: 9, code: 'PT000009' } })
        .mockRejectedValueOnce(new Error('Hóa đơn đã thu đủ'));

      await expect(
        service.postWarehouseReceipt(4, allocations as any, 7),
      ).rejects.toThrow('Hóa đơn đã thu đủ');

      expect(state.status).toBe('POSTING');
      expect(auditWrite).toHaveBeenCalledTimes(1);
      // Phần đã commit ngoài transaction: ghi bằng prisma, không phải tx.
      expect(auditWrite.mock.calls[0][0]).toBe(prisma);
      expect(auditWrite.mock.calls[0][1]).toMatchObject({
        action: 'FIN_ENTRY_POST_FAILED',
        entityId: 4,
        actor: { kind: 'USER', userId: 7 },
        params: {
          code: 'TCNB-THU-HN-20261002-000001',
          error: 'Hóa đơn đã thu đủ',
        },
        changes: [
          expect.objectContaining({
            field: 'status',
            detail: { from: 'PENDING_ACCOUNTANT', to: 'POSTING' },
          }),
        ],
        snapshot: { lines: [{ label: 'Phiếu thu PT000009' }] },
        metadata: {
          partialPost: true,
          stage: 'cashFlows',
          newCashFlows: [expect.objectContaining({ id: 9, customerId: 55 })],
        },
      });
    });

    it('keeps the original error when the failure row cannot be written', async () => {
      const { service, prisma, cashFlowsService, auditWrite } = setup();
      prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 1 });
      cashFlowsService.createCustomerPayment.mockRejectedValue(
        new Error('Mất kết nối'),
      );
      auditWrite.mockRejectedValueOnce(new Error('audit down'));
      const logError = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);
      await expect(
        service.postWarehouseReceipt(4, allocations as any, 7),
      ).rejects.toThrow('Mất kết nối');
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('audit down'),
      );
    });

    it('writes nothing when the claim is lost to another request', async () => {
      const { service, prisma, cashFlowsService, auditWrite } = setup();
      prisma.internalFinanceEntry.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.postWarehouseReceipt(4, allocations as any, 7),
      ).rejects.toThrow('đang được lập hoặc đã lập');
      expect(cashFlowsService.createCustomerPayment).not.toHaveBeenCalled();
      expect(auditWrite).not.toHaveBeenCalled();
    });

    it('writes nothing when a stale retry fails again before creating a receipt', async () => {
      const { service, cashFlowsService, auditWrite, state } = setup();
      Object.assign(state, {
        status: 'POSTING',
        cashFlowId: 9,
        updatedAt: new Date(Date.now() - 60000),
        sourceSnapshot: {
          customerIds: [55, 56],
          postedCashFlows: [
            { id: 9, code: 'PT000009', customerId: 55, amount: 40000 },
          ],
        },
      });
      cashFlowsService.createCustomerPayment.mockRejectedValue(
        new Error('Hóa đơn đã thu đủ'),
      );
      await expect(
        service.postWarehouseReceipt(4, allocations as any, 7),
      ).rejects.toThrow('Hóa đơn đã thu đủ');
      expect(auditWrite).not.toHaveBeenCalled();
    });
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
      // Xác nhận xong là tiền vào quỹ kho, theo ngày báo đơn.
      expect(f.fundLedger.postSystemTransaction).toHaveBeenLastCalledWith(
        f.prisma,
        expect.objectContaining({
          sourceKey: 'WAREHOUSE_RECEIPT:4',
          transactionType: 'RECEIPT',
          amount: 100000,
        }),
      );
      await f.service.confirmWarehouseReceiptAmount(
        4,
        { mode: 'MANUAL', amount: 60000 },
        9,
      );
      expect(f.state).toMatchObject({
        confirmedAmount: 60000,
        confirmedMode: 'MANUAL',
      });
      f.prisma.internalFundTransaction.findUnique.mockResolvedValue({
        amount: 60000,
        branchId: f.state.branchId,
        occurredAt: f.state.occurredAt,
      });
      await f.service.confirmWarehouseReceiptAmount(4, { mode: 'CLEAR' }, 9);
      expect(f.state).toMatchObject({
        confirmedAmount: null,
        confirmedMode: null,
        confirmedBy: null,
      });
      // Bỏ xác nhận: rút tiền khỏi quỹ.
      expect(f.fundLedger.cancelBySource).toHaveBeenLastCalledWith(
        f.prisma,
        'WAREHOUSE_RECEIPT:4',
        9,
        'Bỏ xác nhận số tiền thực nhận',
        expect.objectContaining({ kind: 'USER', userId: 9 }),
      );
      expect(f.reviewCreate).toHaveBeenCalledTimes(3);
    });

    it('books an office receipt to the office fund from the fund start date only', async () => {
      // VPSG: sổ quỹ POS bắt đầu 04/11.
      const after = setup({
        branchId: 7,
        confirmedAmount: null,
        occurredAt: new Date('2026-11-10T03:00:00.000Z'),
      });
      await after.service.confirmWarehouseReceiptAmount(
        4,
        { mode: 'MATCH' },
        9,
      );
      expect(after.fundLedger.postSystemTransaction).toHaveBeenCalledWith(
        after.prisma,
        expect.objectContaining({
          branchId: 7,
          sourceKey: 'WAREHOUSE_RECEIPT:4',
          amount: 100000,
        }),
      );

      // Trước mốc: sổ quỹ Lark đã có khoản này, chỉ lưu số xác nhận.
      for (const [branchId, occurredAt] of [
        [7, '2026-11-03T10:00:00.000Z'],
        [4, '2026-10-30T10:00:00.000Z'],
      ] as const) {
        const before = setup({
          branchId,
          confirmedAmount: null,
          occurredAt: new Date(occurredAt),
        });
        await before.service.confirmWarehouseReceiptAmount(
          4,
          { mode: 'MATCH' },
          9,
        );
        expect(before.state.confirmedAmount).toBe(100000);
        expect(before.fundLedger.postSystemTransaction).not.toHaveBeenCalled();
      }
    });

    it('takes the fund row back when an office receipt moves before the fund start', async () => {
      const f = setup({
        branchId: 7,
        occurredAt: new Date('2026-11-03T10:00:00.000Z'),
      });
      f.prisma.internalFundTransaction.findUnique.mockResolvedValue({
        amount: 100000,
        branchId: 7,
        occurredAt: new Date('2026-11-10T03:00:00.000Z'),
      });
      await f.service.confirmWarehouseReceiptAmount(4, { mode: 'MATCH' }, 9);
      expect(f.fundLedger.cancelBySource).toHaveBeenCalledWith(
        f.prisma,
        'WAREHOUSE_RECEIPT:4',
        9,
        'Ngày thu trước mốc sổ quỹ: đã ghi trên sổ quỹ Lark',
        expect.objectContaining({ kind: 'USER', userId: 9 }),
      );
      expect(f.fundLedger.postSystemTransaction).not.toHaveBeenCalled();
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
      'Hủy phiếu tiền mặt kho',
      expect.objectContaining({ kind: 'USER', userId: 7 }),
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

  describe('export warehouse expenses permission', () => {
    const setup = (byBranch: Record<number, string[]>) => {
      const findMany = jest.fn().mockResolvedValue([]);
      const ctx = makeService({
        internalFinanceEntry: { findMany, groupBy: jest.fn() },
        internalFinanceAttachment: {
          groupBy: jest.fn().mockResolvedValue([]),
        },
      });
      ctx.prisma.internalFinanceEntry.groupBy = jest.fn().mockResolvedValue([]);
      ctx.prisma.user.findMany = jest.fn().mockResolvedValue([]);
      ctx.authService.getPermissionsForBranch.mockImplementation(
        (_userId: number, branchId: number) =>
          Promise.resolve(byBranch[branchId] || []),
      );
      const res: any = { setHeader: jest.fn() };
      return { ...ctx, findMany, res };
    };
    const user = { id: 7, roles: [] };
    const VIEW = 'warehouse_expense:view';
    const EXPORT = 'warehouse_expense:export';

    it('refuses users who can view but not export', async () => {
      const { service, res } = setup({ 1: [VIEW], 6: [VIEW] });
      await expect(
        service.exportWarehouseExpenses({} as any, user, res),
      ).rejects.toThrow('Không có quyền xuất file phiếu chi kho');
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('refuses a branch filter without export permission there', async () => {
      const { service, res } = setup({ 1: [VIEW, EXPORT], 6: [VIEW] });
      await expect(
        service.exportWarehouseExpenses({ branchId: 6 } as any, user, res),
      ).rejects.toThrow('Không có quyền xuất file phiếu chi của chi nhánh này');
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('limits "all branches" to branches with both view and export', async () => {
      // Kho SG xuất được; Kho HN chỉ xem; chi nhánh 4 có quyền xuất mà không xem.
      const { service } = setup({
        1: [VIEW, EXPORT],
        6: [VIEW],
        4: [EXPORT],
      });
      const conditions = await (service as any).warehouseExpenseConditions(
        {},
        user,
        'export',
      );
      expect(conditions).toContainEqual({ branchId: { in: [1] } });
    });
  });

  describe('finance audit log (Cài đặt → Lịch sử)', () => {
    const user = { id: 7, name: 'Kế toán A', roles: [] };
    const rowsOf = (auditWrite: jest.SpyInstance, call = 0): any[] => {
      const rows = auditWrite.mock.calls[call][1];
      return Array.isArray(rows) ? rows : [rows];
    };

    it('soft-removes dropped files when editing a manual warehouse expense and logs the edit', async () => {
      const before = {
        id: 88,
        code: 'TCNB-CHI-HN-1',
        direction: 'EXPENSE',
        category: 'OTHER_EXPENSE',
        sourceType: 'MANUAL_EXPENSE',
        branchId: 6,
        amount: 100000,
        description: 'Băng keo',
        cashFlowId: null,
        cashIssued: false,
        weeklyBatchId: null,
        status: 'PENDING_ACCOUNTANT',
        evidenceStatus: 'COMPLETE',
      };
      // Như Prisma: trường không gửi lên giữ nguyên giá trị cũ.
      const update = jest.fn(async ({ data }: any) => ({
        ...before,
        ...Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        ),
      }));
      const { service, prisma, authService, auditWrite } = makeService({
        internalFinanceEntry: {
          findUnique: jest.fn().mockResolvedValue(before),
          update,
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:update',
      ]);
      prisma.internalFinanceAttachment.findMany.mockResolvedValueOnce([
        {
          id: 41,
          entryId: 88,
          kind: 'EVIDENCE',
          fileUrl: 'https://cdn/keep.jpg',
          removedAt: null,
        },
        {
          id: 42,
          entryId: 88,
          kind: 'EVIDENCE',
          fileUrl: 'https://cdn/drop.jpg',
          fileName: 'drop.jpg',
          removedAt: null,
        },
      ]);

      await service.updateWarehouseExpense(
        88,
        {
          amount: 120000,
          attachments: [{ fileUrl: 'https://cdn/keep.jpg' }],
        } as any,
        user,
      );

      // Gỡ file = đặt removedAt/removedBy; không deleteMany, không tạo lại file giữ.
      expect(prisma.internalFinanceAttachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [42] }, removedAt: null },
        data: { removedAt: expect.any(Date), removedBy: 7 },
      });
      expect(
        prisma.internalFinanceAttachment.createMany,
      ).not.toHaveBeenCalled();
      expect(prisma.internalFinanceAttachment.deleteMany).toBeUndefined();
      const data = update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('attachments');
      expect(JSON.stringify(update.mock.calls)).not.toContain('deleteMany');
      expect(data.evidenceStatus).toBe('COMPLETE');

      const [row] = rowsOf(auditWrite);
      expect(auditWrite.mock.calls[0][0]).toBe(prisma);
      expect(row).toMatchObject({
        action: 'FIN_ENTRY_UPDATE',
        entityId: 88,
        entityCode: 'TCNB-CHI-HN-1',
        branchId: 6,
        actor: { kind: 'USER', userId: 7, userName: 'Kế toán A' },
        params: { code: 'TCNB-CHI-HN-1', kindLabel: 'phiếu chi kho' },
        metadata: {
          removedAttachments: [
            { id: 42, fileUrl: 'https://cdn/drop.jpg', fileName: 'drop.jpg' },
          ],
        },
      });
      expect(row.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'amount',
            from: '100.000 đ',
            to: '120.000 đ',
          }),
          expect.objectContaining({
            field: 'attachments',
            type: 'item_removed',
            from: 'drop.jpg',
          }),
        ]),
      );

      // Lưu lại y nguyên: không ghi dòng sửa.
      await service.updateWarehouseExpense(88, { amount: 100000 }, user);
      expect(rowsOf(auditWrite, 1)).toEqual([]);
    });

    it('writes the create row to audit_logs with the real service, inside the create transaction', async () => {
      const createMany = jest.fn();
      const ctx = makeService({
        branch: {
          findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
        },
        internalFinanceEntry: {
          create: jest.fn(async ({ data }: any) => ({ id: 91, ...data })),
        },
        auditLog: { createMany },
      });
      ctx.auditWrite.mockRestore();
      ctx.authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:create',
      ]);

      await ctx.service.createWarehouseExpense(
        {
          branchId: 6,
          occurredAt: '2026-10-09T00:00:00+07:00',
          description: 'Băng keo',
          amount: 180000,
        } as any,
        user,
      );

      expect(createMany).toHaveBeenCalledTimes(1);
      const [row] = createMany.mock.calls[0][0].data;
      expect(row).toMatchObject({
        actionType: 'POST',
        actionCode: 'FIN_ENTRY_CREATE',
        category: 'internal_finance',
        entityType: 'internal_finance_entries',
        entityId: '91',
        entityCode: 'TCNB-CHI-HN-20260930-000001',
        branchId: 6,
        userId: 7,
        userName: 'Kế toán A',
        metadata: expect.objectContaining({
          actorKind: 'USER',
          trigger: 'http',
          sourceType: 'MANUAL_EXPENSE',
        }),
      });
      expect(row.message).toContain(
        'Tạo phiếu chi kho TCNB-CHI-HN-20260930-000001',
      );
      expect(row.message).toContain('180.000 đ');
    });

    it('logs one row per tick and untick, with the role and status change', async () => {
      const entry: any = {
        id: 77,
        code: 'TCNB-77',
        branchId: 6,
        direction: 'EXPENSE',
        sourceType: 'PACKING_SLIP',
        category: 'DELIVERY_FEE',
        status: 'PENDING_ACCOUNTANT',
        cashIssued: false,
        cashFlowId: null,
        weeklyBatchId: null,
        weeklyBatch: null,
        managerReviewedAt: null,
        accountantReviewedAt: new Date('2026-10-10T03:00:00Z'),
      };
      const { service, authService, auditWrite } = makeService({
        internalFinanceEntry: {
          findUnique: jest.fn(async () => entry),
          update: jest.fn(async ({ data }: any) => Object.assign(entry, data)),
        },
        internalFinanceReview: { create: jest.fn() },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:check_manager',
      ]);

      await service.checkWarehouseExpense(77, user, {
        role: 'manager',
        checked: true,
      });
      await service.checkWarehouseExpense(77, user, {
        role: 'manager',
        checked: false,
      });

      const [check] = rowsOf(auditWrite, 0);
      const [uncheck] = rowsOf(auditWrite, 1);
      expect(check).toMatchObject({
        action: 'FIN_ENTRY_CHECK',
        entityId: 77,
        params: { roleLabel: 'Quản lý kho', code: 'TCNB-77' },
      });
      expect(check.changes).toEqual([
        expect.objectContaining({
          field: 'managerReviewedAt',
          from: 'Không',
          to: 'Có',
        }),
        expect.objectContaining({
          field: 'status',
          from: 'Chờ kiểm tra',
          to: 'Đã kiểm tra',
        }),
      ]);
      expect(uncheck).toMatchObject({
        action: 'FIN_ENTRY_UNCHECK',
        params: { roleLabel: 'Quản lý kho' },
      });
      expect(uncheck.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'status', to: 'Chờ kiểm tra' }),
        ]),
      );
      // Tick lẻ: mỗi lần một mã thao tác riêng.
      expect(check.actor.opId).not.toBe(uncheck.actor.opId);
    });

    it('logs a cancelled warehouse expense with its reason and review', async () => {
      const entry = {
        id: 9,
        code: 'TCNB-CHI-HN-9',
        branchId: 6,
        category: 'OTHER_EXPENSE',
        direction: 'EXPENSE',
        amount: 50000,
        status: 'MANAGER_APPROVED',
        cancelReason: null,
        cashIssued: false,
        cashFlowId: null,
        weeklyBatchId: null,
        weeklyBatch: null,
      };
      const { service, authService, auditWrite } = makeService({
        internalFinanceEntry: {
          findUnique: jest.fn().mockResolvedValue(entry),
          update: jest.fn().mockResolvedValue({ id: 9 }),
        },
        internalFinanceReview: {
          create: jest.fn().mockResolvedValue({ id: 501 }),
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'warehouse_expense:cancel',
      ]);
      await service.cancelWarehouseExpense(9, user, ' Sai số tiền ');
      const [row] = rowsOf(auditWrite);
      expect(row).toMatchObject({
        action: 'FIN_ENTRY_CANCEL',
        entityCode: 'TCNB-CHI-HN-9',
        params: { kindLabel: 'phiếu chi kho', reasonSuffix: ': Sai số tiền' },
        metadata: { statusBefore: 'MANAGER_APPROVED', reviewId: 501 },
      });
      expect(row.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'status', to: 'Đã hủy' }),
          expect.objectContaining({ field: 'cancelReason', to: 'Sai số tiền' }),
        ]),
      );
    });

    it('logs a customer-list change on a manual warehouse receipt even when the first customer stays', async () => {
      const before: any = {
        ...warehouseEntry(),
        sourceType: 'MANUAL_RECEIPT',
        sourceKey: null,
        category: 'MANUAL_RECEIPT',
        subCategory: 'OTHER',
        sourceSnapshot: {
          customerIds: [55, 56],
          receiptKind: 'CUSTOMER',
          manual: true,
          note: '',
        },
        invoiceLinks: [],
      };
      const ctx = makeService({
        customer: {
          findMany: jest.fn().mockResolvedValue([{ id: 55 }, { id: 57 }]),
        },
      });
      ctx.prisma.internalFinanceEntry.findUnique.mockImplementation(
        async ({ include }: any) => (include ? before : null),
      );
      ctx.prisma.internalFinanceEntry.update.mockImplementation(
        async ({ data }: any) => ({
          ...before,
          ...Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
          ),
          invoiceLinks: [],
        }),
      );
      await ctx.service.updateWarehouseReceipt(
        4,
        { customers: [{ customerId: 55 }, { customerId: 57 }] } as any,
        9,
      );
      expect(
        ctx.prisma.internalFinanceEntry.update.mock.calls[0][0].data,
      ).toMatchObject({
        customerId: 55,
        sourceSnapshot: expect.objectContaining({ customerIds: [55, 57] }),
      });
      expect(ctx.auditWrite).toHaveBeenCalledTimes(1);
      const rows = rowsOf(ctx.auditWrite);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'FIN_ENTRY_UPDATE',
        entityId: 4,
        actor: { kind: 'USER', userId: 9 },
      });
      // Một dòng "Khách hàng" cho danh sách, không thêm dòng customerId riêng.
      expect(rows[0].changes).toEqual([
        expect.objectContaining({
          field: 'customerIds',
          label: 'Khách hàng',
          detail: { from: [55, 56], to: [55, 57] },
        }),
      ]);
    });

    it('writes no update row when a warehouse receipt is saved unchanged', async () => {
      const before: any = {
        ...warehouseEntry(),
        sourceType: 'MANUAL_RECEIPT',
        sourceKey: null,
        category: 'MANUAL_RECEIPT',
        // Phiếu cũ: chưa có customerIds trong snapshot.
        sourceSnapshot: { manual: true },
        invoiceLinks: [],
      };
      const ctx = makeService({
        customer: { findMany: jest.fn().mockResolvedValue([{ id: 55 }]) },
      });
      ctx.prisma.internalFinanceEntry.findUnique.mockImplementation(
        async ({ include }: any) => (include ? before : null),
      );
      ctx.prisma.internalFinanceEntry.update.mockImplementation(
        async ({ data }: any) => ({
          ...before,
          ...Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
          ),
          invoiceLinks: [],
        }),
      );
      await ctx.service.updateWarehouseReceipt(
        4,
        { customers: [{ customerId: 55 }] } as any,
        9,
      );
      expect(ctx.auditWrite).toHaveBeenCalledTimes(1);
      expect(rowsOf(ctx.auditWrite)).toEqual([]);
    });

    it('stores the typed reason and canceller when cancelling a warehouse receipt', async () => {
      const cancel = async (reason?: string) => {
        const state = {
          ...warehouseEntry(),
          status: 'PENDING_ACCOUNTANT',
        } as any;
        const ctx = makeService();
        ctx.prisma.internalFinanceEntry.update.mockImplementation(
          async ({ data }: any) => {
            Object.assign(state, data);
            return { ...state };
          },
        );
        jest.spyOn(ctx.service, 'getWarehouseReceipt').mockResolvedValue(state);
        await ctx.service.cancelWarehouseReceipt(
          4,
          { cancelCashFlows: false, ...(reason ? { reason } : {}) },
          9,
        );
        return ctx;
      };

      const typed = await cancel('  Khách trả lại tiền ');
      expect(
        typed.prisma.internalFinanceEntry.update.mock.calls[0][0].data,
      ).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Khách trả lại tiền',
        cancelledBy: 9,
        cancelledAt: expect.any(Date),
      });
      // Chưa lập phiếu thu: tiền rút khỏi quỹ với cùng lý do, cùng người.
      expect(typed.fundLedger.cancelBySource).toHaveBeenCalledWith(
        typed.prisma,
        'WAREHOUSE_RECEIPT:4',
        9,
        'Khách trả lại tiền',
        expect.objectContaining({ kind: 'USER', userId: 9 }),
      );
      const [row] = rowsOf(typed.auditWrite);
      expect(row).toMatchObject({
        action: 'FIN_ENTRY_CANCEL',
        entityId: 4,
        entityCode: 'TCNB-THU-HN-20261002-000001',
        actor: { kind: 'USER', userId: 9 },
        params: {
          kindLabel: 'phiếu thu tiền mặt',
          reasonSuffix: ': Khách trả lại tiền',
        },
        metadata: {
          statusBefore: 'PENDING_ACCOUNTANT',
          cancelCashFlows: false,
          fundReleased: true,
        },
      });

      const blank = await cancel();
      expect(
        blank.prisma.internalFinanceEntry.update.mock.calls[0][0].data
          .cancelReason,
      ).toBe('Hủy phiếu tiền mặt kho');
    });

    it('cancels entries a packing slip drops with a reason, the canceller and one row each', async () => {
      const db = memoryFinanceDb();
      const { service, auditWrite } = makeService();
      const slip = {
        id: 26,
        code: 'BD-26',
        branchId: 6,
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
        paymentMethod: 'cash',
        cashAmount: 50000,
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
      await service.syncPackingSlipEntriesInTransaction(db as any, slip, 7);
      const created = rowsOf(auditWrite, 0);
      expect(created.map((row) => row.action)).toEqual([
        'FIN_ENTRY_CREATE',
        'FIN_ENTRY_CREATE',
      ]);
      expect(created[0].actor).toMatchObject({
        kind: 'USER',
        userId: 7,
        trigger: 'packing-slip',
      });
      expect(created[0].actor.opId).toBe(created[1].actor.opId);
      expect(auditWrite.mock.calls[0][0]).toBe(db);

      await service.syncPackingSlipEntriesInTransaction(
        db as any,
        { ...slip, hasFeeGuiBen: false, paymentMethod: 'transfer' },
        8,
      );
      const fee = db.entries.get('PACKING_SLIP:26:FEE_GUI_BEN');
      const receipt = db.entries.get('PACKING_SLIP:26:CUSTOMER_RECEIPT');
      for (const entry of [fee, receipt])
        expect(entry).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'Báo đơn BD-26 bỏ khoản này',
          cancelledBy: 8,
          cancelledAt: expect.any(Date),
        });
      const dropped = rowsOf(auditWrite, 1);
      expect(dropped.map((row) => [row.action, row.entityId])).toEqual([
        ['FIN_ENTRY_CANCEL', fee.id],
        ['FIN_ENTRY_CANCEL', receipt.id],
      ]);
      expect(dropped[0]).toMatchObject({
        params: { reasonSuffix: ': Báo đơn BD-26 bỏ khoản này' },
        actor: { userId: 8, trigger: 'packing-slip' },
        metadata: { statusBefore: 'PENDING_ACCOUNTANT', packingSlipId: 26 },
      });

      // Báo đơn thu tiền mặt lại: mở lại phiếu thu, xóa thông tin hủy cũ.
      await service.syncPackingSlipEntriesInTransaction(db as any, slip, 8);
      expect(receipt).toMatchObject({
        status: 'PENDING_ACCOUNTANT',
        cancelReason: null,
        cancelledAt: null,
        cancelledBy: null,
      });
      const reopened = rowsOf(auditWrite, 2).find(
        (row) => row.action === 'FIN_ENTRY_REOPEN',
      );
      expect(reopened).toMatchObject({
        entityId: receipt.id,
        params: { reasonSuffix: ': theo báo đơn BD-26' },
        snapshot: {
          cancelledBefore: {
            cancelReason: 'Báo đơn BD-26 bỏ khoản này',
            cancelledBy: 8,
          },
        },
      });
    });

    describe('re-preparing a week with nothing new', () => {
      const prepare = async (keptStatus: string, totalAmount = 100) => {
        const ctx = makeService({
          branch: {
            findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
          },
          internalFinanceWeeklyBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 9,
              code: 'TUAN-9',
              status: 'READY',
              totalAmount,
              entries: [
                { id: 5, code: 'TCNB-5', branchId: 6, status: keptStatus },
              ],
            }),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({ id: 9, code: 'TUAN-9' }),
          },
          internalFinanceEntry: {
            findMany: jest.fn().mockResolvedValue([
              {
                id: 5,
                code: 'TCNB-5',
                amount: 100,
                status: keptStatus,
                branchId: 6,
              },
            ]),
            updateMany: jest.fn(),
          },
        });
        ctx.authService.getPermissionsForBranch.mockResolvedValue([
          'weekly_approval:prepare',
        ]);
        await ctx.service.prepareWarehouseExpenseBatch(
          { branchId: 6, weekStart: '2026-10-19', weekEnd: '2026-10-25' },
          user,
        );
        return rowsOf(ctx.auditWrite);
      };

      it('writes no row when entries, total and statuses are unchanged', async () => {
        expect(await prepare('READY_FOR_WEEKLY_APPROVAL')).toEqual([]);
      });

      it('still logs a changed total', async () => {
        const rows = await prepare('READY_FOR_WEEKLY_APPROVAL', 130);
        expect(rows.map((row) => row.action)).toEqual(['FIN_BATCH_REPREPARE']);
      });

      it('logs a kept entry whose status returns to "đã gom tuần"', async () => {
        const rows = await prepare('PENDING_ACCOUNTANT');
        expect(rows.map((row) => [row.action, row.entityId])).toEqual([
          ['FIN_BATCH_REPREPARE', 9],
          ['FIN_ENTRY_WEEKLY_STATUS', 5],
        ]);
        expect(rows[0].metadata).toMatchObject({ restatusedEntryIds: [5] });
        expect(rows[1]).toMatchObject({
          params: { code: 'TCNB-5', batchCode: 'TUAN-9' },
          changes: [
            expect.objectContaining({
              detail: {
                from: 'PENDING_ACCOUNTANT',
                to: 'READY_FOR_WEEKLY_APPROVAL',
              },
            }),
          ],
        });
      });
    });

    it('logs a re-prepared week with the entries added and dropped', async () => {
      const update = jest.fn().mockResolvedValue({ id: 9, code: 'TUAN-9' });
      const updateMany = jest.fn();
      const { service, authService, auditWrite } = makeService({
        branch: {
          findUnique: jest.fn().mockResolvedValue({ id: 6, isActive: true }),
        },
        internalFinanceWeeklyBatch: {
          findFirst: jest.fn().mockResolvedValue({
            id: 9,
            code: 'TUAN-9',
            status: 'READY',
            totalAmount: 130,
            entries: [
              {
                id: 5,
                code: 'TCNB-5',
                branchId: 6,
                status: 'READY_FOR_WEEKLY_APPROVAL',
              },
              {
                id: 4,
                code: 'TCNB-4',
                branchId: 6,
                status: 'READY_FOR_WEEKLY_APPROVAL',
              },
            ],
          }),
          findMany: jest.fn().mockResolvedValue([]),
          update,
        },
        internalFinanceEntry: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 5,
              code: 'TCNB-5',
              amount: 100,
              status: 'READY_FOR_WEEKLY_APPROVAL',
              branchId: 6,
            },
            {
              id: 6,
              code: 'TCNB-6',
              amount: 50,
              status: 'MANAGER_APPROVED',
              branchId: 6,
            },
          ]),
          updateMany,
        },
      });
      authService.getPermissionsForBranch.mockResolvedValue([
        'weekly_approval:prepare',
      ]);

      await service.prepareWarehouseExpenseBatch(
        { branchId: 6, weekStart: '2026-10-19', weekEnd: '2026-10-25' },
        user,
      );

      const rows = rowsOf(auditWrite);
      expect(rows.map((row) => [row.action, row.entityId])).toEqual([
        ['FIN_BATCH_REPREPARE', 9],
        ['FIN_ENTRY_BATCH_ADD', 6],
        ['FIN_ENTRY_BATCH_REMOVE', 4],
      ]);
      expect(rows[0]).toMatchObject({
        entityCode: 'TUAN-9',
        params: { batchCode: 'TUAN-9', added: 1, dropped: 1, totalAmount: 150 },
        metadata: { addedEntryIds: [6], droppedEntryIds: [4] },
      });
      expect(rows[1].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'weeklyBatchId', to: 'TUAN-9' }),
          expect.objectContaining({ field: 'status', to: 'Đã gom tuần' }),
        ]),
      );
      expect(rows[2]).toMatchObject({
        metadata: { batchId: 9, statusBefore: 'READY_FOR_WEEKLY_APPROVAL' },
      });
      expect(rows[2].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'status', to: 'Đã kiểm tra' }),
        ]),
      );
      expect(new Set(rows.map((row) => row.actor.opId)).size).toBe(1);
    });

    it('logs the Lark submission per batch and entry, and the failure on rollback', async () => {
      const batch = {
        id: 4,
        code: 'TUAN-4',
        branchId: 6,
        status: 'READY',
        approvalRequestId: null,
        totalAmount: 100,
        weekStart: new Date('2026-10-04T17:00:00Z'),
        weekEnd: new Date('2026-10-11T16:59:59Z'),
        updatedAt: new Date(),
      };
      const ok = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue(batch),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn(),
        },
      });
      // Phiếu trong batch; không có phiếu tick muộn (chưa thuộc batch nào).
      ok.prisma.internalFinanceEntry.findMany.mockImplementation(
        async ({ where }: any) =>
          where?.weeklyBatchId === null
            ? []
            : [{ id: 11, code: 'TCNB-11', branchId: 6 }],
      );
      // Lịch sử gửi duyệt ghi trong transaction khóa batch, TRƯỚC khi gọi Lark.
      ok.approvalLifecycle.create.mockImplementation(async () => {
        expect(ok.auditWrite).toHaveBeenCalledTimes(1);
        return { id: 55 };
      });
      await ok.service.createWeeklyApproval(4, 7);
      expect(ok.auditWrite).toHaveBeenCalledTimes(1);
      const rows = rowsOf(ok.auditWrite);
      expect(rows.map((row) => [row.action, row.entityId])).toEqual([
        ['FIN_BATCH_SUBMIT', 4],
        ['FIN_ENTRY_WEEKLY_STATUS', 11],
      ]);
      expect(rows[0]).toMatchObject({
        params: { batchCode: 'TUAN-4', totalAmount: 100 },
        changes: [expect.objectContaining({ field: 'status' })],
        metadata: { kind: 'EXPENSE_HN', entryIds: [11] },
      });
      expect(rows[0].metadata).not.toHaveProperty('approvalRequestId');
      // FIN_APPROVAL_CREATE (approval-lifecycle) dùng chung opId với batch.
      expect(ok.approvalLifecycle.create.mock.calls[0][2].opId).toBe(
        rows[0].actor.opId,
      );
      expect(rows[1].params).toMatchObject({
        code: 'TCNB-11',
        statusLabel: 'Đang duyệt tuần',
      });
      expect(ok.prisma.internalFinanceWeeklyBatch.update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: { approvalRequestId: 55 },
      });

      const failed = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue(batch),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      failed.prisma.internalFinanceEntry.findMany.mockImplementation(
        async ({ where }: any) =>
          where?.weeklyBatchId === null
            ? []
            : [{ id: 11, code: 'TCNB-11', branchId: 6 }],
      );
      failed.approvalLifecycle.create.mockRejectedValue(
        new Error('Offline Lark'),
      );
      await expect(failed.service.createWeeklyApproval(4, 7)).rejects.toThrow(
        'Offline Lark',
      );
      expect(failed.auditWrite).toHaveBeenCalledTimes(2);
      expect(rowsOf(failed.auditWrite, 0).map((row) => row.action)).toEqual([
        'FIN_BATCH_SUBMIT',
        'FIN_ENTRY_WEEKLY_STATUS',
      ]);
      const revert = rowsOf(failed.auditWrite, 1);
      expect(revert.map((row) => [row.action, row.entityId])).toEqual([
        ['FIN_BATCH_SUBMIT_FAILED', 4],
        ['FIN_ENTRY_WEEKLY_STATUS', 11],
      ]);
      expect(revert[0]).toMatchObject({
        params: { batchCode: 'TUAN-4', error: 'Offline Lark' },
        changes: [
          expect.objectContaining({
            field: 'status',
            detail: { from: 'IN_APPROVAL', to: 'READY' },
          }),
        ],
        metadata: { reset: true },
      });
      expect(revert[1].changes).toEqual([
        expect.objectContaining({
          detail: {
            from: 'IN_WEEKLY_APPROVAL',
            to: 'READY_FOR_WEEKLY_APPROVAL',
          },
        }),
      ]);

      // Batch đã bị sự kiện Lark / hủy đổi trong lúc gọi: chỉ ghi lỗi.
      const moved = makeService({
        internalFinanceWeeklyBatch: {
          findUnique: jest.fn().mockResolvedValue(batch),
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      });
      moved.approvalLifecycle.create.mockRejectedValue(new Error('Lỗi mạng'));
      await expect(moved.service.createWeeklyApproval(4, 7)).rejects.toThrow(
        'Lỗi mạng',
      );
      const movedRows = rowsOf(moved.auditWrite, 1);
      expect(movedRows).toHaveLength(1);
      expect(movedRows[0]).toMatchObject({
        action: 'FIN_BATCH_SUBMIT_FAILED',
        metadata: { reset: false },
      });
      expect(movedRows[0].changes).toEqual([]);
    });

    it('logs manual fuel advances added and cancelled', async () => {
      const { service, auditWrite, prisma } = makeService({
        fuelAdvanceEntry: {
          create: jest.fn(async ({ data }: any) => ({ id: 3, ...data })),
          findUnique: jest.fn().mockResolvedValue({
            id: 3,
            branchId: 6,
            status: 'ACTIVE',
            amount: 20000000,
            occurredAt: new Date('2026-11-14T00:00:00+07:00'),
            note: null,
          }),
          update: jest.fn(async ({ data }: any) => ({ id: 3, ...data })),
        },
      });
      await service.createFuelAdvanceEntry(
        { occurredAt: '2026-11-14', amount: 20000000 },
        user,
      );
      await service.cancelFuelAdvanceEntry(3, 'Nhập trùng', user);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(rowsOf(auditWrite, 0)[0]).toMatchObject({
        action: 'FIN_FUEL_ADVANCE_CREATE',
        entityType: 'fuel_advance_entries',
        entityId: 3,
        params: { amount: 20000000, date: '14/11/2026' },
      });
      expect(rowsOf(auditWrite, 1)[0]).toMatchObject({
        action: 'FIN_FUEL_ADVANCE_CANCEL',
        entityId: 3,
        params: { amount: 20000000, reasonSuffix: ': Nhập trùng' },
      });
    });
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

/** Bảng chứng từ / liên kết hóa đơn trong bộ nhớ (theo entryId). */
function memoryFileTables() {
  const files = new Map<number, any[]>();
  const links = new Map<number, any[]>();
  let nextId = 1000;
  const matches = (row: any, where: any) =>
    (!where.id?.in || where.id.in.includes(row.id)) &&
    (where.entryId === undefined || row.entryId === where.entryId) &&
    (!('removedAt' in where) || row.removedAt === where.removedAt);
  const all = (table: Map<number, any[]>) => [...table.values()].flat();
  return {
    files,
    links,
    internalFinanceAttachment: {
      findMany: jest.fn(async ({ where }: any) =>
        all(files).filter((row) => matches(row, where)),
      ),
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) {
          const list = files.get(row.entryId) ?? [];
          list.push({ id: nextId++, removedAt: null, removedBy: null, ...row });
          files.set(row.entryId, list);
        }
        return { count: data.length };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = all(files).filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    },
    internalFinanceInvoiceLink: {
      findMany: jest.fn(async ({ where }: any) =>
        all(links).filter((row) => matches(row, where)),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nextId++, removedAt: null, removedBy: null, ...data };
        links.set(data.entryId, [...(links.get(data.entryId) ?? []), row]);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = all(links).find((item) => item.id === where.id);
        return Object.assign(row, data);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = all(links).filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    },
  };
}

function memoryFinanceDb() {
  const entries = new Map<string, any>();
  return {
    entries,
    ...memoryFileTables(),
    customer: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Khách 55' }),
    },
    // Dòng quỹ đang có của phiếu Tiền mặt kho (theo sourceKey).
    internalFundTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    internalFinanceEntry: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          (where.id
            ? [...entries.values()].find((item) => item.id === where.id)
            : entries.get(where.sourceKey)) || null,
        ),
      ),
      // Phiếu đồng bộ từ Lark cùng báo đơn, cùng loại phí.
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...entries.values()].find(
            (entry) =>
              entry.packingSlipId === where.packingSlipId &&
              entry.sourceType === where.sourceType &&
              entry.subCategory === where.subCategory &&
              entry.status !== 'CANCELLED',
          ) || null,
        ),
      ),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...entries.values()].filter(
            (entry) =>
              entry.packingSlipId === where.packingSlipId &&
              (where.direction
                ? entry.direction === where.direction
                : // Dọn phiếu báo đơn bỏ: thu, hoặc chi chưa vào batch tuần.
                  !where.OR ||
                  where.OR.some(
                    (option: any) =>
                      entry.direction === option.direction &&
                      (!('weeklyBatchId' in option) ||
                        (entry.weeklyBatchId ?? null) === option.weeklyBatchId),
                  )) &&
              !where.sourceKey?.notIn?.includes(entry.sourceKey) &&
              (!where.status?.in || where.status.in.includes(entry.status)),
          ),
        ),
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
          if (where.id?.in && !where.id.in.includes(entry.id)) continue;
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
