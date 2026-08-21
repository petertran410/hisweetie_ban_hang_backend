// prisma/seeds/backfill-invoice-delivered-at.ts
//
// Điền `invoices.delivered_at` cho dữ liệu cũ = thời điểm phiếu GIAO HÀNG
// SỚM NHẤT còn hiệu lực (cancelled_at IS NULL) gắn với hóa đơn đó.
//
// AN TOÀN:
//   - CHỈ ghi đúng một cột `delivered_at`. Không đụng cột nào khác.
//   - Chỉ ghi khi giá trị hiện tại khác giá trị đúng (idempotent, chạy lại vô hại).
//   - Bỏ qua hóa đơn đã hủy (status = 2).
//   - Không xóa, không reset bất cứ thứ gì.
//
// Chạy: npx ts-node prisma/seeds/backfill-invoice-delivered-at.ts
// Xem trước không ghi: thêm biến môi trường DRY_RUN=1

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';

async function main() {
  console.log(
    `🌱 Backfill invoices.delivered_at${DRY_RUN ? ' (DRY RUN — không ghi)' : ''}`,
  );

  // Mốc đúng của từng hóa đơn: phiếu giao chưa hủy sớm nhất.
  const rows = await prisma.$queryRaw<
    Array<{ invoiceId: number; firstDelivered: Date }>
  >`
    SELECT psi."invoiceId"          AS "invoiceId",
           MIN(ps."createdAt")      AS "firstDelivered"
    FROM packing_slip_invoices psi
    JOIN packing_slips ps ON ps.id = psi."packingSlipId"
    WHERE psi."invoiceId" IS NOT NULL
      AND ps."cancelledAt" IS NULL
    GROUP BY psi."invoiceId"
  `;

  console.log(`   Tìm thấy ${rows.length} hóa đơn có phiếu giao còn hiệu lực`);

  if (rows.length === 0) {
    console.log('   Không có gì để làm.');
    return;
  }

  const invoiceIds = rows.map((r) => r.invoiceId);
  const current = await prisma.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, code: true, status: true, deliveredAt: true },
  });
  const currentMap = new Map(current.map((c) => [c.id, c]));

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const inv = currentMap.get(row.invoiceId);
    if (!inv) continue;

    // Hóa đơn đã hủy thì không can thiệp.
    if (inv.status === 2) {
      skipped++;
      continue;
    }

    const target = row.firstDelivered;
    if (inv.deliveredAt && inv.deliveredAt.getTime() === target.getTime()) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `   [DRY] ${inv.code}: ${inv.deliveredAt?.toISOString() ?? 'null'} → ${target.toISOString()}`,
      );
    } else {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { deliveredAt: target },
      });
    }
    updated++;
  }

  console.log(
    `✅ Xong — ${updated} hóa đơn ${DRY_RUN ? 'sẽ được' : 'đã'} cập nhật, ${skipped} bỏ qua (đã đúng hoặc đã hủy).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
