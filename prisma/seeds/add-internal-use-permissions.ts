// prisma/seeds/add-internal-use-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'internal-use:view',
    resource: 'internal-use',
    action: 'view',
    description: 'Xem xuất dùng nội bộ',
    category: 'Sản phẩm',
  },
  {
    name: 'internal-use:create',
    resource: 'internal-use',
    action: 'create',
    description: 'Tạo xuất dùng nội bộ',
    category: 'Sản phẩm',
  },
  {
    name: 'internal-use:update',
    resource: 'internal-use',
    action: 'update',
    description: 'Sửa xuất dùng nội bộ',
    category: 'Sản phẩm',
  },
  {
    name: 'internal-use:delete',
    resource: 'internal-use',
    action: 'delete',
    description: 'Xóa xuất dùng nội bộ',
    category: 'Sản phẩm',
  },
  {
    name: 'internal-use-purpose:manage',
    resource: 'internal-use-purpose',
    action: 'manage',
    description: 'Quản lý mục đích sử dụng (xuất dùng nội bộ)',
    category: 'Sản phẩm',
  },
  {
    name: 'internal-use:view_cost_price',
    resource: 'internal-use',
    action: 'view_cost_price',
    description: 'Xem giá vốn (xuất dùng nội bộ)',
    category: 'Sản phẩm',
  },
];

async function main() {
  console.log('🌱 Adding internal-use permissions...');

  const createdPerms: { id: number; name: string }[] = [];
  for (const perm of NEW_PERMISSIONS) {
    const result = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {
        description: perm.description,
        category: perm.category,
      },
      create: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
        category: perm.category,
        scope: 'all',
      },
    });
    createdPerms.push(result);
    console.log(`  ✅ Upserted permission: ${perm.name}`);
  }

  const superAdminRole = await prisma.role.findUnique({
    where: { name: 'Super Admin' },
  });

  if (superAdminRole) {
    for (const perm of createdPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: perm.id,
        },
      });
    }
    console.log(`✅ Assigned all to Super Admin`);
  }

  const adminRole = await prisma.role.findUnique({
    where: { name: 'Admin' },
  });

  if (adminRole) {
    const adminPerms = createdPerms.filter((p) =>
      [
        'internal-use:view',
        'internal-use:create',
        'internal-use:update',
        'internal-use-purpose:manage',
        'internal-use:view_cost_price',
      ].includes(p.name),
    );
    for (const perm of adminPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: perm.id,
        },
      });
    }
    console.log(`✅ Assigned view/create/update to Admin`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
