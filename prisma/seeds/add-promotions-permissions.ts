// prisma/seeds/add-promotions-permissions.ts
//
// Idempotent + non-destructive: chỉ upsert permission `promotions:*` và gán role,
// KHÔNG xóa/ghi đè dữ liệu hiện có. An toàn chạy lại nhiều lần.
//
// Backend (promotions.controller.ts) chỉ dùng 3 action:
//   - promotions:view   → findAll / findOne / logs / usage / stats
//   - promotions:create → POST tạo chương trình
//   - promotions:update → PUT sửa, PATCH toggle (bật/tắt), PATCH stop (ngừng)
// Không có action `delete`.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'promotions:view',
    resource: 'promotions',
    action: 'view',
    description: 'Xem chương trình khuyến mãi',
    category: 'Khách hàng',
  },
  {
    name: 'promotions:create',
    resource: 'promotions',
    action: 'create',
    description: 'Tạo chương trình khuyến mãi',
    category: 'Khách hàng',
  },
  {
    name: 'promotions:update',
    resource: 'promotions',
    action: 'update',
    description: 'Sửa / bật-tắt / ngừng chương trình khuyến mãi',
    category: 'Khách hàng',
  },
];

async function main() {
  console.log('🌱 Adding promotion permissions...');

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
    // Admin nhận toàn bộ quyền khuyến mãi.
    for (const perm of createdPerms) {
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
    console.log(`✅ Assigned all promotion permissions to Admin`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
