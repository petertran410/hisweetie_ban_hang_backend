import { safeReturnTo } from './lark-oauth.util';

describe('safeReturnTo', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://attacker.example/x',
    '//attacker.example/x',
    '/\\attacker.example/x',
    '/\t/attacker.example/x',
    '/\n/attacker.example/x',
    '/.//attacker.example/x',
    '/./\\attacker.example/x',
    '/..//attacker.example/x',
    '/%2e//attacker.example/x',
    'ban-hang',
    '',
  ])('từ chối %p', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });

  it.each([undefined, null, 42, {}])(
    'giá trị không phải chuỗi %p → fallback',
    (value) => {
      expect(safeReturnTo(value, '/x')).toBe('/x');
    },
  );

  it.each([
    ['/', '/'],
    ['/ban-hang', '/ban-hang'],
    ['/ban-hang?tab=order#x', '/ban-hang?tab=order#x'],
    ['/don-hang/hoa-don?code=HD000123', '/don-hang/hoa-don?code=HD000123'],
  ])('giữ đường dẫn nội bộ %p', (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });
});
