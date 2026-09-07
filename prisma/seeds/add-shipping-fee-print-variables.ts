import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VARIABLES = [
  {
    key: 'Phi_Giao_Hang',
    label: 'Phí giao hàng',
    description: 'Phí giao hàng đã định dạng',
    sortOrder: 50,
  },
  {
    key: 'Dong_Phi_Giao_Hang',
    label: 'Dòng phí giao hàng (tự ẩn khi bằng 0)',
    description: 'HTML an toàn do backend tạo; rỗng khi phí giao hàng bằng 0',
    sortOrder: 51,
  },
  {
    key: 'Style_Dong_Phi_Giao_Hang',
    label: 'Ẩn dòng phí giao hàng khi bằng 0',
    description: 'CSS ẩn dòng phí giao hàng khi giá trị bằng 0',
    sortOrder: 52,
  },
];

async function main() {
  for (const templateFor of ['invoice', 'order', 'consignment']) {
    for (const variable of VARIABLES) {
      await prisma.printTemplateVariable.upsert({
        where: {
          templateFor_key: { templateFor, key: variable.key },
        },
        update: {
          label: variable.label,
          description: variable.description,
          group: 'Tổng tiền',
          sortOrder: variable.sortOrder,
          isItemVariable: false,
          isActive: true,
        },
        create: {
          templateFor,
          ...variable,
          group: 'Tổng tiền',
          isItemVariable: false,
          isActive: true,
        },
      });
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
