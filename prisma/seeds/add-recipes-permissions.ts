// prisma/seeds/add-recipes-permissions.ts
//
// Upsert quyền module Công thức pha chế (recipes). Idempotent.
// Không tự gán role — Super Admin bypass; gán role khác qua UI phân quyền.
//
// Cách chạy: yarn seed:recipes

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}> = [
  {
    name: 'recipes:view',
    resource: 'recipes',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách, chi tiết công thức pha chế',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:view_cost',
    resource: 'recipes',
    action: 'view_cost',
    scope: 'all',
    description: 'Xem giá vốn / margin / lịch sử cost công thức',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:create',
    resource: 'recipes',
    action: 'create',
    scope: 'all',
    description: 'Tạo công thức và draft version',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:update',
    resource: 'recipes',
    action: 'update',
    scope: 'all',
    description: 'Sửa draft version (nguyên liệu, quy trình)',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:comment',
    resource: 'recipes',
    action: 'comment',
    scope: 'all',
    description: 'Thêm, sửa và xóa bình luận của mình trên công thức',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:publish',
    resource: 'recipes',
    action: 'publish',
    scope: 'all',
    description: 'Publish draft → version bất biến',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:archive',
    resource: 'recipes',
    action: 'archive',
    scope: 'all',
    description: 'Archive / khôi phục công thức',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:delete',
    resource: 'recipes',
    action: 'delete',
    scope: 'all',
    description: 'Xóa draft công thức chưa tham chiếu',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:clone',
    resource: 'recipes',
    action: 'clone',
    scope: 'all',
    description: 'Clone công thức thành draft mới',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:calculate_cost',
    resource: 'recipes',
    action: 'calculate_cost',
    scope: 'all',
    description: 'Tính lại giá vốn thủ công',
    category: 'Sản phẩm',
  },
  {
    name: 'recipes:export',
    resource: 'recipes',
    action: 'export',
    scope: 'all',
    description: 'Xuất PDF/Excel công thức',
    category: 'Sản phẩm',
  },
];

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền recipes (idempotent)...`,
  );

  let created = 0;
  let updated = 0;

  for (const perm of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: perm.name },
    });

    if (existing) {
      await prisma.permission.update({
        where: { name: perm.name },
        data: {
          category: perm.category,
          description: perm.description,
        },
      });
      console.log(`  ↷ Đã tồn tại "${perm.name}" (id=${existing.id}).`);
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

  console.log(
    `📊 Tổng kết: tạo mới ${created}, cập nhật ${updated}, tổng ${PERMISSIONS.length}.`,
  );
}

main()
  .then(() => console.log('🎉 Hoàn tất seed recipes permissions.'))
  .catch((e) => {
    console.error('❌ Lỗi seed recipes permissions:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
