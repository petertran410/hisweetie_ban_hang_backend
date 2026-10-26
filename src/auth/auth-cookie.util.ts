import { randomBytes } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';
import { sessionConfig } from './session/session.config';
import type { IssuedRefresh, SessionContext } from './session/session.service';

/** Cookie chứa refresh token. HttpOnly → JS (kể cả mã độc XSS) không đọc được. */
export const REFRESH_COOKIE = 'hs_rt';
/**
 * Mã trình duyệt: ngẫu nhiên, không chứa thông tin gì, KHÔNG xoá khi đăng xuất.
 * Nhờ nó, đăng nhập lại trên cùng trình duyệt thay đúng dòng phiên cũ
 * thay vì tạo thêm dòng mới (1 user + 1 trình duyệt = 1 dòng `auth_sessions`).
 */
export const DEVICE_COOKIE = 'hs_did';
/** Chỉ gửi tới các endpoint xác thực, không đi kèm mọi request API. */
const AUTH_COOKIE_PATH = '/api/auth';
/** 16 byte base64url = 22 ký tự. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Chrome giới hạn hạn cookie tối đa 400 ngày. */
const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
/** Mã vừa tạo trong request hiện tại (gọi nhiều lần không sinh mã khác). */
const ISSUED_DEVICE_ID = Symbol('issuedDeviceId');

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: sessionConfig.cookieSecure,
  sameSite: 'strict',
  path: AUTH_COOKIE_PATH,
  // Không đặt `domain` → cookie chỉ thuộc đúng host backend.
});

export function setRefreshCookie(res: Response, refresh: IssuedRefresh) {
  res.cookie(REFRESH_COOKIE, refresh.token, {
    ...baseOptions(),
    expires: refresh.expiresAt,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value ? value : undefined;
}

export function readRefreshCookie(req: Request): string | undefined {
  return readCookie(req, REFRESH_COOKIE);
}

export function readDeviceId(req: Request): string | undefined {
  const issued = (req as unknown as Record<symbol, string | undefined>)[
    ISSUED_DEVICE_ID
  ];
  if (issued) return issued;
  const value = readCookie(req, DEVICE_COOKIE);
  return value && DEVICE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Mã trình duyệt của request; chưa có (hoặc sai định dạng) thì tạo và đặt cookie.
 * SameSite=Lax (khác refresh token): Lark chuyển hướng về callback từ domain
 * khác, Strict sẽ không được gửi kèm. Cookie này không phải thông tin xác thực.
 */
export function ensureDeviceId(req: Request, res: Response): string {
  const existing = readDeviceId(req);
  if (existing) return existing;
  const deviceId = randomBytes(16).toString('base64url');
  (req as unknown as Record<symbol, string>)[ISSUED_DEVICE_ID] = deviceId;
  res.cookie(DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: sessionConfig.cookieSecure,
    sameSite: 'lax',
    path: AUTH_COOKIE_PATH,
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
  return deviceId;
}

/**
 * Mã ngẫu nhiên gắn lượt đăng nhập Lark với ĐÚNG trình duyệt đã bấm "Đăng nhập
 * Lark" (chống login CSRF: kẻ xấu gửi link callback của chính họ cho nạn nhân).
 * Lax vì Lark chuyển hướng về callback từ domain khác.
 */
export const LARK_NONCE_COOKIE = 'hs_lark_nonce';
const LARK_NONCE_PATH = '/api/auth/lark';
const larkNonceOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: sessionConfig.cookieSecure,
  sameSite: 'lax',
  path: LARK_NONCE_PATH,
});

export function issueLarkNonce(res: Response): string {
  const nonce = randomBytes(16).toString('base64url');
  res.cookie(LARK_NONCE_COOKIE, nonce, {
    ...larkNonceOptions(),
    maxAge: 10 * 60 * 1000,
  });
  return nonce;
}

export function takeLarkNonce(req: Request, res: Response): string | undefined {
  const nonce = readCookie(req, LARK_NONCE_COOKIE);
  res.clearCookie(LARK_NONCE_COOKIE, larkNonceOptions());
  return nonce;
}

/**
 * IP gần đúng của người dùng (chỉ để hiển thị trong "Thiết bị đăng nhập"):
 * request đi qua Cloudflare → Synology → nginx nên ưu tiên header của Cloudflare.
 */
export function clientIp(req: Request): string | undefined {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip;
}

/** Có `res` → bảo đảm trình duyệt có mã thiết bị (tạo cookie nếu thiếu). */
export function sessionContext(req: Request, res?: Response): SessionContext {
  return {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
    // Đăng nhập lại trên cùng trình duyệt → thay phiên cũ (1 trình duyệt = 1 phiên).
    replaceToken: readRefreshCookie(req),
    deviceId: res ? ensureDeviceId(req, res) : readDeviceId(req),
  };
}
