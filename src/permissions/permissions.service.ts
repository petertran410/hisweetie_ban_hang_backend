import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters?: { category?: string; resource?: string }) {
    const where: any = {};
    if (filters?.category) where.category = filters.category;
    if (filters?.resource) where.resource = filters.resource;

    return this.prisma.permission.findMany({
      where,
      orderBy: [{ category: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findByUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
        userPermissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    const rolePermissions =
      user?.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => ({
          ...rp.permission,
          conditions: rp.conditions,
        })),
      ) || [];

    const individualPermissions =
      user?.userPermissions.map((up) => ({
        ...up.permission,
        conditions: up.conditions,
      })) || [];

    const allPermissions = [...rolePermissions, ...individualPermissions];

    return this.groupPermissions(allPermissions);
  }

  private groupPermissions(permissions: any[]) {
    const grouped: Record<string, any> = {};

    for (const perm of permissions) {
      const key = `${perm.resource}.${perm.action}`;

      if (!grouped[key]) {
        grouped[key] = {
          resource: perm.resource,
          action: perm.action,
          scopes: [],
          fields: [],
          conditions: {},
        };
      }

      if (perm.scope) {
        grouped[key].scopes.push(perm.scope);
      }

      if (perm.field) {
        grouped[key].fields.push(perm.field);
      }

      if (perm.conditions) {
        grouped[key].conditions = {
          ...grouped[key].conditions,
          ...perm.conditions,
        };
      }
    }

    return Object.values(grouped);
  }

  async checkPermission(
    userId: number,
    resource: string,
    action: string,
    scope?: string,
    field?: string,
    data?: any,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const permissions =
      user?.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.filter((rp) => {
          const p = rp.permission;
          return (
            p.resource === resource &&
            p.action === action &&
            (!scope || p.scope === scope || p.scope === 'all') &&
            (!field || p.field === field || !p.field)
          );
        }),
      ) || [];

    if (permissions.length === 0) return false;

    for (const rp of permissions) {
      if (this.evaluateConditions(rp.conditions, data, user)) {
        return true;
      }
    }

    return false;
  }

  private evaluateConditions(conditions: any, data: any, user: any): boolean {
    if (!conditions) return true;

    if (conditions.branchId && data?.branchId !== user.branchId) {
      return false;
    }

    if (conditions.userId && data?.userId !== user.id) {
      return false;
    }

    return true;
  }

  async getFieldPermissions(userId: number, resource: string) {
    const permissions = await this.findByUser(userId);

    const resourcePerms = permissions.filter((p) => p.resource === resource);

    const fields = await this.prisma.fieldPermission.findMany({
      where: { resource },
    });

    return fields.map((field) => {
      const viewPerm = resourcePerms.find(
        (p) => p.action === 'view' && p.fields.includes(field.fieldName),
      );
      const editPerm = resourcePerms.find(
        (p) => p.action === 'edit' && p.fields.includes(field.fieldName),
      );

      return {
        ...field,
        canView: !!viewPerm || field.canView,
        canEdit: !!editPerm || field.canEdit,
      };
    });
  }

  async getColumnPermissions(userId: number, resource: string) {
    const permissions = await this.findByUser(userId);

    const resourcePerms = permissions.filter((p) => p.resource === resource);

    const columns = await this.prisma.columnPermission.findMany({
      where: { resource },
      orderBy: { order: 'asc' },
    });

    return columns.map((column) => {
      const viewPerm = resourcePerms.find(
        (p) =>
          p.action === 'view' &&
          (p.scopes.includes('all') || p.fields.includes(column.columnName)),
      );

      return {
        ...column,
        canView: !!viewPerm || column.canView,
      };
    });
  }
}
