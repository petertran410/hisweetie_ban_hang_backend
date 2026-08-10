// prisma/seeds/recalc-condition-buckets.ts
//
// Mục đích: ĐỒNG BỘ LẠI cache 3 bucket (damagedQuantity / nearExpiryQuantity /
// promoQuantity) trên Inventory từ SỔ CÁI StockConditionLog (nguồn chân lý).
//
// Vì sao cần: trước bản vá thứ tự trong approve(), phiếu CLT được recalc khi
// vẫn còn status = 1 (Chờ duyệt) nên active-finder 'clt' loại chính log vừa
// ghi → cache bị thiếu phần đã duyệt (vd cận date sổ cái = 29 nhưng cache = 25).
// Script này tính lại cache = Σ log CÒN HIỆU LỰC cho mọi cặp (product, branch)
// có phát sinh StockConditionLog, khớp tuyệt đối với tab "Thẻ kho loại tồn".
//
// AN TOÀN:
//   - CHỈ đọc StockConditionLog + ghi 3 cột cache trên Inventory.
//   - KHÔNG đụng onHand, KHÔNG xóa/thêm log, KHÔNG sửa phiếu.
//   - Idempotent: chạy lại nhiều lần cho cùng kết quả.
//
// Cách chạy:  npx ts-node prisma/seeds/recalc-condition-buckets.ts

import { PrismaClient } from '@prisma/client';
import { recalcConditionBuckets } from '../../src/common/stock-condition-onhand.util';

const prisma = new PrismaClient();

async function main() {
  // Tất cả cặp (productId, branchId) có ít nhất 1 dòng sổ cái loại tồn.
  const pairs = await prisma.stockConditionLog.findMany({
    distinct: ['productId', 'branchId'],
    select: { productId: true, branchId: true },
  });

  console.log(`Tìm thấy ${pairs.length} cặp (product, branch) cần đồng bộ.`);

  let changed = 0;
  for (const { productId, branchId } of pairs) {
    const before = await prisma.inventory.findUnique({
      where: { productId_branchId: { productId, branchId } },
      select: {
        damagedQuantity: true,
        nearExpiryQuantity: true,
        promoQuantity: true,
      },
    });
    if (!before) continue;

    const totals = await recalcConditionBuckets(prisma, productId, branchId);

    const b = {
      d: Number(before.damagedQuantity),
      n: Number(before.nearExpiryQuantity),
      p: Number(before.promoQuantity),
    };
    if (b.d !== totals.damaged || b.n !== totals.nearExpiry || b.p !== totals.promo) {
      changed += 1;
      console.log(
        `  [product ${productId} / branch ${branchId}] ` +
          `damaged ${b.d}->${totals.damaged}, ` +
          `nearExpiry ${b.n}->${totals.nearExpiry}, ` +
          `promo ${b.p}->${totals.promo}`,
      );
    }
  }

  console.log(`Hoàn tất. Đã cập nhật ${changed} bản ghi cache lệch.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
