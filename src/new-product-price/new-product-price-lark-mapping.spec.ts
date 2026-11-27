import {
  fieldOf,
  larkBool,
  larkDecision,
  larkLinks,
  larkNumber,
  larkStage,
  larkText,
  larkUrl,
  larkUser,
} from './new-product-price-lark-mapping';

describe('larkStage (trường Flow "Quá trình thực hiện")', () => {
  it.each([
    ['Đề xuất', 'PROPOSAL'],
    ['Phòng Thu Mua', 'PURCHASING'],
    ['Phòng Kế Toán', 'ACCOUNTING'],
    ['Phòng Kinh Doanh', 'SALES'],
    ['CEO', 'CEO'],
    ['Phòng Dữ Liệu', 'DATA'],
    ['Done', 'DONE'],
    ['Ended', 'ENDED'],
  ])('%s → %s', (label, stage) => {
    expect(larkStage(label)).toBe(stage);
  });

  it('đọc được dạng object/mảng của Base v3', () => {
    expect(larkStage({ name: 'Phòng Thu Mua' })).toBe('PURCHASING');
    expect(larkStage([{ text: 'CEO' }])).toBe('CEO');
    expect(larkStage('???')).toBeNull();
    expect(larkStage(null)).toBeNull();
  });
});

describe('đọc giá trị trường', () => {
  it('text nhiều đoạn (rich text) ghép liền', () => {
    expect(
      larkText([
        { type: 'text', text: 'Siro ' },
        { type: 'text', text: 'Đào' },
      ]),
    ).toBe('Siro Đào');
  });

  it('số, url, checkbox, quyết định', () => {
    expect(larkNumber(12.5)).toBe(12.5);
    expect(larkNumber('1,250')).toBe(1250);
    expect(larkNumber(null)).toBeNull();
    expect(larkUrl({ link: 'https://x.y', text: 'Tài liệu' })).toBe(
      'https://x.y',
    );
    expect(larkBool(true)).toBe(true);
    expect(larkBool(undefined)).toBe(false);
    expect(larkDecision('Approved')).toBe('APPROVED');
    expect(larkDecision('Rejected')).toBe('REJECTED');
    expect(larkDecision('')).toBeNull();
  });

  it('người và liên kết bản ghi', () => {
    expect(larkUser([{ id: 'ou_1', name: 'An' }])).toEqual({
      openId: 'ou_1',
      name: 'An',
    });
    expect(
      larkLinks([{ record_ids: ['rec1', 'rec2'], text_arr: ['KH A', 'KH B'] }]),
    ).toEqual([
      { recordId: 'rec1', text: 'KH A' },
      { recordId: 'rec2', text: 'KH B' },
    ]);
    expect(larkLinks({ link_record_ids: ['rec9'] })).toEqual([
      { recordId: 'rec9', text: '' },
    ]);
  });

  it('fieldOf chấp nhận khác dấu/khoảng trắng tên trường', () => {
    expect(fieldOf({ 'HN- Giá Buôn': 5 }, 'HN- Giá Buôn')).toBe(5);
    expect(fieldOf({ 'hn-  gia buon': 7 }, 'HN- Giá Buôn')).toBe(7);
  });
});
