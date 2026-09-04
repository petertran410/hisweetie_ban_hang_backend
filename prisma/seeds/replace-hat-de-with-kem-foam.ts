import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const USER_ID = 1;
const FOAM_CODE = 'KF-LARK-001';
const PRODUCT_CODE = 'SP007476';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const foam = await prisma.recipe.findUnique({
      where: { code: FOAM_CODE },
      select: { id: true, code: true, name: true, status: true, type: true },
    });
    if (!foam || foam.type !== 'SEMI_FINISHED' || foam.status !== 'PUBLISHED') {
      throw new Error(`${FOAM_CODE} chưa sẵn sàng làm bán thành phẩm`);
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
          include: {
            product: { select: { code: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { code: 'asc' },
    });

    if (!recipes.length) {
      console.log('Không còn món Trà trái cây / Trà đá xay nào dùng bột hạt dẻ.');
      return;
    }

    for (const recipe of recipes) {
      const ingredients = recipe.ingredients.map((item, sortOrder) => {
        if (item.product?.code === PRODUCT_CODE) {
          return {
            sourceType: 'SEMI_FINISHED' as const,
            recipeReferenceId: foam.id,
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
      const foamLine = updated.ingredients.find(
        (item) => item.recipeReferenceId === foam.id,
      );
      console.log(
        `${updated.code}: ${updated.name} -> ${foam.code} ${foamLine?.quantity} ${foamLine?.unit}, cost=${updated.totalCost}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Không thể thay bột hạt dẻ bằng Kem Foam:', error);
  process.exit(1);
});
