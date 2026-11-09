import { ExternalProductionsService } from './external-productions.service';
import { ManufacturersService } from './manufacturers.service';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

jest.mock('../common/inventory-onhand.util', () => ({ recalcOnHandForPairs: jest.fn() }));
jest.mock('../common/supplier-debt.util', () => ({ recalcSupplierDebt: jest.fn() }));

function fixture(status = 1) {
  const row: any = {
    id: 1, code: 'GSX1', isExternal: true, manufacturerId: 5, supplierId: 9,
    status, productId: 10, productCode: 'A', productName: 'Tea A',
    sourceBranchId: 2, sourceBranchName: 'Kho', destinationBranchId: 2, destinationBranchName: 'Kho',
    quantity: 160, materialValue: 8000, totalPayable: 19000, feeCurrency: 'VND', processingFee: 3000,
    createdByName: 'Operator', sentDate: new Date('2026-11-01T00:00:00Z'),
    components: [{ id: 1, componentProductId: 10, componentCode: 'A', componentName: 'Tea A', actualGrams: 80, unit: 'kg', conversionFactor: 1, unitsDeducted: 80 }],
    manufacturerMaterials: [{ productId: null, description: 'Confidential', pricingMode: 'UNIT_PRICE', quantity: 80, unit: 'kg', unitPrice: 200, amount: 16000 }],
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    production: {
      findUnique: jest.fn().mockImplementation(async () => row),
      findUniqueOrThrow: jest.fn().mockImplementation(async () => row),
      update: jest.fn().mockImplementation(async ({ data }) => { Object.assign(row, data); return row; }),
    },
    manufacturer: { findUnique: jest.fn().mockResolvedValue({ id: 5, supplierId: 99, isActive: true }) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Operator' }) },
    inventory: {
      findUnique: jest.fn().mockResolvedValue({ onHand: 80, cost: 100 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryLog: { create: jest.fn().mockResolvedValue({}) },
    productionComponent: { update: jest.fn().mockResolvedValue({}) },
    payableAllocation: { count: jest.fn().mockResolvedValue(0) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma: any = { $transaction: jest.fn((callback) => callback(tx)), user: { findUnique: jest.fn().mockResolvedValue({ supplierId: null }) } };
  const manufacturers = new ManufacturersService(prisma);
  const audit: any = { create: jest.fn() };
  const service = new ExternalProductionsService(prisma, manufacturers, audit);
  return { service, tx, row };
}

describe('external production lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends only owned materials, snapshots costs and current supplier, without booking debt', async () => {
    const { service, tx, row } = fixture();
    await service.send(1, undefined, 7);
    expect(tx.inventoryLog.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryLog.create.mock.calls[0][0].data).toMatchObject({ productId: 10, transactionType: 'PRODUCTION_OUT', quantity: expect.anything(), costPrice: 100 });
    expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(-80);
    expect(row).toMatchObject({ status: 4, materialValue: 8000, supplierId: 99 });
    expect(recalcSupplierDebt).not.toHaveBeenCalled();
    expect(tx.productionComponent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ unitCost: 100 }) }));
  });

  it('receives same SKU directly, books final supplied material + machining, retains historical supplier', async () => {
    const { service, tx, row } = fixture(4);
    await service.receive(1, { receivedQuantity: 160, processingFee: 0, manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 25000 }] }, 7);
    expect(row).toMatchObject({ status: 2, receivedQuantity: 160, totalPayable: 25000, totalCost: 33000, debtAmount: 25000, supplierId: 9 });
    expect(tx.inventoryLog.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryLog.create.mock.calls[0][0].data).toMatchObject({ productId: 10, quantity: 160, transactionType: 'PRODUCTION_IN', refType: 'production' });
    expect(recalcSupplierDebt).toHaveBeenCalledWith(tx, 9);
    expect(recalcOnHandForPairs).toHaveBeenCalled();
  });

  it('rejects repeated receipt before creating a second stock entry', async () => {
    const { service, tx } = fixture(2);
    await expect(service.receive(1, {}, 7)).rejects.toThrow();
    expect(tx.inventoryLog.create).not.toHaveBeenCalled();
  });

  it('rejects receipt with stale confirmed cost', async () => {
    const { service, tx } = fixture(4);
    await expect(service.receive(1, { newCost: 150, expectedOldCost: 90 }, 7)).rejects.toThrow('Giá vốn đã thay đổi');
    expect(tx.inventoryLog.create).not.toHaveBeenCalled();
  });

  it('rejects cancellation while a payment allocation is active', async () => {
    const { service, tx } = fixture(2);
    tx.payableAllocation.count.mockResolvedValue(1);
    await expect(service.cancel(1, 7)).rejects.toThrow('Hãy hủy phân bổ');
    expect(tx.production.update).not.toHaveBeenCalled();
  });

  it('does not require a product for confidential materials', async () => {
    const { service, tx } = fixture();
    const result = await (service as any).materials(tx, [], [{ pricingMode: 'TOTAL', amount: 500 }]);
    expect(result.supplied[0]).toMatchObject({ productId: null, description: 'Nguyên liệu NSX bổ sung', amount: 500 });
  });

  it('snapshots conversion instead of reading a changed product when sending', async () => {
    const { service, tx, row } = fixture();
    row.components[0].conversionFactor = 2;
    row.components[0].actualGrams = 40;
    await service.send(1, undefined, 7);
    expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(-80);
    expect(tx.product.findMany).not.toHaveBeenCalled();
  });
});
