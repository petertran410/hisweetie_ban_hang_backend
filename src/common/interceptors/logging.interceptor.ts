import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

// Chỉ log request chậm hoặc route nặng (xuất/nhập/upload file) để khi CPU
// tăng vọt có thể biết request nào đang chạy, mà không lụt log.
const SLOW_REQUEST_MS = 2000;
const ALWAYS_LOG_ROUTE = /export|import|upload/i;

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id?: number } }>();
    const response = http.getResponse<Response>();
    const start = Date.now();

    // Đo tới khi response đóng (kể cả handler @Res() stream file, hoặc client
    // ngắt giữa chừng) thay vì khi handler return.
    response.once('close', () => {
      const ms = Date.now() - start;
      const slow = ms >= SLOW_REQUEST_MS;
      if (!slow && !ALWAYS_LOG_ROUTE.test(routePath(request))) return;

      const aborted = response.writableFinished ? '' : ' (client ngắt kết nối)';
      const line = `${request.method} ${request.originalUrl} ${response.statusCode} ${ms}ms user:${request.user?.id ?? '-'}${aborted}`;
      if (slow) this.logger.warn(line);
      else this.logger.log(line);
    });

    return next.handle();
  }
}

function routePath(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : '';
}
