import {
  pickLarkDisplayName,
  pickPreferredEmail,
  safeReturnTo,
} from './lark-oauth.util';

describe('lark-oauth.util', () => {
  describe('pickPreferredEmail', () => {
    it('prefers enterprise email when both exist', () => {
      expect(
        pickPreferredEmail('staff@hisweetie.com', 'nhan@gmail.com'),
      ).toBe('staff@hisweetie.com');
    });

    it('uses the only available email', () => {
      expect(pickPreferredEmail(null, 'nhan@gmail.com')).toBe('nhan@gmail.com');
      expect(pickPreferredEmail('staff@hisweetie.com', null)).toBe(
        'staff@hisweetie.com',
      );
    });

    it('returns null when no email', () => {
      expect(pickPreferredEmail('', '  ')).toBeNull();
      expect(pickPreferredEmail(undefined, undefined)).toBeNull();
    });

    it('lowercases and trims', () => {
      expect(pickPreferredEmail('  Staff@HiSweetie.COM ', 'a@b.com')).toBe(
        'staff@hisweetie.com',
      );
    });
  });

  describe('pickLarkDisplayName', () => {
    it('uses name then en_name then email local part', () => {
      expect(pickLarkDisplayName({ name: ' An ' })).toBe('An');
      expect(pickLarkDisplayName({ en_name: 'Ann' })).toBe('Ann');
      expect(
        pickLarkDisplayName({ enterprise_email: 'ann@hisweetie.com' }),
      ).toBe('ann');
    });
  });

  describe('safeReturnTo', () => {
    it('allows relative paths only', () => {
      expect(safeReturnTo('/orders')).toBe('/orders');
      expect(safeReturnTo('//evil.com')).toBe('/');
      expect(safeReturnTo('https://evil.com')).toBe('/');
    });
  });
});
