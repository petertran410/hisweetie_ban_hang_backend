import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, finalize, from, map, of, tap } from 'rxjs';
import { performance } from 'perf_hooks';
import { analyticsPerf, type AnalyticsPerf } from './analytics-prisma.service';

// ═══════════════════════════════════════════════════════════════════════════
// Cache kết quả báo cáo Phân tích (trong bộ nhớ backend).
//   • GET /reports/analytics/** : lưu theo đường dẫn + tham số (+ user nếu route
//     đánh dấu @AnalyticsCachePerUser). Số liệu 5 phút, danh sách bộ lọc 30 phút.
//   • Request giống nhau đang chạy cùng lúc → dùng chung 1 lần tính.
//   • Mọi POST/PUT/PATCH/DELETE dưới /reports/analytics/ thành công → xoá cache.
//   • GET .../config/... không cache (màn cấu hình luôn đọc mới).
//   • Kết quả được chuyển thành chuỗi JSON đúng 1 lần, dùng cho cả cache, đo
//     dung lượng và trả về (lần trúng cache không phải chuyển lại).
//   • Mỗi request ghi 1 dòng log [analytics-perf]: đường dẫn + TÊN tham số (không
//     ghi giá trị bộ lọc), thời gian, số câu SQL, thời gian DB, KB, CPU Node.
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

  /** Đang có 1 lần tính cùng khoá (request này sẽ dùng chung kết quả). */
  isPending(key: string) {
    return this.pending.has(key);
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
      bytes =
        typeof value === 'string'
          ? value.length
          : (JSON.stringify(value)?.length ?? 0);
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
  private readonly logger = new Logger('AnalyticsPerf');

  constructor(
    private cache: AnalyticsCacheService,
    private reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{
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

    const res = http.getResponse<{ type?: (t: string) => unknown }>();
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

    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    const perf: AnalyticsPerf = { queries: 0, dbMs: 0 };
    let state = 'miss';
    let bytes = 0;
    // Chuỗi JSON → trả nguyên văn với Content-Type JSON (như res.json).
    const asJson = (v: unknown) => {
      if (typeof v !== 'string') return v;
      bytes = v.length;
      res.type?.('application/json');
      return v;
    };
    const log = () => {
      const cpu = process.cpuUsage(cpu0);
      const keys = Object.keys(req.query ?? {})
        .sort()
        .join(',');
      this.logger.log(
        `analytics-perf ${path} keys=${keys || '-'} ms=${Math.round(performance.now() - t0)} ` +
          `q=${perf.queries} db=${Math.round(perf.dbMs)}ms json=${Math.round(bytes / 1024)}KB ` +
          `cpu=${Math.round((cpu.user + cpu.system) / 1000)}ms cache=${state}`,
      );
    };

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      state = 'hit';
      return of(hit).pipe(map(asJson), finalize(log));
    }
    if (this.cache.isPending(key)) state = 'shared';
    return from(
      analyticsPerf.run(perf, () =>
        this.cache.wrap(key, ttl, () =>
          new Promise<unknown>((resolve, reject) =>
            next.handle().subscribe({ next: resolve, error: reject }),
          ).then((value) =>
            value === undefined ? value : JSON.stringify(value),
          ),
        ),
      ),
    ).pipe(map(asJson), finalize(log));
  }
}

function stableQuery(q: Record<string, unknown> | undefined): string {
  if (!q) return '';
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${JSON.stringify(q[k])}`)
    .join('&');
}
