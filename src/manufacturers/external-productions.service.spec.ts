import { ExternalProductionsService } from './external-productions.service';
import { Prisma } from '@prisma/client';
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
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ type: 2, unit: 'kg', weight: null, weightUnit: 'kg', conversionValue: new Prisma.Decimal(1), masterUnitId: null, isPieceUnit: false }),
    },
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
    expect(Number(row.batchUnitCost)).toBe(206.25);
    expect(row.outputSpecSnapshot).toEqual({ unit: 'kg', weight: null, weightUnit: null, conversionValue: '1', masterUnitId: null, isPieceUnit: false });
    expect(row.costSnapshotAt).toBeInstanceOf(Date);
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
  });

  it('rejects repeated receipt before creating a second stock entry', async () => {
    const { service, tx } = fixture(2);
    await expect(service.receive(1, {}, 7)).rejects.toThrow();
    expect(tx.inventoryLog.create).not.toHaveBeenCalled();
  });

  it('rejects inline cost application even with a valid cost before any stock/debt write', async () => {
    const { service, tx } = fixture(4);
    await expect(service.receive(1, { newCost: 150, expectedOldCost: 100 }, 7)).rejects.toThrow('Nhận hàng không áp giá vốn');
    expect(tx.inventoryLog.create).not.toHaveBeenCalled();
    expect(tx.production.update).not.toHaveBeenCalled();
  });

  it('snapshots 700/300 with zero machining and actual shrinkage, without inferring secret quantities', async () => {
    const { service, tx, row } = fixture(4);
    row.materialValue = 70000;
    await service.receive(1, { receivedQuantity: 950, processingFee: 0, manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 60000 }] }, 7);
    expect(Number(row.batchUnitCost)).toBe(136.842105);
    expect(row).toMatchObject({ totalCost: 130000, debtAmount: 60000 });
    expect(tx.production.update.mock.calls[0][0].data.manufacturerMaterials.create[0].quantity).toBeNull();
  });

  it('freezes the CNY settlement rate and zero fee without overwriting inventory cost', async () => {
    const { service, tx, row } = fixture(4);
    row.feeCurrency = 'CNY';
    await service.receive(1, { receivedQuantity: 160, feeForeignAmount: 0, feeExchangeRate: 3500, manufacturerMaterials: [{ pricingMode: 'UNIT_PRICE', quantity: 80, unit: 'kg', unitPrice: 2 }] }, 7);
    expect(row).toMatchObject({ totalCost: 568000, totalPayable: 560000, feeExchangeRate: 3500, processingFee: 0 });
    expect(Number(row.batchUnitCost)).toBe(3550);
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
  });

  it('values known and confidential NSX inputs together without moving either through owned stock', async () => {
    const { service, tx, row } = fixture(4);
    tx.product.findMany.mockResolvedValue([{ id: 11, code: 'NSX-B', name: 'Trà B', type: 2 }]);
    await service.receive(1, { receivedQuantity: 160, processingFee: 0, manufacturerMaterials: [
      { productId: 11, pricingMode: 'UNIT_PRICE', quantity: 40, unit: 'kg', unitPrice: 200 },
      { pricingMode: 'TOTAL', amount: 10000 },
    ] }, 7);
    expect(row).toMatchObject({ totalCost: 26000, totalPayable: 18000 });
    expect(Number(row.batchUnitCost)).toBe(162.5);
    expect(tx.inventoryLog.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryLog.create.mock.calls[0][0].data.productId).toBe(10);
    expect(tx.productionComponent.update).not.toHaveBeenCalled();
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
  describe('formula-based slips and priced NSX lines', () => {
    const products = [
      { id: 10, code: 'A', name: 'Tea A', type: 2, unit: 'kg' },
      { id: 11, code: 'B', name: 'Trà B', type: 2, unit: 'kg' },
    ];
    const setup = (status = 1) => {
      const ctx = fixture(status);
      ctx.tx.product.findMany.mockResolvedValue(products);
      ctx.tx.product.findUnique = jest.fn().mockResolvedValue(products[0]);
      ctx.tx.branch = { findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Kho' }) };
      ctx.tx.production.create = jest.fn(async ({ data }) => data);
      ctx.tx.productFormula = { findUnique: jest.fn() };
      return ctx;
    };
    const dto = (over: any = {}) => ({
      isExternal: true, manufacturerId: 5, productId: 10, sourceBranchId: 2, destinationBranchId: 2, quantity: 100,
      ownMaterials: [{ productId: 10, quantity: 50, unit: 'kg' }],
      manufacturerMaterials: [{ productId: 11, pricingMode: 'UNIT_PRICE', quantity: 300, unit: 'g', unitPrice: 250000, priceUnit: 'kg' }],
      ...over,
    });

    it('stores the external formula and a converted g→kg amount on a new slip', async () => {
      const { service, tx } = setup();
      tx.productFormula.findUnique.mockResolvedValue({ id: 8, name: 'Gửi NSX', productId: 10, isExternal: true });
      const saved: any = await service.save(dto({ formulaId: 8 }) as any, 7);
      expect(saved).toMatchObject({ formulaId: 8, formulaName: 'Gửi NSX', externalTemplateId: null, totalPayable: 75000 });
      expect(saved.manufacturerMaterials.create[0]).toMatchObject({ productId: 11, productCode: 'B', description: 'Trà B', unit: 'g', priceUnit: 'kg', amount: 75000 });
    });

    it('rejects an internal formula or one of another product', async () => {
      const { service, tx } = setup();
      tx.productFormula.findUnique.mockResolvedValueOnce({ id: 8, name: 'Nội bộ', productId: 10, isExternal: false });
      await expect(service.save(dto({ formulaId: 8 }) as any, 7)).rejects.toThrow('không thuộc thành phẩm');
      tx.productFormula.findUnique.mockResolvedValueOnce({ id: 9, name: 'Khác', productId: 99, isExternal: true });
      await expect(service.save(dto({ formulaId: 9 }) as any, 7)).rejects.toThrow('không thuộc thành phẩm');
    });

    it('new draft lines must be linked, unique and priced per g/kg/gói', async () => {
      const { service } = setup();
      await expect(service.save(dto({ manufacturerMaterials: [{ pricingMode: 'UNIT_PRICE', quantity: 1, unit: 'kg', unitPrice: 1, priceUnit: 'kg' }] }) as any, 7))
        .rejects.toThrow('cần chọn sản phẩm');
      await expect(service.save(dto({ manufacturerMaterials: [{ productId: 11, pricingMode: 'TOTAL', amount: 500 }] }) as any, 7))
        .rejects.toThrow('lượng × đơn giá');
      const line = { productId: 11, pricingMode: 'UNIT_PRICE', quantity: 1, unit: 'kg', unitPrice: 1, priceUnit: 'kg' };
      await expect(service.save(dto({ manufacturerMaterials: [line, line] }) as any, 7)).rejects.toThrow('trùng mã');
    });

    it('only-machining slip (no NSX lines, zero fee) is valid', async () => {
      const { service } = setup();
      const saved: any = await service.save(dto({ manufacturerMaterials: [], processingFee: 0 }) as any, 7);
      expect(saved).toMatchObject({ totalPayable: 0, manufacturerMaterialCost: 0 });
    });

    it('updating a draft keeps its old template columns and an unchanged formula', async () => {
      const { service, tx, row } = setup();
      Object.assign(row, { formulaId: 8, formulaName: 'Đã đổi tên sau', externalTemplateId: 3, externalTemplateName: 'Mẫu cũ' });
      await service.save(dto({ formulaId: 8 }) as any, 7, 1);
      expect(tx.productFormula.findUnique).not.toHaveBeenCalled();
      const data = tx.production.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ formulaId: 8, formulaName: 'Đã đổi tên sau' });
      expect(data).not.toHaveProperty('externalTemplateId');
    });

    it('receive without edits recomputes saved lines with their price unit (not qty × price)', async () => {
      const { service, row } = setup(4);
      row.processingFee = 0;
      row.manufacturerMaterials = [{ productId: 11, description: 'Trà B', pricingMode: 'UNIT_PRICE', quantity: 300, unit: 'g', unitPrice: 250000, priceUnit: 'kg', amount: 75000 }];
      await service.receive(1, { receivedQuantity: 160 }, 7);
      expect(row).toMatchObject({ totalPayable: 75000, debtAmount: 75000 });
    });
  });
});
