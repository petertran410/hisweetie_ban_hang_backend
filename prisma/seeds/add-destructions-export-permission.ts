// prisma/seeds/add-destructions-export-permission.ts
//
// Mục đích: CHỈ thêm (upsert) đúng MỘT quyền `destructions:export` vào bảng
// `permissions`. File này được thiết kế để KHÔNG đụng tới bất kỳ dữ liệu nào
// khác: không xóa, không reset, không gán quyền cho role/user, không sửa các
// quyền khác. Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy:  yarn seed:destructions-export
//
// Sau khi chạy xong, việc GÁN quyền này cho role do bạn tự thực hiện qua giao
// diện phân quyền (file này cố ý KHÔNG tự gán cho bất kỳ role nào).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Trùng cấu trúc với @@unique([resource, action, scope, field]) trên model Permission.
const PERMISSION = {
  name: 'destructions:export',
  resource: 'destructions',
  action: 'export',
  scope: 'all',
  description: 'Xuất file xuất hủy',
  category: 'Xuất hủy',
};

async function main() {
  console.log(
    '🌱 Thêm quyền destructions:export (chỉ 1 quyền, không ảnh hưởng dữ liệu khác)...',
  );

  const existing = await prisma.permission.findUnique({
    where: { name: PERMISSION.name },
  });

  if (existing) {
    console.log(
      `  ↷ Đã tồn tại quyền "${PERMISSION.name}" (id=${existing.id}). Không thay đổi gì.`,
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
    console.error('❌ Lỗi khi thêm quyền destructions:export:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
