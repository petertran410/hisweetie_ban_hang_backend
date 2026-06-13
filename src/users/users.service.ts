import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { AuditLogsService } from 'src/audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from 'src/audit-logs/audit-templates';
import { PermissionCacheService } from 'src/permission-cache/permission-cache.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private permissionCache: PermissionCacheService,
  ) {}

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
        supplier: { select: { id: true, name: true } },
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
        userBranchRoles: {
          include: {
            role: { select: { id: true, name: true } },
          },
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
      userBranchRoles: (user as any).userBranchRoles || [],
    };
  }

  async create(
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
    performedByUserId?: number,
  ) {
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
          supplierId:
            data.supplierId && data.supplierId > 0 ? data.supplierId : null,
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

    const newUser = await this.findOne(userId); // userId = user mới tạo

    // Thêm block này sau:
    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId }, // actor = admin thực hiện
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'USER_CREATE',
        entityType: 'users',
        entityId: newUser.id.toString(),
        category: getCategoryFromActionCode('USER_CREATE'),
        severity: getSeverityFromActionCode('USER_CREATE'),
        snapshot: { name: newUser.name, email: newUser.email },
        message: renderAuditMessage('USER_CREATE', {
          userName: newUser.name,
          userEmail: newUser.email,
        }),
        messageTemplate: 'USER_CREATE',
        userId: performedByUserId, // người thực hiện
        userName: actor?.name || actor?.email || 'System',
      });
    }

    return newUser;
  }

  async update(
    id: number,
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
    },
    performedByUserId?: number,
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

      if (data.canViewOtherStaffData !== undefined) {
        updateData.canViewOtherStaffData = data.canViewOtherStaffData;
      }

      if (data.canViewOnlyOwnPackings !== undefined) {
        updateData.canViewOnlyOwnPackings = data.canViewOnlyOwnPackings;
      }

      if (data.canViewOnlyOwnLoadingInvoices !== undefined) {
        updateData.canViewOnlyOwnLoadingInvoices =
          data.canViewOnlyOwnLoadingInvoices;
      }

      if (data.branchId !== undefined) {
        updateData.branchId =
          data.branchId && data.branchId > 0 ? data.branchId : null;
      }

      // Đổi NCC (scope dữ liệu) → tăng permissionVersion để buộc nạp lại
      // req.user (đang cache theo permissionVersion) ở lần request kế tiếp.
      if (data.supplierId !== undefined) {
        const newSupplierId =
          data.supplierId && data.supplierId > 0 ? data.supplierId : null;
        updateData.supplierId = newSupplierId;
        if (newSupplierId !== user.supplierId) {
          updateData.permissionVersion = { increment: 1 };
        }
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

    const updatedUser = await this.findOne(id);

    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'USER_UPDATE',
        entityType: 'users',
        entityId: id.toString(),
        category: getCategoryFromActionCode('USER_UPDATE'),
        severity: getSeverityFromActionCode('USER_UPDATE'),
        snapshot: { name: updatedUser.name, email: updatedUser.email },
        message: renderAuditMessage('USER_UPDATE', {
          userName: updatedUser.name,
        }),
        messageTemplate: 'USER_UPDATE',
        userId: performedByUserId,
        userName: actor?.name || actor?.email || 'System',
      });
    }

    if (
      data.roleIds ||
      data.permissionIds ||
      data.denyPermissionIds ||
      data.isActive !== undefined ||
      data.canViewOtherStaffData !== undefined ||
      data.canViewOnlyOwnPackings !== undefined ||
      data.canViewOnlyOwnLoadingInvoices !== undefined
    ) {
      await this.bumpPermissionVersion(id);
    }

    return updatedUser;
  }

  async delete(id: number, performedByUserId?: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    this.permissionCache.invalidateUser(id);

    await this.prisma.user.delete({ where: { id } });

    if (performedByUserId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: performedByUserId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'USER_DELETE',
        entityType: 'users',
        entityId: id.toString(),
        category: getCategoryFromActionCode('USER_DELETE'),
        severity: getSeverityFromActionCode('USER_DELETE'),
        snapshot: { name: user.name, email: user.email },
        message: renderAuditMessage('USER_DELETE', { userName: user.name }),
        messageTemplate: 'USER_DELETE',
        userId: performedByUserId,
        userName: actor?.name || actor?.email || 'System',
      });
    }

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

    await this.bumpPermissionVersion(id);

    return this.findOne(id);
  }

  async getUserBranchRoles(userId: number) {
    return this.prisma.userBranchRole.findMany({
      where: { userId },
      include: {
        role: { select: { id: true, name: true } },
      },
    });
  }

  async setUserBranchRole(
    userId: number,
    branchId: number,
    roleId: number | null,
  ) {
    if (roleId === null) {
      await this.prisma.userBranchRole.deleteMany({
        where: { userId, branchId },
      });
    } else {
      await this.prisma.userBranchRole.upsert({
        where: { userId_branchId: { userId, branchId } },
        create: { userId, branchId, roleId },
        update: { roleId },
      });
    }
    await this.bumpPermissionVersion(userId);
    return { success: true };
  }

  private async bumpPermissionVersion(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { permissionVersion: { increment: 1 } },
    });
    this.permissionCache.invalidateUser(userId);
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

    await this.bumpPermissionVersion(userId);

    return { success: true };
  }
}
