import type { CookieOptions, Request, Response } from 'express';
import { sessionConfig } from './session/session.config';
import type { IssuedRefresh, SessionContext } from './session/session.service';

/** Cookie chứa refresh token. HttpOnly → JS (kể cả mã độc XSS) không đọc được. */
export const REFRESH_COOKIE = 'hs_rt';
/** Chỉ gửi tới các endpoint xác thực, không đi kèm mọi request API. */
const REFRESH_COOKIE_PATH = '/api/auth';

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: sessionConfig.cookieSecure,
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
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

export function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[
    REFRESH_COOKIE
  ];
  return typeof value === 'string' && value ? value : undefined;
}

export function sessionContext(req: Request): SessionContext {
  return {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  };
}
