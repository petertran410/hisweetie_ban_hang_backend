import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const CUT = new Date('2026-05-31T17:00:00.000Z');
async function main() {
  const total = await prisma.transfer.count({ where: { status: 3 } });
  const fromJun = await prisma.transfer.count({ where: { status: 3, receivedDate: { gte: CUT } } });
  const nullRecv = await prisma.transfer.count({ where: { status: 3, receivedDate: null } });
  const recent = await prisma.transfer.findMany({
    where: { status: 3 }, orderBy: { receivedDate: 'desc' }, take: 6,
    select: { code: true, receivedDate: true, updatedAt: true, createdAt: true },
  });
  console.log(`status=3 tổng: ${total}`);
  console.log(`status=3 receivedDate >= 1/6 VN: ${fromJun}`);
  console.log(`status=3 receivedDate NULL: ${nullRecv}`);
  console.log('6 phiếu receivedDate mới nhất:');
  recent.forEach(r => console.log(`  ${r.code}  received=${r.receivedDate?.toISOString() ?? 'NULL'}  created=${r.createdAt.toISOString()}`));
}
main().catch(console.error).finally(() => prisma.$disconnect());
