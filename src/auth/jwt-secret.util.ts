import { hkdfSync } from 'crypto';
import type { ConfigService } from '@nestjs/config';

/** Thuật toán duy nhất được chấp nhận cho access token. */
export const JWT_ALGORITHM = 'HS256' as const;

/** Ai phát hành token và token dùng cho đâu (claim `iss` / `aud`). */
export const JWT_ISSUER = 'hisweetie-pos';
export const ACCESS_TOKEN_AUDIENCE = 'hisweetie-pos-api';
/** Token phụ của luồng đăng nhập Lark (state / đặt mật khẩu). */
export const LARK_TOKEN_AUDIENCE = 'hisweetie-lark-oauth';

/**
 * Luật verify access token — dùng chung cho HTTP (JwtStrategy), WebSocket,
 * rate-limit và làm `verifyOptions` mặc định của JwtModule.
 */
export const ACCESS_TOKEN_VERIFY_OPTIONS = {
  algorithms: [JWT_ALGORITHM],
  issuer: JWT_ISSUER,
  audience: ACCESS_TOKEN_AUDIENCE,
};

export interface AccessTokenClaims {
  sub: number;
  pv: number;
  sid: number;
  typ: 'access';
  exp?: number;
}

/**
 * Access token hợp lệ phải đủ: đúng loại, có user, phiên (`sid`) và
 * permissionVersion (`pv`). Token kiểu cũ (7 ngày, thiếu `sid`/`pv`) bị từ
 * chối — không thu hồi được khi đăng xuất nên không còn được chấp nhận.
 */
export function isAccessTokenClaims(
  payload: unknown,
): payload is AccessTokenClaims {
  const p = payload as Partial<AccessTokenClaims> | null | undefined;
  return (
    !!p &&
    p.typ === 'access' &&
    Number.isInteger(p.sub) &&
    Number.isInteger(p.sid) &&
    Number.isInteger(p.pv)
  );
}

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

/**
 * Khoá riêng cho từng loại token phụ (vd state/setup của Lark), dẫn xuất từ
 * `JWT_SECRET` bằng HKDF. Token loại này ký bằng khoá khác → không bao giờ
 * được chấp nhận như access token (và ngược lại), kể cả khi quên kiểm `typ`.
 */
export function deriveJwtSecret(purpose: string, config?: ConfigService) {
  return Buffer.from(
    hkdfSync('sha256', getJwtSecret(config), 'hisweetie-jwt', purpose, 32),
  ).toString('base64url');
}
