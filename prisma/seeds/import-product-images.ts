/**
 * Import mapping ảnh sản phẩm vào DB PRODUCTION.
 *
 * Đọc prisma/seeds/data/product-image-map.json (xuất từ sandbox bằng
 * export:product-image-map), map theo Product.code, ghi vào product_images với
 * URL = ${baseUrl}/uploads/products/${filename}.
 *
 * File ảnh đã được upload sẵn vào uploads/products/ trên Docker production —
 * script này CHỈ ghi DB, không tải/ghi file.
 *
 * baseUrl mặc định lấy từ env API_URL (giống UploadService.getFileUrl), có thể
 * override bằng --base-url. KHÔNG có /api ở cuối — uploads serve ở root /uploads/.
 *
 * Ghi đè: REPLACE toàn bộ — mỗi code trong map sẽ bị xóa hết ảnh cũ rồi tạo lại.
 * Sản phẩm không có trong map không bị đụng.
 *
 * ⚠️ PHẢI chạy khi DATABASE_URL trỏ PRODUCTION (port 4050). Tự kiểm tra & dừng
 *    nếu sai port (trừ khi truyền --force-port để chủ động bỏ qua guard).
 *
 * Cách chạy:
 *   yarn import:product-images --dry-run          # đếm match + in URL mẫu
 *   yarn import:product-images --skip-existing     # resume, bỏ sp đã có ảnh prod
 *   yarn import:product-images                      # chạy thật toàn bộ
 *   yarn import:product-images --base-url https://backendpos.hisweetievietnam.com
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { readFileSync } from 'fs';

dotenv.config({ path: join(process.cwd(), '.env') });

const prisma = new PrismaClient();

const EXPECTED_PORT = '4050'; // production
const MAP_PATH = join(process.cwd(), 'prisma/seeds/data/product-image-map.json');

interface MapEntry {
  code: string;
  filenames: string[];
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function assertProduction(forcePort: boolean) {
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/:(\d+)\//);
  const port = m ? m[1] : '(unknown)';
  if (port !== EXPECTED_PORT) {
    if (forcePort) {
      console.warn(
        `  ⚠ DB port = ${port} (KHÔNG phải ${EXPECTED_PORT}) — bỏ qua guard do --force-port`,
      );
      return;
    }
    throw new Error(
      `DATABASE_URL đang trỏ port ${port}, nhưng import YÊU CẦU production (port ${EXPECTED_PORT}). ` +
        `Đổi .env sang production rồi chạy lại (hoặc --force-port nếu chắc chắn).`,
    );
  }
  console.log(`  DB port = ${port} (production) ✓`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipExisting = args.includes('--skip-existing');
  const forcePort = args.includes('--force-port');
  const baseUrlArg = getArgValue(args, '--base-url');

  const baseUrlRaw = baseUrlArg || process.env.API_URL;
  if (!baseUrlRaw) {
    throw new Error('Thiếu base URL: set API_URL trong .env hoặc truyền --base-url');
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, ''); // bỏ slash cuối

  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
  console.log('Import ảnh sản phẩm vào DB production');
  console.log(`  Mode: ${dryRun ? '[DRY-RUN]' : '[REAL RUN]'}`);
  assertProduction(forcePort);
  console.log(`  Base URL: ${baseUrl}`);
  console.log(
    '═══════════════════════════════════════════════════════════════\n',
  );

  const entries: MapEntry[] = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const totalFiles = entries.reduce((s, e) => s + e.filenames.length, 0);
  console.log(`  Đọc map: ${entries.length} sản phẩm / ${totalFiles} file\n`);

  // Dry-run: in 5 URL mẫu để kiểm host.
  if (dryRun) {
    console.log('  Mẫu URL sẽ ghi (5 dòng đầu):');
    let shown = 0;
    for (const e of entries) {
      for (const f of e.filenames) {
        if (shown >= 5) break;
        console.log(`    ${e.code} → ${baseUrl}/uploads/products/${f}`);
        shown++;
      }
      if (shown >= 5) break;
    }
    console.log('');
  }

  let matched = 0;
  let notFound = 0;
  let skipped = 0;
  let productsUpdated = 0;
  let imagesInserted = 0;
  const missingCodes: string[] = [];

  for (const entry of entries) {
    const product = await prisma.product.findUnique({
      where: { code: entry.code },
      select: { id: true },
    });

    if (!product) {
      notFound++;
      if (missingCodes.length < 50) missingCodes.push(entry.code);
      continue;
    }
    matched++;

    if (skipExisting) {
      const existing = await prisma.productImage.count({
        where: { productId: product.id },
      });
      if (existing > 0) {
        skipped++;
        continue;
      }
    }

    const urls = entry.filenames.map(
      (f) => `${baseUrl}/uploads/products/${f}`,
    );

    if (dryRun) continue;

    await prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany({ where: { productId: product.id } });
      await tx.productImage.createMany({
        data: urls.map((url) => ({ productId: product.id, image: url })),
      });
    });
    productsUpdated++;
    imagesInserted += urls.length;
  }

  console.log(
    '───────────────────────────────────────────────────────────────',
  );
  console.log(`Hoàn tất ${dryRun ? '[DRY-RUN]' : ''}.`);
  console.log(`  Map entries:               ${entries.length}`);
  console.log(`  Match sản phẩm production: ${matched}`);
  console.log(`  Không tìm thấy code:       ${notFound}`);
  if (skipExisting) console.log(`  Bỏ qua (đã có ảnh):        ${skipped}`);
  if (!dryRun) {
    console.log(`  Sản phẩm đã cập nhật:      ${productsUpdated}`);
    console.log(`  Số ảnh đã ghi:             ${imagesInserted}`);
  }
  if (missingCodes.length > 0) {
    console.log(
      `\n  Code có trong map nhưng KHÔNG có ở production (tối đa 50): ${missingCodes.join(', ')}`,
    );
  }
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
