import { FinanceAccessService } from './finance-access.service';

describe('FinanceAccessService', () => {
  const make = (profile: any = {}) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          userBranches: [{ branchId: 6 }],
          userRoles: [],
          ...profile,
        }),
      },
    };
    const auth = {
      // Vai trò có quyền ở mọi chi nhánh: chỉ danh sách chi nhánh mới giới hạn.
      getPermissionsForBranch: jest
        .fn()
        .mockResolvedValue(['warehouse_expense:view', 'vehicles:view']),
    };
    return {
      service: new FinanceAccessService(prisma as any, auth as any),
      prisma,
      auth,
    };
  };

  it('denies a branch outside the user list even when the role holds the permission', async () => {
    const { service, auth } = make();
    expect(await service.can(7, 6, 'warehouse_expense:view')).toBe(true);
    expect(await service.can(7, 1, 'warehouse_expense:view')).toBe(false);
    await expect(
      service.assert(7, 1, 'warehouse_expense:view'),
    ).rejects.toThrow('Thiếu quyền');
    // Không hỏi quyền của chi nhánh user không được truy cập.
    expect(auth.getPermissionsForBranch).not.toHaveBeenCalledWith(7, 1);
    expect(await service.branchesFor(7, 'warehouse_expense:view')).toEqual([6]);
    expect(await service.can(7, 6, 'warehouse_expense:mark_issued')).toBe(
      false,
    );
  });

  it('uses the branch list already on the request user and counts the primary branch', async () => {
    const { service, prisma } = make();
    const requestUser = { id: 7, roles: ['Kế toán'], branchIds: [1] };
    expect(await service.can(requestUser, 1, 'vehicles:view')).toBe(true);
    expect(await service.can(requestUser, 6, 'vehicles:view')).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    const primary = make({ branchId: 1, userBranches: [] });
    expect(await primary.service.can(7, 1, 'vehicles:view')).toBe(true);
  });

  it('lets a Super Admin act on every finance branch', async () => {
    const { service, auth } = make({
      userBranches: [],
      userRoles: [{ role: { name: 'Super Admin' } }],
    });
    expect(await service.can(7, 1, 'internal_fund:close')).toBe(true);
    expect(await service.branchesFor(7, 'cash_flows:view')).toEqual([
      6, 1, 4, 7,
    ]);
    expect(auth.getPermissionsForBranch).not.toHaveBeenCalled();
    expect((await service.summary(7)).superAdmin).toBe(true);
  });

  it('summarises only finance permissions of accessible branches', async () => {
    const { service, auth } = make();
    auth.getPermissionsForBranch.mockResolvedValue([
      'warehouse_cash:view',
      'invoices:view',
    ]);
    expect(await service.summary(7)).toEqual({
      superAdmin: false,
      branches: [{ branchId: 6, permissions: ['warehouse_cash:view'] }],
    });
  });
});
