// prisma/seeds/add-transfer-planning-permissions.ts
//
// Mục đích: Thêm (upsert) 2 quyền `transfer_planning:view` và
// `transfer_planning:export` vào bảng `permissions`. File này KHÔNG đụng tới
// dữ liệu nào khác: không xóa, không reset, không gán quyền cho role/user.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy:  yarn seed:transfer-planning-permissions
//
// Sau khi chạy xong, việc GÁN quyền này cho role do bạn tự thực hiện qua giao
// diện phân quyền (file này cố ý KHÔNG tự gán cho bất kỳ role nào).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionSeed {
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}

const PERMISSIONS: PermissionSeed[] = [
  {
    name: 'transfer_planning:view',
    resource: 'transfer_planning',
    action: 'view',
    scope: 'all',
    description: 'Xem bảng dự kiến chuyển kho',
    category: 'Kho',
  },
  {
    name: 'transfer_planning:export',
    resource: 'transfer_planning',
    action: 'export',
    scope: 'all',
    description: 'Xuất Excel bảng dự kiến chuyển kho',
    category: 'Kho',
  },
];

async function main() {
  console.log(
    '🌱 Thêm quyền transfer_planning:view và transfer_planning:export...',
  );

  for (const perm of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: perm.name },
    });

    if (existing) {
      console.log(
        `  ↷ Đã tồn tại quyền "${perm.name}" (id=${existing.id}). Không thay đổi gì.`,
      );
      continue;
    }

    const created = await prisma.permission.create({
      data: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        scope: perm.scope,
        description: perm.description,
        category: perm.category,
      },
    });

    console.log(`  ✅ Đã tạo quyền "${created.name}" (id=${created.id}).`);
  }

  console.log(
    '👉 Hãy gán quyền này cho role mong muốn qua giao diện phân quyền. File này cố ý không tự gán.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((e) => {
    console.error('❌ Lỗi khi thêm quyền transfer_planning:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());