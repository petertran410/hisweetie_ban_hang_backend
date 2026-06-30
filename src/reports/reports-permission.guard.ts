import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  REPORT_PERMISSION_KEY,
  ReportGroup,
  ReportPermissionConfig,
} from '../auth/decorators/report-permission.decorator';
import { AuthService } from '../auth/auth.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';

const SUPER_ADMIN_ROLE = 'Super Admin';

// Map nhóm + ViewType → key quyền. ViewType lấy từ query (mặc định = phần tử
// đầu mỗi nhóm, khớp default trong các *-reports.service.ts).
const VIEWTYPE_KEY_MAP: Record<ReportGroup, Record<string, string>> = {
  sale: {
    PurchaseDate: 'reports:sale_time',
    Profit: 'reports:sale_profit',
    SoldBy: 'reports:sale_soldby',
    Branch: 'reports:sale_branch',
    Refund: 'reports:sale_refund',
  },
  product: {
    ProductBySale: 'reports:product_sale',
    ProductByProfit: 'reports:product_profit',
    ProductByCategory: 'reports:product_category',
    InOutStock: 'reports:product_inoutstock',
    InOutStockDetail: 'reports:product_inoutstock_detail',
    ProductByUser: 'reports:product_byuser',
    ProductByCustomer: 'reports:product_bycustomer',
    ProductBySupplier: 'reports:product_bysupplier',
    DamageItem: 'reports:product_damage',
  },
  supplier: {
    PurchaseBySupplier: 'reports:supplier_purchase',
    PurchaseByProduct: 'reports:supplier_byproduct',
    SupplierDebt: 'reports:supplier_debt',
    SupplierReturn: 'reports:supplier_return',
    SupplierInfo: 'reports:supplier_info',
  },
  eod: {
    Synthetic: 'reports:eod_synthetic',
    Document: 'reports:eod_document',
    CashFlow: 'reports:eod_cashflow',
    Product: 'reports:eod_product',
  },
  customer: {
    CustomerBySale: 'reports:customer_sale',
    CustomerByProfit: 'reports:customer_profit',
    CustomerDebt: 'reports:customer_debt',
    CustomerByProduct: 'reports:customer_product',
  },
};

// ViewType mặc định mỗi nhóm khi query không truyền (khớp service).
const DEFAULT_VIEWTYPE: Record<ReportGroup, string> = {
  sale: 'PurchaseDate',
  product: 'ProductBySale',
  supplier: 'PurchaseBySupplier',
  eod: 'Synthetic',
  customer: 'CustomerBySale',
};

/**
 * Guard động cho trang Báo cáo. Mỗi loại báo cáo (ViewType) ứng 1 quyền
 * `reports:<group>_<viewtype>`. Tất cả endpoint cùng nhóm + viewType
 * (chart / preview / drilldown / export) dùng chung 1 key.
 *
 * Cơ chế lấy permissions sao chép từ PermissionsGuard: ưu tiên quyền theo
 * chi nhánh (header x-branch-id) có cache, fallback về user.permissions.
 */
@Injectable()
export class ReportsPermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private authService: AuthService,
    private permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<ReportPermissionConfig>(
      REPORT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Route không khai báo quyền report → không chặn ở guard này.
    if (!config) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Không có quyền truy cập');
    }

    if (user.roles?.includes(SUPER_ADMIN_ROLE)) {
      return true;
    }

    const requiredKey = this.resolveKey(config, request);
    if (!requiredKey) {
      // viewType không hợp lệ / không map được → từ chối an toàn.
      throw new ForbiddenException('Loại báo cáo không hợp lệ');
    }

    const permissions = await this.getPermissions(user, request);

    if (!permissions.includes(requiredKey)) {
      throw new ForbiddenException(
        `Bạn không có quyền xem báo cáo này. Cần quyền: ${requiredKey}`,
      );
    }

    // Endpoint xuất Excel: cần thêm quyền xuất theo nhóm.
    if (config.exportKey && !permissions.includes(config.exportKey)) {
      throw new ForbiddenException(
        `Bạn không có quyền xuất Excel báo cáo này. Cần quyền: ${config.exportKey}`,
      );
    }

    return true;
  }

  private resolveKey(
    config: ReportPermissionConfig,
    request: any,
  ): string | null {
    if (config.key) return config.key;
    if (!config.group) return null;

    const group = config.group;
    const viewType = String(request.query?.viewType || DEFAULT_VIEWTYPE[group]);
    return VIEWTYPE_KEY_MAP[group][viewType] || null;
  }

  private async getPermissions(user: any, request: any): Promise<string[]> {
    const branchIdRaw =
      request.headers['x-branch-id'] ||
      request.body?.branchId ||
      request.query?.branchId;

    const branchId = branchIdRaw ? parseInt(String(branchIdRaw)) : undefined;

    if (branchId && !isNaN(branchId)) {
      const cached = this.permissionCache.getBranch(user.id, branchId);
      if (cached) return cached;

      const permissions = await this.authService.getPermissionsForBranch(
        user.id,
        branchId,
      );
      this.permissionCache.setBranch(user.id, branchId, permissions);
      return permissions;
    }

    return user.permissions || [];
  }
}
