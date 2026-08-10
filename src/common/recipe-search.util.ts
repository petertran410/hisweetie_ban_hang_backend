import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const escapeRegex = (token: string) =>
  token.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
const MIN_LIKE_LEN = 2;
const PER_TOKEN_LIMIT = 5000;

export async function searchRecipeIds(
  prisma: PrismaService,
  search: string,
): Promise<number[]> {
  const tokens = (search || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return [];

  const tokenSets = await Promise.all(
    tokens.map((token) => {
      const nameCondition = Prisma.sql`unaccent(lower(name)) ~ ('\\m' || unaccent(lower(${escapeRegex(
        token,
      )})) || '\\M')`;
      const where =
        token.length >= MIN_LIKE_LEN
          ? Prisma.sql`${nameCondition} OR lower(code) LIKE lower(${`%${token}%`})`
          : nameCondition;
      return prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "recipes"
        WHERE "deleted_at" IS NULL AND (${where})
        LIMIT ${PER_TOKEN_LIMIT}
      `;
    }),
  );

  if (tokenSets.length === 1) return tokenSets[0].map((row) => row.id);
  const idSets = tokenSets.map((rows) => new Set(rows.map((row) => row.id)));
  return tokenSets[0]
    .filter((row) => idSets.every((ids) => ids.has(row.id)))
    .map((row) => row.id);
}
