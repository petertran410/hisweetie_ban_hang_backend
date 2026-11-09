import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/**
 * Mã hoá token Smax lưu trong DB (AES-256-GCM). Khoá lấy từ SMAX_TOKEN_ENCRYPTION_KEY,
 * thiếu thì JWT_SECRET. Đổi khoá → token cũ không giải mã được → nhập lại ở /cai-dat/smax.
 */
function key(): Buffer {
  const secret =
    process.env.SMAX_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret)
    throw new Error(
      'Thiếu SMAX_TOKEN_ENCRYPTION_KEY (hoặc JWT_SECRET) để mã hoá token Smax',
    );
  return createHash('sha256').update(`smax-user-token:${secret}`).digest();
}

export function encryptSmaxToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

/** null = không giải mã được (sai khoá / dữ liệu hỏng). */
export function decryptSmaxToken(stored: string): string | null {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1')
    return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(parts[2], 'hex'),
    );
    decipher.setAuthTag(Buffer.from(parts[3], 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4], 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** Hạn của token nếu là JWT (đọc payload, không xác thực chữ ký). */
export function jwtExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown } | null;
    return typeof payload?.exp === 'number'
      ? new Date(payload.exp * 1000)
      : null;
  } catch {
    return null;
  }
}
