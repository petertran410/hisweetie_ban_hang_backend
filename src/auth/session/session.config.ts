/** Cấu hình thời gian sống token. Đọc từ env, có mặc định an toàn. */
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const sessionConfig = {
  /** Access token JWT — chỉ nằm trong bộ nhớ FE. */
  get accessTokenTtl(): string {
    return (process.env.ACCESS_TOKEN_TTL || '15m').trim();
  },
  /** Refresh token: hết hạn nếu không dùng trong N ngày (gia hạn mỗi lần xoay). */
  get refreshIdleMs(): number {
    return num(process.env.REFRESH_TOKEN_TTL_DAYS, 7) * DAY_MS;
  },
  /** Refresh token: hạn tuyệt đối kể từ lúc đăng nhập. */
  get refreshAbsoluteMs(): number {
    return num(process.env.REFRESH_TOKEN_MAX_DAYS, 30) * DAY_MS;
  },
  /** Nhiều tab làm mới cùng lúc: token vừa bị thay vẫn được chấp nhận trong khoảng này. */
  rotationGraceMs: 30_000,
  get cookieSecure(): boolean {
    return process.env.COOKIE_SECURE !== 'false';
  },
};

/** Đổi '15m' | '1h' | '900' (giây) → giây. */
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(ttl.trim());
  if (!m) return 15 * 60;
  const n = Number(m[1]);
  const unit = m[2] || 's';
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
}
