import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

function assertNotSelfPermissionEdit(req: any, targetUserId: number): void {
  const actor = req.user;
  if (actor.id === targetUserId) {
    throw new ForbiddenException(
      'Bạn không thể tự thay đổi quyền của chính mình.',
    );
  }
}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @RequirePermissions('users:view')
  @ApiOperation({ summary: 'Get all users with filters' })
  findAll(
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.findAll({
      search,
      branchId: branchId ? parseInt(branchId) : undefined,
      isActive:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('all')
  @ApiOperation({ summary: 'Get all active users (simplified)' })
  getUsers() {
    return this.usersService.getUsers();
  }

  @Get('for-filter')
  @UseGuards(JwtAuthGuard)
  async getUsersForFilter() {
    return this.usersService.findAllForFilter();
  }

  @Get(':id/branch-permissions/:branchId')
  @RequirePermissions('users:view')
  getBranchPermissions(
    @Param('id') id: string,
    @Param('branchId') branchId: string,
  ) {
    return this.usersService.getBranchPermissions(
      parseInt(id),
      parseInt(branchId),
    );
  }

  @Get(':id')
  @RequirePermissions('users:view')
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(parseInt(id));
  }

  @Post()
  @RequirePermissions('users:create')
  create(
    @Body()
    data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      branchId?: number;
      roleIds?: number[];
      permissionIds?: number[];
      denyPermissionIds?: number[];
      branchIds?: number[];
      isActive?: boolean;
    },
    @Req() req: any,
  ) {
    const performedByUserId = req.user?.id;
    return this.usersService.create(data, performedByUserId);
  }

  @Put(':id/branch-permissions')
  @RequirePermissions('users:update')
  assignBranchPermissions(
    @Param('id') id: string,
    @Body()
    data: {
      branchId: number;
      grantPermissionIds: number[];
      denyPermissionIds: number[];
    },
    @Req() req: any,
  ) {
    assertNotSelfPermissionEdit(req, parseInt(id));
    return this.usersService.assignBranchPermissions(
      parseInt(id),
      data.branchId,
      data.grantPermissionIds,
      data.denyPermissionIds,
    );
  }

  @Put(':id')
  @RequirePermissions('users:update')
  update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      email?: string;
      password?: string;
      phone?: string;
      branchId?: number;
      isActive?: boolean;
      roleIds?: number[];
      permissionIds?: number[];
      denyPermissionIds?: number[];
      branchIds?: number[];
    },
    @Req() req: any,
  ) {
    if (data.roleIds || data.permissionIds || data.denyPermissionIds) {
      assertNotSelfPermissionEdit(req, parseInt(id));
    }

    const performedByUserId = req.user?.id;
    return this.usersService.update(parseInt(id), data, performedByUserId);
  }

  @Delete(':id')
  @RequirePermissions('users:delete')
  @ApiOperation({ summary: 'Delete user' })
  delete(@Param('id') id: string, @Req() req: any) {
    const performedByUserId = req.user?.id;
    return this.usersService.delete(parseInt(id), performedByUserId);
  }

  @Put(':id/permissions')
  @RequirePermissions('users:update')
  @ApiOperation({ summary: 'Assign permissions to user' })
  assignPermissions(
    @Param('id') id: string,
    @Body() data: { permissionIds: number[] },
    @Req() req: any,
  ) {
    assertNotSelfPermissionEdit(req, parseInt(id));
    return this.usersService.assignPermissions(
      parseInt(id),
      data.permissionIds,
    );
  }
}
