import { PrismaClient } from '@prisma/client';
import {
  getActiveLogKeys,
  isLogActive,
} from '../../src/common/inventory-onhand.util';
import {
  ALL_BUCKETS,
  BUCKET_DAMAGED,
  BUCKET_NEAR_EXPIRY,
  BUCKET_PROMO,
} from '../../src/common/stock-condition-onhand.util';

const prisma = new PrismaClient();
const EPSILON = 1e-9;

type Totals = { damaged: number; nearExpiry: number; promo: number };

const emptyTotals = (): Totals => ({ damaged: 0, nearExpiry: 0, promo: 0 });
const pairKey = (productId: number, branchId: number) =>
  `${productId}|${branchId}`;
const lotKey = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : 'NO_NSX';
const differs = (left: number, right: number) =>
  Math.abs(left - right) > EPSILON;

async function main() {
  console.log('AUDIT TON LOAI TON - CHI DOC, KHONG GHI DATABASE\n');

  const [inventories, logs] = await Promise.all([
    prisma.inventory.findMany({
      select: {
        productId: true,
        productCode: true,
        productName: true,
        branchId: true,
        branchName: true,
        onHand: true,
        damagedQuantity: true,
        nearExpiryQuantity: true,
        promoQuantity: true,
      },
    }),
    prisma.stockConditionLog.findMany({
      select: {
        id: true,
        productId: true,
        productCode: true,
        productName: true,
        branchId: true,
        branchName: true,
        bucket: true,
        transactionType: true,
        refCode: true,
        refType: true,
        refId: true,
        quantity: true,
        expiryDate: true,
      },
    }),
  ]);

  const activeKeys = await getActiveLogKeys(prisma, logs);
  const activeLogs = logs.filter((log) => isLogActive(log, activeKeys));
  const totalsByPair = new Map<string, Totals>();
  const lots = new Map<string, number>();
  const sourceCounts = new Map<string, { rows: number; quantity: number }>();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const log of activeLogs) {
    if (!ALL_BUCKETS.includes(log.bucket as (typeof ALL_BUCKETS)[number])) {
      errors.push(
        `Log #${log.id} co bucket khong hop le: ${log.bucket} (${log.refCode})`,
      );
      continue;
    }

    const key = pairKey(log.productId, log.branchId);
    const totals = totalsByPair.get(key) ?? emptyTotals();
    const quantity = Number(log.quantity);
    if (log.bucket === BUCKET_DAMAGED) totals.damaged += quantity;
    if (log.bucket === BUCKET_NEAR_EXPIRY) totals.nearExpiry += quantity;
    if (log.bucket === BUCKET_PROMO) totals.promo += quantity;
    totalsByPair.set(key, totals);

    if (log.bucket === BUCKET_NEAR_EXPIRY) {
      const keyByLot = `${key}|${lotKey(log.expiryDate)}`;
      lots.set(keyByLot, (lots.get(keyByLot) ?? 0) + quantity);
    }

    const source = sourceCounts.get(log.transactionType) ?? {
      rows: 0,
      quantity: 0,
    };
    source.rows += 1;
    source.quantity += quantity;
    sourceCounts.set(log.transactionType, source);
  }

  const inventoryByPair = new Map(
    inventories.map((inventory) => [
      pairKey(inventory.productId, inventory.branchId),
      inventory,
    ]),
  );
  // Chỉ audit các cặp thực sự tham gia tồn loại: có log (kể cả log inactive)
  // hoặc cache bucket khác 0. Không kéo toàn bộ Inventory vào vì onHand âm của
  // sản phẩm không có tồn loại là một vấn đề tồn tổng riêng, ngoài phạm vi này.
  const allPairs = new Set(
    logs.map((log) => pairKey(log.productId, log.branchId)),
  );
  for (const inventory of inventories) {
    if (
      Number(inventory.damagedQuantity) !== 0 ||
      Number(inventory.nearExpiryQuantity) !== 0 ||
      Number(inventory.promoQuantity) !== 0
    ) {
      allPairs.add(pairKey(inventory.productId, inventory.branchId));
    }
  }

  for (const key of allPairs) {
    const inventory = inventoryByPair.get(key);
    const totals = totalsByPair.get(key) ?? emptyTotals();
    if (!inventory) {
      errors.push(`Co log active nhung khong co Inventory cho cap ${key}`);
      continue;
    }

    const cached = {
      damaged: Number(inventory.damagedQuantity),
      nearExpiry: Number(inventory.nearExpiryQuantity),
      promo: Number(inventory.promoQuantity),
    };
    const label = `${inventory.productCode} / ${inventory.branchName} (${key})`;

    if (
      differs(cached.damaged, totals.damaged) ||
      differs(cached.nearExpiry, totals.nearExpiry) ||
      differs(cached.promo, totals.promo)
    ) {
      errors.push(
        `${label}: cache [${cached.damaged}, ${cached.nearExpiry}, ${cached.promo}] ` +
          `khac so cai [${totals.damaged}, ${totals.nearExpiry}, ${totals.promo}]`,
      );
    }

    for (const [bucket, quantity] of Object.entries(totals)) {
      if (quantity < -EPSILON) {
        errors.push(`${label}: bucket ${bucket} bi am (${quantity})`);
      }
    }

    const onHand = Number(inventory.onHand);
    const classified = totals.damaged + totals.nearExpiry + totals.promo;
    const good = onHand - classified;
    if (good < -EPSILON) {
      errors.push(
        `${label}: hang tot bi am (${good}); onHand=${onHand}, da phan loai=${classified}`,
      );
    }
  }

  for (const [key, quantity] of lots) {
    if (quantity < -EPSILON) {
      errors.push(`Lo can date ${key} bi am (${quantity})`);
    }
  }

  const nullLotLogs = activeLogs.filter(
    (log) => log.bucket === BUCKET_NEAR_EXPIRY && log.expiryDate == null,
  );
  if (nullLotLogs.length > 0) {
    const nullLotSources = new Set(
      nullLotLogs.map((log) => `${log.transactionType}/${log.refType}`),
    );
    warnings.push(
      `${nullLotLogs.length} log can date chua co NSX. Nguon: ${[
        ...nullLotSources,
      ].join(', ')}`,
    );
  }

  const openingCount = logs.filter(
    (log) => log.transactionType === 'OPENING',
  ).length;
  if (openingCount > 0) {
    warnings.push(`Con ${openingCount} log OPENING trong database`);
  }

  console.log(
    `Inventory: ${inventories.length}; log: ${logs.length}; log active: ${activeLogs.length}`,
  );
  console.log(`Cap san pham/chi nhanh da kiem: ${allPairs.size}`);
  console.log('\nLOG ACTIVE THEO NGHIEP VU:');
  for (const [transactionType, value] of [...sourceCounts.entries()].sort()) {
    console.log(
      `  ${transactionType.padEnd(24)} ${String(value.rows).padStart(5)} dong, tong co dau ${value.quantity}`,
    );
  }

  if (warnings.length > 0) {
    console.log(`\nCANH BAO (${warnings.length}):`);
    warnings.forEach((warning) => console.log(`  - ${warning}`));
  }

  if (errors.length > 0) {
    console.error(`\nTHAT BAI - ${errors.length} loi:`);
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    '\nDAT: cache khop so cai, bucket/lo khong am, hang tot khong am.',
  );
}

main()
  .catch((error) => {
    console.error('Audit that bai:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
