// prisma/seeds/add-warehouse-cost-price-permissions.ts
//
// Mục đích:
// 1. Thêm quyền `transfers:view_cost_price` (Xem giá — Chuyển kho): ẩn/hiện
//    đơn giá & giá trị phiếu chuyển. User thiếu quyền vẫn tạo phiếu được, đơn
//    giá mặc định = giá vốn chi nhánh chuyển (backend tự điền).
// 2. Chuyển `internal-use:view_cost_price` + `internal-use:delete` từ category
//    "Sản phẩm" về "Kho" để nằm CHUNG box "Xuất dùng nội bộ" với các quyền
//    internal-use:* khác trên màn phân quyền (grouping = category + resource),
//    và đổi mô tả `internal-use:view_cost_price` thành "Xem giá".
//
// KHÔNG gán quyền cho role/user, không xóa gì. Chạy lại nhiều lần vẫn an toàn.
//
// Cách chạy:  yarn seed:warehouse-cost-price
//
// Sau khi chạy, gán quyền "Xem giá" của Chuyển kho cho role mong muốn qua
// giao diện phân quyền (Cài đặt → Vai trò & Quyền).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TRANSFER_PERMISSION = {
  name: 'transfers:view_cost_price',
  resource: 'transfers',
  action: 'view_cost_price',
  scope: 'all',
  description: 'Xem giá (chuyển kho)',
  category: 'Kho',
};

const MOVE_TO_KHO = ['internal-use:view_cost_price', 'internal-use:delete'];

async function main() {
  const existing = await prisma.permission.findUnique({
    where: { name: TRANSFER_PERMISSION.name },
  });
  if (existing) {
    console.log(`  ↷ Đã tồn tại "${TRANSFER_PERMISSION.name}". Bỏ qua.`);
  } else {
    const created = await prisma.permission.create({
      data: TRANSFER_PERMISSION,
    });
    console.log(`  ✅ Đã tạo "${created.name}" (id=${created.id}).`);
  }

  const moved = await prisma.permission.updateMany({
    where: { name: { in: MOVE_TO_KHO }, category: { not: 'Kho' } },
    data: { category: 'Kho' },
  });
  console.log(
    `  ✅ Chuyển ${moved.count} quyền xuất dùng nội bộ về nhóm "Kho".`,
  );

  await prisma.permission.updateMany({
    where: { name: 'internal-use:view_cost_price' },
    data: { description: 'Xem giá (xuất dùng nội bộ)' },
  });
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
