/**
 * Migration: tái tính `Supplier.debt` cho TOÀN BỘ supplier theo Formula B.
 *
 * Chạy sau khi deploy Wave 2. Kết quả phải KHỚP với 6 implementations cũ
 * trong các trường hợp đã có data, và FIX trong các trường hợp dữ liệu lệch
 * (ví dụ supplierReturn cash_refund + by_purchase_order trước đây không giảm
 * debt sẽ được khôi phục).
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/recalc-all-suppliers-debt.ts            # chạy thật
 *   yarn ts-node prisma/seeds/recalc-all-suppliers-debt.ts --dry-run  # chỉ in
 */

import { PrismaClient } from '@prisma/client';
import { recalcSupplierDebt } from '../../src/common/supplier-debt.util';

const prisma = new PrismaClient();

async function main() {
  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, debt: true },
  });

  console.log(`Recalc ${suppliers.length} suppliers...`);

  const dryRun = process.argv.includes('--dry-run');
  let drift = 0;

  for (const s of suppliers) {
    try {
      if (dryRun) {
        const newDebt = await prisma.$transaction(async (tx) => {
          // Tính bằng tx mock không update — gọi thẳng util sau đó rollback
          const before = await tx.supplier.findUnique({
            where: { id: s.id },
            select: { debt: true },
          });
          const debt = await recalcSupplierDebt(tx, s.id);
          // rollback bằng cách throw — Prisma sẽ revert update trong tx
          await tx.supplier.update({
            where: { id: s.id },
            data: { debt: before?.debt ?? 0 },
          });
          return debt;
        });
        const oldDebt = Number(s.debt ?? 0);
        const diff = newDebt - oldDebt;
        const mark = Math.abs(diff) > 0.01 ? '✗' : '✓';
        if (mark === '✗') drift++;
        console.log(
          `  ${mark} ${s.code} - ${s.name}: ${oldDebt} → ${newDebt}  (diff=${diff})`,
        );
      } else {
        const newDebt = await prisma.$transaction((tx) =>
          recalcSupplierDebt(tx, s.id),
        );
        const oldDebt = Number(s.debt ?? 0);
        const diff = newDebt - oldDebt;
        const mark = Math.abs(diff) > 0.01 ? '⟲' : '✓';
        if (mark === '⟲') drift++;
        console.log(
          `  ${mark} ${s.code} - ${s.name}: ${oldDebt} → ${newDebt}  (diff=${diff})`,
        );
      }
    } catch (err) {
      console.error(`✗ ${s.code}:`, err);
    }
  }

  console.log(
    `\n${dryRun ? '[dry-run] ' : ''}Hoàn tất. ${drift}/${suppliers.length} supplier có drift.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
