import {
  marginPct,
  sheetPriceMultiplier,
  tierForQty,
  toVnd,
  validateTiers,
} from './quote-pricing';

const agency = [
  { key: 'le', label: 'Giá lẻ', minQty: null, maxQty: null, price: 42000 },
  { key: 'ctv', label: 'Giá CTV', minQty: null, maxQty: null, price: 40000 },
  {
    key: 'dl_lt10',
    label: 'Giá Đại lý < 10T',
    minQty: 1,
    maxQty: 9,
    price: 38000,
  },
  {
    key: 'dl_ge10',
    label: 'Giá Đại lý ≥ 10T',
    minQty: 10,
    maxQty: null,
    price: 36000,
  },
];

describe('tierForQty — giá theo khung số lượng', () => {
  it('chọn khung theo số thùng, bỏ qua khung không cận (Giá lẻ / CTV)', () => {
    expect(tierForQty(agency, 1)?.key).toBe('dl_lt10');
    expect(tierForQty(agency, 9)?.key).toBe('dl_lt10');
    expect(tierForQty(agency, 10)?.key).toBe('dl_ge10');
    expect(tierForQty(agency, 250)?.key).toBe('dl_ge10');
  });

  it('không có khung phù hợp → null', () => {
    expect(tierForQty(agency, 0)).toBeNull();
    expect(tierForQty(agency.slice(0, 2), 5)).toBeNull();
  });

  it('khung chỉ có cận trên', () => {
    const tiers = [{ key: 'a', label: 'Tới 49T', minQty: null, maxQty: 49 }];
    expect(tierForQty(tiers, 49)?.key).toBe('a');
    expect(tierForQty(tiers, 50)).toBeNull();
  });
});

describe('validateTiers', () => {
  it('bộ khung đại lý của file Excel hợp lệ', () => {
    expect(validateTiers(agency)).toBeNull();
  });

  it('báo lỗi nhãn trống, trùng khoá, từ > đến, chồng khoảng, giá âm', () => {
    expect(validateTiers([])).toMatch(/ít nhất 1/);
    expect(
      validateTiers([{ key: 'a', label: ' ', minQty: null, maxQty: null }]),
    ).toMatch(/nhãn/);
    expect(
      validateTiers([
        { key: 'a', label: 'A', minQty: null, maxQty: null },
        { key: 'a', label: 'B', minQty: null, maxQty: null },
      ]),
    ).toMatch(/Trùng khoá/);
    expect(
      validateTiers([{ key: 'a', label: 'A', minQty: 10, maxQty: 5 }]),
    ).toMatch(/lớn hơn/);
    expect(
      validateTiers([
        { key: 'a', label: 'A', minQty: 1, maxQty: 10 },
        { key: 'b', label: 'B', minQty: 10, maxQty: null },
      ]),
    ).toMatch(/chồng/);
    expect(
      validateTiers([
        { key: 'a', label: 'A', minQty: null, maxQty: null, price: -1 },
      ]),
    ).toMatch(/âm/);
  });
});

describe('marginPct — cột Lợi nhuận', () => {
  it('khớp số trong file Excel (42 lẻ / 36 ≥10T → 16,67%)', () => {
    expect(marginPct(agency)).toBeCloseTo(0.16667, 4);
  });

  it('nhiệt thường: giá lẻ 55 / giá buôn 47 → 17,02%', () => {
    expect(
      marginPct([
        {
          key: 'le',
          label: 'Giá lẻ',
          minQty: null,
          maxQty: null,
          price: 55000,
        },
        {
          key: 'buon',
          label: 'Giá buôn',
          minQty: null,
          maxQty: null,
          price: 47000,
        },
      ]),
    ).toBeCloseTo(0.1702, 3);
  });

  it('ít hơn 2 giá → null', () => {
    expect(marginPct(agency.slice(0, 1))).toBeNull();
    expect(marginPct([{ ...agency[0], price: null }, agency[1]])).toBeNull();
  });
});

describe('chuẩn hoá giá khi import Excel', () => {
  it('sheet ghi theo nghìn đồng (38, 63, 2050) → ×1000', () => {
    const mul = sheetPriceMultiplier([38, 63, 150, 2050]);
    expect(mul).toBe(1000);
    expect(toVnd(38, mul)).toBe(38000);
    expect(toVnd(2050, mul)).toBe(2050000);
  });

  it('sheet đã ghi VNĐ (95000…160000) → giữ nguyên', () => {
    const mul = sheetPriceMultiplier([95000, 110000, 160000]);
    expect(mul).toBe(1);
    expect(toVnd(95000, mul)).toBe(95000);
  });

  it('ô chữ / trống / âm → null; chuỗi số được đọc', () => {
    expect(toVnd('COMING SOON', 1000)).toBeNull();
    expect(toVnd(null, 1000)).toBeNull();
    expect(toVnd(-5, 1000)).toBeNull();
    expect(toVnd('38', 1000)).toBe(38000);
    expect(toVnd('38,5', 1000)).toBe(38500);
  });

  it('sheet không có giá → hệ số 1', () => {
    expect(sheetPriceMultiplier([])).toBe(1);
  });
});
