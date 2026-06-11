/**
 * Backfill `InventoryLog.transactionDate` = `purchase_orders.purchaseDate`
 * cho các log PURCHASE cũ.
 *
 * Bối cảnh: `updateInventory()` của phiếu nhập trước đây tạo InventoryLog mà
 * KHÔNG set `transactionDate` → Prisma dùng `@default(now())`. Mỗi lần sửa/nhận
 * lại phiếu, log PURCHASE bị xóa và tạo mới với thời điểm hiện tại, nên thẻ kho
 * hiển thị sai timeline (vd PN003528 nhảy lên ngày sửa thay vì ngày nhập gốc).
 *
 * Script này set lại `transactionDate = purchaseDate` cho mọi log PURCHASE còn
 * lệch so với ngày nhập của phiếu (> 60 giây). An toàn khi chạy lại nhiều lần —
 * các log đã đúng (chênh ≤ 60s) sẽ được bỏ qua.
 *
 * KHÔNG đụng tới `createdAt` (giữ nguyên dấu vết thời điểm ghi sổ thực tế).
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/backfill-purchase-log-transaction-date.ts
 *   yarn ts-node prisma/seeds/backfill-purchase-log-transaction-date.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM inventory_logs il
      JOIN purchase_orders po ON po.id = il."refId"
      WHERE il."refType" = 'purchase_order'
        AND il."transactionType" = 'PURCHASE'
        AND ABS(EXTRACT(EPOCH FROM (il."transactionDate" - po."purchaseDate"))) > 60
    `;
    const count = Number(rows[0]?.count ?? 0);
    console.log(`[DRY-RUN] Sẽ cập nhật ${count} dòng inventory_logs (PURCHASE).`);
    return;
  }

  const result = await prisma.$executeRaw`
    UPDATE inventory_logs il
    SET "transactionDate" = po."purchaseDate"
    FROM purchase_orders po
    WHERE po.id = il."refId"
      AND il."refType" = 'purchase_order'
      AND il."transactionType" = 'PURCHASE'
      AND ABS(EXTRACT(EPOCH FROM (il."transactionDate" - po."purchaseDate"))) > 60
  `;
  console.log(
    `Đã cập nhật transactionDate = purchaseDate cho ${result} dòng inventory_logs (PURCHASE).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
