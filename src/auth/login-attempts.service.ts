import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
/** Sai liên tiếp từ cùng 1 IP vào 1 tài khoản → khoá IP đó với tài khoản đó. */
const MAX_FAILURES_PER_EMAIL_IP = 5;
/**
 * Trần mềm theo tài khoản (mọi IP cộng lại) → chống dò mật khẩu phân tán. Đặt
 * cao hơn để kẻ xấu khó cố tình khoá tài khoản của người khác.
 */
const MAX_FAILURES_PER_EMAIL = 20;
const MAX_TRACKED_KEYS = 10_000;

interface AttemptRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export interface FailureResult {
  /** Lần sai này vừa làm tài khoản / IP bị khoá. */
  lockedNow: boolean;
}

/**
 * Chống dò mật khẩu theo TÀI KHOẢN (bổ sung cho rate-limit theo IP của
 * ThrottlerGuard). Lưu trong bộ nhớ: app chạy 1 instance; khởi động lại thì
 * đếm lại từ đầu — chấp nhận được.
 */
@Injectable()
export class LoginAttemptsService {
  private readonly records = new Map<string, AttemptRecord>();

  private keys(email: string, ip?: string) {
    const account = `e:${email.trim().toLowerCase()}`;
    return { account, pair: `${account}|ip:${ip ?? '-'}` };
  }

  private live(key: string, now: number): AttemptRecord | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.lockedUntil <= now && now - record.windowStart >= WINDOW_MS) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** Đang bị khoá → 429 kèm số phút phải chờ. */
  assertNotLocked(email: string, ip?: string, now = Date.now()) {
    const { account, pair } = this.keys(email, ip);
    const lockedUntil = Math.max(
      this.live(pair, now)?.lockedUntil ?? 0,
      this.live(account, now)?.lockedUntil ?? 0,
    );
    if (lockedUntil > now) {
      const minutes = Math.ceil((lockedUntil - now) / 60_000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'LOGIN_LOCKED',
          message: `Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(email: string, ip?: string, now = Date.now()): FailureResult {
    const { account, pair } = this.keys(email, ip);
    const pairLocked = this.bump(pair, MAX_FAILURES_PER_EMAIL_IP, now);
    const accountLocked = this.bump(account, MAX_FAILURES_PER_EMAIL, now);
    return { lockedNow: pairLocked || accountLocked };
  }

  /** Đăng nhập đúng → xoá đếm của IP này (đếm theo tài khoản giữ nguyên). */
  recordSuccess(email: string, ip?: string) {
    this.records.delete(this.keys(email, ip).pair);
  }

  private bump(key: string, max: number, now: number): boolean {
    let record = this.live(key, now);
    if (!record || now - record.windowStart >= WINDOW_MS) {
      record = { failures: 0, windowStart: now, lockedUntil: 0 };
    }
    record.failures += 1;
    let lockedNow = false;
    if (record.failures >= max && record.lockedUntil <= now) {
      record.lockedUntil = now + LOCK_MS;
      record.failures = 0;
      record.windowStart = now;
      lockedNow = true;
    }
    if (!this.records.has(key) && this.records.size >= MAX_TRACKED_KEYS) {
      this.sweep(now);
    }
    this.records.set(key, record);
    return lockedNow;
  }

  private sweep(now: number) {
    for (const key of [...this.records.keys()]) this.live(key, now);
    // Vẫn đầy (đang bị tấn công diện rộng) → bỏ bản ghi cũ nhất.
    while (this.records.size >= MAX_TRACKED_KEYS) {
      const [oldest] = this.records.keys();
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}
