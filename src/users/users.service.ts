import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters?: {
    search?: string;
    branchId?: number;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters?.branchId !== undefined) {
      where.branchId = filters.branchId;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    const page = filters?.page || 1;
    const limit = filters?.limit || 20;

    const [total, data] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          branch: { select: { id: true, name: true } },
          userRoles: {
            include: {
              role: {
                select: { id: true, name: true, description: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      data: data.map((user) => ({
        ...user,
        roles: user.userRoles.map((ur) => ur.role),
      })),
      total,
      page,
      limit,
    };
  }

  async getUsers() {
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });

    return users;
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        userBranches: {
          include: { branch: { select: { id: true, name: true } } },
        },
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
      throw new NotFoundException('User not found');
    }

    const roles = user.userRoles.map((ur) => ur.role);
    const rolePermissions = user.userRoles.flatMap((ur) =>
      ur.role.rolePermissions.map((rp) => rp.permission),
    );
    const grantPermissions = user.userPermissions
      .filter((up) => up.type === 'grant')
      .map((up) => up.permission);
    const denyPermissions = user.userPermissions
      .filter((up) => up.type === 'deny')
      .map((up) => up.permission);
    const assignedBranches =
      (user as any).userBranches?.map((ub: any) => ub.branch) || [];

    return {
      ...user,
      roles,
      rolePermissions,
      individualPermissions: grantPermissions,
      denyPermissions,
      assignedBranches,
    };
  }

  async create(data: {
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
  }) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    if (data.branchId && data.branchId > 0) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: data.branchId },
      });

      if (!branch) {
        throw new NotFoundException(
          `Branch with id ${data.branchId} not found`,
        );
      }
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const userId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          password: hashedPassword,
          phone: data.phone,
          branchId: data.branchId && data.branchId > 0 ? data.branchId : null,
          isActive: data.isActive ?? true,
        },
      });

      if (data.roleIds && data.roleIds.length > 0) {
        await tx.userRole.createMany({
          data: data.roleIds.map((roleId) => ({
            userId: user.id,
            roleId,
          })),
        });
      }

      if (data.permissionIds && data.permissionIds.length > 0) {
        await tx.userPermission.createMany({
          data: data.permissionIds.map((permissionId) => ({
            userId: user.id,
            permissionId,
            type: 'grant',
          })),
        });
      }

      if (data.denyPermissionIds && data.denyPermissionIds.length > 0) {
        await tx.userPermission.createMany({
          data: data.denyPermissionIds.map((permissionId) => ({
            userId: user.id,
            permissionId,
            type: 'deny',
          })),
        });
      }

      if (data.branchIds && data.branchIds.length > 0) {
        await tx.userBranch.createMany({
          data: data.branchIds.map((branchId, index) => ({
            userId: user.id,
            branchId,
            isPrimary: index === 0,
          })),
        });
      }

      return user.id;
    });

    return this.findOne(userId);
  }

  async update(
    id: number,
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
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (data.email && data.email !== user.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: data.email },
      });
      if (existingUser) {
        throw new BadRequestException('Email already exists');
      }
    }

    if (data.branchId && data.branchId > 0) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: data.branchId },
      });

      if (!branch) {
        throw new NotFoundException(
          `Branch with id ${data.branchId} not found`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const updateData: any = {
        name: data.name,
        email: data.email,
        phone: data.phone,
        isActive: data.isActive,
      };

      if (data.branchId !== undefined) {
        updateData.branchId =
          data.branchId && data.branchId > 0 ? data.branchId : null;
      }

      if (data.password) {
        updateData.password = await bcrypt.hash(data.password, 10);
      }

      await tx.user.update({
        where: { id },
        data: updateData,
      });

      if (data.roleIds !== undefined) {
        await tx.userRole.deleteMany({
          where: { userId: id },
        });

        if (data.roleIds.length > 0) {
          await tx.userRole.createMany({
            data: data.roleIds.map((roleId) => ({
              userId: id,
              roleId,
            })),
          });
        }
      }

      if (
        data.permissionIds !== undefined ||
        data.denyPermissionIds !== undefined
      ) {
        await tx.userPermission.deleteMany({
          where: { userId: id },
        });

        const grantIds = data.permissionIds || [];
        const denyIds = data.denyPermissionIds || [];

        if (grantIds.length > 0) {
          await tx.userPermission.createMany({
            data: grantIds.map((permissionId) => ({
              userId: id,
              permissionId,
              type: 'grant',
            })),
          });
        }

        if (denyIds.length > 0) {
          await tx.userPermission.createMany({
            data: denyIds.map((permissionId) => ({
              userId: id,
              permissionId,
              type: 'deny',
            })),
          });
        }
      }

      if (data.branchIds !== undefined) {
        await tx.userBranch.deleteMany({
          where: { userId: id },
        });

        if (data.branchIds.length > 0) {
          await tx.userBranch.createMany({
            data: data.branchIds.map((branchId, index) => ({
              userId: id,
              branchId,
              isPrimary: index === 0,
            })),
          });
        }
      }
    });

    return this.findOne(id);
  }

  async delete(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.delete({ where: { id } });
    return { message: 'User deleted successfully' };
  }

  async assignPermissions(id: number, permissionIds: number[]) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.userPermission.deleteMany({
      where: { userId: id },
    });

    if (permissionIds.length > 0) {
      await this.prisma.userPermission.createMany({
        data: permissionIds.map((permissionId) => ({
          userId: id,
          permissionId,
        })),
      });
    }

    return this.findOne(id);
  }

  async findAllForFilter() {
    return this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async getBranchPermissions(userId: number, branchId: number) {
    const records = await this.prisma.userBranchPermission.findMany({
      where: { userId, branchId },
      include: { permission: true },
    });

    return {
      grants: records.filter((r) => r.granted).map((r) => r.permission),
      denies: records.filter((r) => !r.granted).map((r) => r.permission),
    };
  }

  async assignBranchPermissions(
    userId: number,
    branchId: number,
    grantPermissionIds: number[],
    denyPermissionIds: number[],
  ) {
    await this.prisma.userBranchPermission.deleteMany({
      where: { userId, branchId },
    });

    const records = [
      ...grantPermissionIds.map((permissionId) => ({
        userId,
        branchId,
        permissionId,
        granted: true,
      })),
      ...denyPermissionIds.map((permissionId) => ({
        userId,
        branchId,
        permissionId,
        granted: false,
      })),
    ];

    if (records.length > 0) {
      await this.prisma.userBranchPermission.createMany({ data: records });
    }

    return { success: true };
  }
}
