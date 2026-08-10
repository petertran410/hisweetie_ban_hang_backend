import { resolveIncoming } from './incoming-resolution.engine';

describe('resolveIncoming', () => {
  it('counts only remaining confirmed or partial quantities', () => {
    const result = resolveIncoming({
      snapshotDate: '2026-08-08',
      leadTimeDays: 30,
      lines: [
        {
          status: 1,
          orderedQuantity: 100,
          receivedQuantity: 30,
          expectedArrivalDate: '2026-08-20',
        },
        {
          status: 'CANCELLED',
          orderedQuantity: 500,
          expectedArrivalDate: '2026-08-20',
        },
      ],
    });
    expect(result.total).toBe(70);
    expect(result.receipts[0].date).toBe('2026-08-20');
  });

  it('moves a shipment overdue up to 7 days three days forward', () => {
    const result = resolveIncoming({
      snapshotDate: '2026-08-08',
      leadTimeDays: 30,
      lines: [
        { status: 2, orderedQuantity: 40, expectedArrivalDate: '2026-08-01' },
      ],
    });
    expect(result.receipts[0]).toEqual(
      expect.objectContaining({
        date: '2026-08-11',
        quantity: 40,
        overdue: true,
      }),
    );
    expect(result.flags).toEqual(['OVERDUE_SHIPMENT']);
  });

  it('drops shipments overdue more than 30 days from incoming', () => {
    const result = resolveIncoming({
      snapshotDate: '2026-08-08',
      leadTimeDays: 30,
      lines: [
        { status: 1, orderedQuantity: 40, expectedArrivalDate: '2026-06-01' },
      ],
    });
    expect(result.total).toBe(0);
    expect(result.receipts).toEqual([]);
    expect(result.flags).toEqual(['OVERDUE_SHIPMENT', 'SHIPMENT_STALE']);
  });
});
