import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const permission = await prisma.permission.upsert({
    where: { name: 'customers:assign_sale_pic' },
    update: {
      description: 'Gắn Sale PIC cho khách hàng',
      category: 'Khách hàng',
    },
    create: {
      name: 'customers:assign_sale_pic',
      resource: 'customers',
      action: 'assign_sale_pic',
      scope: 'all',
      description: 'Gắn Sale PIC cho khách hàng',
      category: 'Khách hàng',
    },
  });

  console.log(
    `Đã upsert permission ${permission.name} (id=${permission.id}). Hãy cấp quyền cho role trong giao diện Vai trò.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
