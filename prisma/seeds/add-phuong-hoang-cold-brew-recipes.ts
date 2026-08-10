import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RECIPES = [
  ['CB-PH-HT-001', 'Hồng Trà Bột CTC', 'SP000183'],
  ['CB-PH-HT-002', 'Hồng Trà Nguyên Lá', 'SP000180'],
  ['CB-PH-HT-003', 'Hồng Trà Shan Tuyết', 'SP000763'],
  ['CB-PH-TX-001', 'Trà Xanh Nhài Ướp Hương', 'SP000511'],
  ['CB-PH-TX-002', 'Trà Xanh Nhài', 'SP000179'],
  ['CB-PH-TX-003', 'Trà Xanh Bạch Lan', 'SP007520'],
  ['CB-PH-TX-004', 'Trà Gạo Rang', 'SP000182'],
  ['CB-PH-TX-005', 'Trà Long Tỉnh Chi Xuân', 'SP007416'],
  ['CB-PH-OL-001', 'Trà Ô Long Nướng', 'SP000501'],
  ['CB-PH-OL-002', 'Trà Ô Long Phân Vịt', 'SP000512'],
  ['CB-PH-OL-003', 'Trà Thiết Quan Âm', 'SP000184'],
  ['CB-PH-OL-004', 'Trà Ô Long Đậm Vị', 'SP000293'],
  ['CB-PH-OL-005', 'Trà Ô Long Đào', 'SP000489'],
  ['CB-PH-OL-006', 'Trà Ô Long Nhài', 'SP000181'],
  ['CB-PH-OL-007', 'Trà Ô Long Tứ Quý', 'SP000185'],
  ['CB-PH-OL-008', 'Trà Ô Long Hoa Sen', 'SP000349'],
  ['CB-PH-OL-009', 'Trà Ô Long Dành Dành', 'SP000513'],
  ['CB-PH-OL-010', 'Trà Ô Long Quế Hoa', 'SP000514'],
  ['CB-PH-OL-011', 'Trà Ô Long Shan Tuyết', 'SP000673'],
  ['CB-PH-OL-012', 'Trà Ô Long Phong Lan', 'SP000424'],
] as const;

const STEPS = [
  {
    title: 'Cân trà',
    content: 'Cân chính xác 100 gram trà.',
  },
  {
    title: 'Thêm nước',
    content: 'Cho trà vào bình sạch, thêm 4.000 ml nước.',
  },
  {
    title: 'Ủ lạnh',
    content: 'Đậy kín nắp và ủ trong ngăn mát từ 6–12 giờ.',
  },
  {
    title: 'Lọc trà',
    content: 'Lọc bỏ toàn bộ bã trà trước khi sử dụng.',
  },
  {
    title: 'Bảo quản',
    content: 'Giữ cốt trà trong bình sạch, đậy kín và tiếp tục bảo quản lạnh.',
  },
];

async function main() {
  const productCodes = RECIPES.map(([, , productCode]) => productCode);
  const products = await prisma.product.findMany({
    where: { code: { in: productCodes }, isActive: true },
    select: { id: true, code: true },
  });
  const productByCode = new Map(products.map((product) => [product.code, product]));
  const missingCodes = productCodes.filter((code) => !productByCode.has(code));

  if (missingCodes.length) {
    throw new Error(`Không tìm thấy Product đang hoạt động: ${missingCodes.join(', ')}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingCategory = await tx.recipeCategory.findFirst({
      where: {
        deletedAt: null,
        OR: [{ code: 'TRA-U-LANH' }, { name: 'Trà ủ lạnh' }],
      },
    });
    const category = existingCategory
      ? await tx.recipeCategory.update({
          where: { id: existingCategory.id },
          data: { code: 'TRA-U-LANH', name: 'Trà ủ lạnh', type: 'SEMI_FINISHED', isActive: true },
        })
      : await tx.recipeCategory.create({
          data: { code: 'TRA-U-LANH', name: 'Trà ủ lạnh', type: 'SEMI_FINISHED' },
        });

    let created = 0;
    let skipped = 0;

    for (const [code, teaName, productCode] of RECIPES) {
      const existing = await tx.recipe.findUnique({ where: { code } });
      if (existing) {
        skipped += 1;
        continue;
      }

      await tx.recipe.create({
        data: {
          code,
          slug: code.toLowerCase(),
          name: `Trà ủ - ${teaName}`,
          type: 'SEMI_FINISHED',
          categoryId: category.id,
          status: 'DRAFT',
          description: 'Bán thành phẩm trà ủ lạnh theo tỷ lệ 1 trà : 40 nước.',
          quantity: 4000,
          quantityUnit: 'ml',
          unit: 'bình',
          storage: 'Đậy kín và bảo quản trong ngăn mát.',
          ingredients: {
            create: [
              {
                sourceType: 'PRODUCT',
                productId: productByCode.get(productCode)!.id,
                quantity: 100,
                unit: 'gram',
                includeInCost: true,
                sortOrder: 0,
                note: `Tỷ lệ 1:40 - ${teaName}`,
              },
              {
                sourceType: 'CUSTOM',
                customName: 'Nước lọc',
                customUnit: 'ml',
                customPrice: 0,
                quantity: 4000,
                unit: 'ml',
                includeInCost: false,
                sortOrder: 1,
              },
            ],
          },
          steps: {
            create: STEPS.map((step, sortOrder) => ({ ...step, sortOrder })),
          },
        },
      });
      created += 1;
    }

    return { categoryId: category.id, created, skipped };
  }, { maxWait: 10_000, timeout: 120_000 });

  console.log(
    `Hoàn tất Trà ủ lạnh: tạo ${result.created}, bỏ qua ${result.skipped}, categoryId=${result.categoryId}.`,
  );
}

main()
  .catch((error) => {
    console.error('Không thể tạo công thức Trà ủ lạnh:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
