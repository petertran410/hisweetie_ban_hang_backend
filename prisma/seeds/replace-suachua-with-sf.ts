import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const USER_ID = 1;
const SF_CODE = 'RCP-62154071';
const PRODUCT_CODE = 'SP000346';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const sf = await prisma.recipe.findUnique({
      where: { code: SF_CODE },
      select: { id: true, code: true, name: true, status: true, type: true },
    });
    if (!sf || sf.type !== 'SEMI_FINISHED' || sf.status !== 'PUBLISHED') {
      throw new Error(`${SF_CODE} chưa sẵn sàng`);
    }

    const recipes = await prisma.recipe.findMany({
      where: {
        deletedAt: null,
        OR: [
          { code: { startsWith: 'FTC-LARK-' } },
          { code: { startsWith: 'IB-LARK-' } },
        ],
        ingredients: { some: { product: { code: PRODUCT_CODE } } },
      },
      include: {
        ingredients: {
          include: { product: { select: { code: true } }, recipeReference: { select: { code: true } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { code: 'asc' },
    });

    for (const recipe of recipes) {
      const ingredients = recipe.ingredients.map((item, sortOrder) => {
        if (item.product?.code === PRODUCT_CODE) {
          return {
            sourceType: 'SEMI_FINISHED' as const,
            recipeReferenceId: sf.id,
            quantity: Number(item.quantity),
            unit: item.unit,
            includeInCost: true,
            sortOrder,
          };
        }
        if (item.sourceType === 'SEMI_FINISHED') {
          return {
            sourceType: 'SEMI_FINISHED' as const,
            recipeReferenceId: item.recipeReferenceId!,
            quantity: Number(item.quantity),
            unit: item.unit,
            includeInCost: item.includeInCost,
            sortOrder,
          };
        }
        if (item.sourceType === 'PRODUCT') {
          return {
            sourceType: 'PRODUCT' as const,
            productId: item.productId!,
            quantity: Number(item.quantity),
            unit: item.unit,
            includeInCost: item.includeInCost,
            sortOrder,
          };
        }
        return {
          sourceType: 'CUSTOM' as const,
          customName: item.customName!,
          customUnit: item.customUnit || item.unit,
          customPrice: item.customPrice == null ? 0 : Number(item.customPrice),
          quantity: Number(item.quantity),
          unit: item.unit,
          includeInCost: item.includeInCost,
          sortOrder,
        };
      });

      await recipesService.update(recipe.id, { ingredients }, USER_ID);
      await recipesService.calculateCost(recipe.id, {}, USER_ID, true);
      const updated = await recipesService.findOne(recipe.id, true);
      const sfLine = updated.ingredients.find((i) => i.recipeReferenceId === sf.id);
      console.log(
        `${updated.code}: ${updated.name} -> ${sf.code} ${sfLine?.quantity} ${sfLine?.unit}, cost=${updated.totalCost}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});