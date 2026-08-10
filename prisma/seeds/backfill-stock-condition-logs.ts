// prisma/seeds/backfill-stock-condition-logs.ts
//
// Mục đích: NẠP dữ liệu tồn 3 bucket hiện có trên Inventory
// (damagedQuantity / nearExpiryQuantity / promoQuantity — đang là con số bị
// ghi đè bởi cơ chế cũ KLB/KKM) vào SỔ CÁI StockConditionLog dưới dạng dòng
// "OPENING" (mở sổ), để sau khi chuyển sang mô hình dẫn xuất, tồn loại KHÔNG
// bị mất.
//
// AN TOÀN:
//   - KHÔNG xóa, KHÔNG reset, KHÔNG sửa cột Inventory.
//   - CHỈ tạo dòng StockConditionLog loại OPENING cho các bucket đang > 0.
//   - Idempotent: nếu đã có dòng OPENING cho (product, branch, bucket) thì bỏ qua.
//   - Cận date cũ không có hạn dùng → expiryDate = null (lô "chưa xác định").
//
// Chạy SAU khi đã đồng bộ schema (có bảng stock_condition_logs) và TRƯỚC khi
// bắt đầu dùng phiếu CLT / bán hàng theo lô.
//
// Cách chạy:  npx ts-node prisma/seeds/backfill-stock-condition-logs.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const OPENING_DATE = new Date('2000-01-01T00:00:00.000Z'); // mở sổ sớm nhất

async function backfillBucket(
  inv: {
    productId: number;
    productCode: string;
    productName: string;
    branchId: number;
    branchName: string;
    cost: any;
  },
  bucket: 'DAMAGED' | 'NEAR_EXPIRY' | 'PROMO',
  quantity: number,
): Promise<boolean> {
  if (!quantity || quantity === 0) return false;

  const existing = await prisma.stockConditionLog.findFirst({
    where: {
      productId: inv.productId,
      branchId: inv.branchId,
      bucket,
      transactionType: 'OPENING',
    },
    select: { id: true },
  });
  if (existing) return false; // đã backfill trước đó

  await prisma.stockConditionLog.create({
    data: {
      productId: inv.productId,
      productCode: inv.productCode,
      productName: inv.productName,
      branchId: inv.branchId,
      branchName: inv.branchName,
      bucket,
      transactionType: 'OPENING',
      refCode: 'OPENING',
      refType: 'opening',
      refId: 0,
      quantity,
      expiryDate: null,
      costPrice: Number(inv.cost) || 0,
      transactionDate: OPENING_DATE,
      note: 'Mở sổ loại tồn từ dữ liệu cũ',
      createdByName: 'System (backfill)',
    },
  });
  return true;
}

async function main() {
  console.log(
    '🌱 Backfill sổ cái loại tồn từ Inventory (OPENING). Không sửa Inventory, idempotent...',
  );

  const inventories = await prisma.inventory.findMany({
    where: {
      OR: [
        { damagedQuantity: { gt: 0 } },
        { nearExpiryQuantity: { gt: 0 } },
        { promoQuantity: { not: 0 } },
      ],
    },
    select: {
      productId: true,
      productCode: true,
      productName: true,
      branchId: true,
      branchName: true,
      cost: true,
      damagedQuantity: true,
      nearExpiryQuantity: true,
      promoQuantity: true,
    },
  });

  let rows = 0;
  for (const inv of inventories) {
    if (await backfillBucket(inv, 'DAMAGED', Number(inv.damagedQuantity))) rows++;
    if (
      await backfillBucket(inv, 'NEAR_EXPIRY', Number(inv.nearExpiryQuantity))
    )
      rows++;
    if (await backfillBucket(inv, 'PROMO', Number(inv.promoQuantity))) rows++;
  }

  console.log(
    `📊 Hoàn tất: quét ${inventories.length} dòng tồn có phân loại, tạo ${rows} dòng OPENING.`,
  );
  console.log(
    '👉 Kiểm tra thẻ kho loại tồn của vài sản phẩm để xác nhận tồn khớp trước khi vận hành.',
  );
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi backfill stock condition logs:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
