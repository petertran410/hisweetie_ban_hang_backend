import { readFundReceipt } from './approval-lifecycle.constants';

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
