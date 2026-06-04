/**
 * Backfill `InventoryLog.transactionDate` = `createdAt` cho dữ liệu cũ.
 *
 * Bối cảnh: thêm field `transactionDate` vào InventoryLog để hỗ trợ kiểm kho
 * lùi ngày (backdated) và tính cột "Tồn cuối" trên thẻ kho theo đúng mốc thời
 * gian giao dịch. Khi chạy `prisma db push`, field mới có `@default(now())`
 * nên MỌI dòng cũ sẽ bị set transactionDate = thời điểm push (sai timeline).
 *
 * Script này set lại `transactionDate = createdAt` cho mọi log mà 2 giá trị
 * lệch nhau đáng kể (>1 phút) — tức các dòng cũ chưa từng có transactionDate
 * đúng. Log mới (ghi sau khi deploy logic mới) đã có transactionDate chuẩn nên
 * createdAt ≈ transactionDate → bỏ qua, an toàn khi chạy lại nhiều lần.
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/backfill-inventory-log-transaction-date.ts
 *   yarn ts-node prisma/seeds/backfill-inventory-log-transaction-date.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Set transactionDate = createdAt cho mọi dòng lệch > 60 giây.
  // Dùng raw SQL để update theo batch, nhanh và không kéo toàn bộ vào RAM.
  if (dryRun) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM inventory_logs
      WHERE ABS(EXTRACT(EPOCH FROM ("transactionDate" - "createdAt"))) > 60
    `;
    const count = Number(rows[0]?.count ?? 0);
    console.log(`[DRY-RUN] Sẽ cập nhật ${count} dòng inventory_logs.`);
    return;
  }

  const result = await prisma.$executeRaw`
    UPDATE inventory_logs
    SET "transactionDate" = "createdAt"
    WHERE ABS(EXTRACT(EPOCH FROM ("transactionDate" - "createdAt"))) > 60
  `;
  console.log(`Đã cập nhật transactionDate cho ${result} dòng inventory_logs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
