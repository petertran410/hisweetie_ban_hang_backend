import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';

// ═══════════════════════════════════════════════════════════════════════════
// Kết nối DB riêng cho báo cáo Phân tích.
//   • Pool nhỏ (mặc định 4 kết nối, đổi bằng ANALYTICS_DB_CONNECTIONS): báo cáo
//     nặng chạy tối đa 4 câu cùng lúc, phần còn lại xếp hàng — không lấy hết
//     kết nối của bán hàng (PrismaService dùng pool riêng).
//   • pool_timeout dài: câu xếp hàng chờ tới lượt thay vì báo lỗi sau 10 giây.
//   • Đếm số câu SQL + thời gian DB của từng request (analyticsPerf) để ghi
//     log [analytics-perf] — chỉ số đo, không có số liệu.
// ═══════════════════════════════════════════════════════════════════════════

const POOL_SIZE = Number(process.env.ANALYTICS_DB_CONNECTIONS) || 4;
const POOL_TIMEOUT_S = 120;

export type AnalyticsPerf = { queries: number; dbMs: number };
export const analyticsPerf = new AsyncLocalStorage<AnalyticsPerf>();

/** DATABASE_URL với connection_limit / pool_timeout của báo cáo (ghi đè nếu đã có). */
export function analyticsDbUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const [base, query = ''] = raw.split(/\?(.*)/s);
  const params = query
    .split('&')
    .filter((p) => p && !/^(connection_limit|pool_timeout)=/.test(p));
  params.push(
    `connection_limit=${POOL_SIZE}`,
    `pool_timeout=${POOL_TIMEOUT_S}`,
  );
  return `${base}?${params.join('&')}`;
}

/** Bắt đầu đo khi câu SQL thực sự chạy (PrismaPromise chỉ chạy khi được await). */
function track<T extends PromiseLike<unknown>>(p: T): T {
  const st = analyticsPerf.getStore();
  if (!st) return p;
  const then = p.then.bind(p) as PromiseLike<unknown>['then'];
  let started = false;
  (p as { then: unknown }).then = (
    ok?: (v: unknown) => unknown,
    err?: (e: unknown) => unknown,
  ) => {
    if (started) return then(ok, err);
    started = true;
    st.queries++;
    const t0 = performance.now();
    return then(
      (v) => {
        st.dbMs += performance.now() - t0;
        return v;
      },
      (e) => {
        st.dbMs += performance.now() - t0;
        throw e;
      },
    ).then(ok, err);
  };
  return p;
}

@Injectable()
export class AnalyticsPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      datasources: { db: { url: analyticsDbUrl(process.env.DATABASE_URL) } },
    });
    // Bọc các lệnh raw để đếm/đo (không đổi hành vi). Giao dịch dạng mảng
    // ([set_config, câu chính]) tính là 1 câu.
    const self = this as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const queryRaw = self.$queryRaw.bind(this);
    const queryRawUnsafe = self.$queryRawUnsafe.bind(this);
    const transaction = self.$transaction.bind(this);
    self.$queryRaw = (...a) => track(queryRaw(...a) as PromiseLike<unknown>);
    self.$queryRawUnsafe = (...a) =>
      track(queryRawUnsafe(...a) as PromiseLike<unknown>);
    self.$transaction = (arg, opts) => {
      const p = transaction(arg, opts) as Promise<unknown>;
      const st = analyticsPerf.getStore();
      if (!st || !Array.isArray(arg)) return p;
      st.queries++;
      const t0 = performance.now();
      return p.finally(() => {
        st.dbMs += performance.now() - t0;
      });
    };
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
