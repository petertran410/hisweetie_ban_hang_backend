import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard tùy biến: đếm rate-limit theo USER thay vì theo IP.
 *
 * Lý do: nhiều nhân viên trong cùng văn phòng NAT ra chung 1 IP public.
 * Nếu đếm theo IP, tất cả họ dùng chung 1 "bucket" → mau chạm trần 429
 * dù mỗi người chỉ gọi vài request. Đếm theo user-id giúp mỗi người có
 * hạn mức riêng.
 *
 * Lưu ý thứ tự guard: ThrottlerGuard chạy TRƯỚC JwtAuthGuard nên tại đây
 * `req.user` chưa tồn tại. Vì vậy ta tự DECODE (không verify) phần payload
 * của JWT để lấy `sub` làm khóa đếm. Việc verify chữ ký vẫn do JwtAuthGuard
 * đảm nhiệm ngay sau đó — token giả sẽ bị chặn ở bước auth, nên decode ở
 * đây chỉ phục vụ mục đích gom đếm, không tạo lỗ hổng bảo mật.
 *
 * Fallback về IP khi: không có Bearer token / token sai định dạng / decode
 * lỗi / thiếu `sub` (vd request public, màn hình login).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth: string | undefined = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const parts = token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8'),
          );
          if (payload?.sub) {
            return `user:${payload.sub}`;
          }
        } catch {
          // Token hỏng → rơi xuống fallback IP bên dưới.
        }
      }
    }
    return `ip:${req.ip}`;
  }
}
