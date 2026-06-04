// prisma/seeds/add-dashboard-permission.ts
//
// Thêm permission `dashboard:view` để kiểm soát ai xem được trang Tổng quan
// (dashboard chứa dữ liệu nhạy cảm: doanh thu, công nợ, top khách...).
// - Upsert permission, KHÔNG xóa dữ liệu hiện có.
// - Gán cho Super Admin + Admin. Các role khác mặc định KHÔNG có
//   (cấp thêm qua trang Cài đặt → Vai trò nếu cần).
//
// Chạy: npx ts-node prisma/seeds/add-dashboard-permission.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSION = {
  name: 'dashboard:view',
  resource: 'dashboard',
  action: 'view',
  description: 'Xem trang Tổng quan (dashboard)',
  category: 'Báo cáo',
};

// Các role được gán sẵn quyền xem dashboard.
const ROLES_TO_GRANT = ['Super Admin', 'Admin'];

async function main() {
  console.log('🌱 Adding dashboard:view permission...');

  const perm = await prisma.permission.upsert({
    where: { name: NEW_PERMISSION.name },
    update: {
      description: NEW_PERMISSION.description,
      category: NEW_PERMISSION.category,
    },
    create: {
      name: NEW_PERMISSION.name,
      resource: NEW_PERMISSION.resource,
      action: NEW_PERMISSION.action,
      description: NEW_PERMISSION.description,
      category: NEW_PERMISSION.category,
      scope: 'all',
    },
  });
  console.log(`  ✅ Upserted permission: ${perm.name} (id=${perm.id})`);

  for (const roleName of ROLES_TO_GRANT) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.log(`  ⚠ Role "${roleName}" không tồn tại — bỏ qua.`);
      continue;
    }
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: perm.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: perm.id },
    });
    console.log(`  ✅ Assigned ${perm.name} to role "${roleName}"`);
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
