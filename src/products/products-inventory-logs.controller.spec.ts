import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthService } from '../auth/auth.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';

describe('ProductsController inventory log visibility', () => {
  const logs = [
    { refType: 'invoice', costPrice: 750, transactionPrice: 1200, tonCuoi: 20 },
    {
      refType: 'purchase_order',
      costPrice: 750,
      transactionPrice: 800,
      tonCuoi: 23,
    },
  ];
  const service = {
    findInventoryLogs: jest.fn().mockResolvedValue({ data: logs, total: 2 }),
    findConditionLogs: jest.fn().mockResolvedValue({
      data: [{ refType: 'invoice', costPrice: 750, quantity: 2, tonCuoi: 5 }],
      total: 1,
    }),
  };
  const auth = { getPermissionsForBranch: jest.fn() };
  const cache = { getBranch: jest.fn(), setBranch: jest.fn() };
  const controller = new ProductsController(
    service as unknown as ProductsService,
    auth as unknown as AuthService,
    cache as unknown as PermissionCacheService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    cache.getBranch.mockReturnValue(undefined);
  });

  it('removes both prices for a user with only products:view', async () => {
    const result = await controller.findInventoryLogs('10', {
      user: { id: 7, roles: [], permissions: ['products:view'] },
    });
    expect(result).toEqual({
      data: [
        { refType: 'invoice', tonCuoi: 20 },
        { refType: 'purchase_order', tonCuoi: 23 },
      ],
      total: 2,
    });
    expect(service.findInventoryLogs).toHaveBeenCalledWith(10, undefined, 1, 5);
    expect(logs[0].costPrice).toBe(750);
  });

  it('uses effective branch permissions instead of global grants', async () => {
    auth.getPermissionsForBranch.mockResolvedValue([
      'products:view',
      'products:view_sale_price',
    ]);
    const result = await controller.findInventoryLogs(
      '10',
      {
        user: {
          id: 7,
          roles: [],
          permissions: ['products:view', 'products:view_cost_price'],
        },
        headers: { 'x-branch-id': '3' },
      },
      '3',
      '2',
      '15',
    );
    expect(auth.getPermissionsForBranch).toHaveBeenCalledWith(7, 3);
    expect(result.data[0]).not.toHaveProperty('costPrice');
    expect(result.data[0].transactionPrice).toBe(1200);
    expect(result.data[1]).not.toHaveProperty('transactionPrice');
    expect(service.findInventoryLogs).toHaveBeenCalledWith(10, 3, 2, 15);
  });

  it('honors branch permission cache', async () => {
    cache.getBranch.mockReturnValue([
      'products:view',
      'products:view_cost_price',
    ]);
    const result = await controller.findInventoryLogs('10', {
      user: { id: 7, roles: [], permissions: [] },
      headers: { 'x-branch-id': '3' },
    });
    expect(auth.getPermissionsForBranch).not.toHaveBeenCalled();
    expect(result.data[0].costPrice).toBe(750);
    expect(result.data[0]).not.toHaveProperty('transactionPrice');
    expect(result.data[1].transactionPrice).toBe(800);
  });

  it('keeps the existing Super Admin bypass', async () => {
    const result = await controller.findInventoryLogs('10', {
      user: { id: 1, roles: ['Super Admin'], permissions: [] },
      headers: { 'x-branch-id': '3' },
    });
    expect(result).toEqual({ data: logs, total: 2 });
    expect(auth.getPermissionsForBranch).not.toHaveBeenCalled();
  });

  it('does not leak cost through condition inventory logs', async () => {
    const result = await controller.findConditionLogs(
      '10',
      { user: { id: 7, roles: [], permissions: ['products:view'] } },
      'DAMAGED',
      '3',
      '1',
      '15',
    );
    expect(result).toEqual({
      data: [{ refType: 'invoice', quantity: 2, tonCuoi: 5 }],
      total: 1,
    });
    expect(service.findConditionLogs).toHaveBeenCalledWith(
      10,
      'DAMAGED',
      3,
      1,
      15,
    );
  });
});
