import { Prisma } from '@prisma/client';
import { ProductionCostHistoryService } from './production-cost-history.service';

const decimal = (value: number) => new Prisma.Decimal(value);
const spec = {
  unit: 'túi',
  weight: '1',
  weightUnit: 'kg',
  conversionValue: '1',
  masterUnitId: null,
  isPieceUnit: false,
};
function batch(
  id: number,
  cost: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    code: `GSX${id}`,
    productId: 10,
    productName: 'Trà A',
    manufacturerId: (id % 2) + 1,
    manufacturer: { name: `NSX ${(id % 2) + 1}` },
    completedDate: new Date(
      `2026-11-01T${String(id % 24).padStart(2, '0')}:00:00Z`,
    ),
    quantity: decimal(1000),
    receivedQuantity: decimal(1000),
    batchUnitCost: decimal(cost),
    totalCost: decimal(cost * 1000),
    materialValue: decimal(70000),
    manufacturerMaterialCost: decimal(30000),
    processingFee: decimal(0),
    outputSpecSnapshot: spec,
    costSnapshotAt: new Date(),
    costAppliedAt: null,
    receipts: [],
    ...overrides,
  };
}

describe('production cost history', () => {
  function fixture(rows: any[]) {
    const prisma: any = {
      production: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    return { prisma, service: new ProductionCostHistoryService(prisma) };
  }

  it('computes the prior cost before paging, including different manufacturers in the filtered set', async () => {
    const { service, prisma } = fixture(
      Array.from({ length: 23 }, (_, index) => batch(index + 1, 100 + index)),
    );
    const result = await service.history({
      productId: 10,
      page: 2,
      pageSize: 20,
    });
    expect(result.total).toBe(23);
    expect(result.data[0]).toMatchObject({
      id: 21,
      previousProductionId: 20,
      deltaAmount: 1,
      deltaPercent: 0.8403,
    });
    expect(prisma.production.findMany.mock.calls[0][0]).toMatchObject({
      where: { isExternal: true, status: 2, productId: 10 },
      orderBy: [{ completedDate: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.production.findMany.mock.calls[0][0].skip).toBeUndefined();
  });

  it('uses saved snapshots, not current product costs, and charts the entire filtered set', async () => {
    const { service } = fixture([batch(1, 100), batch(2, 200), batch(3, 250)]);
    const table = await service.history({
      productId: 10,
      page: 1,
      pageSize: 1,
    });
    const chart = await service.history(
      { productId: 10, page: 1, pageSize: 1 },
      true,
    );
    expect(table.data).toHaveLength(1);
    expect(chart.data).toHaveLength(3);
    expect(chart.data[2]).toMatchObject({ deltaAmount: 50, deltaPercent: 25 });
  });

  it('never compares incompatible output specifications or guesses a legacy specification', async () => {
    const { service } = fixture([
      batch(1, 0),
      batch(2, 100),
      batch(3, 200, { outputSpecSnapshot: { ...spec, weight: '2' } }),
      batch(4, 150, {
        batchUnitCost: null,
        outputSpecSnapshot: null,
        costSnapshotAt: null,
      }),
      batch(5, 180),
    ]);
    const { data } = await service.history({
      productId: 10,
      page: 1,
      pageSize: 20,
    });
    expect(data[0]).toMatchObject({ deltaAmount: null, deltaPercent: null });
    expect(data[1]).toMatchObject({ deltaAmount: 100, deltaPercent: null });
    expect(data[2]).toMatchObject({
      deltaAmount: null,
      previousProductionId: null,
    });
    expect(data[3]).toMatchObject({
      unitCost: 150,
      snapshotMissing: true,
      canApply: false,
      deltaAmount: null,
    });
    expect(data[4]).toMatchObject({ previousProductionId: 2, deltaAmount: 80 });
  });

  it('filters specifications before calculating deltas and rejects reversed dates', async () => {
    const { service } = fixture([
      batch(1, 100),
      batch(2, 200, { outputSpecSnapshot: { ...spec, weight: '2' } }),
      batch(3, 150),
    ]);
    const result = await service.history({
      productId: 10,
      variantKey: JSON.stringify(['túi', '1', 'kg', '1', null, false]),
      manufacturerId: 2,
      page: 1,
      pageSize: 20,
    });
    expect(result.data.map((row) => row.id)).toEqual([1, 3]);
    expect(result.data[1].deltaAmount).toBe(50);
    await expect(
      service.history({
        productId: 10,
        fromDate: '2026-11-10',
        toDate: '2026-10-10',
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toThrow();
  });

  it('multi-receipt batch: NSX + fee summed from active receipts, actual vs planned unit cost', async () => {
    const { service } = fixture([
      batch(1, 100, {
        quantity: decimal(1000),
        receivedQuantity: decimal(950),
        totalCost: decimal(98000),
        manufacturerMaterialCost: decimal(30000),
        processingFee: decimal(5000),
        receipts: [
          {
            manufacturerMaterialCost: decimal(15000),
            processingFee: decimal(2500),
          },
          {
            manufacturerMaterialCost: decimal(13000),
            processingFee: decimal(2500),
          },
        ],
      }),
    ]);
    const [row] = (await service.history({} as any)).data;
    expect(row.manufacturerMaterialCost).toBe(28000);
    expect(row.processingFee).toBe(5000);
    expect(row.unitCost).toBe(100);
    expect(row.actualUnitCost).toBeCloseTo(98000 / 950, 6);
    expect(row.receivedQuantity).toBe(950);
  });
});
