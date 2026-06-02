// prisma/seeds/add-vat-invoices-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'vat_invoices:view',
    resource: 'vat_invoices',
    action: 'view',
    description: 'Xem hóa đơn VAT (dữ liệu Misa)',
    category: 'Bán hàng',
  },
  {
    name: 'vat_invoices:push',
    resource: 'vat_invoices',
    action: 'push',
    description: 'Đẩy hóa đơn VAT lên Misa (đồng nghĩa đẩy lên thuế)',
    category: 'Bán hàng',
  },
  {
    name: 'vat_invoices:delete',
    resource: 'vat_invoices',
    action: 'delete',
    description: 'Xóa chứng từ Misa của hóa đơn VAT',
    category: 'Bán hàng',
  },
];

async function main() {
  console.log('🌱 Adding vat_invoices permissions...');

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

  // Gán toàn bộ (view + push + delete) cho Admin
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

  console.log(
    '🎉 Done — chỉ Super Admin + Admin được cấp. Không có dữ liệu hiện tại nào bị ảnh hưởng.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
