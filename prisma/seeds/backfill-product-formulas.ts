// prisma/seeds/backfill-product-formulas.ts
//
// Mục đích: chuyển danh sách thành phần hiện có của hàng sản xuất (type 4)
// sang mô hình nhiều công thức. Mỗi sản phẩm type 4 có thành phần chưa gắn
// công thức → tạo "Công thức 1" (mặc định) và gắn các thành phần vào đó.
//
// Không xóa / sửa số lượng thành phần nào. Combo (type 1) không bị đụng tới.
// Chạy lại nhiều lần vẫn an toàn (idempotent).
//
// Cách chạy:  yarn seed:product-formulas  (sau khi `prisma db push`)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: {
      type: 4,
      comboComponents: { some: { formulaId: null } },
    },
    select: { id: true, code: true },
  });

  console.log(`🌱 ${products.length} hàng sản xuất cần tạo công thức mặc định`);

  for (const product of products) {
    await prisma.$transaction(async (tx) => {
      const existingDefault = await tx.productFormula.findFirst({
        where: { productId: product.id, isDefault: true },
      });
      const formula =
        existingDefault ??
        (await tx.productFormula.create({
          data: {
            productId: product.id,
            name: 'Công thức 1',
            isDefault: true,
            sortOrder: 0,
          },
        }));
      const { count } = await tx.productComponent.updateMany({
        where: { comboProductId: product.id, formulaId: null },
        data: { formulaId: formula.id },
      });
      console.log(
        `  ✅ ${product.code}: gắn ${count} thành phần vào "${formula.name}"`,
      );
    });
  }
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
