// prisma/seeds/add-old-delivery-address-print-vars.ts
//
// Đăng ký biến in địa chỉ hành chính cũ (trước sáp nhập) của địa chỉ giao hàng
// để chọn được trong trình soạn mẫu in. Giá trị do print-templates.service
// (deliveryVars) tính. Chỉ upsert biến, không sửa mẫu in. Chạy lại an toàn.
//
// Cách chạy:  yarn seed:print-old-address-vars

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPLATE_FORS = ['delivery', 'invoice', 'order', 'warehouse_export'];

const VARIABLES = [
  {
    key: 'Dia_Chi_Cu_Giao_Hang',
    label: 'Địa chỉ cũ (phường/xã, quận/huyện, tỉnh cũ)',
    sortOrder: 8,
  },
  {
    key: 'Dong_Dia_Chi_Cu_Giao_Hang',
    label: 'Dòng địa chỉ cũ (tự ẩn khi không có)',
    sortOrder: 9,
  },
];

async function main() {
  for (const templateFor of TEMPLATE_FORS) {
    for (const v of VARIABLES) {
      await prisma.printTemplateVariable.upsert({
        where: { templateFor_key: { templateFor, key: v.key } },
        update: { label: v.label, group: 'Giao hàng', isActive: true },
        create: { ...v, templateFor, group: 'Giao hàng' },
      });
    }
    console.log(`  ✅ ${templateFor}: ${VARIABLES.length} biến`);
  }
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
