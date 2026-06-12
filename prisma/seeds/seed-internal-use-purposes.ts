// prisma/seeds/seed-internal-use-purposes.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PURPOSES = [
  { name: 'Xuất văn phòng phẩm, dụng cụ làm việc', order: 1 },
  { name: 'Xuất vật tư tiêu hao, công cụ dụng cụ', order: 2 },
  { name: 'Xuất phục vụ sự kiện, hội nghị nội bộ', order: 3 },
  { name: 'Xuất bồi thường, đền bù', order: 4 },
  { name: 'Xuất mẫu trưng bày, demo sản phẩm', order: 5 },
  { name: 'Xuất quà tặng khách hàng, đối tác', order: 6 },
  { name: 'Khác', order: 999 },
];

async function main() {
  console.log('🌱 Seeding internal use purposes...');

  for (const purpose of PURPOSES) {
    const existing = await prisma.internalUsePurpose.findFirst({
      where: { name: purpose.name },
    });
    if (existing) {
      await prisma.internalUsePurpose.update({
        where: { id: existing.id },
        data: { order: purpose.order, isDeleted: false },
      });
      console.log(`  ↻ Updated: ${purpose.name}`);
    } else {
      await prisma.internalUsePurpose.create({ data: purpose });
      console.log(`  ✅ Created: ${purpose.name}`);
    }
  }

  console.log('🎉 Done seeding internal use purposes.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
