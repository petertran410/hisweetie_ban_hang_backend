/**
 * Backfill thẻ kho chiều NHẬN cho các phiếu chuyển hàng cũ.
 *
 * Bối cảnh: trước khi sửa `incrementInventoryToBranch`, khi chi nhánh nhận bấm
 * "Nhận hàng" (Transfer.status = 3) hệ thống chỉ cộng `onHand` mà KHÔNG ghi
 * InventoryLog `TRANSFER_IN`. Hậu quả: thẻ kho ở chi nhánh nhận của các phiếu
 * đã nhận trước deploy bị trống chiều cộng (chỉ có dòng trừ ở chi nhánh chuyển).
 *
 * Script này quét mọi Transfer đang ở trạng thái ĐÃ NHẬN (status = 3) và tạo bù
 * log `TRANSFER_IN` với:
 *   - branchId   = toBranchId        (chi nhánh nhận)
 *   - quantity   = +receivedQuantity (cộng đúng số nhận thực tế, có thể khác số
 *                                     chuyển đi)
 *   - costPrice  = giá vốn hiện tại của tồn kho ở chi nhánh nhận (xấp xỉ tốt
 *                  nhất cho dữ liệu lịch sử — không lưu lại cost tại thời điểm
 *                  nhận trong quá khứ)
 *   - createdAt  = receivedDate (fallback updatedAt → createdAt) để dòng nằm
 *                  đúng mốc thời gian trên timeline thẻ kho.
 *
 * IDEMPOTENT: với mỗi (transfer, product, toBranch) nếu ĐÃ có bất kỳ log
 * `TRANSFER_IN` nào thì bỏ qua. Nhờ vậy:
 *   - Chạy lại nhiều lần không tạo trùng.
 *   - Tự động bỏ qua các phiếu được nhận SAU deploy (đã có log từ logic mới).
 *
 * Bỏ qua:
 *   - Transfer.status != 3 (chưa nhận / đã hủy).
 *   - Transfer.receivedDate < mốc 1/6/2026 (00:00 giờ VN, UTC+7) — chỉ backfill
 *     các phiếu nhận từ 1/6 trở đi.
 *   - detail.receivedQuantity <= 0.
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/backfill-transfer-in-logs.ts            # chạy thật
 *   yarn ts-node prisma/seeds/backfill-transfer-in-logs.ts --dry-run  # chỉ in
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Chỉ backfill các phiếu có receivedDate >= 00:00 ngày 1/6/2026 giờ VN (UTC+7).
// 00:00 1/6 VN = 17:00 31/5 UTC.
const FROM_DATE = new Date('2026-05-31T17:00:00.000Z');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Backfill InventoryLog TRANSFER_IN cho phiếu chuyển đã nhận');
  console.log(`  Mode: ${dryRun ? '[DRY-RUN]' : '[REAL RUN]'}`);
  console.log(`  Chỉ phiếu nhận từ: ${FROM_DATE.toISOString()} (00:00 1/6 giờ VN)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Lấy mọi phiếu ĐÃ NHẬN (status = 3) có receivedDate từ mốc 1/6 trở đi.
  const transfers = await prisma.transfer.findMany({
    where: {
      status: 3,
      receivedDate: { gte: FROM_DATE },
    },
    include: {
      details: true,
      toBranch: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`  Tìm thấy ${transfers.length} phiếu chuyển đã nhận (status=3) từ 1/6 trở đi\n`);

  let created = 0;
  let skippedExisting = 0;
  let skippedZeroQty = 0;
  let transfersTouched = 0;

  for (const transfer of transfers) {
    let touchedThisTransfer = false;

    for (const detail of transfer.details) {
      // Bỏ qua dòng không nhận gì.
      if (Number(detail.receivedQuantity) <= 0) {
        skippedZeroQty++;
        continue;
      }

      // IDEMPOTENT: đã có log TRANSFER_IN cho (transfer, product, chi nhánh nhận)?
      const existing = await prisma.inventoryLog.findFirst({
        where: {
          transactionType: 'TRANSFER_IN',
          refType: 'transfer',
          refId: transfer.id,
          productId: detail.productId,
          branchId: transfer.toBranchId,
        },
        select: { id: true },
      });

      if (existing) {
        skippedExisting++;
        continue;
      }

      // Giá vốn hiện tại ở chi nhánh nhận (best-effort cho dữ liệu lịch sử).
      const inventory = await prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
        select: { cost: true },
      });

      const logCreatedAt =
        transfer.receivedDate || transfer.updatedAt || transfer.createdAt;

      if (dryRun) {
        console.log(
          `  [DRY] ${transfer.code} · ${detail.productCode} · ` +
            `+${Number(detail.receivedQuantity)} @ ${transfer.toBranch?.name || transfer.toBranchName} ` +
            `(${new Date(logCreatedAt).toISOString()})`,
        );
      } else {
        await prisma.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.toBranchId,
            branchName: transfer.toBranch?.name || transfer.toBranchName || '',
            transactionType: 'TRANSFER_IN',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: Number(detail.receivedQuantity),
            costPrice: inventory ? Number(inventory.cost) : 0,
            transactionPrice: null,
            partnerName: null,
            note: 'Backfill TRANSFER_IN',
            createdAt: logCreatedAt,
          },
        });
      }

      created++;
      touchedThisTransfer = true;
    }

    if (touchedThisTransfer) transfersTouched++;
  }

  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(`Hoàn tất ${dryRun ? '[DRY-RUN]' : ''}.`);
  console.log(`  Log TRANSFER_IN ${dryRun ? 'sẽ tạo' : 'đã tạo'}: ${created}`);
  console.log(`  Phiếu được bù log: ${transfersTouched}`);
  console.log(`  Bỏ qua (đã có log): ${skippedExisting}`);
  console.log(`  Bỏ qua (số nhận = 0): ${skippedZeroQty}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
