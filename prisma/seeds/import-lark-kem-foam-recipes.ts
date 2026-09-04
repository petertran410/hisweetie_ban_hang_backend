import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const USER_ID = 1;

type Unit = 'ml' | 'gram';
type Ingredient =
  | { kind: 'PRODUCT'; code: string; quantity: number; unit: Unit }
  | { kind: 'CUSTOM'; name: string; quantity: number; unit: Unit };
type Media = {
  mediaType: 'IMAGE';
  fileUrl: string;
  fileName: string;
  altText: string;
  sortOrder: number;
};
type RecipeManifest = {
  code: string;
  name: string;
  quantity: number;
  quantityUnit: Unit;
  ingredients: Ingredient[];
  step: string;
  media?: Media[];
};

const RECIPES: RecipeManifest[] = [
  {
    code: 'KF-LARK-001',
    name: 'Kem Foam - Foam hạt dẻ cười',
    quantity: 150,
    quantityUnit: 'ml',
    ingredients: [
      { kind: 'PRODUCT', code: 'SP007476', quantity: 30, unit: 'gram' },
      { kind: 'PRODUCT', code: 'STTTW01', quantity: 20, unit: 'gram' },
      { kind: 'CUSTOM', name: 'Whipping Cream', quantity: 100, unit: 'ml' },
    ],
    step: 'Cho 30 gram bột hạt dẻ cười, 20 gram sữa tươi và 100 ml whipping cream vào ca. Dùng máy đánh kem đánh tới khi hỗn hợp thành kem foam.',
    media: [
      {
        mediaType: 'IMAGE',
        fileUrl: 'https://i.postimg.cc/XN2X6y7M/foam-hat-de-lermao1.png',
        fileName: 'foam-hat-de-lermao1.png',
        altText: 'Foam hạt dẻ cười',
        sortOrder: 0,
      },
    ],
  },
  {
    code: 'KF-LARK-002',
    name: 'Kem Foam - Kem Foam Lá Dứa',
    quantity: 130,
    quantityUnit: 'gram',
    ingredients: [
      { kind: 'PRODUCT', code: 'SP000354', quantity: 10, unit: 'gram' },
      { kind: 'PRODUCT', code: 'SP000500', quantity: 15, unit: 'gram' },
      { kind: 'PRODUCT', code: 'STTTW01', quantity: 5, unit: 'gram' },
      { kind: 'CUSTOM', name: 'Whipping Cream', quantity: 100, unit: 'gram' },
    ],
    step: 'Cho 10 gram bột kem cheese muối biển, 15 gram mứt lá dứa, 5 gram sữa tươi và 100 gram whipping cream vào ca. Dùng máy đánh kem đánh tới khi hỗn hợp thành kem foam.',
  },
];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const productCodes = [
      ...new Set(
        RECIPES.flatMap((recipe) =>
          recipe.ingredients
            .filter((ingredient): ingredient is Extract<Ingredient, { kind: 'PRODUCT' }> => ingredient.kind === 'PRODUCT')
            .map((ingredient) => ingredient.code),
        ),
      ),
    ];
    const products = await prisma.product.findMany({
      where: { code: { in: productCodes }, isActive: true },
      select: { id: true, code: true },
    });
    const productByCode = new Map(products.map((product) => [product.code, product]));
    const missingProducts = productCodes.filter((code) => !productByCode.has(code));

    if (missingProducts.length) {
      throw new Error(
        `Không tìm thấy Product đang hoạt động: ${missingProducts.join(', ')}`,
      );
    }

    let category = await prisma.recipeCategory.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { code: 'KEM-FOAM' },
          { name: { equals: 'Kem Foam', mode: 'insensitive' } },
        ],
      },
    });
    category = category
      ? await prisma.recipeCategory.update({
          where: { id: category.id },
          data: {
            code: 'KEM-FOAM',
            name: 'Kem Foam',
            type: 'SEMI_FINISHED',
            isActive: true,
          },
        })
      : await prisma.recipeCategory.create({
          data: {
            code: 'KEM-FOAM',
            name: 'Kem Foam',
            type: 'SEMI_FINISHED',
          },
        });

    let created = 0;
    let skipped = 0;
    for (const row of RECIPES) {
      const existing = await prisma.recipe.findUnique({
        where: { code: row.code },
      });
      if (existing) {
        if (existing.name !== row.name) {
          throw new Error(`${row.code} đã tồn tại nhưng sai tên: ${existing.name}`);
        }
        skipped += 1;
        console.log(`${row.code}: skipped - ${row.name}`);
        continue;
      }

      const recipe = await recipesService.create(
        {
          code: row.code,
          name: row.name,
          type: 'SEMI_FINISHED',
          categoryId: category.id,
          description: 'Công thức Kem foam nhập từ Lark Base Diệp Trà.',
          quantity: row.quantity,
          quantityUnit: row.quantityUnit,
          unit: 'mẻ',
          ingredients: row.ingredients.map((ingredient, sortOrder) =>
            ingredient.kind === 'PRODUCT'
              ? {
                  sourceType: 'PRODUCT' as const,
                  productId: productByCode.get(ingredient.code)!.id,
                  quantity: ingredient.quantity,
                  unit: ingredient.unit,
                  includeInCost: true,
                  sortOrder,
                }
              : {
                  sourceType: 'CUSTOM' as const,
                  customName: ingredient.name,
                  customUnit: ingredient.unit,
                  customPrice: 0,
                  quantity: ingredient.quantity,
                  unit: ingredient.unit,
                  includeInCost: false,
                  sortOrder,
                },
          ),
          steps: [
            {
              title: 'Đánh kem foam',
              content: row.step,
              sortOrder: 0,
            },
          ],
          media: row.media,
        },
        USER_ID,
      );
      created += 1;
      console.log(
        `${recipe.code}: created as ${recipe.status} - ${recipe.name}, categoryId=${category.id}`,
      );
    }

    console.log(`Hoàn tất Kem Foam: tạo ${created}, bỏ qua ${skipped}.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Không thể import công thức Kem Foam:', error);
  process.exit(1);
});
