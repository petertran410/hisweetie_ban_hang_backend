// prisma/seeds/add-contract-permissions.ts
//
// Idempotent + non-destructive: chỉ upsert permission `contracts:*` và gán role,
// KHÔNG xóa/ghi đè dữ liệu hiện có. An toàn chạy lại nhiều lần.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'contracts:view',
    resource: 'contracts',
    action: 'view',
    description: 'Xem hợp đồng khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'contracts:create',
    resource: 'contracts',
    action: 'create',
    description: 'Tạo hợp đồng (từ template / upload PDF)',
    category: 'Khách hàng',
  },
  {
    name: 'contracts:send',
    resource: 'contracts',
    action: 'send',
    description: 'Gửi / gửi lại hợp đồng cho khách',
    category: 'Khách hàng',
  },
  {
    name: 'contracts:download',
    resource: 'contracts',
    action: 'download',
    description: 'Tải PDF hợp đồng đã ký',
    category: 'Khách hàng',
  },
];

async function main() {
  console.log('🌱 Adding contract permissions...');

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
    // Admin nhận toàn bộ quyền hợp đồng.
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
    console.log(`✅ Assigned all contract permissions to Admin`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
