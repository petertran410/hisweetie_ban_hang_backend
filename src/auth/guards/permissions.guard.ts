import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthService } from '../auth.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private reflector: Reflector,
    private authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Không có quyền truy cập');
    }

    const branchIdRaw =
      request.headers['x-branch-id'] ||
      request.body?.branchId ||
      request.query?.branchId;

    const branchId = branchIdRaw ? parseInt(String(branchIdRaw)) : undefined;

    let permissions: string[];

    if (branchId && !isNaN(branchId)) {
      permissions = await this.authService.getPermissionsForBranch(
        user.id,
        branchId,
      );
    } else {
      permissions = user.permissions || [];
    }

    const hasPermission = requiredPermissions.every((permission) =>
      permissions.includes(permission),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Bạn không có quyền thực hiện thao tác này. Cần quyền: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
