/**
 * Backfill `inventory_daily_snapshot` bằng cách replay ngược `InventoryLog`.
 *
 * Ý tưởng: tồn kho hiện tại là điểm mốc đã biết chắc. Đi ngược thời gian và
 * hoàn tác từng ngày giao dịch sẽ dựng lại được tồn cuối mỗi ngày trong quá
 * khứ:
 *
 *     onHand(cuối ngày d-1) = onHand(cuối ngày d) − Σ quantity(các log ngày d)
 *
 * Quy ước dấu: `InventoryLog.quantity` đã mang dấu theo chiều tác động lên
 * tồn (nhập dương, xuất âm), nên chỉ cần trừ đi tổng của ngày.
 *
 * An toàn:
 * - CHỈ ghi vào bảng `inventory_daily_snapshot`. Không đụng `inventories`,
 *   không đụng `inventory_logs`.
 * - Idempotent nhờ unique `(productId, branchId, date)` — chạy lại ghi đè
 *   bằng giá trị tính mới, không nhân đôi dòng.
 * - Mặc định là chế độ xem trước; phải có `--apply` mới ghi.
 *
 * Hạn chế cần biết:
 * - Độ chính xác phụ thuộc tính đầy đủ của `InventoryLog`. Nếu có điều chỉnh
 *   tồn không sinh log, số quá khứ sẽ lệch dần khi đi càng xa.
 * - Chỉ xử lý các chi nhánh đang active (planning nhìn toàn bộ mạng lưới).
 *   `isPurchasingHub` chỉ xác định chi nhánh gốc nhận hàng sau thông quan.
 *
 * Dùng:
 *   npx ts-node prisma/scripts/backfill-inventory-snapshot.ts                 # xem trước 180 ngày
 *   npx ts-node prisma/scripts/backfill-inventory-snapshot.ts --days=90       # đổi phạm vi
 *   npx ts-node prisma/scripts/backfill-inventory-snapshot.ts --apply         # ghi thật
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const WRITE_CHUNK = 1000;

/** Quy một mốc thời gian về ngày theo giờ VN (Date ở UTC midnight). */
function toVnDate(value: Date): Date {
  const vn = new Date(value.getTime() + VN_OFFSET_MS);
  return new Date(
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()),
  );
}

function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseArgNumber(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const days = parseArgNumber('days', 180);

  const branches = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  if (branches.length === 0) {
    console.log('Không có chi nhánh active để backfill.');
    return;
  }

  const branchIds = branches.map((branch) => branch.id);
  console.log(
    `Chi nhánh đầu mối : ${branches.map((b) => `${b.name} (#${b.id})`).join(', ')}`,
  );
  console.log(`Phạm vi           : ${days} ngày gần nhất`);

  const today = toVnDate(new Date());
  const from = new Date(today.getTime() - days * DAY_MS);

  // Mốc đã biết chắc: tồn kho hiện tại.
  const inventories = await prisma.inventory.findMany({
    where: { branchId: { in: branchIds } },
    select: { productId: true, branchId: true, onHand: true },
  });

  if (inventories.length === 0) {
    console.log('Không có dòng tồn kho nào trong phạm vi. Dừng.');
    return;
  }

  // Tổng biến động theo (sản phẩm, chi nhánh, ngày) trong khoảng cần dựng lại.
  const logs = await prisma.inventoryLog.findMany({
    where: {
      branchId: { in: branchIds },
      transactionDate: { gte: from },
    },
    select: {
      productId: true,
      branchId: true,
      quantity: true,
      transactionDate: true,
    },
  });

  const deltaByKey = new Map<string, number>();
  for (const log of logs) {
    const dateKey = toKey(toVnDate(log.transactionDate));
    const key = `${log.productId}:${log.branchId}:${dateKey}`;
    deltaByKey.set(key, (deltaByKey.get(key) ?? 0) + Number(log.quantity ?? 0));
  }

  console.log(`Dòng tồn kho      : ${inventories.length}`);
  console.log(`Log giao dịch     : ${logs.length}`);

  // Replay ngược: bắt đầu từ hôm nay, lùi dần về quá khứ.
  type Row = {
    productId: number;
    branchId: number;
    date: Date;
    onHand: number;
    hadStock: boolean;
  };
  const rows: Row[] = [];

  for (const inventory of inventories) {
    let running = Number(inventory.onHand ?? 0);
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(today.getTime() - offset * DAY_MS);
      rows.push({
        productId: inventory.productId,
        branchId: inventory.branchId,
        date,
        onHand: running,
        hadStock: running > 0,
      });
      // Hoàn tác biến động của chính ngày này để ra tồn cuối ngày hôm trước.
      const key = `${inventory.productId}:${inventory.branchId}:${toKey(date)}`;
      running -= deltaByKey.get(key) ?? 0;
    }
  }

  const negative = rows.filter((row) => row.onHand < 0).length;
  console.log(`Bản ghi sẽ ghi    : ${rows.length}`);
  if (negative > 0) {
    console.log(
      `Cảnh báo          : ${negative} bản ghi có tồn âm — dấu hiệu InventoryLog chưa đủ để dựng lại chính xác.`,
    );
  }

  if (!apply) {
    console.log('\nĐây là chế độ xem trước. Chạy lại với --apply để ghi vào DB.');
    return;
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.inventoryDailySnapshot.upsert({
          where: {
            productId_branchId_date: {
              productId: row.productId,
              branchId: row.branchId,
              date: row.date,
            },
          },
          create: row,
          update: { onHand: row.onHand, hadStock: row.hadStock },
        }),
      ),
    );
    written += chunk.length;
    if (written % 20000 === 0) {
      console.log(`  ... đã ghi ${written}/${rows.length}`);
    }
  }

  console.log(`\nHoàn tất: ghi ${written} bản ghi snapshot.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
