import {
  FUEL_ADVANCE_FROM,
  buildFuelAdvanceLedger,
  fuelAdvanceFromManual,
  fuelAdvanceFromVoucher,
  fuelApprovedAt,
  isFuelAdvanceEntry,
  isKhoHnFuelVoucher,
} from './fuel-advance';

const METHOD = 'widget17321753417610001';
const CASH_SOURCE = 'widget17643292059530001';
const AMOUNT = 'widget17321752802850001';

function voucherForm(patch: Record<string, unknown> = {}) {
  const fields = {
    department: 'Kho Hà Nội',
    expenseType: 'Chi phí kho',
    expenseItem: 'Xăng xe: oto, xe tại kho',
    method: 'Chuyển khoản công ty',
    cashSource: '',
    amount: 20000000,
    ...patch,
  };
  return JSON.stringify([
    { id: METHOD, name: 'Phương thức thanh toán', value: fields.method },
    { id: CASH_SOURCE, name: 'Nguồn Tiền Mặt', value: fields.cashSource },
    { id: AMOUNT, name: 'Số tiền', value: fields.amount },
    { id: 'a', name: 'Chi phí thuộc phòng ban', value: fields.department },
    { id: 'b', name: 'Loại chi phí', value: fields.expenseType },
    { id: 'c', name: 'Khoản mục chi phí', value: fields.expenseItem },
  ]);
}

const voucher = (patch: Record<string, unknown> = {}, id = 1) => ({
  id,
  completedAt: new Date('2026-11-15T03:00:00.000Z'),
  amount: 20000000,
  description: 'Ứng xăng tháng 11',
  requesterName: 'Kế toán',
  form: voucherForm(patch),
});

describe('Kho HN fuel advance', () => {
  it('only takes PHIẾU CHI for Kho Hà Nội / Chi phí kho / Xăng xe, with or without accents', () => {
    expect(
      isKhoHnFuelVoucher({
        department: 'Kho Hà Nội',
        expenseType: 'Chi phí kho',
        expenseItem: 'Xăng xe: oto, xe tại kho',
      }),
    ).toBe(true);
    expect(
      isKhoHnFuelVoucher({
        department: 'kho ha noi',
        expenseType: 'chi phi kho',
        expenseItem: 'xang xe oto xe tai kho',
      }),
    ).toBe(true);
    for (const wrong of [
      { department: 'Kho Sài Gòn' },
      { expenseType: 'Chi phí văn phòng' },
      { expenseItem: 'Sửa chữa, bảo dưỡng; oto xe máy' },
      { department: null },
    ])
      expect(
        isKhoHnFuelVoucher({
          department: 'Kho Hà Nội',
          expenseType: 'Chi phí kho',
          expenseItem: 'Xăng xe: oto, xe tại kho',
          ...wrong,
        }),
      ).toBe(false);
  });

  it('counts every payment method and keeps the cash source of cash vouchers', () => {
    expect(fuelAdvanceFromVoucher(voucher())).toMatchObject({
      amount: 20000000,
      method: 'Chuyển khoản công ty',
      cashSource: null,
      cashAmount: null,
    });
    expect(
      fuelAdvanceFromVoucher(
        voucher({ method: 'Tiền mặt', cashSource: 'Tiền Mặt Văn Phòng HN' }),
      ),
    ).toMatchObject({
      amount: 20000000,
      cashSource: 'Tiền Mặt Văn Phòng HN',
      cashAmount: 20000000,
    });
    expect(fuelAdvanceFromVoucher(voucher({ department: 'Kho SG' }))).toBe(
      null,
    );
    expect(
      fuelAdvanceFromVoucher({ ...voucher(), form: 'không phải JSON' }),
    ).toBe(null);
  });

  it('turns a manual advance into an advance row without fund details', () => {
    expect(
      fuelAdvanceFromManual({
        id: 3,
        occurredAt: FUEL_ADVANCE_FROM,
        amount: '20000000',
        note: 'Ứng xăng trước khi lên POS',
        creatorName: 'Kế toán kho',
      }),
    ).toEqual({
      source: 'MANUAL',
      id: 3,
      at: FUEL_ADVANCE_FROM,
      amount: 20000000,
      description: 'Ứng xăng trước khi lên POS',
      requesterName: 'Kế toán kho',
      method: null,
      cashSource: null,
      cashAmount: null,
    });
  });

  it('applies to Kho HN fuel from 14/11/2026 only', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      isFuelAdvanceEntry({
        branchId: 6,
        category: 'FUEL',
        occurredAt: FUEL_ADVANCE_FROM,
      }),
    ).toBe(true);
    expect(
      isFuelAdvanceEntry({
        branchId: 6,
        category: 'FUEL',
        occurredAt: at('2026-11-13T16:59:59.000Z'),
      }),
    ).toBe(false);
    expect(
      isFuelAdvanceEntry({
        branchId: 1,
        category: 'FUEL',
        occurredAt: at('2026-11-20T00:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      isFuelAdvanceEntry({
        branchId: 6,
        category: 'VEHICLE_CARE',
        occurredAt: at('2026-11-20T00:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('deducts a fuel entry when its second tick lands', () => {
    expect(
      fuelApprovedAt({
        managerReviewedAt: new Date('2026-11-16T02:00:00.000Z'),
        accountantReviewedAt: new Date('2026-11-17T09:00:00.000Z'),
      }),
    ).toEqual(new Date('2026-11-17T09:00:00.000Z'));
  });

  it('builds the opening balance, running balance, overspend and totals per creator', () => {
    const advance = (id: number, iso: string, amount: number) => ({
      source: 'LARK' as const,
      id,
      at: new Date(iso),
      amount,
      description: null,
      requesterName: null,
      method: null,
      cashSource: null,
      cashAmount: null,
    });
    const fuel = (
      id: number,
      iso: string,
      amount: number,
      creator: number,
    ) => ({
      id,
      code: `XD${id}`,
      at: new Date(iso),
      occurredAt: new Date(iso),
      amount,
      vehicle: '29D',
      creatorId: creator,
      creatorName: `Lái xe ${creator}`,
    });
    const ledger = buildFuelAdvanceLedger(
      [
        advance(1, '2026-11-14T03:00:00.000Z', 20000000),
        advance(2, '2026-11-25T03:00:00.000Z', 5000000),
      ],
      [
        fuel(10, '2026-11-15T03:00:00.000Z', 3000000, 7),
        fuel(11, '2026-11-20T03:00:00.000Z', 15000000, 7),
        fuel(12, '2026-11-21T03:00:00.000Z', 6000000, 8),
        fuel(13, '2026-11-26T03:00:00.000Z', 1000000, 8),
      ],
      {
        from: new Date('2026-11-19T17:00:00.000Z'),
        to: new Date('2026-11-25T17:00:00.000Z'),
      },
    );

    // Trước kỳ: ứng 20tr, đã dùng 3tr.
    expect(ledger.opening).toBe(17000000);
    expect(ledger.advanced).toBe(5000000);
    expect(ledger.used).toBe(21000000);
    expect(ledger.closing).toBe(1000000);
    expect(ledger.rows.map((row) => [row.kind, row.id, row.balance])).toEqual([
      ['FUEL', 11, 2000000],
      // Dùng vượt số ứng: số dư âm.
      ['FUEL', 12, -4000000],
      ['ADVANCE', 2, 1000000],
    ]);
    expect(ledger.byCreator).toEqual([
      { creatorId: 7, creatorName: 'Lái xe 7', count: 1, amount: 15000000 },
      { creatorId: 8, creatorName: 'Lái xe 8', count: 1, amount: 6000000 },
    ]);
  });
});
