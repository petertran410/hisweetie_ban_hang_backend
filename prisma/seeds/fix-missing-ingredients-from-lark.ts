import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecipesService } from '../../src/recipes/recipes.service';

const USER_ID = 1;

async function main() {
  const manifest: { recipes: any[] } = JSON.parse(
    readFileSync(join(__dirname, 'lark-fruit-tea-ice-blended.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recipesService = app.get(RecipesService);

    const productCodes = [
      ...new Set(
        manifest.recipes.flatMap((r) =>
          r.ingredients.filter((i: any) => i.kind === 'PRODUCT').map((i: any) => i.code),
        ),
      ),
    ];
    const teaCodes = [
      ...new Set(
        manifest.recipes.flatMap((r) =>
          r.ingredients.filter((i: any) => i.kind === 'TEA').map((i: any) => i.code),
        ),
      ),
    ];
    const foamCodes = [
      ...new Set(
        manifest.recipes.flatMap((r) =>
          r.ingredients.filter((i: any) => i.kind === 'FOAM').map((i: any) => i.code),
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
      throw new Error(`Thiếu Product: ${missingProducts.join(', ')}`);
    }

    const teaRecipes = await prisma.recipe.findMany({
      where: { type: 'SEMI_FINISHED', status: 'PUBLISHED', deletedAt: null, category: { name: 'Trà ủ lạnh', deletedAt: null } },
      include: { ingredients: { where: { sourceType: 'PRODUCT' }, include: { product: { select: { code: true } } } } },
    });
    const teaByProductCode = new Map<string, { id: number }>();
    for (const r of teaRecipes) {
      const c = r.ingredients[0]?.product?.code;
      if (c) teaByProductCode.set(c, { id: r.id });
    }
    const missingTea = teaCodes.filter((c) => !teaByProductCode.has(c));
    if (missingTea.length) throw new Error(`Thiếu Trà ủ: ${missingTea.join(', ')}`);

    const foamRecipes = await prisma.recipe.findMany({
      where: { code: { in: foamCodes }, deletedAt: null },
      select: { id: true, code: true },
    });
    const foamByCode = new Map(foamRecipes.map((r) => [r.code, r]));

    let updated = 0;
    for (const row of manifest.recipes) {
      const existing = await prisma.recipe.findUnique({
        where: { code: row.code },
        include: { ingredients: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!existing) continue;

      // Build ingredient payload from manifest
      const ingredients = row.ingredients.map((ingredient: any, sortOrder: number) => {
        if (ingredient.kind === 'TEA') {
          return { sourceType: 'SEMI_FINISHED' as const, recipeReferenceId: teaByProductCode.get(ingredient.code)!.id, quantity: ingredient.quantity, unit: ingredient.unit, includeInCost: true, sortOrder };
        }
        if (ingredient.kind === 'FOAM') {
          const foam = foamByCode.get(ingredient.code);
          return { sourceType: 'SEMI_FINISHED' as const, recipeReferenceId: foam!.id, quantity: ingredient.quantity, unit: ingredient.unit, includeInCost: true, sortOrder };
        }
        if (ingredient.kind === 'PRODUCT') {
          return { sourceType: 'PRODUCT' as const, productId: productByCode.get(ingredient.code)!.id, quantity: ingredient.quantity, unit: ingredient.unit, includeInCost: true, sortOrder };
        }
        return { sourceType: 'CUSTOM' as const, customName: ingredient.name, customUnit: ingredient.unit, customPrice: 0, quantity: ingredient.quantity, unit: ingredient.unit, includeInCost: false, sortOrder };
      });

      // Compare lengths
      const dbQty = (item: any) => Number(item.quantity);
      const mfQty = (item: any) => item.quantity;
      const same =
        existing.ingredients.length === ingredients.length &&
        existing.ingredients.every((db, i) => {
          const mf = ingredients[i];
          if (db.sourceType !== mf.sourceType) return false;
          if (db.sourceType === 'PRODUCT' && db.productId !== mf.productId) return false;
          if (db.sourceType === 'SEMI_FINISHED' && db.recipeReferenceId !== mf.recipeReferenceId) return false;
          if (db.sourceType === 'CUSTOM' && db.customName !== mf.customName) return false;
          if (dbQty(db) !== mfQty(mf)) return false;
          if (db.unit !== mf.unit) return false;
          return true;
        });

      if (same) continue;

      await recipesService.update(existing.id, { ingredients }, USER_ID);
      await recipesService.calculateCost(existing.id, {}, USER_ID, true);
      updated += 1;
      console.log(`${row.code}: updated - ${row.name}`);
    }

    console.log(`Hoàn tất: cập nhật ${updated} công thức.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Lỗi:', error);
  process.exit(1);
});