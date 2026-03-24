import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') || 'default-secret-key',
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
        userPermissions: {
          include: { permission: true },
        },
        userBranches: {
          include: { branch: { select: { id: true, name: true } } },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

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

    const permissions = [
      ...new Set([...rolePermissions, ...grantPermissions]),
    ].filter((p) => !denyPermissions.has(p));

    const branchIds = user.userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions,
      branchId: user.branchId,
      branchIds,
      canViewOtherStaffData: user.canViewOtherStaffData,
    };
  }
}
