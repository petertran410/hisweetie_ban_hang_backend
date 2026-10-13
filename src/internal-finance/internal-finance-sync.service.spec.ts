import { InternalFinanceSyncService } from './internal-finance-sync.service';

describe('InternalFinanceSyncService', () => {
  const table = (counts: any, error?: string) => ({ ...counts, error });
  const counts = { fetched: 4, created: 2, updated: 1, skipped: 1 };
  const make = () => {
    const larkImport = {
      getImportStatus: jest.fn().mockReturnValue({ running: false }),
      importHistory: jest.fn().mockResolvedValue({ tables: [table(counts)] }),
      setExclusive: jest.fn(),
      importWarehouseCash: jest.fn().mockResolvedValue(counts),
      downloadPendingAttachments: jest
        .fn()
        .mockResolvedValue({ total: 9, downloaded: 8, failed: 1 }),
    };
    const fundHistory = {
      getStatus: jest.fn().mockReturnValue({ running: false }),
      runAndWait: jest.fn().mockResolvedValue({ ...counts, error: null }),
    };
    return {
      service: new InternalFinanceSyncService(
        larkImport as any,
        fundHistory as any,
      ),
      larkImport,
      fundHistory,
    };
  };
  const settle = async (service: InternalFinanceSyncService) => {
    for (let i = 0; i < 50 && service.getStatus().running; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    return service.getStatus();
  };

  it('runs expenses, weekly approvals, warehouse cash then the fund ledger', async () => {
    const { service, larkImport, fundHistory } = make();
    service.start(7);
    expect(() => service.start(7)).toThrow('Đang đồng bộ');
    const status = await settle(service);
    expect(larkImport.importHistory.mock.calls.map((call) => call[0])).toEqual([
      {
        dryRun: false,
        sources: ['FUEL', 'VEHICLE_CARE', 'EXPENSE_HN', 'EXPENSE_SG'],
        skipAttachments: true,
      },
      {
        dryRun: false,
        sources: ['APPROVAL_HN', 'APPROVAL_SG'],
        skipAttachments: true,
      },
    ]);
    expect(larkImport.importWarehouseCash).toHaveBeenCalledWith(
      { dryRun: false },
      7,
    );
    expect(fundHistory.runAndWait).toHaveBeenCalledWith(7);
    expect(larkImport.setExclusive.mock.calls).toEqual([[true], [false]]);
    expect(status.steps.map((step) => step.state)).toEqual([
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
    ]);
    expect(status.steps[0]).toMatchObject(counts);
    expect(status.steps[4]).toMatchObject({
      key: 'DOCUMENTS',
      fetched: 9,
      created: 8,
      skipped: 1,
    });
    expect(status.error).toBeNull();
  });

  it('records a failed step and still runs the remaining ones', async () => {
    const { service, larkImport, fundHistory } = make();
    larkImport.importHistory
      .mockResolvedValueOnce({ tables: [table(counts, 'Không đọc được bảng')] })
      .mockResolvedValueOnce({ tables: [table(counts)] });
    service.start(7);
    const status = await settle(service);
    expect(status.steps[0]).toMatchObject({
      state: 'FAILED',
      error: 'Không đọc được bảng',
    });
    expect(status.steps.slice(1).map((step) => step.state)).toEqual([
      'DONE',
      'DONE',
      'DONE',
      'DONE',
    ]);
    expect(fundHistory.runAndWait).toHaveBeenCalled();
    expect(status.error).toContain('1 bước');
  });
});
