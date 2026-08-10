// prisma/seeds/add-old-address-print-variables.ts
//
// Đăng ký biến địa chỉ CŨ (3 cấp) cho các mẫu in có giao hàng, để nhân viên giao
// hàng có thể đối chiếu địa chỉ cũ bên cạnh địa chỉ mới.
//
// Biến thêm (cho mỗi templateFor dưới đây):
//   - Phuong_Xa_Cu_Khach_Hang     (phường/xã cũ — khách hàng)
//   - Quan_Huyen_Cu_Khach_Hang    (quận/huyện cũ — khách hàng)
//   - Tinh_Thanh_Cu_Khach_Hang    (tỉnh/thành cũ — khách hàng)
//   - Phuong_Xa_Cu_Giao_Hang      (phường/xã cũ — giao hàng)
//   - Quan_Huyen_Cu_Giao_Hang     (quận/huyện cũ — giao hàng)
//   - Tinh_Thanh_Cu_Giao_Hang     (tỉnh/thành cũ — giao hàng)
//
// An toàn re-run: upsert theo (templateFor, key). KHÔNG xóa biến/template hiện có.
//
// CHÚ Ý: Theo ràng buộc trong AGENTS.md, KHÔNG tự chạy seed. Người dùng tự chạy:
//   npx ts-node prisma/seeds/add-old-address-print-variables.ts
// (hoặc: yarn ts-node prisma/seeds/add-old-address-print-variables.ts)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Các templateFor có thông tin giao hàng (customerVars + deliveryVars).
const TEMPLATE_FOR_LIST = [
  'order',
  'invoice',
  'consignment',
  'order_delivery',
  'invoice_delivery',
];

// 6 biến địa chỉ cũ (3 cấp) — 3 cho khách hàng, 3 cho giao hàng.
const OLD_ADDRESS_VARIABLES: {
  key: string;
  label: string;
  group: string;
  sortOrder: number;
}[] = [
  {
    key: 'Phuong_Xa_Cu_Khach_Hang',
    label: 'Phường/Xã cũ (khách hàng)',
    group: 'Khách hàng',
    sortOrder: 90,
  },
  {
    key: 'Quan_Huyen_Cu_Khach_Hang',
    label: 'Quận/Huyện cũ (khách hàng)',
    group: 'Khách hàng',
    sortOrder: 91,
  },
  {
    key: 'Tinh_Thanh_Cu_Khach_Hang',
    label: 'Tỉnh/Thành cũ (khách hàng)',
    group: 'Khách hàng',
    sortOrder: 92,
  },
  {
    key: 'Phuong_Xa_Cu_Giao_Hang',
    label: 'Phường/Xã cũ (giao hàng)',
    group: 'Giao hàng',
    sortOrder: 90,
  },
  {
    key: 'Quan_Huyen_Cu_Giao_Hang',
    label: 'Quận/Huyện cũ (giao hàng)',
    group: 'Giao hàng',
    sortOrder: 91,
  },
  {
    key: 'Tinh_Thanh_Cu_Giao_Hang',
    label: 'Tỉnh/Thành cũ (giao hàng)',
    group: 'Giao hàng',
    sortOrder: 92,
  },
];

async function main() {
  console.log('🌱 Đăng ký biến địa chỉ cũ (3 cấp) cho mẫu in giao hàng...');

  let count = 0;
  for (const templateFor of TEMPLATE_FOR_LIST) {
    for (const v of OLD_ADDRESS_VARIABLES) {
      await prisma.printTemplateVariable.upsert({
        where: {
          templateFor_key: { templateFor, key: v.key },
        },
        update: {
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: false,
          isActive: true,
        },
        create: {
          templateFor,
          key: v.key,
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: false,
          isActive: true,
        },
      });
      count++;
    }
  }

  console.log(
    `  ✅ Upserted ${count} biến địa chỉ cũ (${OLD_ADDRESS_VARIABLES.length} biến × ${TEMPLATE_FOR_LIST.length} templateFor)`,
  );
  console.log(
    '  ℹ️  Để dùng trong phiếu in, mở editor template và thêm {Phuong_Xa_Cu_Giao_Hang}, {Quan_Huyen_Cu_Giao_Hang}, {Tinh_Thanh_Cu_Giao_Hang} vào nội dung template.',
  );
}

main()
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
