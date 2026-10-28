// prisma/seeds/add-units-permissions.ts
//
// Mục đích: CHỈ upsert quyền quản lý danh mục Đơn vị tính. Không xóa/reset dữ
// liệu và không tự gán quyền cho role/user. Chạy lại nhiều lần vẫn an toàn.
//
// Quyền:
//   units:manage — Thêm / đổi tên / gộp / ẩn / xóa / sắp xếp đơn vị tính.
//   (Xem danh sách không cần quyền: ô chọn ở form sản phẩm dùng cho mọi user.)
//
// Cách chạy:
//   yarn seed:units-permissions
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  {
    name: 'units:manage',
    resource: 'units',
    action: 'manage',
    description:
      'Quản lý danh mục Đơn vị tính (thêm, đổi tên, gộp, ẩn, xóa, sắp xếp)',
  },
] as const;

async function main() {
  console.log(`🌱 Upsert ${PERMISSIONS.length} quyền cho Đơn vị tính...`);

  for (const permission of PERMISSIONS) {
    const data = {
      resource: permission.resource,
      action: permission.action,
      scope: 'all',
      category: 'Kho',
      description: permission.description,
    };
    const existing = await prisma.permission.findUnique({
      where: { name: permission.name },
    });
    if (existing) {
      await prisma.permission.update({
        where: { name: permission.name },
        data,
      });
      console.log(`  ↷ Đã cập nhật "${permission.name}" (id=${existing.id}).`);
    } else {
      const created = await prisma.permission.create({
        data: { name: permission.name, ...data },
      });
      console.log(`  ✅ Đã tạo "${created.name}" (id=${created.id}).`);
    }
  }

  console.log(
    '👉 Seed này không tự gán quyền. Hãy gán quyền cho role/user qua giao diện phân quyền.',
  );
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((error) => {
    console.error('❌ Lỗi khi thêm quyền units:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
