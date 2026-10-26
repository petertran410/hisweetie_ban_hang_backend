import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';
import { isRetiredPermissionName } from '../permissions/permission-policy';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private permissionCache: PermissionCacheService,
  ) {}

  async login(email: string, password: string, branchId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, password: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.password)
      throw new UnauthorizedException('Vui lòng đăng nhập bằng Lark');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is inactive');

    return this.issueAuthResponse(user.id, branchId);
  }

  async issueAuthResponse(userId: number, branchId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is inactive');

    const roles = user.userRoles.map((ur) => ur.role.name);

    const effectiveBranchId = branchId ?? user.branchId ?? undefined;

    let permissions: string[];
    if (effectiveBranchId) {
      permissions = await this.getPermissionsForBranch(
        user.id,
        effectiveBranchId,
      );
    } else {
      const rolePermissions = user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      );
      const grantPermissions = user.userPermissions
        .filter((up) => up.type === 'grant')
        .map((up) => up.permission.name);
      const denyPermissions = new Set(
        user.userPermissions
          .filter((up) => up.type === 'deny')
          .map((up) => up.permission.name),
      );
      permissions = [
        ...new Set([...rolePermissions, ...grantPermissions]),
      ].filter((p) => !denyPermissions.has(p) && !isRetiredPermissionName(p));
    }

    const userBranches = await this.prisma.userBranch.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    });
    const branchIds = userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    // JWT chỉ được KÝ, không mã hóa — ai cầm token cũng đọc được payload.
    // Chỉ để id + permissionVersion; thông tin hiển thị trả trong `user`.
    const payload = {
      sub: user.id,
      pv: user.permissionVersion,
      typ: 'access',
    };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        roles,
        permissions,
        branchId: user.branchId,
        branchIds,
        supplierId: user.supplierId ?? null,
        canViewOtherStaffData: user.canViewOtherStaffData,
        canViewOnlyOwnPackings: user.canViewOnlyOwnPackings,
        canViewOnlyOwnLoadingInvoices: user.canViewOnlyOwnLoadingInvoices,
      },
    };
  }

  async validateUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return null;
    }

    return user;
  }

  async getProfile(userId: number, branchId?: number) {
    // FE gọi profile mỗi lần load trang/đổi chi nhánh (RouteGuard) — mỗi lần
    // ~25 câu SQL. Cache 60s, xóa qua invalidateUser/invalidateAll khi quyền,
    // trạng thái hoặc thông tin user thay đổi.
    const cached = this.permissionCache.getProfile(userId, branchId);
    if (cached) return cached;

    const profile = await this.loadProfile(userId, branchId);
    this.permissionCache.setProfile(userId, branchId, profile);
    return profile;
  }

  private async loadProfile(userId: number, branchId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: { select: { id: true, name: true } },
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
        userBranches: {
          include: { branch: { select: { id: true, name: true } } },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    let permissions: string[];

    if (branchId) {
      permissions = await this.getPermissionsForBranch(userId, branchId);
    } else {
      const rolePermissions = user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      );
      const grantPermissions = user.userPermissions
        .filter((up) => up.type === 'grant')
        .map((up) => up.permission.name);
      const denyPermissions = new Set(
        user.userPermissions
          .filter((up) => up.type === 'deny')
          .map((up) => up.permission.name),
      );
      permissions = [
        ...new Set([...rolePermissions, ...grantPermissions]),
      ].filter((p) => !denyPermissions.has(p) && !isRetiredPermissionName(p));
    }

    const branchIds = user.userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar,
      roles,
      permissions,
      branchId: user.branchId,
      branchIds,
      supplierId: user.supplierId ?? null,
      canViewOtherStaffData: user.canViewOtherStaffData,
      canViewOnlyOwnPackings: user.canViewOnlyOwnPackings,
      canViewOnlyOwnLoadingInvoices: user.canViewOnlyOwnLoadingInvoices,
      permissionVersion: user.permissionVersion,
    };
  }

  async updateProfile(
    userId: number,
    data: { name?: string; phone?: string; avatar?: string },
  ) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
      },
    });
    this.permissionCache.invalidateUser(userId);
    return updated;
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.password) {
      throw new UnauthorizedException(
        'Cannot change password for Google account',
      );
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Password changed successfully' };
  }

  async getPermissionsForBranch(
    userId: number,
    branchId?: number,
  ): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userBranchRoles: {
          ...(branchId ? { where: { branchId } } : {}),
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
                ...(branchId
                  ? {
                      roleBranchPermissions: {
                        where: { branchId },
                        include: { permission: true },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
                ...(branchId
                  ? {
                      roleBranchPermissions: {
                        where: { branchId },
                        include: { permission: true },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
      },
    });

    if (!user) return [];

    const basePermKeys = new Set<string>();

    // Ưu tiên branch-specific role, fallback về global roles
    const userBranchRoles = (user as any).userBranchRoles || [];
    const rolesSource =
      branchId && userBranchRoles.length > 0
        ? userBranchRoles.map((ubr: any) => ubr.role)
        : user.userRoles.map((ur) => ur.role);

    for (const role of rolesSource) {
      const branchPerms = role.roleBranchPermissions || [];
      const source =
        branchPerms.length > 0 ? branchPerms : role.rolePermissions;
      for (const rp of source) {
        basePermKeys.add(`${rp.permission.resource}:${rp.permission.action}`);
      }
    }

    const grantKeys = new Set<string>();
    const denyKeys = new Set<string>();
    for (const up of user.userPermissions) {
      const key = `${up.permission.resource}:${up.permission.action}`;
      if (up.type === 'grant') grantKeys.add(key);
      else if (up.type === 'deny') denyKeys.add(key);
    }

    const permissions = new Set([...basePermKeys, ...grantKeys]);
    for (const dk of denyKeys) permissions.delete(dk);

    if (branchId) {
      const branchOverrides = await this.prisma.userBranchPermission.findMany({
        where: { userId, branchId },
        include: { permission: true },
      });
      for (const bp of branchOverrides) {
        const key = `${bp.permission.resource}:${bp.permission.action}`;
        if (bp.granted) permissions.add(key);
        else permissions.delete(key);
      }
    }

    return Array.from(permissions).filter(
      (permission) => !isRetiredPermissionName(permission),
    );
  }
}
