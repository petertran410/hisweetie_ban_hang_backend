// prisma/seeds/add-invoices-update-finalized-permission.ts
//
// Mục đích: CHỈ upsert quyền "invoices:update_finalized" — sửa nội dung hóa đơn
// đã Giao thành công / Hoàn thành (hàng hóa, khách, giao hàng, giảm giá, phí ship).
// Lưu ghi chú, Kết thúc, Báo đơn, Hủy KHÔNG cần quyền này.
// File không xóa/reset dữ liệu và không tự gán quyền cho role/user.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Scope/category lấy theo quyền "invoices:update" để nằm cùng nhóm Hóa đơn.
//
// Cách chạy:
//   yarn seed:invoices-update-finalized
// Hoặc:
//   npx ts-node prisma/seeds/add-invoices-update-finalized-permission.ts
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSION = {
  name: 'invoices:update_finalized',
  resource: 'invoices',
  action: 'update_finalized',
  description: 'Sửa hóa đơn đã Giao thành công / Hoàn thành',
} as const;

async function main() {
  const base = await prisma.permission.findUnique({
    where: { name: 'invoices:update' },
  });
  const scope = base?.scope ?? 'all';
  const category = base?.category ?? 'Hóa đơn';

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
    console.error('❌ Lỗi khi thêm quyền invoices:update_finalized:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
