import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.permission.upsert({
    where: { name: 'invoices:merge' },
    update: {
      description: 'Gộp nhiều hóa đơn thành một hóa đơn mới',
      category: 'Bán hàng',
    },
    create: {
      name: 'invoices:merge',
      resource: 'invoices',
      action: 'merge',
      scope: 'all',
      description: 'Gộp nhiều hóa đơn thành một hóa đơn mới',
      category: 'Bán hàng',
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
