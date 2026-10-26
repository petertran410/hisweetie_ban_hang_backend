import { EventEmitter } from 'events';

/**
 * Kênh sự kiện nội bộ (không import service nào) để SessionService báo
 * "phiên bị thu hồi" mà không phụ thuộc trực tiếp vào RealtimeService
 * (tránh vòng import session → realtime → auth → session).
 */
export const SESSION_REVOKED = 'session.revoked';

export interface SessionRevokedEvent {
  /** Đăng xuất mọi thiết bị của các user này. */
  userIds: number[];
  /** Đăng xuất đúng các phiên (thiết bị) này. */
  sessionIds?: number[];
  reason: string;
}

/** Vừa đăng nhập (tạo phiên mới). */
export const SESSION_CREATED = 'session.created';

export interface SessionCreatedEvent {
  userId: number;
  sessionId: number;
  userAgent?: string;
  ip?: string;
  /**
   * Trình duyệt/thiết bị user chưa từng dùng (không phải lần đăng nhập đầu
   * tiên của user) → nên báo cho chính chủ.
   */
  newDevice: boolean;
}

export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(20);
