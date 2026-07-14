// prisma/seeds/add-consignment-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'consignments:view',
    resource: 'consignments',
    action: 'view',
    description: 'Xem đơn hàng ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignments:create',
    resource: 'consignments',
    action: 'create',
    description: 'Tạo đơn hàng ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignments:update',
    resource: 'consignments',
    action: 'update',
    description: 'Sửa đơn hàng ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignments:delete',
    resource: 'consignments',
    action: 'delete',
    description: 'Xóa đơn hàng ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignment_returns:view',
    resource: 'consignment_returns',
    action: 'view',
    description: 'Xem phiếu hoàn ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignment_returns:create',
    resource: 'consignment_returns',
    action: 'create',
    description: 'Tạo phiếu hoàn ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignment_returns:update',
    resource: 'consignment_returns',
    action: 'update',
    description: 'Cập nhật phiếu hoàn ký gửi',
    category: 'Bán hàng',
  },
  {
    name: 'consignment_returns:cancel',
    resource: 'consignment_returns',
    action: 'cancel',
    description: 'Hủy phiếu hoàn ký gửi',
    category: 'Bán hàng',
  },
];

async function main() {
  console.log('🌱 Adding consignment permissions...');

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
        'consignments:view',
        'consignments:create',
        'consignments:update',
        'consignment_returns:view',
        'consignment_returns:create',
        'consignment_returns:update',
        'consignment_returns:cancel',
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
    console.log(`✅ Assigned consignment(s) view/create/update + returns view/create/update/cancel to Admin`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
