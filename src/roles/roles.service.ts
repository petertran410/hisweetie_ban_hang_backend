import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto';
import { PermissionCacheService } from 'src/permission-cache/permission-cache.service';

@Injectable()
export class RolesService {
  constructor(
    private prisma: PrismaService,
    private permissionCache: PermissionCacheService,
  ) {}

  async findAll() {
    return this.prisma.role.findMany({
      include: {
        _count: {
          select: { userRoles: true, rolePermissions: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
        userRoles: {
          include: {
            user: {
              select: { id: true, name: true, email: true },
            },
          },
        },
        _count: {
          select: { userRoles: true, rolePermissions: true },
        },
      },
    });

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    return role;
  }

  async create(dto: CreateRoleDto) {
    const lastRole = await this.prisma.role.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = lastRole ? lastRole.id + 1 : 1;

    const role = await this.prisma.role.create({
      data: {
        id: nextId,
        name: dto.name,
        description: dto.description,
      },
    });

    if (dto.permissionIds && dto.permissionIds.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: dto.permissionIds.map((permissionId) => ({
          roleId: role.id,
          permissionId,
        })),
      });
    }

    return this.findOne(role.id);
  }

  async update(id: number, dto: UpdateRoleDto) {
    await this.findOne(id);

    const role = await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
      },
    });

    if (dto.permissionIds !== undefined) {
      await this.prisma.rolePermission.deleteMany({
        where: { roleId: id },
      });

      if (dto.permissionIds.length > 0) {
        await this.prisma.rolePermission.createMany({
          data: dto.permissionIds.map((permissionId) => ({
            roleId: id,
            permissionId,
          })),
        });
      }
    }

    return this.findOne(role.id);
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.bumpUsersOfRole(id);
    return this.prisma.role.delete({ where: { id } });
  }

  async assignPermissions(id: number, permissionIds: number[]) {
    await this.findOne(id);

    await this.prisma.rolePermission.deleteMany({
      where: { roleId: id },
    });

    if (permissionIds.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: id,
          permissionId,
        })),
      });
    }

    await this.bumpUsersOfRole(id);

    return this.findOne(id);
  }

  private async bumpUsersOfRole(roleId: number): Promise<void> {
    await this.prisma.user.updateMany({
      where: { userRoles: { some: { roleId } } },
      data: { permissionVersion: { increment: 1 } },
    });
    this.permissionCache.invalidateAll();
  }

  async getRoleBranchPermissions(
    roleId: number,
    branchId: number,
  ): Promise<number[]> {
    const records = await this.prisma.roleBranchPermission.findMany({
      where: { roleId, branchId },
      select: { permissionId: true },
    });
    return records.map((r) => r.permissionId);
  }

  async assignRoleBranchPermissions(
    roleId: number,
    branchId: number,
    permissionIds: number[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.roleBranchPermission.deleteMany({
        where: { roleId, branchId },
      }),
      ...(permissionIds.length > 0
        ? [
            this.prisma.roleBranchPermission.createMany({
              data: permissionIds.map((permissionId) => ({
                roleId,
                branchId,
                permissionId,
              })),
            }),
          ]
        : []),
    ]);
  }
}
