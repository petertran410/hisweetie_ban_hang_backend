// prisma/seeds/add-internal-use-returns-permissions.ts
//
// Mục đích: CHỈ upsert các quyền cho tính năng
// "Trả hàng xuất dùng nội bộ". File không xóa/reset dữ liệu và không tự gán
// quyền cho role/user. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Quyền:
//   internal-use-returns:view
//   internal-use-returns:create
//   internal-use-returns:update
//   internal-use-returns:cancel
//   internal-use-returns:export
//
// Cách chạy:
//   yarn seed:internal-use-returns
// Hoặc:
//   npx ts-node prisma/seeds/add-internal-use-returns-permissions.ts
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  {
    name: 'internal-use-returns:view',
    resource: 'internal-use-returns',
    action: 'view',
    description: 'Xem danh sách và chi tiết phiếu trả xuất dùng nội bộ',
  },
  {
    name: 'internal-use-returns:create',
    resource: 'internal-use-returns',
    action: 'create',
    description: 'Tạo phiếu trả xuất dùng nội bộ',
  },
  {
    name: 'internal-use-returns:update',
    resource: 'internal-use-returns',
    action: 'update',
    description: 'Cập nhật và xác nhận nhập lại kho phiếu trả xuất dùng nội bộ',
  },
  {
    name: 'internal-use-returns:cancel',
    resource: 'internal-use-returns',
    action: 'cancel',
    description: 'Hủy phiếu trả xuất dùng nội bộ',
  },
  {
    name: 'internal-use-returns:export',
    resource: 'internal-use-returns',
    action: 'export',
    description: 'Xuất file phiếu trả xuất dùng nội bộ',
  },
] as const;

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền cho Trả hàng xuất dùng nội bộ...`,
  );

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
          category: 'Kho',
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
        category: 'Kho',
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
    console.error(
      '❌ Lỗi khi thêm quyền internal-use-returns:',
      error,
    );
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

