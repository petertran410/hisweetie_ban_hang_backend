// prisma/seeds/backfill-product-attributes.ts
//
// Chuyển dữ liệu thuộc tính cũ từ cột products.attributesText (dạng
// "Vị:Ngọt|Màu sắc:Đen") sang mô hình danh mục quan hệ:
//   attribute_definitions (title, unique)
//   attribute_values ([definitionId, value], unique)
//   product_attributes ([productId, attributeValueId], unique)
//
// ⚠️ CHẠY SCRIPT NÀY TRƯỚC KHI DROP CỘT attributesText.
// Quy trình an toàn:
//   1. Sửa schema THÊM 3 bảng mới nhưng GIỮ cột attributesText → npx prisma db push
//   2. npx prisma generate
//   3. npx ts-node prisma/seeds/backfill-product-attributes.ts   ← script này
//   4. Xóa cột attributesText khỏi schema → npx prisma db push (accept data loss)
//
// Script đọc attributesText bằng raw SQL nên không phụ thuộc vào việc field còn
// tồn tại trong Prisma Client hay không.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseAttributesText(
  attributesText: string | null,
): { name: string; value: string }[] {
  if (!attributesText) return [];
  const seen = new Set<string>();
  const result: { name: string; value: string }[] = [];
  for (const part of attributesText.split('|')) {
    const [name, value] = part.split(':');
    const n = (name || '').trim();
    const v = (value || '').trim();
    if (!n || !v) continue;
    const key = `${n.toLowerCase()}::${v.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name: n, value: v });
  }
  return result;
}

async function main() {
  // Đọc trực tiếp cột attributesText qua raw SQL (không qua Prisma model).
  const rows = await prisma.$queryRaw<
    { id: number; attributesText: string | null }[]
  >`SELECT id, "attributesText" FROM products WHERE "attributesText" IS NOT NULL AND "attributesText" <> ''`;

  console.log(`Tìm thấy ${rows.length} sản phẩm có attributesText cần backfill.`);

  // Cache để tránh upsert lặp.
  const definitionCache = new Map<string, number>();
  const valueCache = new Map<string, number>();

  let migratedProducts = 0;
  let migratedPairs = 0;

  for (const row of rows) {
    const attrs = parseAttributesText(row.attributesText);
    if (attrs.length === 0) continue;

    const valueIds: number[] = [];

    for (const attr of attrs) {
      const nameKey = attr.name.toLowerCase();
      let definitionId = definitionCache.get(nameKey);
      if (definitionId === undefined) {
        const definition = await prisma.attributeDefinition.upsert({
          where: { name: attr.name },
          update: {},
          create: { name: attr.name },
        });
        definitionId = definition.id;
        definitionCache.set(nameKey, definitionId);
      }

      const valueKey = `${definitionId}::${attr.value.toLowerCase()}`;
      let valueId = valueCache.get(valueKey);
      if (valueId === undefined) {
        const attributeValue = await prisma.attributeValue.upsert({
          where: {
            attributeDefinitionId_value: {
              attributeDefinitionId: definitionId,
              value: attr.value,
            },
          },
          update: {},
          create: { attributeDefinitionId: definitionId, value: attr.value },
        });
        valueId = attributeValue.id;
        valueCache.set(valueKey, valueId);
      }
      valueIds.push(valueId);
    }

    if (valueIds.length > 0) {
      await prisma.productAttribute.createMany({
        data: valueIds.map((attributeValueId) => ({
          productId: row.id,
          attributeValueId,
        })),
        skipDuplicates: true,
      });
      migratedProducts += 1;
      migratedPairs += valueIds.length;
    }
  }

  console.log(
    `Hoàn tất: ${migratedProducts} sản phẩm, ${migratedPairs} cặp thuộc tính đã được backfill.`,
  );
  console.log(
    `Số title (definitions): ${definitionCache.size}, số value: ${valueCache.size}.`,
  );
}

main()
  .catch((e) => {
    console.error('Backfill thất bại:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
