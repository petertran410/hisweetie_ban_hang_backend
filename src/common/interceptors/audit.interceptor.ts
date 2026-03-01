import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import path from 'path';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private auditLogsService: AuditLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, user, body, params, query, headers } = request;

    const excludedPaths = ['/api/auth/refresh', '/api/audit-logs'];
    if (excludedPaths.some((path) => url.includes(path))) {
      return next.handle();
    }

    const startTime = Date.now();
    const sessionId =
      headers['x-session-id'] || `session-${user?.id}-${Date.now()}`;

    const resourceMap = {
      '/products': 'products',
      '/orders': 'orders',
      '/invoices': 'invoices',
      '/customers': 'customers',
      '/suppliers': 'suppliers',
      '/inventories': 'inventories',
      '/users': 'users',
      '/branches': 'branches',
      '/transfers': 'transfers',
      '/purchase-orders': 'purchase_orders',
      '/order-suppliers': 'order_suppliers',
      '/packing-slips': 'packing_slips',
      '/packing-hangs': 'packing_hangs',
      '/packing-loadings': 'packing_loadings',
      '/cashflows': 'cashflows',
      '/productions': 'productions',
      '/destructions': 'destructions',
    };

    const resource = Object.keys(resourceMap).find((key) => url.includes(key));
    if (!resource) {
      return next.handle();
    }

    const actionMap = {
      GET: params?.id || query?.id ? 'view' : 'list',
      POST: 'create',
      PUT: 'update',
      PATCH: 'update',
      DELETE: 'delete',
    };

    const action = actionMap[method];
    const resourceId = params?.id ? parseInt(params.id) : null;

    return next.handle().pipe(
      tap({
        next: (data) => {
          const response = context.switchToHttp().getResponse();
          const duration = Date.now() - startTime;

          if (user?.id) {
            this.auditLogsService
              .create({
                userId: user.id,
                userName: user.name || user.email,
                branchId: user.branchId || undefined,
                action,
                resource: resourceMap[resource],
                resourceId,
                method,
                path: url,
                statusCode: response.statusCode,
                duration,
                oldData:
                  method === 'PUT' || method === 'DELETE' ? body : undefined,
                newData:
                  method === 'POST' || method === 'PUT' ? data : undefined,
                metadata: {
                  query,
                  params,
                  body: method === 'GET' ? undefined : body,
                },
                ipAddress: request.ip || request.connection.remoteAddress,
                userAgent: headers['user-agent'],
                sessionId,
              })
              .catch((err) => console.error('Audit log error:', err));
          }
        },
        error: (error) => {
          const duration = Date.now() - startTime;

          if (user?.id) {
            this.auditLogsService
              .create({
                userId: user.id,
                userName: user.name || user.email,
                branchId: user.branchId || undefined,
                action,
                resource: resourceMap[resource],
                resourceId,
                method,
                path: url,
                statusCode: error.status || 500,
                duration,
                error: error.message || JSON.stringify(error),
                metadata: { query, params },
                ipAddress: request.ip || request.connection.remoteAddress,
                userAgent: headers['user-agent'],
                sessionId,
              })
              .catch((err) => console.error('Audit log error:', err));
          }
        },
      }),
    );
  }
}
