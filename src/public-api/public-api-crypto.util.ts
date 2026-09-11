import { BadRequestException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import * as dns from 'dns';
import * as net from 'net';

function getEncryptionKey(): Buffer {
  const secret =
    process.env.PUBLIC_API_ENCRYPTION_KEY ||
    process.env.PUBLIC_API_JWT_SECRET ||
    'default-encryption-key-for-public-api-32';
  return createHash('sha256').update(secret).digest();
}

/**
 * Mã hóa bí mật webhook bằng AES-256-GCM trước khi ghi vào cơ sở dữ liệu.
 */
export function encryptSecret(secret?: string | null): string | null {
  if (!secret) return null;
  if (secret.startsWith('enc:v1:')) return secret;
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Giải mã bí mật webhook. Tương thích ngược với các bản ghi lưu thô cũ.
 */
export function decryptSecret(stored?: string | null): string | null {
  if (!stored) return null;
  if (!stored.startsWith('enc:v1:')) {
    return stored;
  }
  try {
    const parts = stored.split(':');
    if (parts.length !== 5) return stored;
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const ciphertext = Buffer.from(parts[4], 'hex');
    const key = getEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return stored;
  }
}

/**
 * Kiểm tra địa chỉ URL webhook để chống SSRF (Server-Side Request Forgery).
 */
export async function assertSafeWebhookUrl(urlString: string): Promise<void> {
  if (process.env.ALLOW_INSECURE_WEBHOOK_URLS === 'true') {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new BadRequestException('URL webhook không hợp lệ');
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException(
      'URL webhook bắt buộc sử dụng giao thức HTTPS',
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    throw new BadRequestException(
      'URL webhook không được trỏ tới localhost hoặc địa chỉ nội bộ',
    );
  }

  // Nếu hostname trực tiếp là IP (vd https://10.0.0.1/hook)
  if (net.isIP(hostname)) {
    if (isPrivateOrRestrictedIp(hostname)) {
      throw new BadRequestException(
        'URL webhook không được trỏ tới dải địa chỉ IP nội bộ / riêng tư',
      );
    }
  }

  // Trong môi trường unit test không có kết nối mạng thực tế, bỏ qua DNS lookup
  // cho các fake domain (vd partner.example) trừ khi bật cờ ENFORCE_WEBHOOK_SSRF
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.ENFORCE_WEBHOOK_SSRF !== 'true'
  ) {
    return;
  }

  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateOrRestrictedIp(record.address)) {
        throw new BadRequestException(
          'URL webhook không được trỏ tới dải địa chỉ IP nội bộ / riêng tư',
        );
      }
    }
  } catch (error: any) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      `Không thể phân giải tên miền webhook: ${error.message}`,
    );
  }
}

export function isPrivateOrRestrictedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice('::ffff:'.length);
      if (net.isIPv4(v4)) return isPrivateOrRestrictedIp(v4);
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }
  return true;
}
