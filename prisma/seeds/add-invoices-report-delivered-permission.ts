// prisma/seeds/add-invoices-report-delivered-permission.ts
//
// Mục đích: CHỈ thêm (upsert) đúng MỘT quyền `invoices:report_delivered` vào
// bảng `permissions`. Quyền này chỉ quyết định việc HIỂN THỊ nút "Đã Báo Đơn"
// ở màn chi tiết hóa đơn (không liên quan tới quyền cập nhật hóa đơn).
// File này được thiết kế để KHÔNG đụng tới bất kỳ dữ liệu nào khác: không xóa,
// không reset, không gán quyền cho role/user, không sửa các quyền khác. Chạy
// lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy:  yarn seed:invoices-report-delivered
//
// Sau khi chạy xong, việc GÁN quyền này cho role do bạn tự thực hiện qua giao
// diện phân quyền (file này cố ý KHÔNG tự gán cho bất kỳ role nào).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
// category = 'Bán hàng' để nằm CHUNG nhóm "Hóa đơn" với các quyền invoices:* khác
// trong màn phân quyền (grouping theo category + resource).
const PERMISSION = {
  name: 'invoices:report_delivered',
  resource: 'invoices',
  action: 'report_delivered',
  scope: 'all',
  description: 'Hiển thị nút "Đã Báo Đơn" (chuyển hóa đơn sang Giao thành công)',
  category: 'Bán hàng',
};

async function main() {
  console.log(
    '🌱 Upsert quyền invoices:report_delivered (chỉ 1 quyền, không ảnh hưởng dữ liệu khác)...',
  );

  const existing = await prisma.permission.findUnique({
    where: { name: PERMISSION.name },
  });

  if (existing) {
    // Đã tồn tại → đảm bảo category đúng (idempotent, không tạo trùng).
    const updated = await prisma.permission.update({
      where: { name: PERMISSION.name },
      data: {
        category: PERMISSION.category,
        description: PERMISSION.description,
      },
    });
    console.log(
      `  ↷ Đã tồn tại quyền "${PERMISSION.name}" (id=${updated.id}). Đã đồng bộ category = "${updated.category}".`,
    );
    return;
  }

  const created = await prisma.permission.create({
    data: {
      name: PERMISSION.name,
      resource: PERMISSION.resource,
      action: PERMISSION.action,
      scope: PERMISSION.scope,
      description: PERMISSION.description,
      category: PERMISSION.category,
    },
  });

  console.log(`  ✅ Đã tạo quyền "${created.name}" (id=${created.id}).`);
  console.log(
    '👉 Hãy gán quyền này cho role mong muốn qua giao diện phân quyền. File này cố ý không tự gán.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((e) => {
    console.error('❌ Lỗi khi thêm quyền invoices:report_delivered:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
