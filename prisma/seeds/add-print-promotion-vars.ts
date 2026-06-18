// prisma/seeds/add-print-promotion-vars.ts
//
// Seed các biến item liên quan khuyến mãi cho bản in, để người dùng có thể
// chèn vào template (tạo cột riêng / nhãn) phân biệt hàng thường - hàng KM - reward.
// An toàn re-run: upsert theo (templateFor, key).
//
// Lưu ý: nhãn mặc định "(KM)/(Quà KM)/(Mua kèm KM)" đã được chèn sẵn vào
// {Ten_Hang_Hoa} ở mapItem nên hiện ngay trên template cũ; các biến dưới đây
// là tùy chọn để hiển thị cột/chi tiết riêng.
//
// Chạy: npm run seed:print-promotion-vars

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// templateFor có danh sách hàng hóa (item) và dùng chung mapItem.
const TEMPLATE_FORS = [
  'invoice',
  'order',
  'consignment',
  'order_supplier',
  'purchase_order',
];

const VARIABLES = [
  {
    key: 'Loai_Dong_KM',
    label: 'Loại dòng KM',
    group: 'Hàng hóa',
    sortOrder: 20,
    isItemVariable: true,
  },
  {
    key: 'La_Hang_KM',
    label: 'Là hàng KM (1/rỗng)',
    group: 'Hàng hóa',
    sortOrder: 21,
    isItemVariable: true,
  },
  {
    key: 'Ma_KM',
    label: 'Mã khuyến mãi',
    group: 'Hàng hóa',
    sortOrder: 22,
    isItemVariable: true,
  },
  {
    key: 'Ten_KM',
    label: 'Tên khuyến mãi',
    group: 'Hàng hóa',
    sortOrder: 23,
    isItemVariable: true,
  },
];

async function main() {
  console.log('🌱 Seeding print promotion item variables...');
  let count = 0;
  for (const templateFor of TEMPLATE_FORS) {
    for (const v of VARIABLES) {
      await prisma.printTemplateVariable.upsert({
        where: { templateFor_key: { templateFor, key: v.key } },
        update: {
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: v.isItemVariable,
        },
        create: {
          templateFor,
          key: v.key,
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: v.isItemVariable,
        },
      });
      count++;
    }
  }
  console.log(`✅ Upserted ${count} biến (${VARIABLES.length} × ${TEMPLATE_FORS.length} templateFor)`);
}

main()
  .catch((e) => {
    console.error('❌ Seed lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
