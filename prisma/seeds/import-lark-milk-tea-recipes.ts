import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

type Unit = 'ml' | 'gram' | 'quả';
type Ingredient =
  | { kind: 'TEA'; code: string; quantity: number; unit: Unit }
  | { kind: 'PRODUCT'; code: string; quantity: number; unit: Unit }
  | { kind: 'CUSTOM'; name: string; quantity: number; unit: Unit };

const tea = (
  code: string,
  quantity: number,
  unit: Unit = 'ml',
): Ingredient => ({
  kind: 'TEA',
  code,
  quantity,
  unit,
});
const product = (code: string, quantity: number, unit: Unit): Ingredient => ({
  kind: 'PRODUCT',
  code,
  quantity,
  unit,
});
const custom = (name: string, quantity: number, unit: Unit): Ingredient => ({
  kind: 'CUSTOM',
  name,
  quantity,
  unit,
});

const RECIPES: Array<{ name: string; ingredients: Ingredient[] }> = [
  {
    name: 'Hồng Trà Shan Sữa',
    ingredients: [
      tea('SP000763', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Nhãn Dừa',
    ingredients: [
      product('SP000640', 100, 'ml'),
      product('SP000670', 20, 'gram'),
      custom('Đá viên', 250, 'gram'),
      custom('Nhãn tươi', 3, 'quả'),
    ],
  },
  {
    name: 'Trà Sữa Chua Quýt',
    ingredients: [
      product('SP000595', 60, 'gram'),
      tea('SP000179', 120),
      product('SP000346', 60, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Cốm',
    ingredients: [
      tea('SP000349', 200),
      product('SP000500', 5, 'gram'),
      product('SP007382', 30, 'ml'),
      custom('Kem cheese cốm', 20, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Dành Dành',
    ingredients: [
      tea('SP000513', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Hồng',
    ingredients: [
      product('SP000597', 30, 'gram'),
      tea('SP000179', 200),
      product('STTTW01', 50, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Hồng 2',
    ingredients: [
      product('SP000597', 40, 'gram'),
      tea('SP000179', 120),
      product('STTTW01', 30, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Mộc Tê',
    ingredients: [
      tea('SP000514', 200),
      product('SP007382', 30, 'ml'),
      product('STTTW01', 50, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Sen',
    ingredients: [
      tea('SP000349', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Hoa Sen V2',
    ingredients: [
      tea('SP000349', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Hồng Trà Shan Tuyết',
    ingredients: [
      tea('SP000763', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Khoai Môn Nghiền',
    ingredients: [
      tea('SP000180', 150),
      product('SP007382', 40, 'ml'),
      product('SP000736', 50, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Khoai Môn Nghiền V2',
    ingredients: [
      tea('SP000180', 150),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
      product('SP000736', 50, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Kiều Mạch',
    ingredients: [
      tea('SP000182', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Kiều Mạch V2',
    ingredients: [
      tea('SP000182', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Long Nhãn',
    ingredients: [
      tea('SP000179', 200),
      product('SP000670', 30, 'gram'),
      product('SP007382', 40, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Long Nhãn V2',
    ingredients: [
      tea('SP000179', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP000670', 30, 'gram'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Long Tỉnh Chi Xuân',
    ingredients: [
      tea('SP007416', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Long Tỉnh Chi Xuân V2',
    ingredients: [
      tea('SP007416', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Nướng',
    ingredients: [
      tea('SP000501', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Nướng V2',
    ingredients: [
      tea('SP000501', 130),
      custom('Nước nóng', 25, 'gram'),
      product('SP007406', 25, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Oolong Quế Hoa',
    ingredients: [tea('SP000514', 160, 'gram')],
  },
  {
    name: 'Trà Sữa Phong Lan',
    ingredients: [
      tea('SP000424', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Phong Lan V2',
    ingredients: [
      tea('SP000424', 130),
      custom('Nước nóng', 25, 'gram'),
      product('SP007406', 25, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Quế Hoa',
    ingredients: [tea('SP000514', 150), product('SP007406', 25, 'gram')],
  },
  {
    name: 'Trà Sữa Quế Hoa Khoai Môn',
    ingredients: [
      tea('SP000514', 150),
      product('SP007382', 40, 'gram'),
      product('SP000736', 50, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Quế Hoa V2',
    ingredients: [
      tea('SP000514', 130),
      product('SP007406', 25, 'gram'),
      custom('Nước nóng', 25, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Shan Tuyết',
    ingredients: [
      tea('SP000673', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Shan Tuyết V2',
    ingredients: [
      tea('SP000673', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Sài Gòn',
    ingredients: [
      tea('SP007394', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Sài Gòn V2',
    ingredients: [
      tea('SP007394', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Thiết Quan Âm',
    ingredients: [
      tea('SP000184', 130),
      product('SP007406', 25, 'gram'),
      custom('Nước nóng', 25, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Thiết Quan Âm V2',
    ingredients: [
      tea('SP000184', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Xoài',
    ingredients: [
      product('SP000552', 30, 'gram'),
      product('STTTW01', 50, 'gram'),
      tea('SP000179', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Đào',
    ingredients: [
      tea('SP000489', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Đào V2',
    ingredients: [tea('SP000489', 150), product('SP007406', 25, 'gram')],
  },
  {
    name: 'Trà Sữa Đơn Tùng Hạt Dẻ Cười',
    ingredients: [
      tea('SP000512', 200),
      product('SP007382', 20, 'ml'),
      product('STTTW01', 70, 'ml'),
      product('SP007476', 10, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Đại Hồng Bào',
    ingredients: [
      tea('SP007355', 200),
      product('SP007382', 40, 'ml'),
      custom('Đá viên', 200, 'gram'),
    ],
  },
  {
    name: 'Trà Sữa Đại Hồng Bào V2',
    ingredients: [
      tea('SP007355', 130),
      custom('Nước nóng', 25, 'ml'),
      product('SP007406', 25, 'gram'),
    ],
  },
  {
    name: 'Đào Sữa Dừa',
    ingredients: [
      product('SP000553', 25, 'gram'),
      tea('SP000179', 120),
      product('SP000640', 40, 'ml'),
    ],
  },
  {
    name: 'Trà Sữa Kem Hồng Hạt Dẻ',
    ingredients: [
      tea('SP007416', 200),
      product('STTTW01', 50, 'ml'),
      product('SP007382', 30, 'ml'),
      custom('Kem hồng', 25, 'gram'),
      product('SP007476', 25, 'gram'),
    ],
  },
  {
    name: 'Hạt Dẻ Cười Fa Fa',
    ingredients: [
      tea('SP000349', 200),
      product('STTTW01', 50, 'ml'),
      product('SP007382', 30, 'ml'),
      custom('Sốt hạt dẻ', 20, 'gram'),
      product('SP007476', 50, 'gram'),
    ],
  },
  {
    name: 'Trà Lài Kem Hạt Dẻ Cười',
    ingredients: [tea('SP000179', 150), product('SP007476', 40, 'gram')],
  },
  {
    name: 'Trà Sữa Hạt Dẻ Cười',
    ingredients: [
      product('SP007476', 30, 'gram'),
      custom('Nước nóng', 50, 'ml'),
      custom('Sốt hạt dẻ', 60, 'gram'),
      product('SP007382', 15, 'ml'),
      product('STTTW01', 25, 'ml'),
      tea('SP000179', 130),
    ],
  },
];

const EXTRA_TEA_RECIPES = [
  { code: 'CB-PH-HT-004', name: 'Hồng Trà Sài Gòn', productCode: 'SP007394' },
  { code: 'CB-PH-HT-005', name: 'Đại Hồng Bào', productCode: 'SP007355' },
];
const USER_ID = 1;

async function main() {
  if (
    RECIPES.length !== 44 ||
    new Set(RECIPES.map((row) => row.name)).size !== 44
  ) {
    throw new Error('Manifest phải có đúng 44 tên công thức duy nhất.');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const productCodes = new Set<string>();
    for (const recipe of RECIPES) {
      for (const ingredient of recipe.ingredients) {
        if (ingredient.kind !== 'CUSTOM') productCodes.add(ingredient.code);
      }
    }
    EXTRA_TEA_RECIPES.forEach((row) => productCodes.add(row.productCode));
    const products = await prisma.product.findMany({
      where: { code: { in: [...productCodes] }, isActive: true },
      select: { id: true, code: true },
    });
    const productByCode = new Map(products.map((row) => [row.code, row]));
    const missingProducts = [...productCodes].filter(
      (code) => !productByCode.has(code),
    );
    if (missingProducts.length)
      throw new Error(
        `Thiếu Product đang hoạt động: ${missingProducts.join(', ')}`,
      );

    let coldBrewCategory = await prisma.recipeCategory.findFirst({
      where: { code: 'TRA-U-LANH', deletedAt: null },
    });
    if (!coldBrewCategory)
      throw new Error('Không tìm thấy category TRA-U-LANH.');

    for (const extra of EXTRA_TEA_RECIPES) {
      const recipe = await prisma.recipe.findUnique({
        where: { code: extra.code },
      });
      let recipeId = recipe?.id;
      if (!recipeId) {
        const created = await recipesService.create(
          {
            code: extra.code,
            name: `Trà ủ - ${extra.name}`,
            type: 'SEMI_FINISHED',
            categoryId: coldBrewCategory.id,
            description:
              'Bán thành phẩm trà ủ lạnh theo tỷ lệ 1 trà : 40 nước.',
            quantity: 4000,
            quantityUnit: 'ml',
            unit: 'bình',
            storage: 'Đậy kín và bảo quản trong ngăn mát.',
            ingredients: [
              {
                sourceType: 'PRODUCT',
                productId: productByCode.get(extra.productCode)!.id,
                quantity: 100,
                unit: 'gram',
                includeInCost: true,
              },
              {
                sourceType: 'CUSTOM',
                customName: 'Nước lọc',
                customUnit: 'ml',
                customPrice: 0,
                quantity: 4000,
                unit: 'ml',
                includeInCost: false,
              },
            ],
            steps: [
              {
                content:
                  'Cân 100 gram trà, thêm 4.000 ml nước và ủ lạnh từ 6–12 giờ.',
                sortOrder: 0,
              },
            ],
          },
          USER_ID,
        );
        recipeId = created.id;
      }
      const detail = await recipesService.findOne(recipeId);
      if (detail.status === 'DRAFT') {
        await recipesService.publish(
          detail.id,
          { changeNote: 'Bổ sung Trà ủ cho bộ công thức trà sữa Lark Base' },
          USER_ID,
        );
      }
    }

    const teaRecipes = await prisma.recipe.findMany({
      where: {
        type: 'SEMI_FINISHED',
        status: 'PUBLISHED',
        deletedAt: null,
        outputProduct: null,
      },
      include: {
        ingredients: { where: { sourceType: 'PRODUCT' } },
      },
    });
    const teaByProductCode = new Map<string, { id: number }>();
    for (const recipe of teaRecipes) {
      const productId = recipe.ingredients[0]?.productId;
      const productCode = products.find((row) => row.id === productId)?.code;
      if (productCode) {
        teaByProductCode.set(productCode, { id: recipe.id });
      }
    }
    const teaCodes = new Set(
      RECIPES.flatMap((row) =>
        row.ingredients
          .filter((item) => item.kind === 'TEA')
          .map((item: any) => item.code),
      ),
    );
    const missingTea = [...teaCodes].filter(
      (code) => !teaByProductCode.has(code),
    );
    if (missingTea.length)
      throw new Error(`Thiếu bán thành phẩm Trà ủ: ${missingTea.join(', ')}`);

    for (const recipe of teaRecipes) {
      await recipesService.calculateCost(recipe.id, {}, USER_ID, true);
    }

    let category = await prisma.recipeCategory.findFirst({
      where: {
        deletedAt: null,
        OR: [{ code: 'TRA-SUA' }, { name: 'Trà sữa' }],
      },
    });
    if (category) {
      category = await prisma.recipeCategory.update({
        where: { id: category.id },
        data: {
          code: 'TRA-SUA',
          name: 'Trà sữa',
          type: 'FINISHED_PRODUCT',
          isActive: true,
        },
      });
    } else {
      category = await prisma.recipeCategory.create({
        data: { code: 'TRA-SUA', name: 'Trà sữa', type: 'FINISHED_PRODUCT' },
      });
    }

    let created = 0;
    let published = 0;
    let skipped = 0;
    for (const [index, row] of RECIPES.entries()) {
      const code = `MT-LARK-${String(index + 1).padStart(3, '0')}`;
      const existing = await prisma.recipe.findUnique({ where: { code } });
      let recipeId = existing?.id;
      if (!recipeId) {
        const ingredients = row.ingredients.map((ingredient, sortOrder) => {
          if (ingredient.kind === 'TEA') {
            const reference = teaByProductCode.get(ingredient.code)!;
            return {
              sourceType: 'SEMI_FINISHED' as const,
              recipeReferenceId: reference.id,
              quantity: ingredient.quantity,
              unit: ingredient.unit,
              includeInCost: true,
              sortOrder,
            };
          }
          if (ingredient.kind === 'PRODUCT') {
            return {
              sourceType: 'PRODUCT' as const,
              productId: productByCode.get(ingredient.code)!.id,
              quantity: ingredient.quantity,
              unit: ingredient.unit,
              includeInCost: true,
              sortOrder,
            };
          }
          return {
            sourceType: 'CUSTOM' as const,
            customName: ingredient.name,
            customUnit: ingredient.unit,
            customPrice: 0,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            includeInCost: false,
            sortOrder,
          };
        });
        const createdRecipe = await recipesService.create(
          {
            code,
            name: `Trà sữa - ${row.name}`,
            type: 'FINISHED_PRODUCT',
            categoryId: category.id,
            description: 'Công thức nhập từ Lark Base Diệp Trà.',
            quantity: 500,
            quantityUnit: 'ml',
            unit: 'ly',
            ingredients,
            steps: [
              {
                title: 'Pha chế',
                content:
                  'Cho lần lượt các nguyên liệu theo định lượng, khuấy đều và hoàn thiện món.',
                sortOrder: 0,
              },
            ],
          },
          USER_ID,
        );
        recipeId = createdRecipe.id;
        created += 1;
      }
      const detail = await recipesService.findOne(recipeId);
      if (detail.name !== `Trà sữa - ${row.name}`) {
        throw new Error(`${code} đã tồn tại nhưng sai tên: ${detail.name}`);
      }
      if (detail.status === 'DRAFT') {
        await recipesService.publish(
          detail.id,
          { changeNote: 'Publish bộ 44 công thức trà sữa từ Lark Base' },
          USER_ID,
        );
        published += 1;
      } else {
        skipped += 1;
      }
      console.log(
        `${code}: ${detail.status === 'DRAFT' ? 'published' : 'skipped'} - ${row.name}`,
      );
    }
    console.log(
      `Hoàn tất: tạo ${created}, publish ${published}, bỏ qua ${skipped}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Không thể import công thức trà sữa:', error);
  process.exit(1);
});
