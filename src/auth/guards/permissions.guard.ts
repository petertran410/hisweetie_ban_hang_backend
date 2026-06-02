import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  ANY_PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { AuthService } from '../auth.service';
import { PermissionCacheService } from '../../permission-cache/permission-cache.service';

const SUPER_ADMIN_ROLE = 'Super Admin';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private reflector: Reflector,
    private authService: AuthService,
    private permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const anyPermissions = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const hasRequired =
      Array.isArray(requiredPermissions) && requiredPermissions.length > 0;
    const hasAny = Array.isArray(anyPermissions) && anyPermissions.length > 0;

    if (!hasRequired && !hasAny) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Không có quyền truy cập');
    }

    if (user.roles?.includes(SUPER_ADMIN_ROLE)) {
      return true;
    }

    const branchIdRaw =
      request.headers['x-branch-id'] ||
      request.body?.branchId ||
      request.query?.branchId;

    const branchId = branchIdRaw ? parseInt(String(branchIdRaw)) : undefined;

    let permissions: string[];

    if (branchId && !isNaN(branchId)) {
      // Cache theo cặp user + chi nhánh (TTL 60s). Hit → bỏ qua 2 query DB.
      // Cache được invalidate qua PermissionCacheService.invalidateUser/invalidateAll
      // mỗi khi quyền của user/role thay đổi (xem users.service & roles.service).
      const cached = this.permissionCache.getBranch(user.id, branchId);
      if (cached) {
        permissions = cached;
      } else {
        permissions = await this.authService.getPermissionsForBranch(
          user.id,
          branchId,
        );
        this.permissionCache.setBranch(user.id, branchId, permissions);
      }
    } else {
      permissions = user.permissions || [];
    }

    if (hasRequired) {
      const ok = requiredPermissions.every((p) => permissions.includes(p));
      if (!ok) {
        throw new ForbiddenException(
          `Bạn không có quyền thực hiện thao tác này. Cần quyền: ${requiredPermissions.join(', ')}`,
        );
      }
    }

    if (hasAny) {
      const ok = anyPermissions.some((p) => permissions.includes(p));
      if (!ok) {
        throw new ForbiddenException(
          `Bạn không có quyền thực hiện thao tác này. Cần một trong các quyền: ${anyPermissions.join(', ')}`,
        );
      }
    }

    return true;
  }
}
