import { BadRequestException } from '@nestjs/common';
import {
  assertSafeWebhookUrl,
  decryptSecret,
  encryptSecret,
  isPrivateOrRestrictedIp,
} from './public-api-crypto.util';

describe('public-api-crypto.util', () => {
  describe('encryptSecret & decryptSecret', () => {
    it('mã hóa và giải mã chính xác chuỗi bí mật', () => {
      const raw = 'partner-webhook-secret-123456';
      const encrypted = encryptSecret(raw);

      expect(encrypted).not.toBe(raw);
      expect(encrypted).toMatch(/^enc:v1:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);

      const decrypted = decryptSecret(encrypted);
      expect(decrypted).toBe(raw);
    });

    it('không mã hóa lại nếu chuỗi đã có tiền tố enc:v1:', () => {
      const raw = 'enc:v1:abc:def:123';
      expect(encryptSecret(raw)).toBe(raw);
    });

    it('tương thích ngược: giữ nguyên chuỗi plain text cũ nếu chưa mã hóa', () => {
      const legacy = 'legacy-plain-text-secret';
      expect(decryptSecret(legacy)).toBe(legacy);
    });
  });

  describe('isPrivateOrRestrictedIp', () => {
    it.each([
      ['127.0.0.1', true],
      ['127.255.255.255', true],
      ['10.0.1.2', true],
      ['172.16.5.4', true],
      ['192.168.1.1', true],
      ['169.254.169.254', true], // AWS / Cloud metadata
      ['0.0.0.0', true],
      ['8.8.8.8', false],
      ['1.1.1.1', false],
      ['::1', true],
      ['::ffff:127.0.0.1', true],
    ])('nhận diện đúng IP %s là restricted: %p', (ip, expected) => {
      expect(isPrivateOrRestrictedIp(ip)).toBe(expected);
    });
  });

  describe('assertSafeWebhookUrl', () => {
    it('chặn URL không phải HTTPS', async () => {
      await expect(
        assertSafeWebhookUrl('http://example.com/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('chặn localhost', async () => {
      await expect(
        assertSafeWebhookUrl('https://localhost/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('chặn IP nội bộ trực tiếp', async () => {
      await expect(
        assertSafeWebhookUrl('https://127.0.0.1/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        assertSafeWebhookUrl('https://169.254.169.254/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        assertSafeWebhookUrl('https://10.0.0.5/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        assertSafeWebhookUrl('https://192.168.1.50/webhook'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
