import {
  CUTOFF,
  ledgerBranch,
  mapLedgerRecord,
  readLinks,
  warehouseBranch,
} from './legacy-fund-reconcile';

describe('legacy fund reconcile – mapping Lark ledger rows', () => {
  const record = (fields: Record<string, unknown>) => ({
    recordId: 'rec1',
    fields: {
      'Chi Nhánh': 'Kho Sài Gòn',
      'Ngày Giao Dịch': Date.parse('2026-09-22T03:00:00Z'),
      STT: '120',
      ...fields,
    },
  });

  it('keeps only the two warehouse funds', () => {
    expect(warehouseBranch('Kho Hà Nội')).toBe(6);
    expect(warehouseBranch('Kho Sài Gòn')).toBe(1);
    expect(warehouseBranch('Văn Phòng Hà Nội')).toBeNull();
    expect(warehouseBranch('Cửa Hàng Diệp Trà')).toBeNull();
  });

  it('maps the four POS funds when asked, and lets the mapper pick the fund', () => {
    expect(ledgerBranch('Kho Hà Nội')).toBe(6);
    expect(ledgerBranch('Văn Phòng Hà Nội')).toBe(4);
    expect(ledgerBranch('Văn Phòng Sài Gòn')).toBe(7);
    expect(ledgerBranch('Cửa Hàng Diệp Trà')).toBeNull();
    const office = record({
      'Chi Nhánh': 'Văn Phòng Hà Nội',
      Thu: 175000000,
      'Loại Thu Chi': 'Chuyển Tiền Nội Bộ',
    });
    expect(mapLedgerRecord(office)).toEqual([]);
    expect(mapLedgerRecord(office, ledgerBranch)).toMatchObject([
      { branchId: 4, transactionType: 'TRANSFER_IN' },
    ]);
  });

  it('splits a row with both Thu and Chi into two transactions like the Lark formula', () => {
    const rows = mapLedgerRecord(record({ Thu: 500000, Chi: 280000 }));
    expect(
      rows.map((row) => [
        row.sourceKey,
        row.transactionType,
        String(row.amount),
      ]),
    ).toEqual([
      ['LARK_LEDGER:rec1', 'RECEIPT', '500000'],
      ['LARK_LEDGER:rec1:CHI', 'EXPENSE', '280000'],
    ]);
    expect(rows[1].code).toBe('SQ-120-C');
  });

  it('maps internal transfers, cancelled rows and expense links', () => {
    const [row] = mapLedgerRecord(
      record({
        Chi: 70000,
        'Loại Thu Chi': 'Chuyển Tiền Nội Bộ',
        'Trạng Thái': 'Hủy',
        'Phiếu Chi SG': { link_record_ids: ['recExpense'] },
      }),
    );
    expect(row).toMatchObject({
      sourceKey: 'LARK_LEDGER:rec1',
      transactionType: 'TRANSFER_OUT',
      status: 'CANCELLED',
      linkedRecordIds: ['recExpense'],
    });
    expect(readLinks(['a', { record_ids: ['b'] }])).toEqual(['a', 'b']);
  });

  it('keeps a row without trade date but does not count it, like the Lark formula', () => {
    const [row] = mapLedgerRecord(
      record({
        'Ngày Giao Dịch': null,
        'Ngày Tạo': Date.parse('2026-09-12T05:13:55Z'),
        Chi: 220000,
      }),
    );
    expect(row).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Thiếu ngày giao dịch trên Lark, Lark không tính vào quỹ',
    });
    expect(row.occurredAt.toISOString()).toBe('2026-09-12T05:13:55.000Z');
  });

  it('drops rows without date, amount or warehouse', () => {
    expect(mapLedgerRecord(record({ 'Ngày Giao Dịch': null, Chi: 1 }))).toEqual(
      [],
    ); // không có cả ngày tạo
    expect(mapLedgerRecord(record({}))).toEqual([]);
    expect(
      mapLedgerRecord(record({ 'Chi Nhánh': 'Văn Phòng Sài Gòn', Chi: 1 })),
    ).toEqual([]);
    expect(CUTOFF.toISOString()).toBe('2026-10-10T17:00:00.000Z');
  });
});
