// prisma/seeds/add-vehicle-permissions.ts
//
// Mục đích: CHỈ upsert các quyền cho tính năng "Xe cộ" (xăng dầu, chăm sóc xe,
// danh sách xe) ở /tai-chinh/xe-co. File không xóa/reset dữ liệu và không tự
// gán quyền cho role/user. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Quyền (hn = Kho Hà Nội, sg = Kho Sài Gòn):
//   vehicles:view_hn     vehicles:view_sg
//   vehicles:create_hn   vehicles:create_sg
//   vehicles:update_hn   vehicles:update_sg
//   vehicles:manage_hn   vehicles:manage_sg
//
// Cách chạy:
//   yarn seed:vehicles
// Hoặc:
//   npx ts-node prisma/seeds/add-vehicle-permissions.ts
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SCOPES = [
  { key: 'hn', label: 'Kho Hà Nội' },
  { key: 'sg', label: 'Kho Sài Gòn' },
] as const;

const ACTIONS = [
  {
    key: 'view',
    description: 'Xem phiếu xăng dầu, chăm sóc xe và danh sách xe',
  },
  { key: 'create', description: 'Tạo phiếu xăng dầu, chăm sóc xe' },
  { key: 'update', description: 'Sửa, hủy phiếu xăng dầu, chăm sóc xe' },
  { key: 'manage', description: 'Thêm, sửa, ngừng dùng xe trong danh sách xe' },
] as const;

const PERMISSIONS = SCOPES.flatMap((scope) =>
  ACTIONS.map((action) => ({
    name: `vehicles:${action.key}_${scope.key}`,
    resource: 'vehicles',
    action: `${action.key}_${scope.key}`,
    description: `${action.description} - ${scope.label}`,
  })),
);

async function main() {
  console.log(`🌱 Upsert ${PERMISSIONS.length} quyền cho Xe cộ...`);

  let created = 0;
  let updated = 0;

  for (const permission of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: permission.name },
    });

    if (existing) {
      await prisma.permission.update({
        where: { name: permission.name },
        data: {
          resource: permission.resource,
          action: permission.action,
          scope: 'all',
          category: 'Tài chính',
          description: permission.description,
        },
      });
      updated += 1;
      console.log(`  ↷ Đã cập nhật "${permission.name}" (id=${existing.id}).`);
      continue;
    }

    const createdPermission = await prisma.permission.create({
      data: {
        name: permission.name,
        resource: permission.resource,
        action: permission.action,
        scope: 'all',
        category: 'Tài chính',
        description: permission.description,
      },
    });
    created += 1;
    console.log(
      `  ✅ Đã tạo "${createdPermission.name}" (id=${createdPermission.id}).`,
    );
  }

  console.log(
    `📊 Tổng kết: tạo mới ${created}, cập nhật ${updated}, tổng cộng ${PERMISSIONS.length} quyền.`,
  );
  console.log(
    '👉 Seed này không tự gán quyền. Hãy gán quyền cho role/user qua giao diện phân quyền.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((error) => {
    console.error('❌ Lỗi khi thêm quyền vehicles:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
