import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const USER_ID = 1;

type Unit = string;
type Ingredient =
  | { kind: 'TEA'; code: string; quantity: number; unit: Unit }
  | { kind: 'PRODUCT'; code: string; quantity: number; unit: Unit }
  | { kind: 'FOAM'; code: string; quantity: number; unit: Unit }
  | { kind: 'CUSTOM'; name: string; quantity: number; unit: Unit };

type RecipeRow = {
  code: string;
  name: string;
  category: 'TRA-TRAI-CAY' | 'TRA-DA-XAY';
  ingredients: Ingredient[];
};

type Manifest = {
  recipes: RecipeRow[];
  skipped: Array<{ name: string; reason: string }>;
};

const CATEGORIES = {
  'TRA-TRAI-CAY': { name: 'Trà trái cây', prefix: 'Trà trái cây' },
  'TRA-DA-XAY': { name: 'Trà đá xay', prefix: 'Trà đá xay' },
} as const;

async function upsertCategory(
  prisma: PrismaService,
  code: keyof typeof CATEGORIES,
) {
  const meta = CATEGORIES[code];
  const existing = await prisma.recipeCategory.findFirst({
    where: {
      deletedAt: null,
      OR: [{ code }, { name: { equals: meta.name, mode: 'insensitive' } }],
    },
  });
  if (existing) {
    return prisma.recipeCategory.update({
      where: { id: existing.id },
      data: {
        code,
        name: meta.name,
        type: 'FINISHED_PRODUCT',
        isActive: true,
      },
    });
  }
  return prisma.recipeCategory.create({
    data: { code, name: meta.name, type: 'FINISHED_PRODUCT' },
  });
}

async function main() {
  const manifest: Manifest = JSON.parse(
    readFileSync(
      join(__dirname, 'lark-fruit-tea-ice-blended.json'),
      'utf8',
    ),
  );
  if (manifest.skipped?.length) {
    console.log(
      `Bỏ qua ${manifest.skipped.length} món incomplete: ${manifest.skipped
        .map((row) => row.name)
        .join(', ')}`,
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const productCodes = [
      ...new Set(
        manifest.recipes.flatMap((recipe) =>
          recipe.ingredients
            .filter(
              (ingredient): ingredient is Extract<Ingredient, { kind: 'PRODUCT' }> =>
                ingredient.kind === 'PRODUCT',
            )
            .map((ingredient) => ingredient.code),
        ),
      ),
    ];
    const teaCodes = [
      ...new Set(
        manifest.recipes.flatMap((recipe) =>
          recipe.ingredients
            .filter(
              (ingredient): ingredient is Extract<Ingredient, { kind: 'TEA' }> =>
                ingredient.kind === 'TEA',
            )
            .map((ingredient) => ingredient.code),
        ),
      ),
    ];
    const foamCodes = [
      ...new Set(
        manifest.recipes.flatMap((recipe) =>
          recipe.ingredients
            .filter(
              (ingredient): ingredient is Extract<Ingredient, { kind: 'FOAM' }> =>
                ingredient.kind === 'FOAM',
            )
            .map((ingredient) => ingredient.code),
        ),
      ),
    ];

    const products = await prisma.product.findMany({
      where: { code: { in: productCodes }, isActive: true },
      select: { id: true, code: true },
    });
    const productByCode = new Map(products.map((row) => [row.code, row]));
    const missingProducts = productCodes.filter((code) => !productByCode.has(code));
    if (missingProducts.length) {
      throw new Error(
        `Thiếu Product đang hoạt động: ${missingProducts.join(', ')}`,
      );
    }

    const teaRecipes = await prisma.recipe.findMany({
      where: {
        type: 'SEMI_FINISHED',
        status: 'PUBLISHED',
        deletedAt: null,
        category: { name: 'Trà ủ lạnh', deletedAt: null },
      },
      include: {
        ingredients: {
          where: { sourceType: 'PRODUCT' },
          include: { product: { select: { code: true } } },
        },
      },
    });
    const teaByProductCode = new Map<string, { id: number }>();
    for (const recipe of teaRecipes) {
      const productCode = recipe.ingredients[0]?.product?.code;
      if (productCode) teaByProductCode.set(productCode, { id: recipe.id });
    }
    const missingTea = teaCodes.filter((code) => !teaByProductCode.has(code));
    if (missingTea.length) {
      throw new Error(`Thiếu bán thành phẩm Trà ủ: ${missingTea.join(', ')}`);
    }

    const foamRecipes = await prisma.recipe.findMany({
      where: { code: { in: foamCodes }, deletedAt: null },
      select: { id: true, code: true, status: true, type: true },
    });
    const foamByCode = new Map(foamRecipes.map((row) => [row.code, row]));
    const missingFoam = foamCodes.filter((code) => {
      const recipe = foamByCode.get(code);
      return !recipe || recipe.type !== 'SEMI_FINISHED' || recipe.status !== 'PUBLISHED';
    });
    if (missingFoam.length) {
      throw new Error(
        `Thiếu Kem Foam đã publish: ${missingFoam.join(', ')}`,
      );
    }

    const fruitCategory = await upsertCategory(prisma, 'TRA-TRAI-CAY');
    const iceCategory = await upsertCategory(prisma, 'TRA-DA-XAY');
    const categoryByCode = {
      'TRA-TRAI-CAY': fruitCategory,
      'TRA-DA-XAY': iceCategory,
    };

    let created = 0;
    let published = 0;
    let skipped = 0;
    for (const row of manifest.recipes) {
      const meta = CATEGORIES[row.category];
      const fullName = `${meta.prefix} - ${row.name}`;
      const existing = await prisma.recipe.findUnique({
        where: { code: row.code },
      });
      let recipeId = existing?.id;
      if (!recipeId) {
        const ingredients = row.ingredients.map((ingredient, sortOrder) => {
          if (ingredient.kind === 'TEA') {
            return {
              sourceType: 'SEMI_FINISHED' as const,
              recipeReferenceId: teaByProductCode.get(ingredient.code)!.id,
              quantity: ingredient.quantity,
              unit: ingredient.unit,
              includeInCost: true,
              sortOrder,
            };
          }
          if (ingredient.kind === 'FOAM') {
            return {
              sourceType: 'SEMI_FINISHED' as const,
              recipeReferenceId: foamByCode.get(ingredient.code)!.id,
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
            code: row.code,
            name: fullName,
            type: 'FINISHED_PRODUCT',
            categoryId: categoryByCode[row.category].id,
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
      if (detail.name !== fullName) {
        throw new Error(`${row.code} đã tồn tại nhưng sai tên: ${detail.name}`);
      }
      if (detail.status === 'DRAFT') {
        await recipesService.publish(
          detail.id,
          { changeNote: 'Publish công thức từ Lark Base Diệp Trà' },
          USER_ID,
        );
        published += 1;
        console.log(`${row.code}: published - ${fullName}`);
      } else {
        skipped += 1;
        console.log(`${row.code}: skipped - ${fullName}`);
      }
    }

    console.log(
      `Hoàn tất: tạo ${created}, publish ${published}, bỏ qua ${skipped}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Không thể import Trà trái cây / Trà đá xay:', error);
  process.exit(1);
});
