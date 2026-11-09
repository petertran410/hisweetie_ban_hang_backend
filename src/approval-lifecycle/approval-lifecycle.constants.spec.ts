import {
  LARK_LEDGER_CUTOFF,
  SALARY_ADVANCE_FUND_FROM,
  VPHN_LEDGER_CUTOFF,
  larkFundCutoff,
  larkLedgerCutoff,
  readFundReceipt,
  readPaymentVoucherDetails,
  readSalaryAdvance,
} from './approval-lifecycle.constants';

describe('readFundReceipt', () => {
  const pick = (id: string, key: string) => ({
    id,
    type: 'radioV2',
    value: 'chữ hiển thị',
    option: { key },
  });
  const cash = pick('widget17321728506550001', 'md9r0rqr-tlntv5zjg8-1');
  const amount = { id: 'widget17321629138780001', type: 'amount', value: 500 };
  const date = {
    id: 'widget17321631178550001',
    type: 'date',
    value: '2026-10-08T17:00:00Z',
  };

  it('reads an internal transfer between two funds', () => {
    expect(
      readFundReceipt([
        pick('widget17321740179360001', 'miior6p8-s0rjayqbcv-1'),
        pick('widget17863314165550001', 'msmnlqej-osblnddobgd-0'),
        pick('widget17863314190270001', 'msmnlqf7-dfecjahtjww-7'),
        cash,
        amount,
        date,
      ]),
    ).toMatchObject({
      kind: 'TRANSFER',
      sourceBranchId: 1,
      destinationBranchId: 7,
      amount: 500,
      description: 'Chuyển tiền nội bộ',
    });
  });

  it('reads a refund-advance cash receipt into a fund and accepts ids in value', () => {
    expect(
      readFundReceipt([
        // Đơn POS tạo lưu thẳng mã lựa chọn ở value.
        {
          id: 'widget17321740179360001',
          type: 'radioV2',
          value: 'm5yyxva1-0qljlzdgfq2k-1',
        },
        pick('widget17730449889490001', 'mmix6zt5-jloc41vsx8k-1'),
        cash,
        amount,
        date,
      ]),
    ).toMatchObject({ kind: 'RECEIPT', branchId: 4, amount: 500 });
  });

  it('treats any receipt with two POS funds as a transfer, whatever the method', () => {
    const places = [
      pick('widget17863314165550001', 'msmnlqej-t6tk3qikgcm-0'),
      pick('widget17863314190270001', 'msmnlsb8-5t1nguy4lg2-0'),
    ];
    // Chuyển khoản cá nhân, không có phân loại: vẫn là chuyển Kho HN → VP HN.
    expect(
      readFundReceipt([
        ...places,
        pick('widget17321728506550001', 'm3sj5uh2-zttr08nfqcm-1'),
        amount,
      ]),
    ).toMatchObject({
      kind: 'TRANSFER',
      sourceBranchId: 6,
      destinationBranchId: 4,
    });
  });

  it('returns null for zero amount, a non-POS place or a non-cash plain receipt', () => {
    const transfer = [
      pick('widget17321740179360001', 'miior6p8-s0rjayqbcv-1'),
      pick('widget17863314165550001', 'msmnlqej-t6tk3qikgcm-0'),
      pick('widget17863314190270001', 'msmnlsb8-5t1nguy4lg2-0'),
    ];
    // Nơi nhận là Cá Nhân: không phải quỹ của POS.
    expect(
      readFundReceipt([
        transfer[0],
        transfer[1],
        pick('widget17863314190270001', 'msmnlqf7-dkuca05446o-11'),
        cash,
        amount,
      ]),
    ).toBeNull();
    // Thu "khác" bằng chuyển khoản: không vào quỹ tiền mặt.
    expect(
      readFundReceipt([
        pick('widget17321740179360001', 'm3qzoq6o-9zz1b70wu0s-0'),
        pick('widget17730449889490001', 'mmix7h92-hukohb4on6-0'),
        pick('widget17321728506550001', '$i18n-m3sj1xiv-4ru39bef6i-1'),
        amount,
      ]),
    ).toBeNull();
    expect(
      readFundReceipt([...transfer, cash, { ...amount, value: 0 }]),
    ).toBeNull();
    expect(
      readFundReceipt([
        pick('widget17321740179360001', 'loai-khac'),
        pick('widget17730449889490001', 'mmix7h92-hukohb4on6-0'),
        cash,
        amount,
      ]),
    ).toBeNull();
  });
});

describe('larkLedgerCutoff', () => {
  it('uses 14/10 for the warehouses and 01/11 for Văn phòng HN', () => {
    expect(larkLedgerCutoff(6)).toEqual(LARK_LEDGER_CUTOFF);
    expect(larkLedgerCutoff(1)).toEqual(LARK_LEDGER_CUTOFF);
    expect(larkLedgerCutoff(4)).toEqual(VPHN_LEDGER_CUTOFF);
    expect(larkLedgerCutoff(null)).toEqual(LARK_LEDGER_CUTOFF);
    expect(VPHN_LEDGER_CUTOFF.toISOString()).toBe('2026-10-31T17:00:00.000Z');
  });
});

describe('readPaymentVoucherDetails', () => {
  const base = [
    { id: 'widget17321753417610001', type: 'radioV2', value: 'Tiền Mặt' },
    {
      id: 'widget17643292059530001',
      type: 'radioV2',
      value: 'Tiền Mặt Văn Phòng HN',
    },
    { id: 'widget17321752802850001', type: 'amount', value: 1306000 },
    { id: 'widget17321750170610001', type: 'input', value: 'Cước đt T10' },
  ];

  it('finds the extra fields by their label, ignoring accents and punctuation', () => {
    expect(
      readPaymentVoucherDetails([
        ...base,
        {
          id: 'a',
          name: 'Loại chi phí',
          type: 'radioV2',
          value: 'Mua hàng nội địa, CCDC, dịch vụ',
        },
        {
          id: 'b',
          name: 'Khoản mục chi phí',
          type: 'radioV2',
          value: 'Cước điện thoại di động',
        },
        {
          id: 'c',
          name: 'Chi phí thuộc phòng ban',
          type: 'radioV2',
          value: 'Phòng Hành Chính - Nhân Sự',
        },
        { id: 'd', name: 'NCU', type: 'input', value: 'Viettel' },
        { id: 'e', name: 'Số tiền chuyển khoản', type: 'amount', value: 0 },
      ]),
    ).toEqual({
      method: 'Tiền Mặt',
      expenseType: 'Mua hàng nội địa, CCDC, dịch vụ',
      expenseItem: 'Cước điện thoại di động',
      department: 'Phòng Hành Chính - Nhân Sự',
      supplier: 'Viettel',
      totalAmount: 1306000,
      cashAmount: 1306000,
      transferAmount: null,
    });
  });

  it('takes the cash part for mixed payments and leaves unknown fields empty', () => {
    expect(
      readPaymentVoucherDetails([
        {
          id: 'widget17321753417610001',
          type: 'radioV2',
          value: 'Chuyển Khoản (Công Ty + Tiền Mặt)',
        },
        {
          id: 'widget17643292059530001',
          type: 'radioV2',
          value: 'Tiền Mặt Văn Phòng HN',
        },
        { id: 'widget17321752802850001', type: 'amount', value: 51274630 },
        { id: 'widget17643300136400001', type: 'amount', value: 43511590 },
        {
          id: 'e',
          name: 'Số tiền chuyển khoản',
          type: 'amount',
          value: 7763040,
        },
      ]),
    ).toMatchObject({
      totalAmount: 51274630,
      cashAmount: 43511590,
      transferAmount: 7763040,
      expenseItem: null,
      department: null,
    });
  });
});

describe('readSalaryAdvance', () => {
  const form = (method: string, source: string, amount = 3000000) => [
    {
      id: 'widget17321750020230001',
      name: 'Ngày đề xuất',
      type: 'date',
      value: '2026-08-18T17:00:00Z',
    },
    {
      id: 'widget17321753417610001',
      name: 'Phương thức thanh toán',
      type: 'radioV2',
      value: method,
    },
    {
      id: 'widget17642424767350001',
      name: 'Nguồn Tiền',
      type: 'radioV2',
      value: source,
    },
    {
      id: 'widget17321752802850001',
      name: 'Số tiền',
      type: 'amount',
      value: amount,
    },
  ];

  it('maps a cash advance to the fund it is paid from', () => {
    expect(readSalaryAdvance(form('Tiền Mặt', 'Tiền Mặt Kho SG'))).toEqual({
      amount: 3000000,
      method: 'Tiền Mặt',
      cashSource: 'Tiền Mặt Kho SG',
      branchId: 1,
      requestDate: new Date('2026-08-18T17:00:00Z'),
    });
    expect(
      readSalaryAdvance(form('Tiền Mặt', 'Tiền Mặt Văn Phòng HN'))?.branchId,
    ).toBe(4);
    expect(
      readSalaryAdvance(form('Tiền Mặt', 'Tiền Mặt Văn Phòng HCM'))?.branchId,
    ).toBe(7);
  });

  it('keeps company transfers and unknown sources out of the funds', () => {
    expect(
      readSalaryAdvance(form('Chuyển Khoản Công Ty', 'Chuyển Khoản Công Ty'))
        ?.branchId,
    ).toBeNull();
    expect(
      readSalaryAdvance(form('Tiền Mặt', 'Tiền Mặt CHDT'))?.branchId,
    ).toBeNull();
    expect(
      readSalaryAdvance(form('Tiền Mặt', 'Tiền Mặt Kho SG', 0)),
    ).toBeNull();
  });
});

describe('larkFundCutoff', () => {
  it('books salary advances only from 02/11/2026, other forms keep the branch cutoff', () => {
    expect(larkFundCutoff(6, 'LARK_SALARY_ADVANCE')).toEqual(
      SALARY_ADVANCE_FUND_FROM,
    );
    expect(larkFundCutoff(4, 'LARK_SALARY_ADVANCE')).toEqual(
      SALARY_ADVANCE_FUND_FROM,
    );
    expect(larkFundCutoff(6, 'LARK_PAYMENT_VOUCHER')).toEqual(
      LARK_LEDGER_CUTOFF,
    );
    expect(larkFundCutoff(4, null)).toEqual(VPHN_LEDGER_CUTOFF);
  });
});
