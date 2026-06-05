/**
 * Export mapping ảnh sản phẩm từ DB SANDBOX ra JSON, để import sang production.
 *
 * Bối cảnh: ảnh đã được upload sẵn vào uploads/products/ trên Docker production,
 * nhưng tên file ngẫu nhiên (không chứa mã SP). Quan hệ "file nào thuộc sản phẩm
 * nào" chỉ nằm ở bảng product_images của DB sandbox (tạo lúc backfill từ Lark).
 * Script này trích quan hệ đó ra JSON, KEY theo Product.code (id 2 DB lệch nhau).
 *
 * Chỉ lưu BASENAME (bỏ host) — host production sẽ được ráp lại lúc import.
 *
 * ⚠️ PHẢI chạy khi DATABASE_URL trỏ SANDBOX (port 4051). Script tự kiểm tra port
 *    và dừng nếu không phải 4051 để tránh export nhầm DB.
 *
 * Cách chạy:
 *   yarn export:product-image-map
 *
 * Output: prisma/seeds/data/product-image-map.json
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { join, basename } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

dotenv.config({ path: join(process.cwd(), '.env') });

const prisma = new PrismaClient();

const EXPECTED_PORT = '4051'; // sandbox
const OUT_PATH = join(process.cwd(), 'prisma/seeds/data/product-image-map.json');
const MARKER = '/uploads/products/';

interface MapEntry {
  code: string;
  filenames: string[];
}

function assertSandbox() {
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/:(\d+)\//);
  const port = m ? m[1] : '(unknown)';
  if (port !== EXPECTED_PORT) {
    throw new Error(
      `DATABASE_URL đang trỏ port ${port}, nhưng export YÊU CẦU sandbox (port ${EXPECTED_PORT}). ` +
        `Đổi .env về sandbox rồi chạy lại.`,
    );
  }
  console.log(`  DB port = ${port} (sandbox) ✓`);
}

async function main() {
  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
  console.log('Export mapping ảnh sản phẩm (sandbox → JSON)');
  assertSandbox();
  console.log(
    '═══════════════════════════════════════════════════════════════\n',
  );

  // Lấy mọi ảnh uploads/products/, kèm code của product. Sắp xếp theo id để thứ
  // tự ảnh ổn định, tái lập được giữa các lần chạy.
  const rows = await prisma.productImage.findMany({
    where: { image: { contains: MARKER } },
    select: { id: true, image: true, product: { select: { code: true } } },
    orderBy: { id: 'asc' },
  });

  const byCode = new Map<string, string[]>();
  let skippedNoCode = 0;

  for (const r of rows) {
    const code = r.product?.code;
    if (!code) {
      skippedNoCode++;
      continue;
    }
    const file = basename(r.image);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push(file);
  }

  const entries: MapEntry[] = Array.from(byCode.entries()).map(
    ([code, filenames]) => ({ code, filenames }),
  );

  mkdirSync(join(process.cwd(), 'prisma/seeds/data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2), 'utf8');

  const totalFiles = entries.reduce((s, e) => s + e.filenames.length, 0);
  console.log(`  Sản phẩm (code) có ảnh: ${entries.length}`);
  console.log(`  Tổng file ảnh:          ${totalFiles}`);
  if (skippedNoCode > 0) {
    console.log(`  Bỏ qua (ảnh không có code product): ${skippedNoCode}`);
  }
  console.log(`\n  → Ghi: ${OUT_PATH}`);
  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
