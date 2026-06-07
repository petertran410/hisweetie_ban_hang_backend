import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto, UpdateRoleDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('roles')
export class RolesController {
  constructor(private rolesService: RolesService) {}

  @Get()
  @RequirePermissions('roles:view')
  @ApiOperation({ summary: 'Get all roles' })
  findAll() {
    return this.rolesService.findAll();
  }

  @Get(':id')
  @RequirePermissions('roles:view')
  @ApiOperation({ summary: 'Get role by ID' })
  findOne(@Param('id') id: string) {
    return this.rolesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('roles:create')
  @ApiOperation({ summary: 'Create new role' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: any) {
    return this.rolesService.create(dto, user?.id);
  }

  @Put(':id')
  @RequirePermissions('roles:update')
  @ApiOperation({ summary: 'Update role' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.rolesService.update(+id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions('roles:delete')
  @ApiOperation({ summary: 'Delete role' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.rolesService.remove(+id, user?.id);
  }

  @Put(':id/permissions')
  @RequirePermissions('roles:update')
  @ApiOperation({ summary: 'Assign permissions to role' })
  assignPermissions(
    @Param('id') id: string,
    @Body() body: { permissionIds: number[] },
    @CurrentUser() user: any,
  ) {
    return this.rolesService.assignPermissions(
      +id,
      body.permissionIds,
      user?.id,
    );
  }

  @Get(':id/branch-permissions/:branchId')
  @RequirePermissions('roles:view')
  getRoleBranchPermissions(
    @Param('id') id: string,
    @Param('branchId') branchId: string,
  ) {
    return this.rolesService.getRoleBranchPermissions(+id, +branchId);
  }

  @Put(':id/branch-permissions/:branchId')
  @RequirePermissions('roles:update')
  assignRoleBranchPermissions(
    @Param('id') id: string,
    @Param('branchId') branchId: string,
    @Body() data: { permissionIds: number[] },
    @CurrentUser() user: any,
  ) {
    return this.rolesService.assignRoleBranchPermissions(
      +id,
      +branchId,
      data.permissionIds,
      user?.id,
    );
  }
}
