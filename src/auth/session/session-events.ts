import { EventEmitter } from 'events';

/**
 * Kênh sự kiện nội bộ (không import service nào) để SessionService báo
 * "phiên bị thu hồi" mà không phụ thuộc trực tiếp vào RealtimeService
 * (tránh vòng import session → realtime → auth → session).
 */
export const SESSION_REVOKED = 'session.revoked';

export interface SessionRevokedEvent {
  userIds: number[];
  reason: string;
}

export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(20);
