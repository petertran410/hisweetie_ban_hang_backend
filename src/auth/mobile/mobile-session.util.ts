import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { clientIp, DEVICE_ID_PATTERN } from '../auth-cookie.util';
import type { IssuedRefresh, SessionContext } from '../session/session.service';

/** App gửi mã thiết bị cố định (lưu trong Keychain) qua header này. */
export const DEVICE_ID_HEADER = 'x-device-id';

/**
 * Thông tin phiên của app iOS: không cookie, mã thiết bị lấy từ header.
 * Mã thiết bị bắt buộc — đăng nhập lại trên cùng iPhone thay đúng dòng phiên
 * cũ (1 user + 1 máy = 1 dòng `auth_sessions`).
 */
export function mobileSessionContext(req: Request): SessionContext {
  const raw = req.headers[DEVICE_ID_HEADER];
  const deviceId = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new BadRequestException('Thiếu hoặc sai mã thiết bị (X-Device-Id)');
  }
  return {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
    deviceId,
  };
}

/** Phản hồi đăng nhập cho app: refresh token trả trong body thay vì cookie. */
export function toMobileAuthBody<
  T extends { accessToken: string; expiresIn: number; refresh: IssuedRefresh },
>(response: T) {
  const { refresh, ...body } = response;
  return {
    ...body,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt.toISOString(),
  };
}
