import { slugifyVietnamese } from './slug.util';

describe('slugifyVietnamese', () => {
  it('converts Vietnamese text to an ASCII lowercase slug', () => {
    expect(slugifyVietnamese('  Trà Đào Cam Sả  ')).toBe('tra-dao-cam-sa');
  });

  it('uses a stable fallback when the name has no ASCII letters or numbers', () => {
    expect(slugifyVietnamese('---')).toBe('cong-thuc');
  });
});
