import { normalizeVnPhone } from './phone.util';

describe('normalizeVnPhone', () => {
  it('đưa về 0xxxxxxxxx, bỏ hậu tố trùng và ký tự phân cách', () => {
    expect(normalizeVnPhone('0913597795')).toBe('0913597795');
    expect(normalizeVnPhone('+84 913 597 795')).toBe('0913597795');
    expect(normalizeVnPhone('84913597795')).toBe('0913597795');
    expect(normalizeVnPhone('091.359.7795')).toBe('0913597795');
    expect(normalizeVnPhone('0382561000.1')).toBe('0382561000');
  });

  it('không phải SĐT 10 số → null', () => {
    expect(normalizeVnPhone('')).toBeNull();
    expect(normalizeVnPhone(null)).toBeNull();
    expect(normalizeVnPhone('12345')).toBeNull();
    expect(normalizeVnPhone('091359779512')).toBeNull();
  });
});
