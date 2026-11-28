import { roundMoney } from './money.util';

describe('roundMoney', () => {
  it('giữ tối đa 2 số lẻ, bỏ đuôi lỗi số thực', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(111111.11 * 3)).toBe(333333.33);
    expect(roundMoney(120000 / 1.08)).toBe(111111.11);
    expect(roundMoney(116666.67 * 30)).toBe(3500000.1);
  });

  it('số nguyên giữ nguyên', () => {
    expect(roundMoney(3600000)).toBe(3600000);
    expect(roundMoney(-88888.9)).toBe(-88888.9);
  });
});
