// src/auth/auth.service.ts - Replace toàn bộ file
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(email: string, password: string, branchId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { email },
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
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.password) {
      throw new UnauthorizedException('Please login with Google');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    let permissions: string[];

    if (branchId) {
      permissions = await this.getPermissionsForBranch(user.id, branchId);
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
      ].filter((p) => !denyPermissions.has(p));
    }

    const userBranches = await this.prisma.userBranch.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    });
    const branchIds = userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions,
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
      },
    };
  }

  async googleLogin(googleUser: {
    googleId: string;
    email: string;
    name: string;
    avatar: string;
  }) {
    let user = await this.prisma.user.findUnique({
      where: { email: googleUser.email },
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
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleId: googleUser.googleId,
          email: googleUser.email,
          name: googleUser.name,
          avatar: googleUser.avatar,
          isActive: true,
        },
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
        },
      });

      const defaultRole = await this.prisma.role.findUnique({
        where: { name: 'User' },
      });
      if (defaultRole) {
        await this.prisma.userRole.create({
          data: { userId: user.id, roleId: defaultRole.id },
        });
      }
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId: googleUser.googleId, avatar: googleUser.avatar },
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
        },
      });
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

    const userBranches = await this.prisma.userBranch.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    });
    const branchIds = userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions,
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
      },
    };
  }

  async register(data: {
    name: string;
    email: string;
    password: string;
    phone?: string;
  }) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new UnauthorizedException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
    });

    const defaultRole = await this.prisma.role.findUnique({
      where: { name: 'User' },
    });
    if (defaultRole) {
      await this.prisma.userRole.create({
        data: { userId: user.id, roleId: defaultRole.id },
      });
    }

    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      roles: ['User'],
      permissions: [],
    };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        ...user,
        roles: ['User'],
        permissions: [],
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
      ].filter((p) => !denyPermissions.has(p));
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
    };
  }

  async updateProfile(
    userId: number,
    data: { name?: string; phone?: string; avatar?: string },
  ) {
    return this.prisma.user.update({
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
      },
    });

    if (!user) return [];

    const rolePermKeys = new Set<string>();
    for (const ur of user.userRoles) {
      for (const rp of ur.role.rolePermissions) {
        rolePermKeys.add(`${rp.permission.resource}:${rp.permission.action}`);
      }
    }

    const grantKeys = new Set<string>();
    const denyKeys = new Set<string>();
    for (const up of user.userPermissions) {
      const key = `${up.permission.resource}:${up.permission.action}`;
      if (up.type === 'grant') {
        grantKeys.add(key);
      } else if (up.type === 'deny') {
        denyKeys.add(key);
      }
    }

    let basePermissions = new Set([...rolePermKeys, ...grantKeys]);
    for (const dk of denyKeys) {
      basePermissions.delete(dk);
    }

    if (!branchId) {
      return Array.from(basePermissions);
    }

    const branchOverrides = await this.prisma.userBranchPermission.findMany({
      where: { userId, branchId },
      include: { permission: true },
    });

    if (branchOverrides.length === 0) {
      return Array.from(basePermissions);
    }

    const branchGrants = new Set<string>();
    const branchDenies = new Set<string>();

    for (const bp of branchOverrides) {
      const key = `${bp.permission.resource}:${bp.permission.action}`;
      if (bp.granted) {
        branchGrants.add(key);
      } else {
        branchDenies.add(key);
      }
    }

    for (const bg of branchGrants) {
      basePermissions.add(bg);
    }
    for (const bd of branchDenies) {
      basePermissions.delete(bd);
    }

    return Array.from(basePermissions);
  }
}
