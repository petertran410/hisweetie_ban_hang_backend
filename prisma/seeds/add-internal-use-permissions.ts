// prisma/seeds/add-internal-use-permissions.ts
//
// Mục đích: CHỈ thêm (upsert) các quyền liên quan tới tính năng
// "Xuất dùng nội bộ" (InternalUse + InternalUsePurpose). KHÔNG đụng tới
// dữ liệu khác: không xóa, không reset, không gán quyền cho role/user,
// không sửa các quyền khác. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Danh sách quyền được thêm:
//
//   1. internal-use:view           — Xem danh sách và chi tiết phiếu
//   2. internal-use:create         — Tạo phiếu xuất dùng nội bộ
//   3. internal-use:update         — Sửa / hoàn thành / hủy phiếu xuất dùng nội bộ
//   4. internal-use:complete       — Hoàn thành phiếu xuất dùng nội bộ
//   5. internal-use-purpose:manage — Quản lý danh mục mục đích xuất
//
// Lưu ý: đối với role "Super Admin" hệ thống đã bypass toàn bộ quyền
// (xem PermissionsGuard → user.roles?.includes('Super Admin')) nên file
// này cố ý KHÔNG tự gán cho bất kỳ role nào. Sau khi chạy xong, bạn tự
// gán cho role mong muốn qua giao diện phân quyền.
//
// Cách chạy:  yarn seed:internal-use
// Hoặc:        npx ts-node prisma/seeds/add-internal-use-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
// category giúp các quyền nhóm "Kho" hiển thị cùng nhau trong màn phân quyền.
const PERMISSIONS: Array<{
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}> = [
  {
    name: 'internal-use:view',
    resource: 'internal-use',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách và chi tiết phiếu xuất dùng nội bộ',
    category: 'Kho',
  },
  {
    name: 'internal-use:create',
    resource: 'internal-use',
    action: 'create',
    scope: 'all',
    description: 'Tạo phiếu xuất dùng nội bộ',
    category: 'Kho',
  },
  {
    name: 'internal-use:update',
    resource: 'internal-use',
    action: 'update',
    scope: 'all',
    description: 'Sửa / hủy phiếu xuất dùng nội bộ',
    category: 'Kho',
  },
  {
    name: 'internal-use:complete',
    resource: 'internal-use',
    action: 'complete',
    scope: 'all',
    description: 'Hoàn thành phiếu xuất dùng nội bộ',
    category: 'Kho',
  },
  {
    name: 'internal-use-purpose:manage',
    resource: 'internal-use-purpose',
    action: 'manage',
    scope: 'all',
    description: 'Quản lý danh mục mục đích xuất dùng nội bộ',
    category: 'Kho',
  },
];

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền cho tính năng Xuất dùng nội bộ (chỉ tạo / cập nhật các quyền này, không đụng dữ liệu khác)...`,
  );

  let created = 0;
  let updated = 0;

  for (const perm of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: perm.name },
    });

    if (existing) {
      // Đã tồn tại → đồng bộ description + category (idempotent, không tạo trùng).
      await prisma.permission.update({
        where: { name: perm.name },
        data: {
          category: perm.category,
          description: perm.description,
        },
      });
      console.log(
        `  ↷ Đã tồn tại "${perm.name}" (id=${existing.id}). Đã đồng bộ category + description.`,
      );
      updated += 1;
      continue;
    }

    const row = await prisma.permission.create({
      data: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        scope: perm.scope,
        description: perm.description,
        category: perm.category,
      },
    });
    console.log(`  ✅ Đã tạo "${row.name}" (id=${row.id}).`);
    created += 1;
  }

  console.log('');
  console.log(
    `📊 Tổng kết: tạo mới ${created}, cập nhật ${updated}, tổng cộng ${PERMISSIONS.length} quyền.`,
  );
  console.log(
    '👉 Hãy gán các quyền trên cho role mong muốn qua giao diện phân quyền. File này cố ý KHÔNG tự gán.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((e) => {
    console.error('❌ Lỗi khi thêm quyền internal-use:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
