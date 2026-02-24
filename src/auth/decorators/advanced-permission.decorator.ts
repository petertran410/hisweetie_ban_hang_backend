import { SetMetadata } from '@nestjs/common';
import { ADVANCED_PERMISSION_KEY } from '../guards/advanced-permission.guard';

export const RequireAdvancedPermission = (config: {
  resource: string;
  action: string;
  scope?: string;
  field?: string;
  checkOwnership?: boolean;
}) => SetMetadata(ADVANCED_PERMISSION_KEY, config);
