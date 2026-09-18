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
    findLatestItemForProduct: jest.fn(),
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
    repository.findProductParameters.mockResolvedValue({
      id: 9,
      code: 'SKU-9',
      name: 'Product 9',
      conversionValue: 24,
    });
    repository.findLatestItemForProduct.mockResolvedValue(null);
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

  it('requires a note when SKU growth factor deviates more than 20%', async () => {
    repository.findLatestItemForProduct.mockResolvedValue({
      calculationTrace: {
        inputs: {
          forecast: {
            systemGrowthFactor: 1,
          },
        },
      },
    });

    await expect(
      service.createConfig({
        scopeType: 'SKU',
        scopeId: 9,
        growthFactor: 1.3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.upsertConfigGroup).not.toHaveBeenCalled();
  });

  it('accepts a well-explained SKU growth factor override', async () => {
    repository.findLatestItemForProduct.mockResolvedValue({
      calculationTrace: {
        inputs: {
          forecast: {
            systemGrowthFactor: 1,
          },
        },
      },
    });
    repository.upsertConfigGroup.mockResolvedValue([
      row('SKU', 9, 'growthFactor', 1.3),
    ]);

    await service.createConfig({
      scopeType: 'SKU',
      scopeId: 9,
      growthFactor: 1.3,
      note: 'Khách xác nhận tăng sản lượng',
    });

    expect(repository.upsertConfigGroup).toHaveBeenCalled();
  });

  it('also requires a note for a large global growth-factor override', async () => {
    await expect(
      service.createConfig({
        scopeType: 'GLOBAL',
        growthFactor: 1.3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
    { create: jest.fn().mockResolvedValue({ id: 9 }) } as any,
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

  it('runs a read-only backtest over loaded history', async () => {
    repository.loadCalculationData.mockResolvedValue({
      products: [],
      invoiceDetails: [],
      stockSnapshots: [],
    });

    const result = await service.runBacktest({
      snapshotDate: '2026-09-14',
      minTrainingMonths: 12,
    });

    expect(repository.loadCalculationData).toHaveBeenCalledWith(
      new Date('2023-09-01T00:00:00.000Z'),
      new Date('2026-09-15T00:00:00.000Z'),
    );
    expect(result).toMatchObject({
      snapshotDate: '2026-09-14',
      evaluatedProducts: 0,
      evaluatedSamples: 0,
    });
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

describe('PurchasingPlanningService normalized history', () => {
  const service = new PurchasingPlanningService(
    {} as any,
    {} as any,
    {} as any,
  );

  it('builds 24 completed months plus the current partial month', () => {
    const months = (service as any).monthlySales(
      [
        {
          invoice: { purchaseDate: new Date('2025-01-12T00:00:00.000Z') },
          quantity: 12,
        },
      ],
      new Date('2026-09-14T00:00:00.000Z'),
      new Map(),
      new Date('2024-01-01T00:00:00.000Z'),
    );

    expect(months).toHaveLength(25);
    expect(months[0]).toMatchObject({
      month: '2024-09',
      quantity: 0,
      days: 30,
      daysInMonth: 30,
      isCurrentMonth: false,
    });
    expect(months.find((item: any) => item.month === '2025-01')).toMatchObject({
      quantity: 12,
    });
    expect(months.at(-1)).toMatchObject({
      month: '2026-09',
      days: 14,
      daysInMonth: 30,
      isCurrentMonth: true,
    });
  });

  it('uses a planning horizon longer than 90 days for the decision timeline', () => {
    const timeline = (service as any).buildDecisionTimelineData({
      snapshotDate: new Date('2026-09-14T00:00:00.000Z'),
      monthlySales: [],
      stability: { historyMonths: [], baselineDailyDemand: 0 },
      firmReceipts: [],
      vehicleLines: [],
      promotions: [],
      shipments: [],
      forecastDailyDemand: 1,
      available: 100,
      reorderPoint: 10,
      safetyBuffer: 2,
      latestOrderDate: null,
      leadTimeDays: 40,
      suggestedQuantity: 0,
      scenarioQuantity: 0,
      planningHorizonDays: 120,
    });

    expect(timeline.projection).toHaveLength(121);
    expect(timeline.projection.at(-1).date).toBe('2027-01-12');
  });
});

describe('PurchasingPlanningService past customer demand', () => {
  const branchScope = {
    branches: [{ id: 11, name: 'Kho Hà Nội', code: 'HN' }],
  };
  const service = new PurchasingPlanningService(
    {} as any,
    {} as any,
    {} as any,
  );
  const product = {
    id: 1,
    code: 'SP007356',
    name: 'Gấu Lermao - Siro Đường Đen 1kg',
    unit: 'túi',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    conversionValue: 12,
    tradeMark: null,
  };
  const baseData = (invoiceCustomerId: number) => ({
    inventories: [
      {
        productId: 1,
        branchId: 11,
        branchName: 'Kho Hà Nội',
        branch: { name: 'Kho Hà Nội', code: 'HN' },
        onHand: 0,
        reserved: 0,
        minQuality: 0,
      },
    ],
    invoiceDetails: [
      {
        productId: 1,
        quantity: 500,
        invoice: {
          purchaseDate: new Date('2026-08-20T00:00:00.000Z'),
          branchId: 11,
          customerId: invoiceCustomerId,
        },
      },
    ],
    inventoryLogs: [],
    orderSupplierItems: [],
    purchaseOrderItems: [],
    promotions: [],
    customerDemandMonths: [
      {
        id: 5,
        demandMonth: new Date('2026-08-01T00:00:00.000Z'),
        status: 'CONFIRMED',
        createdAt: new Date('2026-06-01T08:00:00.000Z'),
        demand: {
          customerId: 7,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
          customer: { name: 'Chuỗi Maycha' },
        },
        lines: [
          {
            productId: 1,
            quantityBase: 1500,
            inputQuantity: 1500,
            inputUnit: 'BASE',
            conversionValue: 12,
            createdAt: new Date('2026-06-01T08:00:00.000Z'),
          },
        ],
      },
    ],
    branchScope,
  });

  it('chỉ trừ số thực tế khách đã mua theo Demand cũ (1.500 demand / 500 hóa đơn)', () => {
    const item = (service as any).calculateProduct(
      product,
      baseData(7),
      [],
      new Map(),
      new Date('2026-09-14T00:00:00.000Z'),
    );

    const breakdown = item.calculationTrace.inputs.forecast.demandBreakdown;
    expect(breakdown.pastCustomerDemand).toBe(500);
    expect(breakdown.pastCustomerDemandDetails[0]).toMatchObject({
      customerName: 'Chuỗi Maycha',
      demandMonth: '2026-08',
      quantityBase: 1500,
      actualPurchasedQuantity: 500,
      deductedQuantity: 500,
      remainingQuantity: 1000,
    });
  });

  it('không trừ khi hóa đơn thuộc khách hàng khác', () => {
    const item = (service as any).calculateProduct(
      product,
      baseData(99),
      [],
      new Map(),
      new Date('2026-09-14T00:00:00.000Z'),
    );

    const breakdown = item.calculationTrace.inputs.forecast.demandBreakdown;
    expect(breakdown.pastCustomerDemand).toBe(0);
    expect(breakdown.pastCustomerDemandDetails[0]).toMatchObject({
      quantityBase: 1500,
      actualPurchasedQuantity: 0,
      deductedQuantity: 0,
      remainingQuantity: 1500,
    });
  });
});

describe('PurchasingPlanningService growth-factor trace', () => {
  const service = new PurchasingPlanningService(
    {} as any,
    {} as any,
    {} as any,
  );

  it('preserves growth analysis and marks overlapping demand for review', () => {
    const analysis = {
      inputMonths: 12,
      cleanMonths: 11,
      excludedMonths: ['2026-05'],
      shortTermTrend: 1.08,
      seasonalIndex: 1.2,
      seasonalWeight: 0.4,
      systemGrowthFactor: 1.1664,
      confidence: 'MEDIUM',
      formula: 'shortTermTrend × (1 + seasonalWeight × (seasonalIndex - 1))',
    };
    const forecast = {
      used: 10,
      growthFactor: 1.25,
      systemGrowthFactor: 1.1664,
      appliedGrowthFactor: 1.25,
      growthFactorOverridden: true,
      growthFactorSource: 'SKU',
      growthFactorNote: 'Khách xác nhận tăng sản lượng',
      growthFactorUpdatedBy: 7,
      growthFactorUpdatedAt: '2026-09-14T00:00:00.000Z',
      growthFactorAnalysis: analysis,
    };
    const trace = (service as any).buildTrace(
      new Date('2026-09-14T00:00:00.000Z'),
      { safetyDays: 7, packSize: 1, growthFactor: 1.25 },
      [],
      [],
      forecast,
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
      { branches: [] },
    );

    expect(trace.growthFactorAnalysis).toEqual(analysis);
    expect(trace.inputs.growthFactorAnalysis).toEqual(analysis);
    expect(trace.inputs.config.growthFactor).toMatchObject({
      value: 1.25,
      systemValue: 1.1664,
      overridden: true,
      updatedBy: 7,
    });

    const flags = (service as any).buildFlags({
      forecast: {
        confidence: 'HIGH',
        flags: [],
      },
      supplierIds: new Set([1]),
      latestSupplier: {},
      rawPhysical: 10,
      inventoryRows: [],
      unitPrice: 10,
      soq: { flags: [], suggestedQuantity: 0 },
      shipments: [],
      incomingFlags: [],
      leadtimeInfo: null,
      moqNotConvertible: false,
      unexplainedAnomaly: false,
      vehicleRisk: 0,
      scenarioQuantity: 0,
      customerDemand: 0,
      customerDemandDetails: [{ skipped: true }],
      pastCustomerDemandDetails: [],
      growthFactorWarnings: ['INSUFFICIENT_HISTORY'],
    });

    expect(flags.map((flag: any) => flag.code)).toEqual(
      expect.arrayContaining(['DEMAND_OVERLAP', 'INSUFFICIENT_HISTORY']),
    );
  });
});
