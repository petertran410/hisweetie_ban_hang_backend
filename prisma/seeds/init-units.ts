// prisma/seeds/init-units.ts
//
// Khởi tạo danh mục Đơn vị tính từ các giá trị Product.unit đang có.
//   1. Gom các cách viết khác nhau của cùng một đơn vị (khác hoa/thường,
//      khoảng trắng, dấu gõ tách rời) → giữ cách viết có nhiều sản phẩm nhất.
//   2. Tạo các đơn vị còn thiếu trong bảng `units` (đơn vị đã có thì giữ tên).
//   3. Bảo đảm có "Thùng" là đơn vị hệ thống (code CARTON).
//   4. Sửa Product.unit của các cách viết lệch về tên chuẩn.
//
// KHÔNG xóa gì. Mặc định chỉ CHẠY THỬ (in ra việc sẽ làm). Thêm --apply để ghi.
//
// Cách chạy:
//   yarn seed:init-units            # chạy thử
//   yarn seed:init-units --apply    # ghi thật

import { PrismaClient } from '@prisma/client';
import {
  CARTON_UNIT_CODE,
  CARTON_UNIT_NAME,
  cleanUnitName,
  normalizeUnitKey,
} from '../../src/common/unit.util';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(
    APPLY ? '✍️  CHẾ ĐỘ GHI (--apply)' : '🔍 CHẠY THỬ — không ghi gì',
  );

  const groups = await prisma.product.groupBy({
    by: ['unit'],
    _count: { _all: true },
  });

  // khóa chuẩn hóa → các cách viết đang có + số sản phẩm
  const byKey = new Map<
    string,
    { variants: Map<string, number>; total: number }
  >();
  for (const g of groups) {
    const key = normalizeUnitKey(g.unit);
    if (!key || g.unit == null) continue;
    const entry = byKey.get(key) ?? { variants: new Map(), total: 0 };
    entry.variants.set(
      g.unit,
      (entry.variants.get(g.unit) ?? 0) + g._count._all,
    );
    entry.total += g._count._all;
    byKey.set(key, entry);
  }

  const existingUnits = await prisma.unit.findMany();
  const existingByKey = new Map(
    existingUnits.map((u) => [normalizeUnitKey(u.name), u]),
  );

  const cartonKey = normalizeUnitKey(CARTON_UNIT_NAME);
  if (!byKey.has(cartonKey))
    byKey.set(cartonKey, { variants: new Map(), total: 0 });

  // Thứ tự: nhiều sản phẩm dùng nhất lên trước.
  const sorted = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total);

  const toCreate: { name: string; sortOrder: number; isCarton: boolean }[] = [];
  const productFixes: { from: string; to: string; count: number }[] = [];
  const nextSort =
    existingUnits.reduce((max, u) => Math.max(max, u.sortOrder), 0) + 1;

  sorted.forEach(([key, entry], index) => {
    const existing = existingByKey.get(key);
    const mostUsed = [...entry.variants.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const canonical =
      existing?.name ??
      (key === cartonKey
        ? CARTON_UNIT_NAME
        : cleanUnitName(mostUsed ? mostUsed[0] : key));

    if (!existing) {
      toCreate.push({
        name: canonical,
        sortOrder: nextSort + index,
        isCarton: key === cartonKey,
      });
    }
    for (const [variant, count] of entry.variants) {
      if (variant !== canonical)
        productFixes.push({ from: variant, to: canonical, count });
    }
  });

  const carton = existingByKey.get(cartonKey);
  const cartonNeedsFlag =
    !!carton &&
    (carton.code !== CARTON_UNIT_CODE || !carton.isSystem || !carton.isActive);

  console.log(`\nĐơn vị sẽ tạo (${toCreate.length}):`);
  toCreate.forEach((u) =>
    console.log(
      `  + ${u.name}${u.isCarton ? '  [hệ thống, code CARTON]' : ''}`,
    ),
  );
  if (cartonNeedsFlag)
    console.log(`  ~ Đánh dấu "${carton!.name}" là đơn vị hệ thống CARTON`);
  console.log(
    `\nSản phẩm sẽ sửa Đơn vị tính (${productFixes.length} cách viết):`,
  );
  productFixes.forEach((f) =>
    console.log(`  "${f.from}" → "${f.to}"  (${f.count} sản phẩm)`),
  );

  if (!APPLY) {
    console.log('\n👉 Chạy lại với --apply để ghi.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const u of toCreate) {
      await tx.unit.create({
        data: {
          name: u.name,
          sortOrder: u.sortOrder,
          ...(u.isCarton ? { code: CARTON_UNIT_CODE, isSystem: true } : {}),
        },
      });
    }
    if (cartonNeedsFlag) {
      await tx.unit.update({
        where: { id: carton!.id },
        data: { code: CARTON_UNIT_CODE, isSystem: true, isActive: true },
      });
    }
    for (const f of productFixes) {
      await tx.product.updateMany({
        where: { unit: f.from },
        data: { unit: f.to },
      });
    }
  });
  console.log('\n✅ Đã ghi.');
}

main()
  .catch((error) => {
    console.error('❌ Lỗi khi khởi tạo Đơn vị tính:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
