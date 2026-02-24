import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Permissions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('permissions')
export class PermissionsController {
  constructor(private permissionsService: PermissionsService) {}

  @Get()
  findAll(
    @Query('category') category?: string,
    @Query('resource') resource?: string,
  ) {
    return this.permissionsService.findAll({ category, resource });
  }

  @Get('my-permissions')
  getMyPermissions(@Req() req: any) {
    return this.permissionsService.findByUser(req.user.id);
  }

  @Get('field-permissions')
  getFieldPermissions(@Req() req: any, @Query('resource') resource: string) {
    return this.permissionsService.getFieldPermissions(req.user.id, resource);
  }

  @Get('column-permissions')
  getColumnPermissions(@Req() req: any, @Query('resource') resource: string) {
    return this.permissionsService.getColumnPermissions(req.user.id, resource);
  }

  @Get('check')
  async checkPermission(
    @Req() req: any,
    @Query('resource') resource: string,
    @Query('action') action: string,
    @Query('scope') scope?: string,
    @Query('field') field?: string,
  ) {
    const hasPermission = await this.permissionsService.checkPermission(
      req.user.id,
      resource,
      action,
      scope,
      field,
    );

    return { hasPermission };
  }
}
