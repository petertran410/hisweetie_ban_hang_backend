import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProductionCostService } from './production-cost.service';
import { FinanceAccessService } from '../auth/finance-access.service';

const d = (value: number) => new Prisma.Decimal(value);
function fixture() {
  const row: any = {
    id: 1,
    isExternal: true,
    manufacturerId: 5,
    productId: 10,
    destinationBranchId: 2,
    status: 2,
    batchUnitCost: d(206.25),
    outputSpecSnapshot: {
      unit: 'kg',
      weight: null,
      weightUnit: null,
      conversionValue: '1',
      masterUnitId: null,
      isPieceUnit: false,
    },
    costSnapshotAt: new Date(),
    costAppliedAt: null,
    totalCost: d(33000),
    debtAmount: d(25000),
  };
  const inventories = [
    {
      id: 10,
      branchId: 2,
      cost: d(100),
      onHand: d(160),
      branch: { name: 'Kho nhận' },
    },
    {
      id: 11,
      branchId: 3,
      cost: d(150),
      onHand: d(20),
      branch: { name: 'Kho khác' },
    },
  ];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    production: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) => Object.assign(row, data)),
    },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        type: 2,
        unit: 'kg',
        weight: null,
        weightUnit: 'kg',
        conversionValue: d(1),
        masterUnitId: null,
        isPieceUnit: false,
      }),
    },
    inventory: {
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }) =>
          inventories.filter(
            (item) => !where.branchId || item.branchId === where.branchId,
          ),
        ),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(async ({ where }) =>
          inventories.find((item) => item.id === where.id),
        ),
      findUnique: jest
        .fn()
        .mockImplementation(
          async ({ where }) =>
            inventories.find(
              (item) => item.branchId === where.productId_branchId?.branchId,
            ) ?? null,
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Operator' }),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn((callback) => callback(tx)),
  };
  const access: any = { assert: jest.fn().mockResolvedValue(undefined) };
  return {
    row,
    inventories,
    tx,
    prisma,
    access,
    service: new ProductionCostService(prisma, access),
  };
}

describe('explicit production cost application', () => {
  it('takes price from the immutable batch, ignores forged client cost, and changes no quantities or payables', async () => {
    const { service, row, tx, access } = fixture();
    await service.apply(
      1,
      {
        basis: 'batch',
        newCost: 999999,
        expectedCosts: [{ branchId: 2, cost: 100 }],
      },
      7,
    );
    expect(tx.inventory.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { cost: d(206.25) },
    });
    expect(access.assert).toHaveBeenCalledWith(7, 2, 'productions:apply_cost');
    expect(row).toMatchObject({
      costAppliedById: 7,
      costAppliedByName: 'Operator',
      costAppliedScope: 'receiveBranch',
    });
    expect(row.costApplicationSnapshot).toEqual({
      basis: 'batch',
      changes: [{ branchId: 2, before: '100', after: '206.25' }],
    });
    expect(Number(row.batchUnitCost)).toBe(206.25);
    expect(Number(row.totalCost)).toBe(33000);
    expect(Number(row.debtAmount)).toBe(25000);
    expect(
      Object.keys(tx.production.update.mock.calls[0][0].data).sort(),
    ).toEqual(
      [
        'appliedUnitCost',
        'costApplicationSnapshot',
        'costAppliedAt',
        'costAppliedById',
        'costAppliedByName',
        'costAppliedScope',
      ].sort(),
    );
  });

  it('blocks duplicate application after a locked transaction and does not write twice', async () => {
    const { service, tx } = fixture();
    await service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7);
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toThrow();
    expect(tx.inventory.update).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('allows only one concurrent application when the database serializes the production lock', async () => {
    const { service, tx, prisma } = fixture();
    let queue = Promise.resolve();
    prisma.$transaction.mockImplementation(
      (callback: (client: any) => Promise<unknown>) => {
        const run = queue.then(() => callback(tx));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    );
    const results = await Promise.allSettled([
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 8),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(tx.inventory.update).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])('rejects status %s before writing', async (status) => {
    const { service, row, tx } = fixture();
    row.status = status;
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toThrow();
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });

  it('old factory slips (no manufacturer) still apply only when completed', async () => {
    const { service, row, tx } = fixture();
    row.manufacturerId = null;
    row.status = 4;
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toThrow();
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });

  it.each([4, 5])(
    'NSX slip applies the cost fixed at send while status is %s (before all goods arrive)',
    async (status) => {
      const { service, row, tx } = fixture();
      row.status = status;
      await service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7);
      expect(tx.inventory.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { cost: d(206.25) },
      });
      expect(row.costAppliedAt).toBeInstanceOf(Date);
    },
  );

  it('NSX slip sent before cost-at-send: fills the planned unit cost + spec, then applies it', async () => {
    const { service, row, tx } = fixture();
    Object.assign(row, {
      status: 4,
      batchUnitCost: null,
      outputSpecSnapshot: null,
      costSnapshotAt: null,
      materialValue: d(70000),
      processingFee: d(5000),
      manufacturerMaterialCost: d(25000),
      quantity: d(1000),
    });
    await service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7);
    expect(tx.inventory.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { cost: d(100) },
    });
    expect(Number(row.appliedUnitCost)).toBe(100);
  });

  it.each(['unit', 'missing', 'stale', 'missingTarget', 'revoked'])(
    'blocks %s without partial inventory or audit writes',
    async (reason) => {
      const { service, row, tx, access } = fixture();
      if (reason === 'unit')
        tx.product.findUniqueOrThrow.mockResolvedValue({
          type: 2,
          unit: 'túi',
          weight: d(1),
          weightUnit: 'kg',
          conversionValue: d(1),
          masterUnitId: null,
          isPieceUnit: false,
        });
      // Phiếu nhà máy cũ (không NSX) thiếu quy cách: không tự bổ sung, phải chặn.
      if (reason === 'missing') {
        row.manufacturerId = null;
        row.outputSpecSnapshot = null;
      }
      if (reason === 'revoked')
        access.assert.mockRejectedValue(new ForbiddenException());
      const expectedCosts = [
        { branchId: 2, cost: 100 },
        { branchId: 3, cost: reason === 'stale' ? 149 : 150 },
      ];
      await expect(
        service.apply(
          1,
          {
            basis: 'batch',
            scope: 'allBranches',
            expectedCosts:
              reason === 'missingTarget'
                ? expectedCosts.slice(0, 1)
                : expectedCosts,
          },
          7,
        ),
      ).rejects.toThrow();
      expect(tx.inventory.update).not.toHaveBeenCalled();
      expect(tx.production.update).not.toHaveBeenCalled();
    },
  );

  it('checks every actual target branch even if the client is authorized at the receiving branch', async () => {
    const { service, tx, access } = fixture();
    access.assert.mockImplementation(
      async (_user: number, branchId: number) => {
        if (branchId === 3) throw new ForbiddenException();
      },
    );
    await expect(
      service.apply(
        1,
        {
          basis: 'batch',
          scope: 'allBranches',
          expectedCosts: [
            { branchId: 2, cost: 100 },
            { branchId: 3, cost: 150 },
          ],
        },
        7,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });

  it('allows a zero batch price and records all target prices', async () => {
    const { service, row, tx } = fixture();
    row.batchUnitCost = d(0);
    await service.apply(
      1,
      {
        basis: 'batch',
        scope: 'allBranches',
        expectedCosts: [
          { branchId: 2, cost: 100 },
          { branchId: 3, cost: 150 },
        ],
      },
      7,
    );
    expect(tx.inventory.update).toHaveBeenCalledTimes(2);
    expect(Number(row.appliedUnitCost)).toBe(0);
  });

  it('retains the legacy payload behind the same target-branch permission check', async () => {
    const { service, row, access, tx } = fixture();
    row.manufacturerId = null;
    row.batchUnitCost = null;
    row.outputSpecSnapshot = null;
    row.costSnapshotAt = null;
    await service.apply(1, { newCost: 123, expectedOldCost: 100 }, 7);
    expect(access.assert).toHaveBeenCalledWith(7, 2, 'productions:apply_cost');
    expect(tx.inventory.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { cost: d(123) },
    });
    expect(row.costApplicationSnapshot.basis).toBe('legacy');
  });

  it('rejects a changed unit conversion even when the unit and weight labels are unchanged', async () => {
    const { service, tx } = fixture();
    tx.product.findUniqueOrThrow.mockResolvedValue({
      type: 2,
      unit: 'kg',
      weight: null,
      weightUnit: 'kg',
      conversionValue: d(6),
      masterUnitId: null,
      isPieceUnit: false,
    });
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toThrow('Đơn vị/quy cách');
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });

  it('rejects supplier actors and changed service products without recording prices', async () => {
    const { service, tx } = fixture();
    tx.user.findUniqueOrThrow.mockResolvedValue({
      supplierId: 9,
      name: 'Supplier',
    });
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toBeInstanceOf(ForbiddenException);
    tx.user.findUniqueOrThrow.mockResolvedValue({
      supplierId: null,
      name: 'Operator',
    });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      type: 3,
      unit: 'kg',
      weight: null,
      weightUnit: 'kg',
    });
    await expect(
      service.apply(1, { basis: 'batch', expectedOldCost: 100 }, 7),
    ).rejects.toThrow('quản lý tồn');
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });
});

describe('production cost target-branch permission policy', () => {
  const user = { branchId: 2, userBranches: [{ branchId: 3 }], userRoles: [] };
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
  };
  const auth: any = {
    getPermissionsForBranch: jest
      .fn()
      .mockResolvedValue(['productions:apply_cost']),
  };
  const access = new FinanceAccessService(prisma, auth);
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(user);
    auth.getPermissionsForBranch.mockResolvedValue(['productions:apply_cost']);
  });

  it('requires a real branch membership and does not trust a client header', async () => {
    await expect(
      access.assert(7, 2, 'productions:apply_cost'),
    ).resolves.toBeUndefined();
    await expect(
      access.assert(7, 999, 'productions:apply_cost'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each([['productions:view'], ['productions:update'], []])(
    'does not substitute %j for the specialized permission',
    async (...permissions) => {
      auth.getPermissionsForBranch.mockResolvedValue(permissions);
      await expect(
        access.assert(7, 2, 'productions:apply_cost'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('preserves the existing Super Admin bypass without granting regular Admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      userRoles: [{ role: { name: 'Super Admin' } }],
    });
    await expect(
      access.assert(7, 999, 'productions:apply_cost'),
    ).resolves.toBeUndefined();
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      userRoles: [{ role: { name: 'Admin' } }],
    });
    auth.getPermissionsForBranch.mockResolvedValue([]);
    await expect(
      access.assert(7, 2, 'productions:apply_cost'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
