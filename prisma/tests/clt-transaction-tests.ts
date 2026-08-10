import { Prisma, PrismaClient } from '@prisma/client';
import { computeBucketTotals } from '../../src/common/stock-condition-onhand.util';
import {
  CLT_STATUS,
  StockConditionTransfersService,
} from '../../src/stock-condition-transfers/stock-condition-transfers.service';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const ROLLBACK = Symbol('ROLLBACK_CLT_TESTS');
const EPSILON = 1e-9;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function transactionPrisma(tx: Prisma.TransactionClient) {
  return new Proxy(tx as any, {
    get(target, property) {
      if (property === '$transaction') {
        return async (callback: (inner: Prisma.TransactionClient) => unknown) =>
          callback(tx);
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runTests(tx: Prisma.TransactionClient) {
  const testPrisma = transactionPrisma(tx);
  const auditLogs = { create: async () => undefined };
  const service = new StockConditionTransfersService(
    testPrisma,
    auditLogs as any,
  );

  const user = await tx.user.findFirst({
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });
  assert(user, 'Khong co user de chay test CLT');

  const inventories = await tx.inventory.findMany({
    where: { onHand: { gte: 2 } },
    select: {
      productId: true,
      productCode: true,
      productName: true,
      branchId: true,
      branchName: true,
      onHand: true,
    },
    orderBy: { onHand: 'desc' },
    take: 100,
  });

  let fixture: (typeof inventories)[number] | undefined;
  let baseline:
    | { damaged: number; nearExpiry: number; promo: number }
    | undefined;

  for (const inventory of inventories) {
    const totals = await computeBucketTotals(
      tx,
      inventory.productId,
      inventory.branchId,
    );
    const good =
      Number(inventory.onHand) -
      totals.damaged -
      totals.nearExpiry -
      totals.promo;
    if (good >= 2) {
      fixture = inventory;
      baseline = totals;
      break;
    }
  }

  assert(fixture && baseline, 'Khong tim thay san pham co it nhat 2 hang tot');
  const fixtureRow = fixture;
  const baselineTotals = baseline;
  const initialOnHand = Number(fixtureRow.onHand);

  console.log(
    `Fixture: ${fixtureRow.productCode} / ${fixtureRow.branchName}; onHand=${initialOnHand}`,
  );

  console.log('1. Create pending khong doi bucket');
  const pending = await service.create(
    {
      branchId: fixtureRow.branchId,
      note: '[AUTO TEST] pending + approve + update',
      items: [
        {
          productId: fixtureRow.productId,
          toBucket: 'DAMAGED',
          direction: 'IN',
          quantity: 2,
        },
      ],
    },
    user.id,
  );
  assert(pending, 'Create khong tra ve phieu');
  assert(
    pending.status === CLT_STATUS.PENDING,
    'Phieu moi khong o status PENDING',
  );
  let totals = await computeBucketTotals(
    tx,
    fixtureRow.productId,
    fixtureRow.branchId,
  );
  assertEqual(totals.damaged, baselineTotals.damaged, 'Pending da doi DAMAGED');

  console.log('2. Approve ghi CLT_IN va recalc cache');
  await service.approve(pending.id, user.id);
  totals = await computeBucketTotals(
    tx,
    fixtureRow.productId,
    fixtureRow.branchId,
  );
  assertEqual(
    totals.damaged,
    baselineTotals.damaged + 2,
    'Approve khong cong DAMAGED',
  );
  let inventory = await tx.inventory.findUnique({
    where: {
      productId_branchId: {
        productId: fixtureRow.productId,
        branchId: fixtureRow.branchId,
      },
    },
  });
  assert(inventory, 'Inventory bien mat sau approve');
  assertEqual(Number(inventory.onHand), initialOnHand, 'CLT da lam doi onHand');
  assertEqual(
    Number(inventory.damagedQuantity),
    baselineTotals.damaged + 2,
    'Cache DAMAGED khong khop sau approve',
  );

  const approvedLogs = await tx.stockConditionLog.findMany({
    where: { refType: 'clt', refId: pending.id },
  });
  assert(approvedLogs.length === 1, 'Approve khong tao dung 1 log CLT');
  assert(
    approvedLogs[0].transactionType === 'CLT_IN' &&
      Number(approvedLogs[0].quantity) === 2,
    'Log approve sai loai hoac sai so luong',
  );

  console.log('3. Update quantity 2 -> 1 xoa log cu va ghi lai');
  const detailId = pending.details[0].id;
  await service.update(
    pending.id,
    { items: [{ detailId, quantity: 1 }] },
    user.id,
  );
  totals = await computeBucketTotals(
    tx,
    fixtureRow.productId,
    fixtureRow.branchId,
  );
  assertEqual(
    totals.damaged,
    baselineTotals.damaged + 1,
    'Update quantity khong tinh lai DAMAGED',
  );
  const updatedLogs = await tx.stockConditionLog.findMany({
    where: { refType: 'clt', refId: pending.id },
  });
  assert(updatedLogs.length === 1, 'Update de lai log CLT trung');
  assertEqual(Number(updatedLogs[0].quantity), 1, 'Log update sai quantity');

  console.log('4. Update quantity -> 0 giu detail nhung bo log');
  await service.update(
    pending.id,
    { items: [{ detailId, quantity: 0 }] },
    user.id,
  );
  totals = await computeBucketTotals(
    tx,
    fixtureRow.productId,
    fixtureRow.branchId,
  );
  assertEqual(
    totals.damaged,
    baselineTotals.damaged,
    'Quantity 0 con doi bucket',
  );
  const zeroLogs = await tx.stockConditionLog.count({
    where: { refType: 'clt', refId: pending.id },
  });
  assert(zeroLogs === 0, 'Quantity 0 van con log CLT');
  const zeroDetail = await tx.stockConditionTransferDetail.findUnique({
    where: { id: detailId },
  });
  assert(
    zeroDetail && Number(zeroDetail.quantity) === 0,
    'Detail quantity 0 bi xoa',
  );

  console.log('5. Cancel approved phuc hoi bucket ve baseline');
  const cancellable = await service.create(
    {
      branchId: fixtureRow.branchId,
      note: '[AUTO TEST] cancel approved',
      items: [
        {
          productId: fixtureRow.productId,
          toBucket: 'DAMAGED',
          direction: 'IN',
          quantity: 1,
        },
      ],
    },
    user.id,
  );
  assert(cancellable, 'Khong tao duoc phieu cancel fixture');
  await service.approve(cancellable.id, user.id);
  await service.cancel(cancellable.id, user.id);
  totals = await computeBucketTotals(
    tx,
    fixtureRow.productId,
    fixtureRow.branchId,
  );
  assertEqual(
    totals.damaged,
    baselineTotals.damaged,
    'Cancel khong phuc hoi bucket',
  );
  const cancelled = await tx.stockConditionTransfer.findUnique({
    where: { id: cancellable.id },
  });
  assert(
    cancelled?.status === CLT_STATUS.CANCELLED,
    'Cancel khong doi status=3',
  );

  console.log('6. OUT vuot ton bucket phai bi chan');
  let rejected = false;
  try {
    await service.create(
      {
        branchId: fixtureRow.branchId,
        note: '[AUTO TEST] reject overdraw',
        items: [
          {
            productId: fixtureRow.productId,
            toBucket: 'PROMO',
            direction: 'OUT',
            quantity: baselineTotals.promo + 1,
          },
        ],
      },
      user.id,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, 'CLT OUT vuot PROMO khong bi chan');

  console.log('7. Update NSX phai neo ve ngay 01');
  const nearExpiry = await service.create(
    {
      branchId: fixtureRow.branchId,
      note: '[AUTO TEST] normalize NSX',
      items: [
        {
          productId: fixtureRow.productId,
          toBucket: 'NEAR_EXPIRY',
          direction: 'IN',
          quantity: 1,
          expiryDate: '2026-07-01',
        },
      ],
    },
    user.id,
  );
  assert(nearExpiry, 'Khong tao duoc phieu NSX fixture');
  await service.update(
    nearExpiry.id,
    {
      items: [
        {
          detailId: nearExpiry.details[0].id,
          expiryDate: '2026-08-22',
        },
      ],
    },
    user.id,
  );
  const normalized = await tx.stockConditionTransferDetail.findUnique({
    where: { id: nearExpiry.details[0].id },
  });
  assert(
    normalized?.expiryDate?.toISOString().slice(0, 10) === '2026-08-01',
    'NSX update khong duoc neo ve ngay 01',
  );

  inventory = await tx.inventory.findUnique({
    where: {
      productId_branchId: {
        productId: fixtureRow.productId,
        branchId: fixtureRow.branchId,
      },
    },
  });
  assert(inventory, 'Inventory bien mat sau test');
  assertEqual(
    Number(inventory.onHand),
    initialOnHand,
    'Test CLT lam doi onHand',
  );

  console.log('\nDAT: tat ca kich ban CLT trong transaction deu dung.');
}

async function main() {
  if (!APPLY) {
    console.log('Script nay co thao tac ghi TAM THOI trong transaction.');
    console.log('Tat ca thay doi se bi rollback khi ket thuc.');
    console.log('Chay lai voi: yarn test:condition-stock:clt --apply');
    return;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        await runTests(tx);
        throw ROLLBACK;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  } catch (error) {
    if (error === ROLLBACK) {
      console.log('ROLLBACK THANH CONG: database khong giu lai du lieu test.');
      return;
    }
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('CLT transaction tests that bai:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
