// prisma/seeds/add-customers-update-comments-permission.ts
//
// Mục đích: CHỈ upsert quyền "customers:update_comments" — sửa ghi chú khách hàng
// (sửa trực tiếp ở trang Khách hàng, API PATCH /customers/:id/comments).
// Người có quyền "customers:update" vẫn sửa được ghi chú; quyền này dành cho
// người chỉ được sửa ghi chú mà không sửa được thông tin khác.
// File không xóa/reset dữ liệu và không tự gán quyền cho role/user.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Scope/category lấy theo quyền "customers:update" để nằm cùng nhóm Khách hàng.
//
// Cách chạy:
//   yarn seed:customers-update-comments
// Hoặc:
//   npx ts-node prisma/seeds/add-customers-update-comments-permission.ts
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSION = {
  name: 'customers:update_comments',
  resource: 'customers',
  action: 'update_comments',
  description: 'Sửa ghi chú khách hàng',
} as const;

async function main() {
  const base = await prisma.permission.findUnique({
    where: { name: 'customers:update' },
  });
  const scope = base?.scope ?? 'all';
  const category = base?.category ?? 'Khách hàng';

  const existing = await prisma.permission.findUnique({
    where: { name: PERMISSION.name },
  });

  if (existing) {
    await prisma.permission.update({
      where: { name: PERMISSION.name },
      data: {
        resource: PERMISSION.resource,
        action: PERMISSION.action,
        scope,
        category,
        description: PERMISSION.description,
      },
    });
    console.log(`  ↷ Đã cập nhật "${PERMISSION.name}" (id=${existing.id}).`);
  } else {
    const created = await prisma.permission.create({
      data: { ...PERMISSION, scope, category },
    });
    console.log(`  ✅ Đã tạo "${created.name}" (id=${created.id}).`);
  }

  console.log(
    '👉 Seed này không tự gán quyền. Hãy gán quyền cho role/user qua giao diện phân quyền.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((error) => {
    console.error('❌ Lỗi khi thêm quyền customers:update_comments:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
