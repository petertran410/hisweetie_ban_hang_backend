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

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
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
    const individualPermissions = user.userPermissions.map(
      (up) => up.permission,
    );

    return {
      ...user,
      roles,
      rolePermissions,
      individualPermissions,
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
    isActive?: boolean;
  }) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          password: hashedPassword,
          phone: data.phone,
          branchId: data.branchId,
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
          })),
        });
      }

      return this.findOne(user.id);
    });
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

    return this.prisma.$transaction(async (tx) => {
      const updateData: any = {
        name: data.name,
        email: data.email,
        phone: data.phone,
        branchId: data.branchId,
        isActive: data.isActive,
      };

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

      if (data.permissionIds !== undefined) {
        await tx.userPermission.deleteMany({
          where: { userId: id },
        });

        if (data.permissionIds.length > 0) {
          await tx.userPermission.createMany({
            data: data.permissionIds.map((permissionId) => ({
              userId: id,
              permissionId,
            })),
          });
        }
      }

      return this.findOne(id);
    });
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
}
