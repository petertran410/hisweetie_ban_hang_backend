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
      row('GLOBAL', null, 'leadTimeDays', 30),
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
          overrides: { leadTimeDays: 30 },
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
      row('GLOBAL', null, 'leadTimeDays', 30),
      row('CATEGORY', 7, 'leadTimeDays', 25),
      row('SUPPLIER', 8, 'coverageDays', 45),
      row('SKU', 9, 'leadTimeDays', 15),
    ]);
    repository.findCategory.mockResolvedValue({ name: 'Tea', type: 'child' });
    repository.findSupplierEntity.mockResolvedValue({ id: 8 });
    const result = await service.getResolvedConfig({ skuId: 9 });

    expect(result.effective.leadTimeDays).toBe(15);
    expect(result.source.leadTimeDays).toMatchObject({
      scopeType: 'SKU',
      scopeId: 9,
      code: 'SKU-9',
      name: 'Product 9',
      label: 'Cấu hình riêng SKU: Product 9',
    });
    expect(result.raw.current).toEqual({ leadTimeDays: 15 });
    expect(result.raw.inherited.leadTimeDays).toBe(25);
    expect(result.productParameters).toMatchObject({
      packSize: 24,
      source: 'PRODUCT',
      label: 'Sản phẩm · Định lượng đóng gói',
    });
    expect(result).toMatchObject({
      scope: 'SKU',
      entity: { id: 9, code: 'SKU-9', name: 'Product 9' },
      configId: 'SKU:9',
      overrides: { leadTimeDays: 15 },
    });
    expect(result.fields.leadTimeDays).toMatchObject({
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
      row('GLOBAL', null, 'leadTimeDays', 30),
      row('CATEGORY', 7, 'safetyDays', 10),
      row('SUPPLIER', 8, 'coverageDays', 45),
    ]);

    const result = await service.getResolvedConfig({ skuId: 9 });

    expect(result.configId).toBeNull();
    expect(result.overrides).toEqual({});
    expect(result.effective).toMatchObject({
      leadTimeDays: 30,
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
      row('SKU', 9, 'leadTimeDays', 15),
      row('SKU', 9, 'safetyDays', 7),
    ]);
    repository.upsertConfigGroup.mockResolvedValue([
      row('SKU', 9, 'safetyDays', 7),
    ]);

    const result = await service.updateConfig('SKU:9', {
      leadTimeDays: null,
    });

    expect(repository.upsertConfigGroup).toHaveBeenCalledWith(
      'SKU',
      9,
      expect.objectContaining({ leadTimeDays: null }),
      undefined,
    );
    expect(result).toMatchObject({
      id: 'SKU:9',
      scope: 'SKU',
      entity: { id: 9, code: 'SKU-9', name: 'Product 9' },
      overrides: { safetyDays: 7 },
      isActive: true,
    });
  });

  it('rejects create when all planning values are null or omitted', async () => {
    await expect(
      service.createConfig({
        scopeType: 'GLOBAL',
        leadTimeDays: null,
        safetyDays: null,
        coverageDays: null,
        growthFactor: null,
        moq: null,
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
        row('SKU', 9, 'leadTimeDays', 15),
      ]);

      const action =
        operation === 'create'
          ? service.createConfig({ scopeType: 'GLOBAL', leadTimeDays: 30 })
          : service.updateConfig('SKU:9', { leadTimeDays: 20 });

      await expect(action).rejects.toMatchObject({
        constructor: ConflictException,
        status: 409,
        message: 'Cấu hình bị trùng hoặc vừa được cập nhật đồng thời',
      });
    },
  );

  it('writes reset audit after a successful null-field update', async () => {
    repository.findActiveConfigGroup.mockResolvedValue([
      row('SKU', 9, 'leadTimeDays', 15),
      row('SKU', 9, 'safetyDays', 7),
    ]);
    repository.upsertConfigGroup.mockResolvedValue([
      row('SKU', 9, 'safetyDays', 7),
    ]);

    await service.updateConfig(
      'SKU:9',
      { leadTimeDays: null },
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
        changes: expect.objectContaining({ resetFields: ['leadTimeDays'] }),
      }),
    );
  });

  it('writes create audit with the created group snapshot', async () => {
    repository.upsertConfigGroup.mockResolvedValue([
      row('GLOBAL', null, 'leadTimeDays', 30),
    ]);

    await service.createConfig(
      { scopeType: 'GLOBAL', leadTimeDays: 30 },
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
      row('SKU', 9, 'leadTimeDays', 15),
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
          overrides: { leadTimeDays: 15 },
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
  const service = new PurchasingPlanningService(repository as any, {} as any);

  beforeEach(() => {
    jest.clearAllMocks();
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
        leadTimeDays: 1,
        safetyDays: 1,
        coverageDays: 1,
        growthFactor: 1,
        packSize: 1,
        moq: 0,
      },
      {},
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
