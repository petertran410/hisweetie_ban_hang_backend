// prisma/seeds/sync-purchase-order-variables.ts
//
// Đồng bộ bộ biến template cho `purchase_order` (phiếu nhập hàng):
//   + Thêm:  Chiet_Khau_Phan_Tram, Chiet_Khau_Tien
//   + Set inactive: Giam_Gia_Don_Gia, Loai_Dong_KM, La_Hang_KM, Ma_KM, Ten_KM
//     (các biến cũ không còn dùng cho phiếu nhập; vẫn giữ record để tránh
//      vỡ template khác nếu có tham chiếu cũ — chỉ isActive=false).
//   + KHÔNG đụng đến templateFor khác (invoice/order/transfer/...).
//
// An toàn re-run: idempotent.
// KHÔNG xóa dữ liệu.
//
// Chạy: yarn seed:print-purchase-order-vars

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPLATE_FOR = 'purchase_order';

// Biến cần thêm / cập nhật active
const ACTIVE_VARS: Array<{
  key: string;
  label: string;
  group: string;
  sortOrder: number;
  isItemVariable: boolean;
  description?: string;
}> = [
  {
    key: 'Chiet_Khau_Phan_Tram',
    label: 'Chiết khấu (%)',
    group: 'Hàng hóa',
    sortOrder: 8,
    isItemVariable: true,
    description: 'Tỷ lệ chiết khấu trên đơn giá',
  },
  {
    key: 'Chiet_Khau_Tien',
    label: 'Tiền chiết khấu',
    group: 'Hàng hóa',
    sortOrder: 9,
    isItemVariable: true,
    description: 'Số tiền chiết khấu trên đơn giá',
  },
];

// Biến cũ cần tắt (set isActive=false) — không xóa để tránh vỡ FK
const INACTIVE_KEYS = [
  'Giam_Gia_Don_Gia', // trùng ý nghĩa với Don_Gia_Sau_Chiet_Khau
  'Loai_Dong_KM',
  'La_Hang_KM',
  'Ma_KM',
  'Ten_KM',
];

async function main() {
  console.log(`🌱 Đồng bộ biến template cho "${TEMPLATE_FOR}"...`);

  let upserted = 0;
  for (const v of ACTIVE_VARS) {
    await prisma.printTemplateVariable.upsert({
      where: {
        templateFor_key: { templateFor: TEMPLATE_FOR, key: v.key },
      },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: v.isItemVariable,
        isActive: true,
        description: v.description,
      },
      create: {
        templateFor: TEMPLATE_FOR,
        key: v.key,
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: v.isItemVariable,
        description: v.description,
      },
    });
    upserted++;
  }

  let deactivated = 0;
  for (const key of INACTIVE_KEYS) {
    const result = await prisma.printTemplateVariable.updateMany({
      where: { templateFor: TEMPLATE_FOR, key },
      data: { isActive: false },
    });
    deactivated += result.count;
  }

  console.log(
    `✅ Upsert active: ${upserted} biến | Deactivate: ${deactivated} biến cũ`,
  );
}

main()
  .catch((e) => {
    console.error('❌ Seed lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
