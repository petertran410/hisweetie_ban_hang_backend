import { mapClosingRecord } from './internal-fund-closing-sync.service';

describe('mapClosingRecord', () => {
  const record = (fields: Record<string, unknown>) => ({
    recordId: 'rec1',
    fields: { 'Chi Nhánh': 'Kho Hà Nội', Ngày: 1773162000000, ...fields },
    createdAt: new Date('2026-03-11T10:00:00Z'),
    modifiedAt: new Date('2026-03-12T05:00:00Z'),
  });

  it('keeps the accountant numbers, note and source timestamps', () => {
    const row = mapClosingRecord(
      record({
        'Đầu Kì': 283706000,
        Thu: 231934000,
        Chi: 19247000,
        'Đầu Kì Lark': { type: 2, value: [298426000] },
        'Thu Lark': { type: 2, value: [231934000] },
        'Chi Lark': { type: 2, value: [12647000] },
        'Ghi Chú': [{ text: 'Thu cod', type: 'text' }],
      }),
    )!;
    expect(row.branchId).toBe(6);
    expect(row.closingDate.toISOString()).toBe('2026-03-11T00:00:00.000Z');
    expect(String(row.actualClosingBalance)).toBe('496393000');
    expect(String(row.systemClosingBalance)).toBe('517713000');
    expect(row.notes).toBe('Thu cod');
    expect(row.createdAt?.toISOString()).toBe('2026-03-11T10:00:00.000Z');
  });

  it('leaves the accountant side empty when nothing was entered', () => {
    const row = mapClosingRecord(record({}))!;
    expect(row.actualOpeningBalance).toBeNull();
    expect(row.actualClosingBalance).toBeNull();
  });

  it('skips funds that are not on POS and rows without a date', () => {
    expect(
      mapClosingRecord(record({ 'Chi Nhánh': 'Cửa Hàng Diệp Trà' })),
    ).toBeNull();
    expect(mapClosingRecord(record({ Ngày: null }))).toBeNull();
  });
});
