// prisma/seeds/add-promotions-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'promotions:view',
    resource: 'promotions',
    action: 'view',
    description: 'Xem chương trình khuyến mãi',
    category: 'Khuyến mãi',
  },
  {
    name: 'promotions:create',
    resource: 'promotions',
    action: 'create',
    description: 'Tạo chương trình khuyến mãi',
    category: 'Khuyến mãi',
  },
  {
    name: 'promotions:update',
    resource: 'promotions',
    action: 'update',
    description: 'Cập nhật / bật-tắt / ngừng chương trình khuyến mãi',
    category: 'Khuyến mãi',
  },
];

async function main() {
  console.log('🌱 Adding promotions permissions...');

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

  for (const roleName of ['Super Admin', 'Admin']) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;
    for (const perm of createdPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    console.log(`✅ Assigned all to ${roleName}`);
  }

  console.log('🎉 Done — promotions permissions seeded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
