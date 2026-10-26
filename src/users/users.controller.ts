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
  Optional,
  ParseIntPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCanAssignRoles,
  assertCanManageUser,
  assertNotLastSuperAdmin,
  assertUserUpdateAllowed,
  isUserSuperAdmin,
} from '../auth/owner-protection';
import { SecurityAuditService } from '../audit-logs/security-audit.service';

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
  constructor(
    private usersService: UsersService,
    private prisma: PrismaService,
    @Optional() private securityAudit?: SecurityAuditService,
  ) {}

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

  @Get(':id/branch-roles')
  @RequirePermissions('users:view')
  getUserBranchRoles(@Param('id') id: string) {
    return this.usersService.getUserBranchRoles(parseInt(id));
  }

  @Put(':id/branch-roles')
  @RequirePermissions('users:update')
  async setUserBranchRole(
    @Param('id') id: string,
    @Body() data: { branchId: number; roleId: number | null },
    @Req() req: any,
  ) {
    assertNotSelfPermissionEdit(req, parseInt(id));
    await assertCanManageUser(this.prisma, req.user, parseInt(id));
    await assertCanAssignRoles(this.prisma, req.user, [data.roleId]);
    return this.usersService.setUserBranchRole(
      parseInt(id),
      data.branchId,
      data.roleId,
    );
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
  async create(
    @Body()
    data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      branchId?: number;
      supplierId?: number | null;
      roleIds?: number[];
      permissionIds?: number[];
      denyPermissionIds?: number[];
      branchIds?: number[];
      isActive?: boolean;
    },
    @Req() req: any,
  ) {
    await assertCanAssignRoles(this.prisma, req.user, data.roleIds);
    const performedByUserId = req.user?.id;
    const created = await this.usersService.create(data, performedByUserId);
    if (created?.id) await this.auditOwnerChange(created.id, false, req.user);
    return created;
  }

  /** Ghi nhật ký bảo mật khi tài khoản được cấp / bị gỡ role Super Admin. */
  private async auditOwnerChange(
    userId: number,
    wasOwner: boolean,
    actor?: { id?: number },
  ) {
    if (!this.securityAudit) return;
    const isOwner = await isUserSuperAdmin(this.prisma, userId);
    if (isOwner === wasOwner) return;
    this.securityAudit.record(
      isOwner ? 'AUTH_SUPER_ADMIN_GRANT' : 'AUTH_SUPER_ADMIN_REVOKE',
      { userId, actorId: actor?.id },
    );
  }

  @Put(':id/branch-permissions')
  @RequirePermissions('users:update')
  async assignBranchPermissions(
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
    await assertCanManageUser(this.prisma, req.user, parseInt(id));
    return this.usersService.assignBranchPermissions(
      parseInt(id),
      data.branchId,
      data.grantPermissionIds,
      data.denyPermissionIds,
    );
  }

  @Put(':id')
  @RequirePermissions('users:update')
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      email?: string;
      password?: string;
      phone?: string;
      branchId?: number;
      supplierId?: number | null;
      isActive?: boolean;
      roleIds?: number[];
      permissionIds?: number[];
      denyPermissionIds?: number[];
      branchIds?: number[];
      canViewOtherStaffData?: boolean;
      canViewOnlyOwnPackings?: boolean;
      canViewOnlyOwnLoadingInvoices?: boolean;
      larkUserId?: string | null;
    },
    @Req() req: any,
  ) {
    if (data.roleIds || data.permissionIds || data.denyPermissionIds) {
      assertNotSelfPermissionEdit(req, parseInt(id));
    }
    await assertUserUpdateAllowed(this.prisma, req.user, parseInt(id), data);
    const wasOwner =
      data.roleIds !== undefined &&
      (await isUserSuperAdmin(this.prisma, parseInt(id)));

    const performedByUserId = req.user?.id;
    const updated = await this.usersService.update(
      parseInt(id),
      data,
      performedByUserId,
    );
    if (data.roleIds !== undefined) {
      await this.auditOwnerChange(parseInt(id), wasOwner, req.user);
    }
    return updated;
  }

  @Delete(':id')
  @RequirePermissions('users:delete')
  @ApiOperation({ summary: 'Delete user' })
  async delete(@Param('id') id: string, @Req() req: any) {
    await assertCanManageUser(this.prisma, req.user, parseInt(id));
    await assertNotLastSuperAdmin(this.prisma, parseInt(id));
    const performedByUserId = req.user?.id;
    return this.usersService.delete(parseInt(id), performedByUserId);
  }

  @Get(':id/sessions')
  @RequirePermissions('users:update')
  @ApiOperation({ summary: 'Thiết bị đang đăng nhập của người dùng' })
  async listSessions(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user?: { id: number; roles?: string[] } },
  ) {
    await assertCanManageUser(this.prisma, req.user, id);
    return this.usersService.listUserSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @RequirePermissions('users:update')
  @ApiOperation({ summary: 'Đăng xuất 1 thiết bị của người dùng' })
  async revokeSession(
    @Param('id', ParseIntPipe) id: number,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Req() req: { user?: { id: number; roles?: string[] } },
  ) {
    await assertCanManageUser(this.prisma, req.user, id);
    return this.usersService.revokeUserSession(id, sessionId, req.user?.id);
  }

  @Post(':id/sessions/revoke-all')
  @RequirePermissions('users:update')
  @ApiOperation({ summary: 'Đăng xuất mọi thiết bị của người dùng' })
  async revokeAllSessions(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user?: { id: number; roles?: string[] } },
  ) {
    await assertCanManageUser(this.prisma, req.user, id);
    return this.usersService.revokeAllUserSessions(id, req.user?.id);
  }

  @Put(':id/permissions')
  @RequirePermissions('users:update')
  @ApiOperation({ summary: 'Assign permissions to user' })
  async assignPermissions(
    @Param('id') id: string,
    @Body() data: { permissionIds: number[] },
    @Req() req: any,
  ) {
    assertNotSelfPermissionEdit(req, parseInt(id));
    await assertCanManageUser(this.prisma, req.user, parseInt(id));
    return this.usersService.assignPermissions(
      parseInt(id),
      data.permissionIds,
    );
  }
}
