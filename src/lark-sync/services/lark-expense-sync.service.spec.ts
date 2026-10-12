import { LarkExpenseSyncService } from './lark-expense-sync.service';

describe('Expense Base writes during the POS/Lark parallel run', () => {
  const make = () => {
    const base = {
      isEnabled: jest.fn().mockReturnValue(true),
      getBaseToken: jest.fn().mockReturnValue('base'),
      createRecord: jest.fn().mockResolvedValue('rec1'),
      updateRecord: jest.fn(),
      searchRecordsByField: jest.fn().mockResolvedValue([]),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'LARK_EXPENSE_TABLE_HN' ? 'tblHN' : undefined,
      ),
    };
    const service = new LarkExpenseSyncService(
      base as any,
      {} as any,
      config as any,
      { packingSlip: { update: jest.fn() } } as any,
    );
    return { service, base };
  };
  const slip = {
    id: 1,
    code: 'BD1',
    branchId: 6,
    createdAt: new Date('2026-10-05T03:00:00Z'),
    hasFeeGuiBen: true,
    feeGuiBen: 20000,
    hasFeeGrab: false,
    hasCuocGuiHang: false,
    hasCuocNhanHang: false,
  } as any;

  it('does not write when the expense Base is not configured', async () => {
    const { service, base } = make();
    base.isEnabled.mockReturnValue(false);
    expect(service.isEnabled()).toBe(false);
    await service.syncPackingSlipExpenses(slip);
    expect(base.createRecord).not.toHaveBeenCalled();
  });

  it('writes the fee row to the warehouse table of the slip branch', async () => {
    const { service, base } = make();
    expect(service.isEnabled()).toBe(true);
    await service.syncPackingSlipExpenses(slip);
    expect(base.createRecord).toHaveBeenCalledTimes(1);
    expect(base.createRecord.mock.calls[0][0]).toBe('tblHN');
  });
});
