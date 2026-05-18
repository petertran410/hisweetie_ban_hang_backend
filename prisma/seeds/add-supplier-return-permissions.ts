// prisma/seeds/add-supplier-return-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'supplier_returns:view',
    resource: 'supplier_returns',
    action: 'view',
    description: 'Xem trả hàng nhập',
    category: 'Nhà cung cấp',
  },
  {
    name: 'supplier_returns:create',
    resource: 'supplier_returns',
    action: 'create',
    description: 'Tạo trả hàng nhập',
    category: 'Nhà cung cấp',
  },
  {
    name: 'supplier_returns:update',
    resource: 'supplier_returns',
    action: 'update',
    description: 'Sửa trả hàng nhập',
    category: 'Nhà cung cấp',
  },
  {
    name: 'supplier_returns:delete',
    resource: 'supplier_returns',
    action: 'delete',
    description: 'Xóa trả hàng nhập',
    category: 'Nhà cung cấp',
  },
];

async function main() {
  console.log('🌱 Adding supplier_returns permissions...');

  // Upsert từng permission — không xóa gì cả, chỉ thêm mới
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

  // Gán toàn bộ permission mới cho Super Admin
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

  // Gán view + create + update cho Admin
  const adminRole = await prisma.role.findUnique({
    where: { name: 'Admin' },
  });

  if (adminRole) {
    const adminPerms = createdPerms.filter((p) =>
      [
        'supplier_returns:view',
        'supplier_returns:create',
        'supplier_returns:update',
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
