// prisma/seeds/backfill-primary-product-images.ts
//
// Mục đích: sản phẩm có ảnh nhưng chưa có ảnh chính → đánh dấu ảnh đầu tiên
// (id nhỏ nhất) là ảnh chính. Không đụng sản phẩm đã có ảnh chính.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy:  yarn backfill:primary-product-images  (sau khi `prisma db push`)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const updated = await prisma.$executeRaw`
    UPDATE product_images SET is_primary = true
    WHERE id IN (
      SELECT DISTINCT ON ("productId") id
      FROM product_images
      WHERE "productId" NOT IN (
        SELECT "productId" FROM product_images WHERE is_primary = true
      )
      ORDER BY "productId", id
    )
  `;
  console.log(`✅ Đã đánh dấu ảnh chính cho ${updated} sản phẩm`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
