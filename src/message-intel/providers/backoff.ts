/** Số lần gọi tối đa cho 1 tin; quá thì chuyển failed. */
export const MAX_ATTEMPTS = 6;
const BASE_MS = 30_000;
const CAP_MS = 6 * 60 * 60 * 1000;
/** Retry-After lớn hơn mức này coi như bất thường, dùng backoff thường. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Thời gian chờ trước lần thử thứ `attempt + 1`: 30s × 2^(attempt-1), tối đa 6 giờ, jitter nửa khoảng
 * (cùng cách outbox Meta). Nhà cung cấp gửi Retry-After thì chờ ít nhất bằng đó.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  random = Math.random,
) {
  const exponential = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  const half = Math.floor(exponential / 2);
  const delay = half + Math.floor(random() * half);
  return retryAfterMs !== null && retryAfterMs <= MAX_RETRY_AFTER_MS
    ? Math.max(delay, retryAfterMs)
    : delay;
}

/** Đọc header Retry-After (giây hoặc ngày giờ HTTP) / retry-after-ms → mili giây; không đọc được → null. */
export function parseRetryAfter(
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): number | null {
  if (!headers) return null;
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers['retry-after'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
