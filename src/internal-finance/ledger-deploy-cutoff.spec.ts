import {
  canMark,
  invoiceCodesIn,
  matchLedgerRows,
  plateKey,
  type LedgerRow,
  type PosEntry,
} from './ledger-deploy-cutoff';

const day = (d: number, h = 10) =>
  new Date(
    `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`,
  );

const ledger = (patch: Partial<LedgerRow>): LedgerRow => ({
  id: 1,
  code: 'SQ-1',
  branchId: 1,
  transactionType: 'EXPENSE',
  amount: 70000,
  occurredAt: day(12),
  description: '',
  ...patch,
});

const pos = (patch: Partial<PosEntry>): PosEntry => ({
  id: 100,
  code: 'TCNB-CHI-SG-20261014-000001',
  branchId: 1,
  direction: 'EXPENSE',
  category: 'DELIVERY_FEE',
  subCategory: 'FEE_GUI_BEN',
  sourceType: 'PACKING_SLIP',
  amount: 70000,
  occurredAt: day(14),
  description: 'Phí gửi bến - BD-1',
  status: 'PENDING_ACCOUNTANT',
  cashIssued: false,
  sourceSnapshot: {},
  invoiceCodes: [],
  plate: null,
  customerName: null,
  fundPosted: false,
  batch: null,
  ...patch,
});

describe('ledger-deploy-cutoff', () => {
  it('reads invoice codes and plates from ledger text', () => {
    expect(
      invoiceCodesIn('Phí Grab - X - HD131238, HD131390 - HD131273.01 -'),
    ).toEqual(['HD131238', 'HD131390', 'HD131273.01']);
    expect(plateKey('29D - 132.16')).toBe('29d13216');
  });

  it('matches delivery fees by invoice code even when POS saved the slip later', () => {
    const rows = [
      ledger({ id: 1, description: 'Phí gửi bến - Ms Hồng - HD131271 -' }),
      ledger({ id: 2, description: 'Phí gửi bến - Ms Mai - HD131273 -' }),
    ];
    const entries = [
      pos({ id: 100, invoiceCodes: ['HD131273'] }),
      pos({ id: 101, invoiceCodes: ['HD131271'] }),
    ];
    const result = matchLedgerRows(rows, entries);
    expect(
      result.map((item) => [item.ledger.id, item.pos?.id, item.by]),
    ).toEqual([
      [1, 101, 'HD'],
      [2, 100, 'HD'],
    ]);
  });

  it('matches a fee entered later on POS by invoice code even with another amount', () => {
    const result = matchLedgerRows(
      [ledger({ description: 'Phí gửi bến - A - HD131271 -', amount: 70000 })],
      [
        pos({
          id: 400,
          amount: 80000,
          occurredAt: day(20),
          invoiceCodes: ['HD131271'],
        }),
        pos({
          id: 401,
          subCategory: 'FEE_GRAB',
          amount: 70000,
          invoiceCodes: ['HD131271'],
        }),
      ],
    );
    expect(result[0]).toMatchObject({ pos: { id: 400 }, by: 'HD' });
  });

  it('does not match a fee to a vehicle entry of the same amount', () => {
    const result = matchLedgerRows(
      [ledger({ description: 'Phí gửi bến - A - HD1 -' })],
      [pos({ sourceType: 'FUEL', category: 'FUEL', invoiceCodes: [] })],
    );
    expect(result[0].pos).toBeNull();
  });

  it('matches fuel by plate and receipts by customer name', () => {
    const result = matchLedgerRows(
      [
        ledger({
          id: 1,
          amount: 500000,
          description: 'Dầu xe - Xăng - 29D - 132.16 - 2026/10/12',
        }),
        ledger({
          id: 2,
          branchId: 6,
          transactionType: 'RECEIPT',
          amount: 130000000,
          occurredAt: day(13),
          description: 'Thu tiền của NLPC Hưng Thường - Hưng Yên (Sale 1 - A1)',
        }),
      ],
      [
        pos({
          id: 200,
          amount: 500000,
          sourceType: 'FUEL',
          category: 'FUEL',
          plate: '29D-233.19',
          occurredAt: day(12, 18),
        }),
        pos({
          id: 201,
          amount: 500000,
          sourceType: 'FUEL',
          category: 'FUEL',
          plate: '29D-132.16',
          occurredAt: day(12, 18),
        }),
        pos({
          id: 300,
          branchId: 6,
          direction: 'RECEIPT',
          amount: 130000000,
          occurredAt: day(13),
          sourceType: 'PACKING_SLIP',
          customerName: 'NLPC Hưng Thường - Hưng Yên',
        }),
      ],
    );
    expect(result[0]).toMatchObject({ pos: { id: 201 }, by: 'BIEN_SO' });
    expect(result[1]).toMatchObject({ pos: { id: 300 }, by: 'TEN_KHACH' });
  });

  it('does not pair fuel two days apart: likely another refuel', () => {
    const result = matchLedgerRows(
      [
        ledger({
          amount: 500000,
          occurredAt: day(13),
          description: 'Dầu xe - Xăng - 31M - 522.18 - 2026/10/13',
        }),
      ],
      [
        pos({
          amount: 500000,
          sourceType: 'FUEL',
          category: 'FUEL',
          plate: '31M-522.18',
          occurredAt: day(15),
        }),
      ],
    );
    expect(result[0].pos).toBeNull();
  });

  it('only marks POS entries that have not reached the fund yet', () => {
    expect(canMark(pos({}))).toBe(true);
    expect(canMark(pos({ cashIssued: true }))).toBe(false);
    expect(canMark(pos({ fundPosted: true }))).toBe(false);
    expect(canMark(pos({ direction: 'RECEIPT', status: 'POSTED' }))).toBe(
      false,
    );
    expect(canMark(pos({ sourceSnapshot: { larkLedgerRecorded: true } }))).toBe(
      false,
    );
  });
});
