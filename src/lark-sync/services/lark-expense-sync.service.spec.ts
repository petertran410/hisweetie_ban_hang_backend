import { LarkExpenseSyncService } from './lark-expense-sync.service';

describe('Legacy expense Base writes', () => {
  it('never writes finance records even if the legacy env flag is enabled', async () => {
    const base = { isEnabled: jest.fn().mockReturnValue(true), createRecord: jest.fn(), updateRecord: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('true') };
    const service = new LarkExpenseSyncService(base as any, {} as any, config as any, {} as any);
    expect(service.isEnabled()).toBe(false);
    await service.syncPackingSlipExpenses({ id: 1, branchId: 6, hasFeeGuiBen: true, feeGuiBen: 20000 } as any);
    expect(base.createRecord).not.toHaveBeenCalled();
    expect(base.updateRecord).not.toHaveBeenCalled();
  });
});
