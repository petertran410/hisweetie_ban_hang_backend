import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePermissionDto, UpdatePermissionDto } from './dto';

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.permission.findMany({
      include: {
        _count: {
          select: { rolePermissions: true },
        },
      },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findOne(id: number) {
    const permission = await this.prisma.permission.findUnique({
      where: { id },
      include: {
        rolePermissions: {
          include: {
            role: true,
          },
        },
        _count: {
          select: { rolePermissions: true },
        },
      },
    });

    if (!permission) {
      throw new NotFoundException(`Permission with ID ${id} not found`);
    }

    return permission;
  }

  async create(dto: CreatePermissionDto) {
    const permission = await this.prisma.permission.create({
      data: dto,
    });

    return this.findOne(permission.id);
  }

  async update(id: number, dto: UpdatePermissionDto) {
    await this.findOne(id);

    const permission = await this.prisma.permission.update({
      where: { id },
      data: dto,
    });

    return this.findOne(permission.id);
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.permission.delete({ where: { id } });
  }

  async findByResource(resource: string) {
    return this.prisma.permission.findMany({
      where: { resource },
      orderBy: { action: 'asc' },
    });
  }

  async getGroupedByResource() {
    const permissions = await this.findAll();
    const grouped: Record<string, any[]> = {};

    permissions.forEach((permission) => {
      if (!grouped[permission.resource]) {
        grouped[permission.resource] = [];
      }
      grouped[permission.resource].push(permission);
    });

    return grouped;
  }
}
