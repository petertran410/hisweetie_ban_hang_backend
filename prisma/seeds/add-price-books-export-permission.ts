// prisma/seeds/add-price-books-export-permission.ts
//
// Mục đích: CHỈ thêm đúng MỘT quyền `price_books:export` vào bảng
// `permissions`. Script không xóa, không reset, không gán quyền cho role/user
// và có thể chạy lại an toàn.
//
// Cách chạy: yarn seed:price-books-export
//
// Sau khi chạy, gán quyền cho role mong muốn qua giao diện phân quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSION = {
  name: 'price_books:export',
  resource: 'price_books',
  action: 'export',
  scope: 'all',
  description: 'Xuất file bảng giá',
  category: 'Sản phẩm',
};

async function main() {
  console.log(
    'Thêm quyền price_books:export (chỉ 1 quyền, không ảnh hưởng dữ liệu khác)...',
  );

  const existing = await prisma.permission.findUnique({
    where: { name: PERMISSION.name },
  });

  if (existing) {
    console.log(
      `Đã tồn tại quyền "${PERMISSION.name}" (id=${existing.id}). Không thay đổi gì.`,
    );
    return;
  }

  const created = await prisma.permission.create({
    data: PERMISSION,
  });

  console.log(`Đã tạo quyền "${created.name}" (id=${created.id}).`);
  console.log('Hãy gán quyền này cho role mong muốn qua giao diện phân quyền.');
}

main()
  .then(() => console.log('Hoàn tất.'))
  .catch((error) => {
    console.error('Lỗi khi thêm quyền price_books:export:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
