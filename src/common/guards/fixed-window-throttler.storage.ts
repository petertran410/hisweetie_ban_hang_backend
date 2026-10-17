import { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

interface WindowRecord {
  hits: number;
  expiresAt: number;
  // 0 = không bị chặn.
  blockExpiresAt: number;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Storage rate-limit dạng cửa sổ cố định (fixed window), thay cho
 * `ThrottlerStorageService` in-memory mặc định của @nestjs/throttler 6.5.0.
 *
 * Bản mặc định có 2 vấn đề:
 * - Tạo 1 `setTimeout` cho MỖI request để trừ đếm, gom chung 1 mảng theo tên
 *   throttler; mỗi timer chạy lại `filter` cả mảng → tốn CPU khi traffic lớn.
 * - Khi 1 key hết bị chặn, `resetBlockdRequest` xóa timer của MỌI key → đếm
 *   của user khác không bao giờ giảm → user bình thường bị 429 oan.
 *
 * Ở đây mỗi key chỉ giữ 1 record (số hit + mốc hết hạn), O(1) mỗi request,
 * không timer theo request; 1 interval dọn record hết hạn mỗi phút.
 * Hành vi giữ như bản gốc: vượt `limit` → chặn `blockDuration`, trong lúc
 * chặn không đếm thêm; hết chặn → đếm lại từ đầu.
 */
export class FixedWindowThrottlerStorage implements ThrottlerStorage {
  private readonly records = new Map<string, WindowRecord>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Không giữ process sống chỉ vì interval dọn dẹp.
    this.sweeper.unref();
  }

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const recordKey = `${throttlerName}:${key}`;
    let record = this.records.get(recordKey);

    if (record && this.isExpired(record, now)) record = undefined;
    if (!record) {
      record = { hits: 0, expiresAt: now + ttl, blockExpiresAt: 0 };
      this.records.set(recordKey, record);
    }

    if (record.blockExpiresAt === 0) {
      record.hits++;
      if (record.hits > limit) record.blockExpiresAt = now + blockDuration;
    }

    const isBlocked = record.blockExpiresAt > now;
    return Promise.resolve({
      totalHits: record.hits,
      timeToExpire: Math.max(0, Math.ceil((record.expiresAt - now) / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.ceil((record.blockExpiresAt - now) / 1000)
        : 0,
    });
  }

  /** Dừng interval dọn dẹp (dùng trong test). */
  dispose(): void {
    clearInterval(this.sweeper);
  }

  // Đang chặn → chỉ hết khi hết thời gian chặn; không chặn → hết khi hết cửa sổ.
  private isExpired(record: WindowRecord, now: number): boolean {
    return record.blockExpiresAt > 0
      ? now >= record.blockExpiresAt
      : now >= record.expiresAt;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (this.isExpired(record, now)) this.records.delete(key);
    }
  }
}
