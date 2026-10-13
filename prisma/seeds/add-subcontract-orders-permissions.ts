// prisma/seeds/add-subcontract-orders-permissions.ts
//
// Mục đích: CHỈ upsert các quyền cho tính năng "Gia công ngoài" (gửi nguyên
// liệu sang nhà máy sản xuất hộ). File không xóa/reset dữ liệu và không tự gán
// quyền cho role/user. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy (người dùng tự chạy, sau khi đã đồng bộ schema vào DB):
//   yarn seed:subcontract-orders
// Hoặc:
//   npx ts-node prisma/seeds/add-subcontract-orders-permissions.ts
//
// Sau khi chạy, hãy gán quyền cho role/user qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RESOURCE = 'subcontract_orders';

const PERMISSIONS = [
  { action: 'view', description: 'Xem danh sách và chi tiết lệnh gia công' },
  { action: 'create', description: 'Tạo lệnh gia công' },
  {
    action: 'update',
    description:
      'Sửa lệnh, gửi nguyên liệu và quản lý chi phí của lệnh gia công',
  },
  { action: 'receive', description: 'Nhập / hủy đợt nhập thành phẩm gia công' },
  { action: 'complete', description: 'Hoàn thành và quyết toán lệnh gia công' },
  { action: 'cancel', description: 'Hủy lệnh gia công' },
  {
    action: 'payment',
    description: 'Thanh toán cho nhà máy theo lệnh gia công',
  },
  {
    action: 'view_cost_price',
    description: 'Xem giá vốn nguyên liệu và giá thành của lệnh gia công',
  },
  {
    action: 'apply_cost',
    description: 'Áp giá thành gia công vào giá vốn thành phẩm',
  },
] as const;

async function main() {
  console.log(`🌱 Upsert ${PERMISSIONS.length} quyền cho Gia công ngoài...`);

  let created = 0;
  let updated = 0;

  for (const permission of PERMISSIONS) {
    const name = `${RESOURCE}:${permission.action}`;
    const data = {
      resource: RESOURCE,
      action: permission.action,
      scope: 'all',
      category: 'Kho',
      description: permission.description,
    };

    const existing = await prisma.permission.findUnique({ where: { name } });
    if (existing) {
      await prisma.permission.update({ where: { name }, data });
      updated += 1;
      console.log(`  ↷ Đã cập nhật "${name}" (id=${existing.id}).`);
      continue;
    }

    const createdPermission = await prisma.permission.create({
      data: { name, ...data },
    });
    created += 1;
    console.log(`  ✅ Đã tạo "${name}" (id=${createdPermission.id}).`);
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
    console.error('❌ Lỗi khi thêm quyền subcontract_orders:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
