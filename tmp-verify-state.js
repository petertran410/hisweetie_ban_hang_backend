const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const inv = await p.invoice.findMany({
    where: { id: { in: [95248, 95250] } },
    select: { id: true, code: true, status: true },
  });
  console.log('=== 2 HOA DON ===');
  console.log(JSON.stringify(inv));

  const logs = await p.stockConditionLog.groupBy({
    by: ['transactionType'],
    _count: { _all: true },
  });
  console.log('=== LOG THEO LOAI ===');
  console.log(JSON.stringify(logs));

  const clt = await p.stockConditionTransfer.findMany({
    select: { id: true, code: true, status: true },
    orderBy: { id: 'asc' },
  });
  console.log('=== PHIEU CLT ===');
  console.log(JSON.stringify(clt));

  const op = await p.stockConditionLog.findMany({
    where: { transactionType: 'OPENING' },
    select: {
      id: true, productId: true, productCode: true, branchId: true,
      branchName: true, bucket: true, quantity: true, expiryDate: true,
    },
    orderBy: { id: 'asc' },
  });
  const g = {};
  for (const l of op) {
    const k = `${l.branchId}|${l.bucket}`;
    g[k] = g[k] || { branchName: l.branchName, rows: 0, total: 0 };
    g[k].rows++;
    g[k].total += Number(l.quantity);
  }
  console.log('=== OPENING gom (CN|loai) ===');
  console.log(JSON.stringify(g, null, 2));
  console.log('tong dong OPENING:', op.length);
})().catch(e => console.log('ERR', e.message)).finally(() => p.$disconnect());
