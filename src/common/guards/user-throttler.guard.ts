import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { getJwtSecret, JWT_ALGORITHM } from '../../auth/jwt-secret.util';

const THROTTLE_LOG_WINDOW_MS = 60_000;
const THROTTLE_LOG_MAX_TRACKERS = 1000;

/**
 * ThrottlerGuard tùy biến: đếm rate-limit theo USER thay vì theo IP.
 *
 * Lý do: nhiều nhân viên trong cùng văn phòng NAT ra chung 1 IP public.
 * Nếu đếm theo IP, tất cả họ dùng chung 1 "bucket" → mau chạm trần 429
 * dù mỗi người chỉ gọi vài request. Đếm theo user-id giúp mỗi người có
 * hạn mức riêng.
 *
 * Lưu ý thứ tự guard: ThrottlerGuard chạy TRƯỚC JwtAuthGuard nên tại đây
 * `req.user` chưa tồn tại. Ta tự VERIFY chữ ký token (HMAC, rẻ) để lấy `sub`.
 * KHÔNG được chỉ decode: kẻ tấn công có thể gửi token giả với `sub` ngẫu
 * nhiên mỗi request → mỗi lần một bucket mới → vượt rate-limit (kể cả
 * POST /auth/login để dò mật khẩu).
 *
 * Fallback về IP khi: không có Bearer token / token sai định dạng / decode
 * lỗi / thiếu `sub` (vd request public, màn hình login).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(UserThrottlerGuard.name);
  // Log 429 gộp theo tracker: dòng đầu mỗi phút được log, phần còn lại chỉ
  // đếm và in kèm ở dòng kế tiếp — tránh lụt log khi FE bắn dồn dập.
  private readonly throttleLog = new Map<
    string,
    { windowStart: number; suppressed: number }
  >();

  private verifier?: JwtService;

  private getVerifier(): JwtService {
    this.verifier ??= new JwtService({
      secret: getJwtSecret(),
      verifyOptions: { algorithms: [JWT_ALGORITHM] },
    });
    return this.verifier;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth: string | undefined = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = this.getVerifier().verify<{ sub?: number }>(
          auth.slice(7),
        );
        if (payload?.sub) {
          return `user:${payload.sub}`;
        }
      } catch {
        // Token giả/hết hạn/hỏng → đếm theo IP.
      }
    }
    return `ip:${req.ip}`;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    this.logThrottled(context, detail.tracker);
    return super.throwThrottlingException(context, detail);
  }

  private logThrottled(context: ExecutionContext, tracker: string): void {
    const now = Date.now();
    const entry = this.throttleLog.get(tracker);
    if (entry && now - entry.windowStart < THROTTLE_LOG_WINDOW_MS) {
      entry.suppressed++;
      return;
    }

    if (!entry && this.throttleLog.size >= THROTTLE_LOG_MAX_TRACKERS) {
      for (const [key, value] of this.throttleLog) {
        if (now - value.windowStart >= THROTTLE_LOG_WINDOW_MS) {
          this.throttleLog.delete(key);
        }
      }
    }
    this.throttleLog.set(tracker, { windowStart: now, suppressed: 0 });

    const req = context.switchToHttp().getRequest<Request>();
    const previous = entry?.suppressed
      ? ` (+${entry.suppressed} request bị chặn không log trong 1 phút sau lần log trước)`
      : '';
    this.logger.warn(
      `429 ${tracker} - ${req.method} ${req.originalUrl}${previous} - IP ${req.ip} - UA "${req.headers['user-agent'] ?? ''}"`,
    );
  }
}
