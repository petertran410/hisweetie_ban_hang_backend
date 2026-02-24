import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../../permissions/permissions.service';

export const ADVANCED_PERMISSION_KEY = 'advancedPermission';

@Injectable()
export class AdvancedPermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permissionConfig = this.reflector.get<{
      resource: string;
      action: string;
      scope?: string;
      field?: string;
      checkOwnership?: boolean;
    }>(ADVANCED_PERMISSION_KEY, context.getHandler());

    if (!permissionConfig) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const data = request.body || request.params;

    const hasPermission = await this.permissionsService.checkPermission(
      user.id,
      permissionConfig.resource,
      permissionConfig.action,
      permissionConfig.scope,
      permissionConfig.field,
      data,
    );

    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
