import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of, tap } from 'rxjs';

// ═══════════════════════════════════════════════════════════════════════════
// Cache kết quả báo cáo Phân tích (trong bộ nhớ backend).
//   • GET /reports/analytics/** : lưu theo đường dẫn + tham số (+ user nếu route
//     đánh dấu @AnalyticsCachePerUser). Số liệu 5 phút, danh sách bộ lọc 30 phút.
//   • Request giống nhau đang chạy cùng lúc → dùng chung 1 lần tính.
//   • Mọi POST/PUT/PATCH/DELETE dưới /reports/analytics/ thành công → xoá cache.
//   • GET .../config/... không cache (màn cấu hình luôn đọc mới).
// ═══════════════════════════════════════════════════════════════════════════

const DATA_TTL = 5 * 60_000;
const OPTIONS_TTL = 30 * 60_000;
const MAX_ENTRIES = 300;
const MAX_BYTES = 64 * 1024 * 1024;
const OPTIONS_PATH = /\/(options|filter-options|bo-loc)$/;

export const ANALYTICS_CACHE_PER_USER = 'analyticsCachePerUser';
/** Kết quả phụ thuộc người xem (vd. KPI Sale chỉ thấy số của mình) → cache riêng theo user. */
export const AnalyticsCachePerUser = () =>
  SetMetadata(ANALYTICS_CACHE_PER_USER, true);

type Entry = { value: unknown; expires: number; bytes: number };

@Injectable()
export class AnalyticsCacheService {
  private readonly logger = new Logger(AnalyticsCacheService.name);
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  /** Tăng mỗi lần xoá cache → kết quả đang tính dở từ trước khi xoá không được lưu. */
  private generation = 0;

  get(key: string): unknown {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.drop(key, e);
      return undefined;
    }
    // LRU: đưa lên cuối.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** Lấy từ cache, hoặc tính (gộp các lần gọi trùng đang chạy) rồi lưu. */
  async wrap<T>(key: string, ttl: number, compute: () => Promise<T>) {
    const hit = this.get(key);
    if (hit !== undefined) return hit as T;
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    const gen = this.generation;
    const p = compute()
      .then((value) => {
        if (gen === this.generation) this.set(key, value, ttl);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  clear() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  private set(key: string, value: unknown, ttl: number) {
    let bytes = 0;
    try {
      bytes = JSON.stringify(value)?.length ?? 0;
    } catch {
      return;
    }
    if (bytes > MAX_BYTES / 4) return;
    const old = this.entries.get(key);
    if (old) this.drop(key, old);
    this.entries.set(key, { value, expires: Date.now() + ttl, bytes });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break;
      this.drop(k, e);
    }
  }

  private drop(key: string, e: Entry) {
    this.entries.delete(key);
    this.bytes -= e.bytes;
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

@Injectable()
export class AnalyticsCacheInterceptor implements NestInterceptor {
  constructor(
    private cache: AnalyticsCacheService,
    private reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      path: string;
      query: Record<string, unknown>;
      user?: { id?: number | string };
    }>();
    const path = req.path ?? '';
    if (!path.includes('/reports/analytics/')) return next.handle();

    if (req.method !== 'GET') {
      return next.handle().pipe(tap(() => this.cache.clear()));
    }
    if (path.includes('/config/')) return next.handle();

    const perUser = this.reflector.getAllAndOverride<boolean>(
      ANALYTICS_CACHE_PER_USER,
      [ctx.getHandler(), ctx.getClass()],
    );
    const key = [
      path,
      stableQuery(req.query),
      perUser ? `u:${req.user?.id ?? ''}` : '',
    ].join('|');
    const ttl = OPTIONS_PATH.test(path) ? OPTIONS_TTL : DATA_TTL;

    const hit = this.cache.get(key);
    if (hit !== undefined) return of(hit);
    return from(
      this.cache.wrap(
        key,
        ttl,
        () =>
          new Promise((resolve, reject) =>
            next.handle().subscribe({ next: resolve, error: reject }),
          ),
      ),
    );
  }
}

function stableQuery(q: Record<string, unknown> | undefined): string {
  if (!q) return '';
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${JSON.stringify(q[k])}`)
    .join('&');
}
