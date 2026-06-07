import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionCacheService } from '../../permission-cache/permission-cache.service';

const SUPER_ADMIN_ROLE = 'Super Admin';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private permissionCache: PermissionCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') || 'default-secret-key',
    });
  }

  async validate(payload: any) {
    const userId: number = payload.sub;
    const tokenPv: number = payload.pv;

    // 1. Cache hit → zero query
    const cached = this.permissionCache.get(userId);
    if (cached) return cached;

    // 2. Cache miss → lightweight query check isActive + permissionVersion
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isActive: true,
        permissionVersion: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    // 3. pv mismatch → quyền đã thay đổi → buộc đăng nhập lại
    if (tokenPv !== undefined && user.permissionVersion !== tokenPv) {
      throw new UnauthorizedException(
        'Quyền của bạn đã được thay đổi. Vui lòng đăng nhập lại.',
      );
    }

    // 4. pv khớp → query full permissions (chỉ chạy 1 lần mỗi 60s)
    const fullUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        branchId: true,
        canViewOtherStaffData: true,
        canViewOnlyOwnPackings: true,
        canViewOnlyOwnLoadingInvoices: true,
        userBranches: { select: { branchId: true } },
        userRoles: {
          select: {
            role: {
              select: {
                name: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: { resource: true, action: true },
                    },
                  },
                },
              },
            },
          },
        },
        userPermissions: {
          select: {
            type: true,
            permission: {
              select: { resource: true, action: true },
            },
          },
        },
      },
    });

    if (!fullUser) {
      throw new UnauthorizedException();
    }

    const roles = fullUser.userRoles.map((ur) => ur.role.name);

    let permissions: string[] = [];
    if (!roles.includes(SUPER_ADMIN_ROLE)) {
      const rolePerms = fullUser.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map(
          (rp) => `${rp.permission.resource}:${rp.permission.action}`,
        ),
      );
      const grantPerms = fullUser.userPermissions
        .filter((up) => up.type === 'grant')
        .map((up) => `${up.permission.resource}:${up.permission.action}`);
      const denyKeys = new Set(
        fullUser.userPermissions
          .filter((up) => up.type === 'deny')
          .map((up) => `${up.permission.resource}:${up.permission.action}`),
      );
      permissions = [...new Set([...rolePerms, ...grantPerms])].filter(
        (p) => !denyKeys.has(p),
      );
    }

    const branchIds = fullUser.userBranches.map((ub) => ub.branchId);
    if (fullUser.branchId && !branchIds.includes(fullUser.branchId)) {
      branchIds.push(fullUser.branchId);
    }

    const result = {
      id: fullUser.id,
      email: fullUser.email,
      name: fullUser.name,
      roles,
      permissions,
      branchId: fullUser.branchId,
      branchIds,
      canViewOtherStaffData: fullUser.canViewOtherStaffData,
      canViewOnlyOwnPackings: fullUser.canViewOnlyOwnPackings,
      canViewOnlyOwnLoadingInvoices: fullUser.canViewOnlyOwnLoadingInvoices,
    };

    // 5. Cache 60s
    this.permissionCache.set(userId, result);

    return result;
  }
}
