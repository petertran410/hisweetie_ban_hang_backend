// prisma/seeds/add-stock-condition-transfers-permissions.ts
//
// Mục đích: CHỈ thêm (upsert) các quyền cho tính năng "Chuyển loại tồn" (CLT).
// KHÔNG xóa, KHÔNG reset, KHÔNG gán quyền cho role/user, KHÔNG đụng quyền khác.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Danh sách quyền được thêm:
//   1. stock_condition_transfers:view    — Xem danh sách và chi tiết phiếu
//   2. stock_condition_transfers:create  — Tạo phiếu chuyển loại tồn
//   3. stock_condition_transfers:approve — Duyệt phiếu (ăn vào tồn loại)
//   4. stock_condition_transfers:update  — Hủy / cập nhật phiếu
//   5. stock_condition_transfers:export  — Xuất file chuyển loại tồn
//
// Lưu ý: role "Super Admin" đã bypass toàn bộ quyền trong PermissionsGuard,
// nên file này cố ý KHÔNG tự gán cho bất kỳ role nào. Sau khi chạy xong,
// bạn tự gán cho role mong muốn qua giao diện phân quyền.
//
// Cách chạy:  npx ts-node prisma/seeds/add-stock-condition-transfers-permissions.ts

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
    name: 'stock_condition_transfers:view',
    resource: 'stock_condition_transfers',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách và chi tiết phiếu chuyển loại tồn',
    category: 'Kho',
  },
  {
    name: 'stock_condition_transfers:create',
    resource: 'stock_condition_transfers',
    action: 'create',
    scope: 'all',
    description: 'Tạo phiếu chuyển loại tồn (bục rách / cận date / khuyến mãi)',
    category: 'Kho',
  },
  {
    name: 'stock_condition_transfers:approve',
    resource: 'stock_condition_transfers',
    action: 'approve',
    scope: 'all',
    description: 'Duyệt phiếu chuyển loại tồn (áp dụng vào tồn loại)',
    category: 'Kho',
  },
  {
    name: 'stock_condition_transfers:update',
    resource: 'stock_condition_transfers',
    action: 'update',
    scope: 'all',
    description: 'Hủy / cập nhật phiếu chuyển loại tồn',
    category: 'Kho',
  },
  {
    name: 'stock_condition_transfers:export',
    resource: 'stock_condition_transfers',
    action: 'export',
    scope: 'all',
    description: 'Xuất file chuyển loại tồn',
    category: 'Kho',
  },
];

async function main() {
  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền cho tính năng Chuyển loại tồn (chỉ tạo / cập nhật các quyền này, không đụng dữ liệu khác)...`,
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
        data: { category: perm.category, description: perm.description },
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
    console.error('❌ Lỗi khi thêm quyền stock_condition_transfers:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
