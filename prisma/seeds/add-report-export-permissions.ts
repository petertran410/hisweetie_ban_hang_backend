// prisma/seeds/add-report-export-permissions.ts
//
// Thêm 6 quyền XUẤT EXCEL cho trang Báo cáo (theo nhóm). Mỗi nhóm báo cáo có
// xuất dữ liệu được 1 quyền export riêng, tách khỏi quyền xem từng loại.
//
// AN TOÀN — script CHỈ insert/upsert:
//   - Không deleteMany, không reset bảng.
//   - Upsert 6 quyền, gán cho Super Admin + Admin qua rolePermission.upsert.
//   - KHÔNG đụng tới quyền hiện có.
//
// Chạy: npx ts-node prisma/seeds/add-report-export-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionData {
  name: string;
  resource: string;
  action: string;
  description: string;
  category: string;
}

const CATEGORY = 'Báo cáo';

const exportPermissions: PermissionData[] = [
  {
    name: 'reports:export_eod',
    resource: 'reports',
    action: 'export_eod',
    description: 'Xuất Excel báo cáo cuối ngày',
    category: CATEGORY,
  },
  {
    name: 'reports:export_sale',
    resource: 'reports',
    action: 'export_sale',
    description: 'Xuất Excel báo cáo bán hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:export_product',
    resource: 'reports',
    action: 'export_product',
    description: 'Xuất Excel báo cáo hàng hóa',
    category: CATEGORY,
  },
  {
    name: 'reports:export_customer',
    resource: 'reports',
    action: 'export_customer',
    description: 'Xuất Excel báo cáo khách hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:export_supplier',
    resource: 'reports',
    action: 'export_supplier',
    description: 'Xuất Excel báo cáo nhà cung cấp',
    category: CATEGORY,
  },
  {
    name: 'reports:export_financial',
    resource: 'reports',
    action: 'export_financial',
    description: 'Xuất Excel báo cáo tài chính',
    category: CATEGORY,
  },
];

const ROLES_TO_GRANT = ['Super Admin', 'Admin'];

async function main() {
  console.log('🌱 Adding report export permissions (insert-only)...');

  const upserted: { id: number; name: string }[] = [];
  for (const perm of exportPermissions) {
    const p = await prisma.permission.upsert({
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
    upserted.push({ id: p.id, name: p.name });
  }
  console.log(`  ✅ Upserted ${upserted.length} export permissions`);

  for (const roleName of ROLES_TO_GRANT) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.log(`  ⚠ Role "${roleName}" không tồn tại — bỏ qua.`);
      continue;
    }
    for (const perm of upserted) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    console.log(
      `  ✅ Assigned ${upserted.length} export permissions to role "${roleName}"`,
    );
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị xóa hay ghi đè.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
