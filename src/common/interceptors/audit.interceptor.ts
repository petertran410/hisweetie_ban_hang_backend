import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import {
  getChangesSummary,
  renderAuditMessage,
} from '../../audit-logs/audit-templates';

const actionCodeMap: Record<string, Record<string, string>> = {
  '/orders': {
    POST: 'ORDER_CREATE',
    PUT: 'ORDER_UPDATE',
    DELETE: 'ORDER_CANCEL',
  },
  '/invoices': {
    POST: 'INVOICE_CREATE',
    PUT: 'INVOICE_UPDATE',
  },
  '/products': {
    POST: 'PRODUCT_CREATE',
    PUT: 'PRODUCT_UPDATE',
    DELETE: 'PRODUCT_DELETE',
  },
  '/customers': {
    POST: 'CUSTOMER_CREATE',
    PUT: 'CUSTOMER_UPDATE',
  },
};

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private auditLogsService: AuditLogsService) {}

  private getActionCode(resource: string, method: string, url: string): string {
    const mapping = actionCodeMap[resource];
    return mapping?.[method] || `${resource.toUpperCase()}_${method}`;
  }

  private buildMessageParams(
    actionCode: string,
    data: any,
    body: any,
  ): Record<string, any> {
    if (actionCode === 'ORDER_CREATE' && data?.order) {
      return {
        orderCode: data.order.code,
        customerName: data.order.customer?.name,
        totalAmount: data.order.grandTotal,
      };
    }

    if (actionCode === 'INVOICE_CREATE' && data) {
      return {
        invoiceCode: data.code,
        orderCode: data.orderCode,
        customerName: data.customerName,
        totalAmount: data.totalAmount,
      };
    }

    if (actionCode === 'PRODUCT_UPDATE' && data) {
      return {
        productName: data.name,
        changesSummary: getChangesSummary(body, data),
      };
    }

    return {};
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, user, body, params, query, headers } = request;

    const excludedPaths = ['/api/auth/refresh', '/api/audit-logs'];
    if (excludedPaths.some((path) => url.includes(path))) {
      return next.handle();
    }

    // SKIP GET requests - chỉ log CREATE/UPDATE/DELETE
    if (method === 'GET') {
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
          const actionCode = this.getActionCode(resource, method, url);
          const messageParams = this.buildMessageParams(actionCode, data, body);

          if (user?.id) {
            this.auditLogsService
              .create({
                actionType: method,
                actionCode,
                entityType: resourceMap[resource],
                entityId: resourceId?.toString(),
                entityCode: data?.code || body?.code,

                oldValues:
                  method === 'PUT' || method === 'DELETE' ? body : undefined,
                newValues:
                  method === 'POST' || method === 'PUT' ? data : undefined,
                changedFields:
                  method === 'PUT' ? Object.keys(body || {}) : undefined,

                message: renderAuditMessage(actionCode, messageParams),
                messageTemplate: actionCode,
                messageParams,

                userId: user.id,
                userName: user.name || user.email,
                branchId: user.branchId,
                branchName: user.branch?.name,

                ipAddress: request.ip || request.connection.remoteAddress,
                userAgent: headers['user-agent'],
                requestId: request.id,

                metadata: { query, params, duration },
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
                actionType: method,
                actionCode: this.getActionCode(resource, method, url),
                entityType: resourceMap[resource],
                entityId: resourceId?.toString(),
                message: `Error on ${method} ${url}: ${error.message || 'Unknown error'}`,
                metadata: {
                  query,
                  params,
                  duration,
                  path: url,
                  statusCode: error.status || 500,
                  error: error.message || JSON.stringify(error),
                },
                ipAddress: request.ip || request.connection.remoteAddress,
                userAgent: headers['user-agent'],
              })
              .catch((err) => console.error('Audit log error:', err));
          }
        },
      }),
    );
  }
}
