// prisma/seeds/fix-export-permission-categories.ts
//
// Mục đích: SỬA (UPDATE) đúng cột `category` của các quyền `*:export` bị lệch
// nhóm trên màn phân quyền, để chúng nằm CHUNG box với các quyền anh em cùng
// resource. Grouping trên UI = (category ở khung ngoài) + (resource ở khung
// trong); một quyền chỉ về đúng box khi category của nó trùng category của các
// quyền cùng resource.
//
// File này CHỈ chạy UPDATE cột `category` của đúng các quyền action='export'
// liệt kê bên dưới. TUYỆT ĐỐI KHÔNG: xóa, reset, tạo mới, gán/huỷ quyền cho
// role/user, hay đụng bất kỳ quyền nào khác. Chạy lại nhiều lần vẫn an toàn
// (idempotent) — dòng nào đã đúng category thì bỏ qua.
//
// Cách chạy:
//   yarn seed:fix-export-categories            (thực thi)
//   yarn seed:fix-export-categories --dry-run  (chỉ xem, không ghi)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

// resource của quyền export  ->  category đích (đã chốt với người dùng).
// Đây là category của các quyền gốc cùng resource.
const TARGET_CATEGORY: Record<string, string> = {
  purchase_orders: 'Nhà cung cấp',
  order_suppliers: 'Nhà cung cấp',
  supplier_returns: 'Nhà cung cấp',
  destructions: 'Kho',
  transfers: 'Kho',
  inventory_checks: 'Kho',
  productions: 'Kho',
  stock_audits: 'Kho',
  return_orders: 'Bán hàng',
};

async function main() {
  console.log(
    `🔧 Sửa category cho các quyền *:export${DRY_RUN ? ' [DRY-RUN: không ghi]' : ''}...`,
  );

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const [resource, targetCategory] of Object.entries(TARGET_CATEGORY)) {
    const perm = await prisma.permission.findFirst({
      where: { resource, action: 'export' },
      select: { id: true, name: true, category: true },
    });

    if (!perm) {
      console.log(`  ⚠️  Không tìm thấy quyền "${resource}:export" — bỏ qua.`);
      missing++;
      continue;
    }

    if (perm.category === targetCategory) {
      console.log(
        `  ↷ "${perm.name}" đã đúng category "${targetCategory}" — không đổi.`,
      );
      skipped++;
      continue;
    }

    console.log(
      `  ${DRY_RUN ? '•' : '✅'} "${perm.name}": "${perm.category}" → "${targetCategory}"`,
    );

    if (!DRY_RUN) {
      // Ghi có điều kiện: chỉ update đúng 1 dòng theo id + action='export'.
      await prisma.permission.updateMany({
        where: { id: perm.id, action: 'export' },
        data: { category: targetCategory },
      });
      updated++;
    }
  }

  console.log(
    `\n📊 Tổng kết: ${DRY_RUN ? 'sẽ đổi' : 'đã đổi'} ${DRY_RUN ? (Object.keys(TARGET_CATEGORY).length - skipped - missing) : updated}, giữ nguyên ${skipped}, thiếu ${missing}.`,
  );
  if (DRY_RUN) console.log('ℹ️  DRY-RUN: chưa ghi gì vào DB.');
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi khi sửa category quyền export:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
