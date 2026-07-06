// prisma/seeds/add-factories-and-product-factory-permissions.ts
//
// Mục đích: CHỈ thêm (upsert) các quyền liên quan tới tính năng Nhà máy
// (Factory) + gắn nhà máy vào sản phẩm. KHÔNG đụng tới dữ liệu khác: không
// xóa, không reset, không gán quyền cho role/user, không sửa các quyền khác.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Danh sách quyền được thêm:
//
//   1. factories:view              — Xem trang Nhà máy + API /factories
//   2. factories:create            — Tạo nhà máy mới
//   3. factories:update            — Sửa nhà máy
//   4. factories:delete            — Xóa / ẩn nhà máy
//   5. products:view_factory       — Xem section "Nhà máy sản xuất" trong ProductForm
//   6. products:assign_factory     — Gắn / đổi nhà máy chính / backup cho sản phẩm
//
// Sau khi chạy xong, việc GÁN các quyền này cho role do bạn tự thực hiện qua
// giao diện phân quyền (file này cố ý KHÔNG tự gán cho bất kỳ role nào).
//
// Cách chạy:  yarn seed:factories-product-factory
// Hoặc:        npx ts-node prisma/seeds/add-factories-and-product-factory-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
// category giúp các quyền nhóm "Sản phẩm" hiển thị cùng nhau trong màn phân quyền.
const PERMISSIONS: Array<{
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}> = [
  {
    name: 'factories:view',
    resource: 'factories',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách và chi tiết nhà máy',
    category: 'Sản phẩm',
  },
  {
    name: 'factories:create',
    resource: 'factories',
    action: 'create',
    scope: 'all',
    description: 'Tạo nhà máy mới',
    category: 'Sản phẩm',
  },
  {
    name: 'factories:update',
    resource: 'factories',
    action: 'update',
    scope: 'all',
    description: 'Sửa thông tin nhà máy',
    category: 'Sản phẩm',
  },
  {
    name: 'factories:delete',
    resource: 'factories',
    action: 'delete',
    scope: 'all',
    description: 'Xóa / ẩn nhà máy (soft-delete khi đang được sử dụng)',
    category: 'Sản phẩm',
  },
  {
    name: 'products:view_factory',
    resource: 'products',
    action: 'view_factory',
    scope: 'all',
    description:
      'Xem thông tin nhà máy chính / backup trên sản phẩm (hiển thị section trong ProductForm)',
    category: 'Sản phẩm',
  },
  {
    name: 'products:assign_factory',
    resource: 'products',
    action: 'assign_factory',
    scope: 'all',
    description:
      'Gắn / đổi nhà máy chính hoặc nhà máy backup cho sản phẩm',
    category: 'Sản phẩm',
  },
];

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền cho tính năng Nhà máy + Product-Factory (chỉ tạo / cập nhật các quyền này, không đụng dữ liệu khác)...`,
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
    console.error('❌ Lỗi khi thêm quyền factories + product-factory:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());