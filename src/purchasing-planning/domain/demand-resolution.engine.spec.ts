import { resolveDemand } from './demand-resolution.engine';

describe('resolveDemand', () => {
  it('uses invoice sales and only supplements non-sales inventory demand', () => {
    expect(
      resolveDemand({
        invoiceDetails: [
          { date: '2026-08-01', quantity: 10 },
          { date: '2026-08-01', quantity: 4, type: 'RETURN' },
        ],
        inventoryLogs: [
          { date: '2026-08-01', quantity: -10, transactionType: 'SALE_OUT' },
          { date: '2026-08-01', quantity: -3, transactionType: 'INTERNAL_USE' },
        ],
      }),
    ).toEqual([
      {
        date: '2026-08-01',
        demand: 9,
        source: 'HYBRID',
      },
    ]);
  });

  it('never returns negative net demand and emits NONE for an empty day', () => {
    expect(
      resolveDemand({
        invoiceDetails: [],
        inventoryLogs: [
          { date: '2026-08-01', quantity: 8, transactionType: 'RETURN_IN' },
        ],
        dates: ['2026-08-01', '2026-08-02'],
      }),
    ).toEqual([
      { date: '2026-08-01', demand: 0, source: 'INVENTORY_LOG' },
      { date: '2026-08-02', demand: 0, source: 'NONE' },
    ]);
  });
});
