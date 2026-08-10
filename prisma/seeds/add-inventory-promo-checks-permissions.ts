// prisma/seeds/add-inventory-promo-checks-permissions.ts
//
// Mục đích: CHỈ thêm (upsert) các quyền liên quan tới tính năng
// "Kiểm hàng khuyến mãi" (InventoryPromoCheck). KHÔNG đụng tới
// dữ liệu khác: không xóa, không reset, không gán quyền cho role/user,
// không sửa các quyền khác. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Danh sách quyền được thêm:
//
//   1. inventory_promo_checks:view   — Xem danh sách và chi tiết phiếu
//   2. inventory_promo_checks:create — Tạo phiếu kiểm hàng khuyến mãi
//   3. inventory_promo_checks:update — Hủy / cập nhật phiếu
//   4. inventory_promo_checks:export — Xuất file kiểm hàng khuyến mãi
//
// Lưu ý: role "Super Admin" đã bypass toàn bộ quyền trong PermissionsGuard,
// nên file này cố ý KHÔNG tự gán cho bất kỳ role nào. Sau khi chạy xong,
// bạn tự gán cho role mong muốn qua giao diện phân quyền.
//
// Cách chạy:  yarn seed:inventory-promo-checks
// Hoặc:        npx ts-node prisma/seeds/add-inventory-promo-checks-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
// category phải là "Kho" để nhóm cùng các quyền kiểm kho / kiểm hàng loại B.
const PERMISSIONS: Array<{
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}> = [
  {
    name: 'inventory_promo_checks:view',
    resource: 'inventory_promo_checks',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách và chi tiết phiếu kiểm hàng khuyến mãi',
    category: 'Kho',
  },
  {
    name: 'inventory_promo_checks:create',
    resource: 'inventory_promo_checks',
    action: 'create',
    scope: 'all',
    description: 'Tạo phiếu kiểm hàng khuyến mãi',
    category: 'Kho',
  },
  {
    name: 'inventory_promo_checks:update',
    resource: 'inventory_promo_checks',
    action: 'update',
    scope: 'all',
    description: 'Hủy / cập nhật phiếu kiểm hàng khuyến mãi',
    category: 'Kho',
  },
  {
    name: 'inventory_promo_checks:export',
    resource: 'inventory_promo_checks',
    action: 'export',
    scope: 'all',
    description: 'Xuất file kiểm hàng khuyến mãi',
    category: 'Kho',
  },
];

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền cho tính năng Kiểm hàng khuyến mãi (chỉ tạo / cập nhật các quyền này, không đụng dữ liệu khác)...`,
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
    console.error('❌ Lỗi khi thêm quyền inventory_promo_checks:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
