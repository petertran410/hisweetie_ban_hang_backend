/**
 * MIG-A: Fix isReceipt sai dấu cho cashFlow code "PDNPC*"
 *
 * Bối cảnh:
 *   `order-suppliers.service.ts` `create` (block tạo OrderSupplier kèm
 *   paymentAmount > 0) trước đây ghi cashFlow với `isReceipt: true` thay vì
 *   `isReceipt: false`. Mục đích thực sự là phiếu CHI (mình chi tiền cho NCC để
 *   ứng trước đặt hàng nhập), nên phải `isReceipt: false`.
 *
 *   Bug đã được fix trong code (FIX-1). Script này dọn dữ liệu lịch sử.
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/fix-pdnpc-isreceipt.ts
 *
 * An toàn:
 *   - Chỉ động vào cashFlow có code startsWith 'PDNPC' VÀ partnerType='S'
 *   - Chỉ flip những row đang isReceipt=true (sai)
 *   - In ra danh sách trước khi update để verify
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const wrongRows = await prisma.cashFlow.findMany({
    where: {
      code: { startsWith: 'PDNPC' },
      partnerType: 'S',
      isReceipt: true,
    },
    select: {
      id: true,
      code: true,
      amount: true,
      partnerName: true,
      transDate: true,
    },
    orderBy: { transDate: 'asc' },
  });

  console.log(`Tìm thấy ${wrongRows.length} cashFlow sai dấu (PDNPC*, isReceipt=true).`);

  if (wrongRows.length === 0) {
    console.log('Không có gì để fix. Thoát.');
    return;
  }

  for (const row of wrongRows) {
    console.log(
      `  ${row.code}  ${row.partnerName ?? '(no name)'}  amount=${row.amount}  transDate=${row.transDate?.toISOString().slice(0, 10)}`,
    );
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('\n--dry-run: KHÔNG update DB. Bỏ flag để chạy thật.');
    return;
  }

  const result = await prisma.cashFlow.updateMany({
    where: {
      code: { startsWith: 'PDNPC' },
      partnerType: 'S',
      isReceipt: true,
    },
    data: { isReceipt: false },
  });

  console.log(`\n✓ Đã update ${result.count} row → isReceipt=false`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
