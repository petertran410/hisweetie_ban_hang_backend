import { Prisma } from '@prisma/client';
import { ManufacturerStockService } from './manufacturer-stock.service';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';

jest.mock('../common/inventory-onhand.util', () => ({ recalcOnHandForPairs: jest.fn() }));

/**
 * DB trong bộ nhớ: phiếu NL NSX + dòng, log kho, tồn kho, dòng phiếu sản xuất
 * dùng tồn NSX. recalcOnHandForPairs được giả lập = tồn đầu + Σ log còn hiệu lực.
 */
function setup() {
  const products: any[] = [
    // Thùng 20 kg: 1 kg = 0.05 thùng.
    { id: 1, code: 'T20', name: 'Trà A 20kg', type: 2, unit: 'Thùng', weight: 20, weightUnit: 'kg' },
    { id: 2, code: 'B', name: 'Trà B', type: 2, unit: 'kg', weight: 1, weightUnit: 'kg' },
  ];
  const inventories = new Map<string, any>([
    ['1:2', { productId: 1, branchId: 2, productName: 'Trà A 20kg', base: 3, onHand: 3, cost: 4000000 }],
    ['2:2', { productId: 2, branchId: 2, productName: 'Trà B', base: 50, onHand: 50, cost: 100 }],
  ]);
  const slips: any[] = [];
  const lines: any[] = [];
  const logs: any[] = [];
  /** Dòng phiếu gửi SX lấy từ tồn NSX (production.status 4 = đang trừ). */
  const components: any[] = [];
  const dec = (value: any) => new Prisma.Decimal(value ?? 0);
  const withLines = (slip: any) => slip && {
    ...slip,
    lines: lines.filter((line) => line.slipId === slip.id),
    manufacturer: { id: 5, code: 'NSX01', name: 'NSX Test' },
  };

  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    manufacturer: { findUnique: jest.fn().mockResolvedValue({ id: 5, name: 'NSX Test', isActive: true }) },
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Kho Hà Nội' }) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Operator' }) },
    product: {
      findMany: jest.fn(async ({ where }: any) => products.filter((p) => where.id.in.includes(p.id))),
      findUnique: jest.fn(async ({ where }: any) => products.find((p) => p.id === where.id)),
    },
    inventory: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { productId, branchId } = where.productId_branchId;
        return inventories.get(`${productId}:${branchId}`) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, base: 0 };
        inventories.set(`${data.productId}:${data.branchId}`, row);
        return row;
      }),
    },
    inventoryLog: {
      create: jest.fn(async ({ data }: any) => { logs.push(data); return data; }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = logs.length - 1; i >= 0; i--) if (logs[i].refType === where.refType && logs[i].refId === where.refId) logs.splice(i, 1);
        return {};
      }),
    },
    manufacturerStockSlip: {
      create: jest.fn(async ({ data }: any) => { const slip = { id: slips.length + 1, ...data }; slips.push(slip); return slip; }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(slips.find((s) => s.id === where.id), data)),
      findUnique: jest.fn(async ({ where }: any) => withLines(slips.find((s) => s.id === where.id))),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => withLines(slips.find((s) => s.id === where.id))),
    },
    manufacturerStockSlipLine: {
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = lines.length - 1; i >= 0; i--) if (lines[i].slipId === where.slipId) lines.splice(i, 1);
        return {};
      }),
      createMany: jest.fn(async ({ data }: any) => { lines.push(...data.map((line: any, i: number) => ({ id: lines.length + i + 1, ...line }))); return {}; }),
      findMany: jest.fn(async ({ where }: any) => lines
        .filter((line) => {
          const slip = slips.find((s) => s.id === line.slipId);
          if (!slip || slip.status !== where.slip.status || slip.manufacturerId !== where.slip.manufacturerId) return false;
          if (where.slip.id?.not && slip.id === where.slip.id.not) return false;
          return !where.productId || where.productId.in.includes(line.productId);
        })
        .map((line) => {
          const slip = slips.find((s) => s.id === line.slipId);
          return { ...line, slip: { id: slip.id, type: slip.type, date: slip.date } };
        })),
    },
    productionComponent: {
      findMany: jest.fn(async ({ where }: any) => components.filter((line) =>
        !where.componentProductId || where.componentProductId.in.includes(line.componentProductId))),
    },
  };
  (recalcOnHandForPairs as jest.Mock).mockImplementation(async (_tx: any, pairs: any[]) => {
    for (const pair of pairs) {
      const inv = inventories.get(`${pair.productId}:${pair.branchId}`);
      const sum = logs
        .filter((log) => log.productId === pair.productId && log.branchId === pair.branchId
          && slips.find((s) => s.id === log.refId)?.status === 1)
        .reduce((total, log) => total.add(log.quantity), dec(0));
      inv.onHand = dec(inv.base).add(sum).toNumber();
    }
  });
  // Giả lập rollback: lỗi trong transaction trả lại trạng thái trước đó.
  const transaction = async (callback: (client: any) => Promise<any>) => {
    const snapshot = {
      slips: slips.map((row) => ({ ...row })), lines: lines.map((row) => ({ ...row })), logs: logs.map((row) => ({ ...row })),
      inventories: new Map([...inventories].map(([key, row]) => [key, { ...row }])),
    };
    try {
      return await callback(tx);
    } catch (error) {
      slips.splice(0, slips.length, ...snapshot.slips);
      lines.splice(0, lines.length, ...snapshot.lines);
      logs.splice(0, logs.length, ...snapshot.logs);
      inventories.clear();
      snapshot.inventories.forEach((row, key) => inventories.set(key, row));
      throw error;
    }
  };
  const prisma: any = {
    $transaction: jest.fn(transaction),
    user: { findUnique: jest.fn().mockResolvedValue({ supplierId: null }) },
    manufacturer: { findUnique: jest.fn().mockResolvedValue({ id: 5 }) },
    product: tx.product,
    manufacturerStockSlipLine: tx.manufacturerStockSlipLine,
    productionComponent: tx.productionComponent,
  };
  const audit: any = { create: jest.fn() };
  const service = new ManufacturerStockService(prisma, audit);
  /** Phiếu gửi SX dùng `units` đơn vị kho từ tồn NSX, chụp giá BQ hiện tại. */
  const consume = async (productId: number, units: number) => {
    const { data } = await service.list(5);
    const avgCost = data.find((row) => row.productId === productId)?.avgCost ?? 0;
    components.push({ componentProductId: productId, unitsDeducted: units, unitCost: avgCost });
  };
  const stockOf = async (productId: number) => (await service.list(5)).data.find((row) => row.productId === productId);
  return { service, tx, inventories, logs, slips, lines, components, consume, stockOf };
}

const send = (over: any = {}) => ({ type: 'SEND' as const, branchId: 2, lines: [{ productId: 1, quantity: 10, unit: 'kg' }], ...over });

describe('material stock held at the manufacturer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sending 10 kg of a 20 kg carton moves 0.5 carton from the branch to the manufacturer at branch cost', async () => {
    const { service, inventories, logs, stockOf } = setup();
    const slip = await service.create(5, send(), 7);
    expect(slip).toMatchObject({ type: 'SEND', status: 1, branchName: 'Kho Hà Nội', totalValue: 2000000 });
    expect(slip.code).toMatch(/^GNL[0-9A-F]{8}$/);
    expect(logs).toEqual([expect.objectContaining({
      productId: 1, branchId: 2, transactionType: 'MANUFACTURER_STOCK_OUT', refType: 'manufacturer_stock', refId: slip.id,
      refCode: slip.code, partnerName: 'NSX Test',
    })]);
    expect(Number(logs[0].quantity)).toBe(-0.5);
    expect(Number(logs[0].costPrice)).toBe(4000000);
    expect(inventories.get('1:2').onHand).toBe(2.5);
    expect(await stockOf(1)).toMatchObject({ units: 0.5, avgCost: 4000000, value: 2000000, gramsPerUnit: 20000 });
  });

  it('refuses to send more than the branch has, with the converted amount in the message', async () => {
    const { service, slips } = setup();
    await expect(service.create(5, send({ lines: [{ productId: 1, quantity: 70, unit: 'kg' }] }), 7))
      .rejects.toThrow('Không đủ tồn kho "Trà A 20kg" tại kho gửi Kho Hà Nội: cần 3.5 Thùng (= 70 kg), còn 3 Thùng');
    expect(slips).toHaveLength(0);
  });

  it('several production slips draw it down; returning more than is left fails, a partial return goes back to the branch', async () => {
    const { service, inventories, logs, consume, stockOf } = setup();
    await service.create(5, send(), 7);
    await consume(1, 0.15); // 3 kg
    await consume(1, 0.2); // 4 kg
    expect((await stockOf(1))!.units).toBe(0.15);
    await expect(service.create(5, { type: 'RETURN', branchId: 2, lines: [{ productId: 1, quantity: 4, unit: 'kg' }] }, 7))
      .rejects.toThrow('Không đủ tồn "Trà A 20kg" tại NSX: cần 0.2 Thùng (= 4 kg), còn 0.15 Thùng');
    const back = await service.create(5, { type: 'RETURN', branchId: 2, lines: [{ productId: 1, quantity: 2, unit: 'kg' }] }, 7);
    expect(back.code).toMatch(/^TNL/);
    const returned = logs.find((log) => log.refId === back.id);
    expect(returned).toMatchObject({ transactionType: 'MANUFACTURER_STOCK_IN' });
    expect(Number(returned.quantity)).toBe(0.1);
    expect(inventories.get('1:2').onHand).toBe(2.6);
    expect((await stockOf(1))!.units).toBe(0.05);
  });

  it('a sent slip already used by production cannot be cancelled or cut below what was used', async () => {
    const { service, slips, consume } = setup();
    const slip = await service.create(5, send(), 7);
    await consume(1, 0.4); // 8 kg đã dùng
    await expect(service.cancel(slip.id, 7)).rejects.toThrow('Không hủy được: "Trà A 20kg" đã được dùng cho phiếu sản xuất');
    await expect(service.update(slip.id, { lines: [{ productId: 1, quantity: 6, unit: 'kg' }] }, 7))
      .rejects.toThrow('Không đủ tồn "Trà A 20kg" tại NSX: thiếu 0.1 Thùng');
    // Lỗi → rollback: phiếu vẫn hiệu lực, lượng vẫn 10 kg.
    expect(slips[0].status).toBe(1);
  });

  it('cancelling an unused sent slip puts the material back in the branch', async () => {
    const { service, inventories, stockOf } = setup();
    const slip = await service.create(5, send(), 7);
    const cancelled = await service.cancel(slip.id, 7);
    expect(cancelled).toMatchObject({ status: 2, cancelledByName: 'Operator' });
    expect(inventories.get('1:2').onHand).toBe(3);
    // Không còn chứng từ hiệu lực nào → mã không còn trong tồn NSX.
    expect(await stockOf(1)).toBeUndefined();
  });

  it('average cost is a moving average: send 10 @100, use 5, send 5 @130 → 115', async () => {
    const { service, inventories, consume, stockOf } = setup();
    await service.create(5, send({ lines: [{ productId: 2, quantity: 10, unit: 'kg' }] }), 7);
    await consume(2, 5);
    inventories.get('2:2').cost = 130;
    await service.create(5, send({ lines: [{ productId: 2, quantity: 5, unit: 'kg' }] }), 7);
    expect(await stockOf(2)).toMatchObject({ units: 10, avgCost: 115, value: 1150 });
  });

  it('editing keeps the cost captured when the slip was made; the stock-out is rewritten', async () => {
    const { service, inventories, logs } = setup();
    const slip = await service.create(5, send({ lines: [{ productId: 2, quantity: 10, unit: 'kg' }] }), 7);
    inventories.get('2:2').cost = 999;
    const edited = await service.update(slip.id, { lines: [{ productId: 2, quantity: 12, unit: 'kg' }] }, 7);
    expect(Number(edited.lines[0].unitCost)).toBe(100);
    expect(logs.filter((log) => log.refId === slip.id).map((log) => Number(log.quantity))).toEqual([-12]);
    expect(inventories.get('2:2').onHand).toBe(38);
    await expect(service.update(slip.id, { type: 'RETURN', lines: [{ productId: 2, quantity: 1, unit: 'kg' }] }, 7)).rejects.toThrow('Không đổi được loại phiếu');
    await expect(service.update(slip.id, { branchId: 3, lines: [{ productId: 2, quantity: 1, unit: 'kg' }] }, 7)).rejects.toThrow('Không đổi được kho');
  });

  it('an adjustment records the counted quantity; the difference is wastage at the average cost, without touching the branch', async () => {
    const { service, logs, stockOf } = setup();
    await service.create(5, send(), 7); // 0.5 thùng = 10 kg
    const logCount = logs.length;
    const adjust = await service.create(5, { type: 'ADJUST', lines: [{ productId: 1, quantity: 9.5, unit: 'kg' }] }, 7);
    expect(adjust.code).toMatch(/^DCN/);
    expect(adjust.branchId).toBeNull();
    expect(Number(adjust.lines[0].systemUnits)).toBe(0.5);
    expect(Number(adjust.lines[0].units)).toBe(-0.025);
    // −0.025 × 4.000.000 = −100.000 (hao hụt 500 g).
    expect(Number(adjust.totalValue)).toBe(-100000);
    expect(logs).toHaveLength(logCount);
    expect((await stockOf(1))!.units).toBe(0.475);
  });

  it('declaring opening stock (already at the NSX, already out of our stock) adds NSX stock only, at the declared cost', async () => {
    const { service, inventories, logs, stockOf, consume } = setup();
    const slip = await service.create(5, { type: 'OPENING', lines: [{ productId: 1, quantity: 10, unit: 'kg', unitCost: 3000000 }] }, 7);
    expect(slip.code).toMatch(/^TDK/);
    expect(slip.branchId).toBeNull();
    expect(Number(slip.lines[0].units)).toBe(0.5);
    expect(Number(slip.totalValue)).toBe(1500000);
    // Không đụng kho mình, không ghi log kho.
    expect(logs).toHaveLength(0);
    expect(inventories.get('1:2').onHand).toBe(3);
    expect(await stockOf(1)).toMatchObject({ units: 0.5, avgCost: 3000000, value: 1500000 });
    // Phiếu sản xuất dùng tồn này lấy đúng giá khai báo.
    await consume(1, 0.2);
    expect((await stockOf(1))!.units).toBe(0.3);
    // Đã dùng 0.2 → không giảm khai báo xuống dưới 4 kg, không hủy được.
    await expect(service.update(slip.id, { lines: [{ productId: 1, quantity: 3, unit: 'kg', unitCost: 3000000 }] }, 7))
      .rejects.toThrow('Không đủ tồn "Trà A 20kg" tại NSX');
    await expect(service.cancel(slip.id, 7)).rejects.toThrow('Không hủy được');
  });

  it('opening stock requires a cost; editing can correct the declared cost', async () => {
    const { service, stockOf } = setup();
    await expect(service.create(5, { type: 'OPENING', lines: [{ productId: 2, quantity: 5, unit: 'kg' }] }, 7))
      .rejects.toThrow('Nhập giá vốn cho "Trà B"');
    const slip = await service.create(5, { type: 'OPENING', lines: [{ productId: 2, quantity: 5, unit: 'kg', unitCost: 100 }] }, 7);
    await service.update(slip.id, { lines: [{ productId: 2, quantity: 5, unit: 'kg', unitCost: 120 }] }, 7);
    expect(await stockOf(2)).toMatchObject({ units: 5, avgCost: 120, value: 600 });
  });

  it('rejects a send/return without a branch and duplicate products', async () => {
    const { service } = setup();
    await expect(service.create(5, send({ branchId: undefined }), 7)).rejects.toThrow('Vui lòng chọn kho gửi');
    await expect(service.create(5, send({ lines: [{ productId: 2, quantity: 1, unit: 'kg' }, { productId: 2, quantity: 2, unit: 'kg' }] }), 7))
      .rejects.toThrow('không được trùng mã');
  });

  it('the stock card lists slips and production use, newest first, with the running balance', async () => {
    const { service, tx, components } = setup();
    await service.create(5, send({ date: new Date('2026-11-01T03:00:00Z').toISOString() }), 7);
    components.length = 0;
    tx.productionComponent.findMany.mockResolvedValueOnce([{
      unitsDeducted: 0.15, unitCost: 4000000,
      production: { id: 9, code: 'GSX9', sentDate: new Date('2026-11-05T03:00:00Z'), createdAt: new Date('2026-11-05T03:00:00Z'), productName: 'Trà thành phẩm' },
    }]);
    tx.manufacturerStockSlipLine.findMany.mockImplementationOnce(async () => [{
      units: 0.5, unitCost: 4000000, slip: { id: 1, code: 'GNL1', type: 'SEND', date: new Date('2026-11-01T03:00:00Z'), branchName: 'Kho Hà Nội', createdAt: new Date('2026-11-01T03:00:00Z') },
    }]);
    const { data } = await service.moves(5, 1);
    expect(data.map((row) => [row.refCode, row.units, row.balanceAfter])).toEqual([['GSX9', -0.15, 0.35], ['GNL1', 0.5, 0.5]]);
    expect(data[0].description).toBe('Sản xuất Trà thành phẩm');
  });
});
