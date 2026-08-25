import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PurchasingPlanningService } from './purchasing-planning.service';

describe('PurchasingPlanningService config', () => {
  const repository = {
    findActiveConfigs: jest.fn(),
    findProductParameters: jest.fn(),
    findResolvedConfigContext: jest.fn(),
    findSupplierEntity: jest.fn(),
    findCategory: jest.fn(),
    findActiveConfigGroup: jest.fn(),
    findConfigEntities: jest.fn(),
    upsertConfigGroup: jest.fn(),
    deactivateConfigGroup: jest.fn(),
  };
  const auditLogs = { create: jest.fn() };
  const service = new PurchasingPlanningService(
    repository as any,
    auditLogs as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogs.create.mockResolvedValue({ id: 1 });
    repository.findConfigEntities.mockImplementation(
      (categoryIds: number[], supplierIds: number[], skuIds: number[]) => ({
        categories: categoryIds.map((id) => ({ id, name: `Category ${id}` })),
        suppliers: supplierIds.map((id) => ({
          id,
          code: `SUP-${id}`,
          name: `Supplier ${id}`,
        })),
        products: skuIds.map((id) => ({
          id,
          code: `SKU-${id}`,
          name: `Product ${id}`,
        })),
      }),
    );
    repository.findResolvedConfigContext.mockResolvedValue({
      product: {
        id: 9,
        code: 'SKU-9',
        name: 'Product 9',
        conversionValue: 24,
      },
      supplierId: 8,
      categoryId: 7,
    });
  });

  it('returns groups with batch-loaded entity metadata', async () => {
    repository.findActiveConfigs.mockResolvedValue([
      row('GLOBAL', null, 'safetyDays', 30),
      row('CATEGORY', 7, 'safetyDays', 10),
      row('SUPPLIER', 8, 'coverageDays', 45),
      row('SKU', 9, 'moq', 24),
    ]);

    const result = await service.getConfigs();

    expect(repository.findConfigEntities).toHaveBeenCalledTimes(1);
    expect(repository.findConfigEntities).toHaveBeenCalledWith([7], [8], [9]);
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'GLOBAL',
          scope: 'GLOBAL',
          entity: null,
          overrides: { safetyDays: 30 },
          isActive: true,
        }),
        expect.objectContaining({
          id: 'SUPPLIER:8',
          scope: 'SUPPLIER',
          entity: { id: 8, code: 'SUP-8', name: 'Supplier 8' },
          overrides: { coverageDays: 45 },
        }),
      ]),
    );
  });

  it('returns hierarchy provenance and Product conversion packSize', async () => {
    repository.findActiveConfigs.mockResolvedValue([
      row('GLOBAL', null, 'safetyDays', 30),
      row('CATEGORY', 7, 'safetyDays', 25),
      row('SUPPLIER', 8, 'coverageDays', 45),
      row('SKU', 9, 'safetyDays', 15),
    ]);
    repository.findCategory.mockResolvedValue({ name: 'Tea', type: 'child' });
    repository.findSupplierEntity.mockResolvedValue({ id: 8 });
    const result = await service.getResolvedConfig({ skuId: 9 });

    expect(result.effective.safetyDays).toBe(15);
    expect(result.source.safetyDays).toMatchObject({
      scopeType: 'SKU',
      scopeId: 9,
      code: 'SKU-9',
      name: 'Product 9',
      label: 'Cấu hình riêng SKU: Product 9',
    });
    expect(result.raw.current).toEqual({ safetyDays: 15 });
    expect(result.raw.inherited.safetyDays).toBe(25);
    expect(result.productParameters).toMatchObject({
      packSize: 24,
      source: 'PRODUCT',
      label: 'Sản phẩm · Định lượng đóng gói',
    });
    expect(result).toMatchObject({
      scope: 'SKU',
      entity: { id: 9, code: 'SKU-9', name: 'Product 9' },
      configId: 'SKU:9',
      overrides: { safetyDays: 15 },
    });
    expect(result.fields.safetyDays).toMatchObject({
      effective: 15,
      current: 15,
      inherited: 25,
    });
    expect(repository.findConfigEntities).toHaveBeenCalledWith([7], [8], [9]);
  });

  it.each([0, -2, 1.5, 'invalid', null])(
    'falls back to packSize 1 for invalid conversionValue %p',
    async (conversionValue) => {
      repository.findActiveConfigs.mockResolvedValue([]);
      repository.findResolvedConfigContext.mockResolvedValue({
        product: { id: 9, conversionValue },
        supplierId: null,
        categoryId: null,
      });

      const result = await service.getResolvedConfig({ skuId: 9 });

      expect(result.productParameters.packSize).toBe(1);
    },
  );

  it('returns null configId when the current SKU has no override', async () => {
    repository.findActiveConfigs.mockResolvedValue([
      row('CATEGORY', 7, 'safetyDays', 10),
      row('SUPPLIER', 8, 'coverageDays', 45),
    ]);

    const result = await service.getResolvedConfig({ skuId: 9 });

    expect(result.configId).toBeNull();
    expect(result.overrides).toEqual({});
    expect(result.effective).toMatchObject({
      safetyDays: 10,
      coverageDays: 45,
    });
    expect(result.source.safetyDays).toMatchObject({
      scopeType: 'CATEGORY',
      scopeId: 7,
      name: 'Category 7',
    });
  });

  it('resets a field with null while preserving the group', async () => {
    repository.findActiveConfigGroup.mockResolvedValue([
      row('SKU', 9, 'safetyDays', 15),
      row('SKU', 9, 'coverageDays', 7),
    ]);
    repository.upsertConfigGroup.mockResolvedValue([
      row('SKU', 9, 'coverageDays', 7),
    ]);

    const result = await service.updateConfig('SKU:9', {
      safetyDays: null,
    });

    expect(repository.upsertConfigGroup).toHaveBeenCalledWith(
      'SKU',
      9,
      expect.objectContaining({ safetyDays: null }),
      undefined,
    );
    expect(result).toMatchObject({
      id: 'SKU:9',
      scope: 'SKU',
      entity: { id: 9, code: 'SKU-9', name: 'Product 9' },
        overrides: { coverageDays: 7 },
      isActive: true,
    });
  });

  it('rejects create when all planning values are null or omitted', async () => {
    await expect(
      service.createConfig({
        scopeType: 'GLOBAL',
        safetyDays: null,
        coverageDays: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.upsertConfigGroup).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'maps Prisma P2002 to ConflictException for %s',
    async (operation) => {
      repository.upsertConfigGroup.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '4.16.2',
        }),
      );
      repository.findActiveConfigGroup.mockResolvedValue([
        row('SKU', 9, 'safetyDays', 15),
      ]);

      const action =
        operation === 'create'
          ? service.createConfig({ scopeType: 'GLOBAL', safetyDays: 30 })
          : service.updateConfig('SKU:9', { safetyDays: 20 });

      await expect(action).rejects.toMatchObject({
        constructor: ConflictException,
        status: 409,
        message: 'Cấu hình bị trùng hoặc vừa được cập nhật đồng thời',
      });
    },
  );

  it('writes reset audit after a successful null-field update', async () => {
    repository.findActiveConfigGroup.mockResolvedValue([
      row('SKU', 9, 'safetyDays', 15),
      row('SKU', 9, 'coverageDays', 7),
    ]);
    repository.upsertConfigGroup.mockResolvedValue([
      row('SKU', 9, 'coverageDays', 7),
    ]);

    await service.updateConfig(
      'SKU:9',
      { safetyDays: null },
      { id: 3, name: 'Nguyễn An' },
    );

    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'PATCH',
        actionCode: 'PLANNING_CONFIG_RESET',
        entityType: 'planning_config',
        entityId: 'SKU:9',
        category: 'Mua hàng',
        userId: 3,
        userName: 'Nguyễn An',
        changes: expect.objectContaining({ resetFields: ['safetyDays'] }),
      }),
    );
  });

  it('writes create audit with the created group snapshot', async () => {
    repository.upsertConfigGroup.mockResolvedValue([
      row('GLOBAL', null, 'safetyDays', 30),
    ]);

    await service.createConfig(
      { scopeType: 'GLOBAL', safetyDays: 30 },
      { id: 3, name: 'Nguyễn An' },
    );

    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'POST',
        actionCode: 'PLANNING_CONFIG_CREATE',
        entityType: 'planning_config',
        entityId: 'GLOBAL',
        category: 'Mua hàng',
        userId: 3,
        userName: 'Nguyễn An',
        snapshot: expect.objectContaining({ id: 'GLOBAL' }),
      }),
    );
  });

  it('writes delete audit with the group snapshot', async () => {
    repository.findActiveConfigGroup.mockResolvedValue([
      row('SKU', 9, 'safetyDays', 15),
    ]);
    repository.deactivateConfigGroup.mockResolvedValue({ count: 1 });

    await service.deleteConfig('SKU:9', { id: 3, name: 'Nguyễn An' });

    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'DELETE',
        actionCode: 'PLANNING_CONFIG_DELETE',
        entityType: 'planning_config',
        entityId: 'SKU:9',
        category: 'Mua hàng',
        userId: 3,
        userName: 'Nguyễn An',
        snapshot: expect.objectContaining({
          id: 'SKU:9',
          overrides: { safetyDays: 15 },
        }),
      }),
    );
  });
});

describe('PurchasingPlanningService calculation branch metadata', () => {
  const branchScope = {
    branches: [
      { id: 11, name: 'Kho Hà Nội', code: 'HN' },
      { id: 22, name: 'Kho Sài Gòn', code: null },
    ],
  };
  const repository = {
    createRun: jest.fn(),
    loadCalculationData: jest.fn(),
    completeRun: jest.fn(),
    failRun: jest.fn(),
  };
  const networkService = {
    getNetworkConfig: jest.fn(),
    getBranchTransferConfigs: jest.fn(),
    getFactoryLeadtimes: jest.fn(),
    getProductFactoryMap: jest.fn(),
    getImportHub: jest.fn(),
  };
  const service = new PurchasingPlanningService(
    repository as any,
    {} as any,
    networkService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    networkService.getNetworkConfig.mockResolvedValue({
      customs: { min: 7, typical: 8, max: 10 },
      inbound: { min: 7, typical: 8, max: 10 },
      transferDefault: {
        COLD: { min: 3, typical: 4, max: 5 },
        NORMAL: { min: 5, typical: 6, max: 7 },
      },
    });
    networkService.getBranchTransferConfigs.mockResolvedValue(new Map());
    networkService.getFactoryLeadtimes.mockResolvedValue(new Map());
    networkService.getProductFactoryMap.mockResolvedValue(new Map());
    networkService.getImportHub.mockResolvedValue({
      id: 11,
      name: 'Kho Hà Nội',
      code: 'HN',
    });
  });

  it('persists branch scope in CalculationRun.configVersion', async () => {
    repository.createRun.mockResolvedValue({
      id: 7,
      startedAt: new Date('2026-08-09T00:00:00.000Z'),
    });
    repository.loadCalculationData.mockResolvedValue({
      products: [],
      configs: [],
      categories: [],
      branchScope,
    });
    repository.completeRun.mockResolvedValue({ id: 8 });

    await service.runCalculation({ runType: 'MANUAL' } as any);

    expect(repository.completeRun).toHaveBeenCalledWith(
      7,
      expect.any(Date),
      expect.any(Date),
      [],
      expect.objectContaining({ branchScope }),
    );
  });

  it('includes branch scope in calculation trace inputs', () => {
    const trace = (service as any).buildTrace(
      new Date('2026-08-09T00:00:00.000Z'),
      {
        safetyDays: 1,
        packSize: 1,
      },
      [],
      [],
      { used: 0 },
      {
        leadTimeDemand: 0,
        safetyBuffer: 0,
        reorderPoint: 0,
        inventoryPosition: 0,
        reorderGap: 0,
      },
      { suggestedQuantity: 0, steps: [] },
      { priority: 'LOW' },
      [],
      0,
      branchScope,
    );

    expect(trace.inputs.branchScope).toEqual(branchScope);
  });

  it('uses canonical Branch metadata in the inventory trace breakdown', () => {
    const item = (service as any).calculateProduct(
      {
        id: 1,
        code: 'SKU-1',
        name: 'Product 1',
        unit: 'cái',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        conversionValue: 1,
        tradeMark: null,
      },
      {
        inventories: [
          {
            productId: 1,
            branchId: 11,
            branchName: 'Tên snapshot đã cũ',
            branch: { name: 'Kho Hà Nội', code: 'HN' },
            onHand: 10,
            reserved: 0,
          },
        ],
        invoiceDetails: [],
        inventoryLogs: [],
        orderSupplierItems: [],
        purchaseOrderItems: [],
        branchScope,
      },
      [],
      new Map(),
      new Date('2026-08-09T00:00:00.000Z'),
    );

    expect(item.calculationTrace.inputs.inventory.branches).toEqual([
      {
        branchId: 11,
        branchName: 'Kho Hà Nội',
        branchCode: 'HN',
        onHand: 10,
      },
    ]);
  });
});

function row(
  scopeType: string,
  scopeId: number | null,
  paramKey: string,
  paramValue: number,
) {
  return {
    id: 1,
    scopeType,
    scopeId,
    paramKey,
    paramValue,
    isActive: true,
    updatedAt: new Date('2026-08-09T00:00:00.000Z'),
  };
}

describe('PurchasingPlanningService incoming shipments', () => {
  const service = new PurchasingPlanningService(
    {} as any,
    {} as any,
    {} as any,
  );

  /** Dựng một dòng đơn NCC kèm các chuyến ghép xe gắn với nó. */
  const orderRow = (
    shipments: Array<{
      productId: number;
      quantity: number;
      branchId: number | null;
      status: number;
    }>,
  ) => ({
    orderSupplier: {
      vehicleShipmentItems: shipments.map((shipment) => ({
        productId: shipment.productId,
        quantity: shipment.quantity,
        vehicleShipment: {
          branchId: shipment.branchId,
          status: shipment.status,
          expectedArrivalDate: new Date('2026-09-01T00:00:00.000Z'),
        },
      })),
    },
  });

  it('cộng hàng đang về vào đúng chi nhánh đích của từng chuyến', () => {
    const result = (service as any).incomingByBranch(
      [
        orderRow([
          { productId: 9, quantity: 300, branchId: 6, status: 1 },
          { productId: 9, quantity: 150, branchId: 7, status: 1 },
        ]),
      ],
      9,
    );

    expect(result.get(6)).toBe(300);
    expect(result.get(7)).toBe(150);
  });

  it('gộp nhiều chuyến cùng về một chi nhánh', () => {
    const result = (service as any).incomingByBranch(
      [
        orderRow([{ productId: 9, quantity: 300, branchId: 6, status: 1 }]),
        orderRow([{ productId: 9, quantity: 200, branchId: 6, status: 1 }]),
      ],
      9,
    );

    expect(result.get(6)).toBe(500);
  });

  it('bỏ qua phiếu tạm và chuyến đã nhập kho để không đếm hai lần', () => {
    const result = (service as any).incomingByBranch(
      [
        orderRow([
          { productId: 9, quantity: 100, branchId: 6, status: 0 },
          { productId: 9, quantity: 300, branchId: 6, status: 1 },
          { productId: 9, quantity: 500, branchId: 6, status: 2 },
        ]),
      ],
      9,
    );

    expect(result.get(6)).toBe(300);
  });

  it('chỉ lấy đúng sản phẩm đang xét', () => {
    const result = (service as any).incomingByBranch(
      [
        orderRow([
          { productId: 9, quantity: 300, branchId: 6, status: 1 },
          { productId: 10, quantity: 999, branchId: 6, status: 1 },
        ]),
      ],
      9,
    );

    expect(result.get(6)).toBe(300);
  });

  it('bỏ qua chuyến chưa gắn chi nhánh nhận', () => {
    const result = (service as any).incomingByBranch(
      [orderRow([{ productId: 9, quantity: 300, branchId: null, status: 1 }])],
      9,
    );

    expect(result.size).toBe(0);
  });

  it('gộp tồn và hàng đang về của mọi chi nhánh thành một vị thế công ty', () => {
    const inventoryRows = [
      { branchId: 6, branch: { name: 'Kho Hà Nội' }, onHand: 50 },
      { branchId: 7, branch: { name: 'Kho Sài Gòn' }, onHand: 50 },
    ];
    // Chỉ Hà Nội có xe đang về, nhưng vị thế tính cho cả công ty.
    const orders = [
      orderRow([{ productId: 9, quantity: 300, branchId: 6, status: 1 }]),
    ];

    const position = (service as any).companyPosition(
      inventoryRows,
      orders,
      9,
      20,
    );

    expect(position.onHand).toBe(100);
    expect(position.incoming).toBe(300);
    expect(position.dailyDemand).toBe(20);
  });
});
