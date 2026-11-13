import { PayablesService } from './payables.service';
import { PayablePaymentDto } from './dto';
import { calculateSupplierDebt } from '../common/supplier-debt.util';

function paymentFixture() {
  const allocations: any[] = [], batches: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    payablePaymentBatch: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => { const row = { id: 1, ...data }; batches.push(row); return row; }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn(async () => ({ ...batches[0], allocations })),
    },
    payableAllocation: { create: jest.fn(async ({ data }) => { allocations.push(data); return data; }) },
    purchaseOrderPayment: { create: jest.fn().mockResolvedValue({ id: 44 }) },
    cashFlow: { create: jest.fn().mockResolvedValue({ id: 66 }) },
    manufacturer: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 5, supplierId: null }) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Operator' }) },
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    auditLog: { create: jest.fn() },
  };
  const prisma: any = { $transaction: (callback: any) => callback(tx) };
  const service = new PayablesService(prisma);
  const summary = {
    accountType: 'M' as const, accountId: 5, partnerName: 'NSX A',
    purchaseDebt: 500, productionDebt: 500, totalDebt: 1000, availableCredit: 0, unallocatedBalance: 0,
    data: [
      { targetType: 'purchase_order' as const, targetId: 10, code: 'PN10', date: new Date(), total: 500, paidAmount: 0, debtAmount: 500, currency: 'VND', foreignDebt: null },
      { targetType: 'production' as const, targetId: 20, code: 'GSX20', date: new Date(), total: 500, paidAmount: 0, debtAmount: 500, currency: 'VND', foreignDebt: null },
    ],
  };
  jest.spyOn(service, 'summary').mockImplementation(async () => summary);
  const recalc = jest.spyOn(service as any, 'recalcTarget').mockResolvedValue(undefined);
  const dto: PayablePaymentDto = { requestKey: 'request-1', totalAmount: 600, branchId: 1, method: 'cash', allocations: [
    { targetType: 'purchase_order', targetId: 10, amount: 500 },
    { targetType: 'production', targetId: 20, amount: 100 },
  ] };
  return { service, tx, allocations, summary, dto, recalc };
}

describe('payables allocation', () => {
  it('one disbursement settles two document types without duplicating cash', async () => {
    const { service, tx, allocations, dto } = paymentFixture();
    await service.pay('M', 5, dto, 7);
    expect(tx.cashFlow.create).toHaveBeenCalledTimes(1);
    expect(tx.cashFlow.create.mock.calls[0][0].data.amount).toBe(600);
    expect(allocations.map((row) => row.targetType)).toEqual(['production', 'purchase_order']);
    expect(allocations.reduce((sum, row) => sum + row.settledAmount, 0)).toBe(600);
    expect(tx.purchaseOrderPayment.create).toHaveBeenCalledTimes(1);
    expect(allocations.find((row) => row.targetType === 'purchase_order').purchaseOrderPaymentId).toBe(44);
  });

  it('credit-only allocation does not create a new cashflow', async () => {
    const { service, tx, summary, dto } = paymentFixture();
    summary.availableCredit = 300;
    dto.totalAmount = 0;
    dto.allocations = [{ targetType: 'production', targetId: 20, creditAmount: 300 }];
    await service.pay('M', 5, dto, 7);
    expect(tx.cashFlow.create).not.toHaveBeenCalled();
    expect(tx.payableAllocation.create.mock.calls[0][0].data).toMatchObject({ source: 'credit', amount: 300, settledAmount: 300, fxAdjustment: 0 });
  });

  it('excess cash remains unallocated advance rather than creating extra allocations', async () => {
    const { service, tx, dto, allocations } = paymentFixture();
    dto.totalAmount = 800;
    await service.pay('M', 5, dto, 7);
    expect(tx.cashFlow.create.mock.calls[0][0].data.amount).toBe(800);
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(600);
  });

  it.each(['over-cash', 'over-credit', 'foreign-target', 'duplicate-target'] as const)('rejects invalid allocation: %s', async (kind) => {
    const { service, tx, dto } = paymentFixture();
    if (kind === 'over-cash') dto.totalAmount = 100;
    if (kind === 'over-credit') dto.allocations = [{ targetType: 'production', targetId: 20, creditAmount: 1 }];
    if (kind === 'foreign-target') dto.allocations = [{ targetType: 'production', targetId: 999, amount: 10 }];
    if (kind === 'duplicate-target') dto.allocations.push(dto.allocations[0]);
    await expect(service.pay('M', 5, dto, 7)).rejects.toThrow();
    if (kind !== 'foreign-target') expect(tx.cashFlow.create).not.toHaveBeenCalled();
  });

  it('replays an identical request without a second cash movement', async () => {
    const { service, tx, dto } = paymentFixture();
    const result = await service.pay('M', 5, dto, 7);
    tx.payablePaymentBatch.findUnique.mockResolvedValue(result);
    await service.pay('M', 5, dto, 7);
    expect(tx.cashFlow.create).toHaveBeenCalledTimes(1);
    await expect(service.pay('M', 5, { ...dto, totalAmount: 700 }, 7)).rejects.toThrow('nội dung khác');
  });

  it('settles CNY book value and records FX difference separately', async () => {
    const { service, tx, dto, summary } = paymentFixture();
    summary.data = [{ ...summary.data[1], debtAmount: 350000, total: 350000, currency: 'CNY', foreignDebt: 100 } as any];
    dto.totalAmount = 360000;
    dto.allocations = [{ targetType: 'production', targetId: 20, amount: 360000, foreignAmount: 100, exchangeRate: 3600 }];
    await service.pay('M', 5, dto, 7);
    expect(tx.payableAllocation.create.mock.calls[0][0].data).toMatchObject({ amount: 360000, settledAmount: 350000, fxAdjustment: 10000 });
  });

  it('does not allow a new standalone advance after manufacturer links to a supplier', async () => {
    const { service, tx, dto } = paymentFixture();
    tx.manufacturer.findUniqueOrThrow.mockResolvedValue({ supplierId: 9 });
    dto.totalAmount = 700;
    await expect(service.pay('M', 5, dto, 7)).rejects.toThrow('tiền ứng mới');
    expect(tx.cashFlow.create).not.toHaveBeenCalled();
  });

  it('checks document state after acquiring locks', async () => {
    const { service, dto, tx } = paymentFixture();
    const summary = service.summary as jest.Mock;
    await service.pay('M', 5, dto, 7);
    expect(tx.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(summary.mock.invocationCallOrder[0]);
  });
});

describe('supplier canonical debt with production', () => {
  it('adds production charges once, excludes owned material and preserves purchase turnover', async () => {
    const tx: any = {
      purchaseOrder: { findMany: jest.fn().mockResolvedValue([{ total: 50000, discount: 0 }]) },
      cashFlow: { findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.isReceipt ? [] : [{ amount: 60000 }])) },
      supplierReturn: { findMany: jest.fn().mockResolvedValue([]) },
      production: { aggregate: jest.fn().mockResolvedValue({ _sum: { totalPayable: 32000 } }) },
      payableAllocation: { aggregate: jest.fn().mockResolvedValue({ _sum: { fxAdjustment: 0 } }) },
    };
    expect(await calculateSupplierDebt(tx, 9)).toEqual({ totalDebt: 22000, totalInvoiced: 50000, productionCharges: 32000 });
    expect(tx.production.aggregate.mock.calls[0][0].where).toMatchObject({ supplierId: 9, status: { in: [2, 5] } });
  });
});
