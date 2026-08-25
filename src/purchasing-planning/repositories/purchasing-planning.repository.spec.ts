import {
  PurchasingPlanningRepository,
  resolveHubBranchScope,
  resolvePurchasingBranchScope,
} from './purchasing-planning.repository';

describe('resolveHubBranchScope', () => {
  it('accepts any set of branches flagged as purchasing hubs', () => {
    expect(
      resolveHubBranchScope([
        { id: 11, name: 'Kho Hà Nội', code: 'HN' },
        { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
        { id: 33, name: 'Kho Đà Nẵng', code: 'DN' },
      ]).branches,
    ).toHaveLength(3);
  });

  it('fails closed when no branch is flagged as a hub', () => {
    expect(() => resolveHubBranchScope([])).toThrow('isPurchasingHub');
  });
});

describe('resolvePurchasingBranchScope', () => {
  it('resolves the two active warehouse names without relying on IDs or row order', () => {
    expect(
      resolvePurchasingBranchScope([
        { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
        { id: 11, name: 'Kho Hà Nội', code: null },
      ]),
    ).toEqual({
      branches: [
        { id: 11, name: 'Kho Hà Nội', code: null },
        { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
      ],
    });
  });

  it.each([
    [[{ id: 11, name: 'Kho Hà Nội', code: 'HN' }], 'Kho Sài Gòn', 0],
    [
      [
        { id: 11, name: 'Kho Hà Nội', code: 'HN-1' },
        { id: 12, name: 'Kho Hà Nội', code: 'HN-2' },
        { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
      ],
      'Kho Hà Nội',
      2,
    ],
  ])('fails closed for a missing or ambiguous branch', (rows, name, count) => {
    expect(() => resolvePurchasingBranchScope(rows)).toThrow(
      `exactly one active branch named "${name}"; found ${count}`,
    );
  });
});

describe('PurchasingPlanningRepository calculation scope', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    branch: { findMany: jest.fn() },
    product: { findMany, findUnique: jest.fn() },
    planningConfig: { findMany },
    inventory: { findMany },
    invoiceDetail: { findMany },
    inventoryLog: { findMany },
    orderSupplierItem: { findMany, findFirst: jest.fn() },
    purchaseOrderItem: { findMany },
    category: { findMany, findFirst: jest.fn() },
  };
  const repository = new PurchasingPlanningRepository(prisma as any);

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    prisma.branch.findMany.mockResolvedValue([
      { id: 11, name: 'Kho Hà Nội', code: 'HN' },
      { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
    ]);
    prisma.product.findUnique.mockResolvedValue(null);
    prisma.orderSupplierItem.findFirst.mockResolvedValue(null);
    prisma.category.findFirst.mockResolvedValue(null);
  });

  it('reuses getPurchasingBranchScope for calculation data loading', async () => {
    const getScope = jest.spyOn(repository, 'getPurchasingBranchScope');

    await repository.loadCalculationData(new Date(), new Date());

    expect(getScope).toHaveBeenCalledTimes(1);
    expect(prisma.branch.findMany).toHaveBeenCalledTimes(1);
    getScope.mockRestore();
  });

  it('scopes resolved config supplier provenance through the shared branch resolver', async () => {
    const getScope = jest.spyOn(repository, 'getPurchasingBranchScope');
    prisma.product.findUnique.mockResolvedValue({
      id: 9,
      code: 'SKU-9',
      name: 'Product 9',
      childName: null,
      conversionValue: 1,
    });
    prisma.orderSupplierItem.findFirst.mockResolvedValue({
      orderSupplier: { supplierId: 8 },
    });

    const result = await repository.findResolvedConfigContext(9);

    expect(getScope).toHaveBeenCalledTimes(1);
    expect(prisma.orderSupplierItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          productId: 9,
          orderSupplier: {
            branchId: { in: [11, 22] },
            status: { not: 4 },
          },
        },
      }),
    );
    expect(result?.supplierId).toBe(8);
    getScope.mockRestore();
  });

  it('fails resolved config context when no hub and legacy names are incomplete', async () => {
    prisma.branch.findMany.mockResolvedValue([]);

    await expect(repository.findResolvedConfigContext(9)).rejects.toThrow(
      'Không có chi nhánh active',
    );
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.orderSupplierItem.findFirst).not.toHaveBeenCalled();
  });

  it('filters every branch-bearing input and nested vehicle shipment', async () => {
    const data = await repository.loadCalculationData(
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const scoped = { in: [11, 22] };

    expect(prisma.inventory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branchId: scoped }),
        select: expect.objectContaining({
          branchName: true,
          branch: { select: { name: true, code: true } },
        }),
      }),
    );
    expect(prisma.invoiceDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoice: expect.objectContaining({ branchId: scoped }),
        }),
      }),
    );
    expect(prisma.inventoryLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branchId: scoped }),
      }),
    );
    expect(prisma.orderSupplierItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderSupplier: expect.objectContaining({ branchId: scoped }),
        }),
        select: expect.objectContaining({
          orderSupplier: expect.objectContaining({
            select: expect.objectContaining({
              vehicleShipmentItems: expect.objectContaining({
                where: {
                  vehicleShipment: { branchId: scoped, status: { not: 3 } },
                },
              }),
            }),
          }),
        }),
      }),
    );
    expect(prisma.purchaseOrderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          purchaseOrder: expect.objectContaining({ branchId: scoped }),
        }),
      }),
    );
    expect(data.branchScope).toEqual({
      branches: [
        { id: 11, name: 'Kho Hà Nội', code: 'HN' },
        { id: 22, name: 'Kho Sài Gòn', code: 'SG' },
      ],
    });
  });

  it('does not launch calculation queries when there is no active branch', async () => {
    prisma.branch.findMany.mockResolvedValue([]);

    await expect(
      repository.loadCalculationData(new Date(), new Date()),
    ).rejects.toThrow('Không có chi nhánh active');
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
