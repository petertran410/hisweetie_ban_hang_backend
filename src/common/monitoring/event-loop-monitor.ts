import { Logger } from '@nestjs/common';
import { monitorEventLoopDelay } from 'perf_hooks';

const WINDOW_MS = 60_000;
const P99_WARN_MS = 200;
const CPU_WARN_PERCENT = 100;

/**
 * Mỗi phút ghi 1 dòng WARN nếu event loop bị nghẽn (p99 > 200ms) hoặc process
 * Node dùng > 100% CPU (nhiều core: GC, zlib, Prisma engine...). Kết hợp với
 * log request chậm (LoggingInterceptor) để biết CPU cao do Node hay do DB.
 */
export function startEventLoopMonitor(): void {
  const logger = new Logger('EventLoopMonitor');
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastCpu = process.cpuUsage();

  const timer = setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const cpuPercent = ((cpu.user + cpu.system) / 1000 / WINDOW_MS) * 100;
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    histogram.reset();

    if (p99 > P99_WARN_MS || cpuPercent > CPU_WARN_PERCENT) {
      logger.warn(
        `1 phút qua: CPU node ${cpuPercent.toFixed(0)}%, event loop delay p99 ${p99.toFixed(0)}ms, max ${max.toFixed(0)}ms`,
      );
    }
  }, WINDOW_MS);
  timer.unref();
}
