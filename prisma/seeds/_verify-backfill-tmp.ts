import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.inventoryLog.findMany({
    where: { transactionType: 'TRANSFER_IN', refType: 'transfer', note: 'Backfill TRANSFER_IN' },
    select: { id: true, refId: true, branchId: true, productId: true, quantity: true, refCode: true },
  });
  console.log(`Tổng log backfill: ${logs.length}`);

  const transferIds = [...new Set(logs.map((l) => l.refId))];
  const transfers = await prisma.transfer.findMany({
    where: { id: { in: transferIds } },
    select: { id: true, code: true, toBranchId: true, fromBranchId: true },
  });
  const tMap = new Map(transfers.map((t) => [t.id, t]));

  let wrongBranch = 0;
  let atSourceBranch = 0;
  let missingTransfer = 0;
  const samples: string[] = [];
  for (const log of logs) {
    const t = tMap.get(log.refId);
    if (!t) { missingTransfer++; continue; }
    if (log.branchId !== t.toBranchId) {
      wrongBranch++;
      if (log.branchId === t.fromBranchId) atSourceBranch++;
      if (samples.length < 10)
        samples.push(`  ${t.code}: log.branchId=${log.branchId} but toBranchId=${t.toBranchId} (fromBranchId=${t.fromBranchId})`);
    }
  }

  console.log(`\nLog gán SAI chi nhánh (branchId != toBranchId): ${wrongBranch}`);
  console.log(`  Trong đó bị gán nhầm về chi nhánh CHUYỂN: ${atSourceBranch}`);
  console.log(`  Log trỏ tới transfer không tồn tại: ${missingTransfer}`);
  if (samples.length) { console.log('  Mẫu:'); samples.forEach((s) => console.log(s)); }

  // Verify quantity = receivedQuantity của detail tương ứng
  let qtyMismatch = 0;
  const qtySamples: string[] = [];
  for (const log of logs.slice(0, 2000)) {
    const detail = await prisma.transferDetail.findFirst({
      where: { transferId: log.refId, productId: log.productId },
      select: { receivedQuantity: true },
    });
    if (detail && Number(detail.receivedQuantity) !== Number(log.quantity)) {
      qtyMismatch++;
      if (qtySamples.length < 5)
        qtySamples.push(`  ${log.refCode}/${log.productId}: log.qty=${log.quantity} vs received=${detail.receivedQuantity}`);
    }
  }
  console.log(`\nKiểm 2000 log đầu — số lượng lệch receivedQuantity: ${qtyMismatch}`);
  qtySamples.forEach((s) => console.log(s));

  const sampleT = transfers.find((t) => t.fromBranchId !== t.toBranchId) || transfers[0];
  if (sampleT) {
    const both = await prisma.inventoryLog.findMany({
      where: { refType: 'transfer', refId: sampleT.id, transactionType: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      select: { transactionType: true, branchId: true, quantity: true, productId: true },
      orderBy: { id: 'asc' },
      take: 8,
    });
    console.log(`\nĐối chiếu phiếu ${sampleT.code} (from=${sampleT.fromBranchId}, to=${sampleT.toBranchId}):`);
    both.forEach((b) => console.log(`  ${b.transactionType} branchId=${b.branchId} qty=${b.quantity} product=${b.productId}`));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
