import { PrismaClient } from '@prisma/client';

// Operator-only, definition-only registration. Never assigns roles or users.
async function main() {
  if (!process.argv.includes('--execute')) {
    throw new Error(
      'Registration writes one permission definition. Review first, then explicitly pass --execute.',
    );
  }
  const prisma = new PrismaClient();
  try {
    const categorySource = await prisma.permission.findFirst({
      where: { resource: 'productions' },
      select: { category: true },
    });
    const definition = {
      resource: 'productions',
      action: 'apply_cost',
      scope: 'all',
      description: 'Áp dụng giá vốn gia công',
      category: categorySource?.category ?? 'Sản phẩm',
    };
    await prisma.permission.upsert({
      where: { name: 'productions:apply_cost' },
      create: { name: 'productions:apply_cost', ...definition },
      update: definition,
    });
    console.log(
      'Registered productions:apply_cost definition only. No role/user assignments changed.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
