// prisma/seeds/add-stock-audit-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  // Stock Audits (Kiểm kho)
  {
    name: 'stock_audits:view',
    resource: 'stock_audits',
    action: 'view',
    description: 'Xem kiểm kho',
    category: 'Kho',
  },
  {
    name: 'stock_audits:create',
    resource: 'stock_audits',
    action: 'create',
    description: 'Tạo kiểm kho',
    category: 'Kho',
  },
  {
    name: 'stock_audits:update',
    resource: 'stock_audits',
    action: 'update',
    description: 'Sửa/hoàn tất/hủy kiểm kho',
    category: 'Kho',
  },
  // Inventory Checks (Kiểm hàng loại B)
  {
    name: 'inventory_checks:view',
    resource: 'inventory_checks',
    action: 'view',
    description: 'Xem kiểm hàng loại B',
    category: 'Kho',
  },
  {
    name: 'inventory_checks:create',
    resource: 'inventory_checks',
    action: 'create',
    description: 'Tạo kiểm hàng loại B',
    category: 'Kho',
  },
  {
    name: 'inventory_checks:update',
    resource: 'inventory_checks',
    action: 'update',
    description: 'Sửa/hủy kiểm hàng loại B',
    category: 'Kho',
  },
];

async function main() {
  console.log('🌱 Adding stock_audits + inventory_checks permissions...');

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
    console.log(`✅ Assigned all to Admin`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
