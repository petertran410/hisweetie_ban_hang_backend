// prisma/seeds/add-customers-import-permission.ts
//
// Mục đích: CHỈ thêm (upsert) các quyền `customers:export` và `customers:import`
// vào bảng `permissions`. File này được thiết kế để KHÔNG đụng tới bất kỳ dữ
// liệu nào khác: không xóa, không reset, không gán quyền cho role/user, không
// sửa các quyền khác. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Lý do: trước đây nút "Xuất file" bị gate bằng `customers:view` và nút "Import"
// bị gate bằng `customers:create`, nên không thể cấm riêng 2 thao tác này.
// Nay tách thành quyền độc lập để bật/tắt riêng cho từng role.
//
// Cách chạy:  yarn seed:customers-import-export
//
// Sau khi chạy xong, việc GÁN quyền này cho role do bạn tự thực hiện qua giao
// diện phân quyền (file này cố ý KHÔNG tự gán cho bất kỳ role nào).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
const PERMISSIONS = [
  {
    name: 'customers:export',
    resource: 'customers',
    action: 'export',
    scope: 'all',
    description: 'Xuất file danh sách khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:import',
    resource: 'customers',
    action: 'import',
    scope: 'all',
    description: 'Import khách hàng và phiếu cân bằng nợ từ Excel',
    category: 'Khách hàng',
  },
];

async function main() {
  console.log(
    '🌱 Thêm quyền customers:export, customers:import ' +
      '(chỉ thêm, không xóa, không gán role)...',
  );

  let created = 0;
  let skipped = 0;

  for (const p of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: p.name },
    });

    if (existing) {
      skipped++;
      console.log(
        `  ↷ Đã tồn tại quyền "${p.name}" (id=${existing.id}). Không thay đổi gì.`,
      );
      continue;
    }

    const row = await prisma.permission.create({
      data: {
        name: p.name,
        resource: p.resource,
        action: p.action,
        scope: p.scope,
        description: p.description,
        category: p.category,
      },
    });

    created++;
    console.log(`  ✅ Đã tạo quyền "${row.name}" (id=${row.id}).`);
  }

  console.log(`\n📊 Kết quả: tạo mới ${created}, bỏ qua ${skipped}.`);
  console.log(
    '👉 Hãy gán các quyền này cho role mong muốn qua giao diện phân quyền. ' +
      'File này cố ý không tự gán.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((e) => {
    console.error('❌ Lỗi khi thêm quyền customers import/export:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
