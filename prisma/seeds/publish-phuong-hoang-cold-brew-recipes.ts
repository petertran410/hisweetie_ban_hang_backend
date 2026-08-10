import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const RECIPE_CODE_PREFIX = 'CB-PH-';
const EXPECTED_RECIPE_COUNT = 20;
const PUBLISH_USER_ID = 1;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);
    const recipes = await prisma.recipe.findMany({
      where: { code: { startsWith: RECIPE_CODE_PREFIX }, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, status: true },
    });

    if (recipes.length !== EXPECTED_RECIPE_COUNT) {
      throw new Error(
        `Cần đúng ${EXPECTED_RECIPE_COUNT} công thức ${RECIPE_CODE_PREFIX}*, hiện có ${recipes.length}.`,
      );
    }

    const invalid = recipes.filter(
      (recipe) => !['DRAFT', 'PUBLISHED'].includes(recipe.status),
    );
    if (invalid.length) {
      throw new Error(
        `Công thức không đủ điều kiện publish: ${invalid.map((recipe) => recipe.code).join(', ')}`,
      );
    }

    let published = 0;
    let skipped = 0;
    for (const recipe of recipes) {
      if (recipe.status === 'PUBLISHED') {
        skipped += 1;
        continue;
      }
      await recipesService.publish(
        recipe.id,
        { changeNote: 'Publish công thức Trà ủ lạnh Phượng Hoàng' },
        PUBLISH_USER_ID,
      );
      published += 1;
      console.log(`Đã publish ${recipe.code}.`);
    }

    console.log(`Hoàn tất: publish ${published}, bỏ qua ${skipped}.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Không thể publish công thức Trà ủ:', error);
  process.exit(1);
});
