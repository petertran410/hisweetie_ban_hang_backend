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
    manufacturerMaterialCost: 16000, receivingClosed: false, receipts: [],
    createdById: 7, createdByName: 'Operator', sentDate: new Date('2026-11-01T00:00:00Z'),
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
    inventoryLog: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionComponent: {
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    productionManufacturerMaterial: {
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    payableAllocation: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { settledAmount: 0 } }),
    },
    // Đợt nhận lưu trong bộ nhớ, gắn luôn vào row.receipts như include của Prisma.
    productionReceipt: {
      create: jest.fn(async ({ data }) => {
        const receipt = { id: 100 + row.receipts.length, status: 1, createdAt: new Date(), ...data };
        row.receipts.push(receipt);
        return receipt;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(row.receipts.find((item: any) => item.id === where.id), data)),
      updateMany: jest.fn(async ({ data }) => {
        row.receipts.filter((item: any) => item.status === 1).forEach((item: any) => Object.assign(item, data));
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ where }) => row.receipts.filter((item: any) => item.status === where.status)),
      aggregate: jest.fn(async () => ({ _max: { seq: row.receipts.reduce((max: number, item: any) => Math.max(max, item.seq), 0) || null } })),
    },
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

  it('receives the whole batch in one receipt: debt per receipt, stock via the receipt, supplier kept', async () => {
    const { service, tx, row } = fixture(4);
    await service.receive(1, { receivedQuantity: 160, processingFee: 0, manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 25000 }] }, 7);
    expect(row).toMatchObject({ status: 2, totalPayable: 25000, totalCost: 33000, debtAmount: 25000, supplierId: 9 });
    expect(Number(row.receivedQuantity)).toBe(160);
    expect(row.receipts).toHaveLength(1);
    expect(row.receipts[0]).toMatchObject({ seq: 1, code: 'GSX1-1', totalPayable: 25000 });
    expect(tx.inventoryLog.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryLog.create.mock.calls[0][0].data).toMatchObject({
      productId: 10, transactionType: 'PRODUCTION_IN', refType: 'production_receipt', refId: 100, refCode: 'GSX1',
    });
    expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(160);
    expect(recalcSupplierDebt).toHaveBeenCalledWith(tx, 9);
    expect(recalcOnHandForPairs).toHaveBeenCalled();
    // Giá thành dự kiến chốt từ lúc gửi: (8.000 + 3.000 + 16.000) / 160.
    expect(Number(row.batchUnitCost)).toBe(168.75);
    expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.costPrice)).toBe(168.75);
    expect(row.outputSpecSnapshot).toEqual({ unit: 'kg', weight: null, weightUnit: null, conversionValue: '1', masterUnitId: null, isPieceUnit: false });
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
  });

  it('rejects receiving on a completed slip before creating a stock entry', async () => {
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

  it('over-receipt (950 of 160) completes; confidential TOTAL line keeps a null quantity', async () => {
    const { service, row } = fixture(4);
    row.materialValue = 70000;
    await service.receive(1, { receivedQuantity: 950, processingFee: 0, manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 60000 }] }, 7);
    expect(row).toMatchObject({ status: 2, totalCost: 130000, debtAmount: 60000 });
    expect(row.receipts[0].manufacturerMaterials[0].quantity).toBeNull();
  });

  it('freezes the CNY settlement rate per receipt without overwriting inventory cost', async () => {
    const { service, tx, row } = fixture(4);
    row.feeCurrency = 'CNY';
    await service.receive(1, { receivedQuantity: 160, feeForeignAmount: 0, feeExchangeRate: 3500, manufacturerMaterials: [{ pricingMode: 'UNIT_PRICE', quantity: 80, unit: 'kg', unitPrice: 2 }] }, 7);
    expect(row).toMatchObject({ totalCost: 568000, totalPayable: 560000, totalForeignPayable: 160 });
    expect(row.receipts[0]).toMatchObject({ feeExchangeRate: 3500, processingFee: 0, feeForeignAmount: 0 });
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
    // Chỉ đọc tên đơn vị kho để báo lỗi, không đọc lại quy cách sản phẩm.
    expect(tx.product.findMany).toHaveBeenCalledWith({ where: { id: { in: [10] } }, select: { id: true, unit: true } });
  });

  describe('sending grams of a 20 kg carton (thùng)', () => {
    // Thùng 20 kg = weight 20000 g → 1 g = 1/20000 thùng (hệ số lưu lúc lưu phiếu).
    const carton = (grams: number, onHand: unknown) => {
      const ctx = fixture();
      ctx.row.components = [{ id: 1, componentProductId: 10, componentCode: 'T20', componentName: 'Trà 20kg', actualGrams: grams, unit: 'g', conversionFactor: 0.00005, unitsDeducted: 0 }];
      ctx.tx.product.findMany.mockResolvedValue([{ id: 10, unit: 'Thùng' }]);
      ctx.tx.inventory.findUnique.mockResolvedValue({ onHand, cost: 4000000 });
      return ctx;
    };

    it('250 g deducts 0.0125 thùng from 2.6 in stock', async () => {
      const { service, tx } = carton(250, 2.6);
      await service.send(1, undefined, 7);
      expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(-0.0125);
    });

    it('stock with a float residue (2.5999999999999996) still covers exactly 2.6 thùng', async () => {
      const { service, tx } = carton(52000, new Prisma.Decimal('2.5999999999999996'));
      await service.send(1, undefined, 7);
      expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(-2.6);
    });

    it('a real shortage says how much is needed, in stock units and grams', async () => {
      const { service, tx } = carton(250000, 2.6);
      await expect(service.send(1, undefined, 7)).rejects.toThrow(
        'Không đủ tồn kho "Trà 20kg" tại kho gửi: cần 12.5 Thùng (= 250,000 g), còn 2.6 Thùng',
      );
      expect(tx.inventoryLog.create).not.toHaveBeenCalled();
    });
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

  describe('partial receipts (gửi 1000, nhận dần)', () => {
    // Dự kiến 1000 sp: NSX 80 kg × 200 = 16.000, phí 3.000 → phải trả dự kiến 19.000.
    const sent = () => {
      const ctx = fixture(4);
      Object.assign(ctx.row, { quantity: 1000, batchUnitCost: 27, outputSpecSnapshot: {}, costSnapshotAt: new Date() });
      ctx.row.manufacturerMaterials = [{ productId: null, description: 'NL NSX', pricingMode: 'UNIT_PRICE', quantity: 80, unit: 'kg', unitPrice: 200, amount: 16000 }];
      return ctx;
    };

    it('500 → Nhận một phần with half the planned payable, then 200 + 300 completes automatically', async () => {
      const { service, row } = sent();
      await service.receive(1, { receivedQuantity: 500, completedDate: '2026-11-03' }, 7);
      expect(row.status).toBe(5);
      expect(Number(row.receivedQuantity)).toBe(500);
      expect(row.receipts[0]).toMatchObject({ processingFee: 1500, manufacturerMaterialCost: 8000, totalPayable: 9500 });
      expect(Number(row.receipts[0].manufacturerMaterials[0].quantity)).toBe(40);
      expect(row).toMatchObject({ totalPayable: 9500, debtAmount: 9500, completedDate: null });
      await service.receive(1, { receivedQuantity: 200, completedDate: '2026-11-05' }, 7);
      expect(row.status).toBe(5);
      await service.receive(1, { receivedQuantity: 300, completedDate: '2026-11-08' }, 7);
      expect(row.status).toBe(2);
      expect(row.receipts.map((item: any) => item.code)).toEqual(['GSX1-1', 'GSX1-2', 'GSX1-3']);
      expect(row).toMatchObject({ totalPayable: 19000, debtAmount: 19000 });
      expect(row.completedDate.toISOString().slice(0, 10)).toBe('2026-11-08');
    });

    it('defaults the quantity to the remaining amount', async () => {
      const { service, row } = sent();
      await service.receive(1, { receivedQuantity: 600 }, 7);
      await service.receive(1, {}, 7);
      expect(Number(row.receipts[1].quantity)).toBe(400);
      expect(row.status).toBe(2);
    });

    it('"đợt cuối" closes short (950), reopen goes back to Nhận một phần, close again via the button', async () => {
      const { service, row } = sent();
      await service.receive(1, { receivedQuantity: 950, finish: true }, 7);
      expect(row).toMatchObject({ status: 2, receivingClosed: true });
      await service.reopenReceiving(1, 7);
      expect(row).toMatchObject({ status: 5, receivingClosed: false, completedDate: null });
      await service.closeReceiving(1, 7);
      expect(row).toMatchObject({ status: 2, receivingClosed: true });
    });

    it('editing a receipt rewrites its stock log and reopens a completed slip (1000 → 900)', async () => {
      const { service, tx, row } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      await service.receive(1, { receivedQuantity: 500 }, 7);
      expect(row.status).toBe(2);
      tx.inventoryLog.create.mockClear();
      await service.updateReceipt(1, 101, { receivedQuantity: 400 }, 7);
      expect(tx.inventoryLog.deleteMany).toHaveBeenCalledWith({ where: { refType: 'production_receipt', refId: 101 } });
      expect(Number(tx.inventoryLog.create.mock.calls[0][0].data.quantity)).toBe(400);
      // Sửa đợt giữ tiền đang lưu của đợt (không tự chia lại).
      expect(row.receipts[1]).toMatchObject({ totalPayable: 9500 });
      expect(row.status).toBe(5);
      expect(Number(row.receivedQuantity)).toBe(900);
    });

    it('blocks a receipt edit that drops the payable below what was already paid', async () => {
      const { service, tx, row } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      tx.payableAllocation.aggregate.mockResolvedValue({ _sum: { settledAmount: 9000 } });
      await expect(service.updateReceipt(1, 100, { receivedQuantity: 500, processingFee: 0, manufacturerMaterials: [] }, 7))
        .rejects.toThrow('Hãy hủy bớt thanh toán');
      expect(row.receipts[0]).toBeDefined();
    });

    it('blocks a receipt edit when the finished goods were already sold (stock would go negative)', async () => {
      const { service, tx } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      tx.inventory.findUnique.mockResolvedValue({ onHand: -100, cost: 100, productName: 'Tea A' });
      await expect(service.updateReceipt(1, 100, { receivedQuantity: 400 }, 7)).rejects.toThrow('đã được xuất tiếp');
    });

    it('cancelling a receipt voids it, lowers debt and goes back to Đã gửi when none is left', async () => {
      const { service, row } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      await service.receive(1, { receivedQuantity: 500, finish: true }, 7);
      await service.cancelReceipt(1, 101, 7);
      expect(row.receipts[1]).toMatchObject({ status: 2, cancelledByName: 'Operator' });
      expect(row).toMatchObject({ status: 5, receivingClosed: false, totalPayable: 9500 });
      await service.cancelReceipt(1, 100, 7);
      expect(row).toMatchObject({ status: 4, receivedQuantity: null, debtAmount: 0, totalPayable: 19000 });
    });

    it('cannot cancel the last receipt while NSX payments exist', async () => {
      const { service, tx } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      tx.payableAllocation.aggregate.mockResolvedValue({ _sum: { settledAmount: 1000 } });
      await expect(service.cancelReceipt(1, 100, 7)).rejects.toThrow('Hãy hủy thanh toán');
    });

    it('cancelling the whole slip cancels every receipt', async () => {
      const { service, row } = sent();
      await service.receive(1, { receivedQuantity: 500 }, 7);
      await service.cancel(1, 7);
      expect(row.status).toBe(3);
      expect(row.receipts[0].status).toBe(2);
    });

    it('a slip completed before receipts existed becomes "Đợt 1" on first edit, moving its stock log', async () => {
      const { service, tx, row } = fixture(2);
      Object.assign(row, {
        receivedQuantity: 160, completedDate: new Date('2026-11-02T00:00:00Z'), totalPayable: 25000,
        processingFee: 0, manufacturerMaterialCost: 25000, totalForeignPayable: null, batchUnitCost: 206.25,
        outputSpecSnapshot: {}, costSnapshotAt: new Date(),
      });
      row.manufacturerMaterials = [{ productId: null, description: 'Confidential', pricingMode: 'TOTAL', quantity: null, unit: null, unitPrice: 0, amount: 25000 }];
      await service.updateReceipt(1, 0, { receivedQuantity: 150 }, 7);
      expect(tx.productionReceipt.create.mock.calls[0][0].data).toMatchObject({ seq: 1, code: 'GSX1-1', totalPayable: 25000 });
      expect(tx.inventoryLog.updateMany).toHaveBeenCalledWith({
        where: { refType: 'production', refId: 1, transactionType: 'PRODUCTION_IN' },
        data: { refType: 'production_receipt', refId: 100 },
      });
      // Phiếu cũ đã nhận đủ 160 → sửa còn 150 thì mở lại như phiếu tự hoàn thành.
      expect(row).toMatchObject({ status: 5, totalPayable: 25000 });
      expect(Number(row.receivedQuantity)).toBe(150);
    });

    it('an old slip completed short counts as closed early and stays completed after an edit', async () => {
      const { service, row } = fixture(2);
      Object.assign(row, {
        receivedQuantity: 150, completedDate: new Date('2026-11-02T00:00:00Z'), totalPayable: 25000,
        processingFee: 0, manufacturerMaterialCost: 25000, totalForeignPayable: null, batchUnitCost: 220,
        outputSpecSnapshot: {}, costSnapshotAt: new Date(),
      });
      row.manufacturerMaterials = [{ productId: null, description: 'Confidential', pricingMode: 'TOTAL', quantity: null, unit: null, unitPrice: 0, amount: 25000 }];
      await service.updateReceipt(1, 100, { receivedQuantity: 140 }, 7);
      expect(row).toMatchObject({ status: 2, receivingClosed: true });
      expect(row.completedDate.toISOString().slice(0, 10)).toBe('2026-11-02');
    });
  });

  describe('editing a sent slip', () => {
    const products = [
      { id: 10, code: 'A', name: 'Tea A', type: 2, unit: 'kg' },
      { id: 12, code: 'C', name: 'Trà C', type: 2, unit: 'kg' },
    ];
    const sent = (status = 4) => {
      const ctx = fixture(status);
      ctx.tx.product.findMany.mockResolvedValue(products);
      Object.assign(ctx.row, {
        quantity: 160, batchUnitCost: 168.75, outputSpecSnapshot: {}, costSnapshotAt: new Date(),
        formulaId: null, formulaName: null, note: null,
      });
      ctx.row.components = [{ id: 1, componentProductId: 10, componentCode: 'A', componentName: 'Tea A', actualGrams: 80, unit: 'kg', conversionFactor: 1, unitsDeducted: 80, unitCost: 100 }];
      ctx.row.manufacturerMaterials = [{ productId: null, description: 'Confidential', pricingMode: 'TOTAL', quantity: null, unit: null, unitPrice: 0, amount: 16000 }];
      // Giá vốn hiện tại đã đổi so với lúc gửi.
      ctx.tx.inventory.findUnique.mockResolvedValue({ onHand: 50, cost: 120, productName: 'Tea A' });
      return ctx;
    };
    const dto = (over: any = {}) => ({
      manufacturerId: 5, productId: 10, sourceBranchId: 2, destinationBranchId: 2, quantity: 160,
      feeCurrency: 'VND', processingFee: 3000,
      ownMaterials: [{ productId: 10, quantity: 100, unit: 'kg' }],
      manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 16000 }],
      ...over,
    });

    it('rewrites the material stock-out keeping the cost captured at send; new lines use the current cost', async () => {
      const { service, tx, row } = sent();
      await service.updateSent(1, dto({ ownMaterials: [{ productId: 10, quantity: 100, unit: 'kg' }, { productId: 12, quantity: 10, unit: 'kg' }] }) as any, 7);
      expect(tx.inventoryLog.deleteMany).toHaveBeenCalledWith({ where: { refType: 'production', refId: 1, transactionType: 'PRODUCTION_OUT' } });
      const logs = tx.inventoryLog.create.mock.calls.map((call: any) => call[0].data);
      expect(logs.map((log: any) => [log.productId, Number(log.quantity), Number(log.costPrice)])).toEqual([[10, -100, 100], [12, -10, 120]]);
      // 100 × 100 + 10 × 120 = 11.200; giá thành = (11.200 + 19.000) / 160.
      expect(row.materialValue).toBe(11200);
      expect(Number(row.batchUnitCost)).toBe(188.75);
      expect(recalcOnHandForPairs).toHaveBeenCalledWith(tx, [{ productId: 10, branchId: 2 }, { productId: 12, branchId: 2 }]);
    });

    it('fails before rewriting stock when the source cannot cover an increase (80 → 100 kg, 10 kg left)', async () => {
      const { service, tx } = sent();
      tx.inventory.findUnique.mockResolvedValue({ onHand: 10, cost: 100, productName: 'Tea A' });
      await expect(service.updateSent(1, dto() as any, 7)).rejects.toThrow(
        'Không đủ tồn kho "Tea A" tại kho gửi: cần 100 kg, còn 90 kg',
      );
      expect(tx.inventoryLog.deleteMany).not.toHaveBeenCalled();
    });

    it('a changed planned cost clears an applied cost so it can be applied again', async () => {
      const { service, row } = sent();
      Object.assign(row, { costAppliedAt: new Date(), appliedUnitCost: 168.75, costAppliedByName: 'Operator' });
      await service.updateSent(1, dto({ ownMaterials: [{ productId: 10, quantity: 80, unit: 'kg' }], quantity: 200 }) as any, 7);
      expect(Number(row.batchUnitCost)).toBe(135);
      expect(row).toMatchObject({ costAppliedAt: null, appliedUnitCost: null });
    });

    it('unchanged inputs keep the batch cost and the applied cost', async () => {
      const { service, row } = sent();
      const appliedAt = new Date();
      Object.assign(row, { costAppliedAt: appliedAt });
      await service.updateSent(1, dto({ ownMaterials: [{ productId: 10, quantity: 80, unit: 'kg' }], note: 'Ghi chú mới' }) as any, 7);
      expect(Number(row.batchUnitCost)).toBe(168.75);
      expect(row).toMatchObject({ costAppliedAt: appliedAt, note: 'Ghi chú mới' });
    });

    it('raising the planned quantity of an auto-completed slip reopens it', async () => {
      const { service, row } = sent(4);
      await service.receive(1, { receivedQuantity: 160 }, 7);
      expect(row.status).toBe(2);
      await service.updateSent(1, dto({ ownMaterials: [{ productId: 10, quantity: 80, unit: 'kg' }], quantity: 300 }) as any, 7);
      expect(row.status).toBe(5);
    });

    it('rejects changing manufacturer, product or branches, and currency once received', async () => {
      const { service, row } = sent();
      await expect(service.updateSent(1, dto({ productId: 99 }) as any, 7)).rejects.toThrow('Hãy hủy phiếu và tạo lại');
      await expect(service.updateSent(1, dto({ sourceBranchId: 3 }) as any, 7)).rejects.toThrow('Hãy hủy phiếu và tạo lại');
      row.receipts.push({ id: 100, seq: 1, status: 1, quantity: 10, receivedDate: new Date('2026-11-02T00:00:00Z') });
      await expect(service.updateSent(1, dto({ feeCurrency: 'CNY', feeForeignAmount: 1 }) as any, 7)).rejects.toThrow('không đổi được tiền tệ');
    });

    it('a cancelled slip cannot be edited', async () => {
      const { service } = sent(3);
      await expect(service.updateSent(1, dto() as any, 7)).rejects.toThrow('Phiếu đã hủy');
    });
  });
});
