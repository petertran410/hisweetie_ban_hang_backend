import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Chỉ gắn cục bộ vào PublicApiController qua @UseInterceptors nên không cần
 * đọc metadata để lọc request nội bộ.
 */
@Injectable()
export class PublicApiAuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    let failed = false;
    return next.handle().pipe(
      catchError((error) => {
        failed = true;
        throw error;
      }),
      finalize(() => {
        const client = request.publicApiClient;
        if (!client?.id) return;
        void this.prisma.publicApiAuditLog.create({
          data: {
            clientId: client.id,
            method: request.method,
            path: request.originalUrl?.split('?')[0] || request.path,
            query: Object.keys(request.query || {}).length ? request.query : undefined,
            statusCode: failed ? Math.max(request.res?.statusCode || 500, 400) : request.res?.statusCode || 200,
            ipAddress: request.ip || null,
          },
        }).catch(() => undefined);
      }),
    );
  }
}
