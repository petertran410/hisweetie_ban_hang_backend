import { PrismaClient } from '@prisma/client';
import { slugifyVietnamese } from '../../src/common/slug.util';

const prisma = new PrismaClient();

async function main() {
  const recipes = await prisma.recipe.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, name: true, slug: true },
  });
  const used = new Set(
    recipes.flatMap((recipe) => recipe.slug ? [recipe.slug] : []),
  );
  let updated = 0;

  for (const recipe of recipes) {
    if (recipe.slug) continue;
    const base = slugifyVietnamese(recipe.name);
    let slug = base;
    let suffix = 2;
    while (used.has(slug)) slug = `${base}-${suffix++}`;

    await prisma.recipe.update({ where: { id: recipe.id }, data: { slug } });
    used.add(slug);
    updated++;
  }

  console.log(`Backfilled ${updated} recipe slug(s).`);
}

main()
  .catch((error) => {
    console.error('Recipe slug backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
