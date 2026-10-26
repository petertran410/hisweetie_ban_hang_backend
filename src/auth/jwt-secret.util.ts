import type { ConfigService } from '@nestjs/config';

/** Thuật toán duy nhất được chấp nhận cho access token. */
export const JWT_ALGORITHM = 'HS256' as const;

/**
 * Secret ký access token. Thiếu `JWT_SECRET` → dừng khởi động thay vì rơi về
 * secret mặc định (ai biết secret mặc định là ký được token hợp lệ).
 */
export function getJwtSecret(config?: ConfigService): string {
  const secret = (
    config?.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET
  )?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET must be configured');
  }
  return secret;
}
