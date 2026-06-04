import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const total = await prisma.inventoryLog.count();
  const before = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM inventory_logs
    WHERE "transactionDate" <> "createdAt"
  `;
  console.log(`Tổng dòng: ${total}`);
  console.log(`Đang lệch (transactionDate <> createdAt): ${Number(before[0].c)}`);

  const updated = await prisma.$executeRaw`
    UPDATE inventory_logs SET "transactionDate" = "createdAt"
  `;
  console.log(`\nĐã UPDATE transactionDate = createdAt cho ${updated} dòng.`);

  const after = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM inventory_logs
    WHERE "transactionDate" <> "createdAt"
  `;
  console.log(`Còn lệch sau update: ${Number(after[0].c)} (kỳ vọng 0)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
