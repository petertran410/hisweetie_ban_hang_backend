/**
 * Backfill ảnh sản phẩm từ Lark Base → bảng `product_images` của POS.
 *
 * Nguồn ảnh: field "Hình Ảnh Kiot" (attachment) trong bảng "Sản Phẩm" của Lark
 * Base. Mỗi attachment được TẢI THẲNG về `uploads/products/` (nén/resize/HEIC
 * qua UploadService), KHÔNG lưu tmp_url của Lark (tmp_url hết hạn sau ~24h).
 *
 * Map sản phẩm: "Mã Hàng Hoá" (Lark) === Product.code (POS, unique).
 *
 * Ghi đè: REPLACE toàn bộ — với mỗi sản phẩm match được và có ảnh Kiot, xóa hết
 * `product_images` cũ rồi tạo lại từ ảnh Lark (đúng lựa chọn "Lark là nguồn
 * chuẩn"). Sản phẩm KHÔNG có ảnh Kiot trên Lark sẽ được bỏ qua (không đụng tới
 * ảnh POS hiện có).
 *
 * Env required (.env):
 *   LARK_APP_ID, LARK_APP_SECRET           — app backend (cli_a76086da2978d02f)
 *   LARK_PRODUCT_BASE_TOKEN                — base "Sản Phẩm" (Vx4hb0o0...)
 *   LARK_PRODUCT_SYNC_TABLE_ID             — table "Sản Phẩm" (tbldKbrNjFkqdzao)
 *   DATABASE_URL
 *
 * Scope cần cấp cho app backend trong Lark Developer Console:
 *   - base:record:read  (đọc record bảng sản phẩm)
 *   - drive:drive:readonly hoặc drive:file:download (tải attachment)
 * App backend cũng phải được add làm collaborator (quyền đọc) của base.
 *
 * Cách chạy:
 *   yarn backfill:product-images --dry-run            # chỉ thống kê, không ghi
 *   yarn backfill:product-images --code SP007545      # chạy thật 1 sản phẩm
 *   yarn backfill:product-images --limit 20           # giới hạn N sản phẩm đầu
 *   yarn backfill:product-images                       # chạy thật toàn bộ
 *
 * ⚠️ REPLACE sẽ xóa ảnh đã chỉnh tay trên POS của những sản phẩm có ảnh Kiot.
 *    Nên backup bảng product_images trước khi chạy full.
 */
import { PrismaClient } from '@prisma/client';
import * as lark from '@larksuiteoapi/node-sdk';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { Readable } from 'stream';
import { UploadService } from '../../src/upload/upload.service';

dotenv.config({ path: join(process.cwd(), '.env') });

const prisma = new PrismaClient();
const uploadService = new UploadService();

// Field "Hình Ảnh Kiot" và "Mã Hàng Hoá" trong bảng Sản Phẩm Lark.
const FIELD_IMAGE = 'Hình Ảnh Kiot';
const FIELD_CODE = 'Mã Hàng Hoá';

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

interface LarkAttachment {
  file_token: string;
  name?: string;
  type?: string; // mime type
  // `extra` lấy từ query param của `url`/`tmp_url` — chứa bitablePerm (tableId +
  // rev). media.download của Base attachment BẮT BUỘC có extra này, thiếu → 400.
  extra?: string;
}

interface ProductRecord {
  code: string;
  attachments: LarkAttachment[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient(): lark.Client {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID / LARK_APP_SECRET phải được cấu hình');
  }
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
  });
}

/**
 * Kéo toàn bộ record (phân trang) lấy code + attachment "Hình Ảnh Kiot".
 * Chỉ giữ record có ít nhất 1 attachment hợp lệ và có code.
 */
async function fetchProductRecords(
  client: lark.Client,
  baseToken: string,
  tableId: string,
): Promise<ProductRecord[]> {
  const records: ProductRecord[] = [];
  let pageToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res: any = await client.bitable.appTableRecord.list({
      path: { app_token: baseToken, table_id: tableId },
      params: {
        field_names: JSON.stringify([FIELD_CODE, FIELD_IMAGE]),
        page_size: 500,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    if (res?.code && res.code !== 0) {
      throw new Error(`record.list code=${res.code} msg=${res.msg}`);
    }

    const items = res?.data?.items || [];
    for (const item of items) {
      const fields = item?.fields || {};
      const rawCode = fields[FIELD_CODE];
      // Field text có thể trả string hoặc mảng segment [{text}].
      const code = normalizeText(rawCode);
      const attachments: LarkAttachment[] = Array.isArray(fields[FIELD_IMAGE])
        ? fields[FIELD_IMAGE]
            .filter((a: any) => a && a.file_token)
            .map((a: any) => ({
              file_token: a.file_token,
              name: a.name,
              type: a.type,
              extra: extractExtra(a.url || a.tmp_url),
            }))
        : [];

      if (code && attachments.length > 0) {
        records.push({ code, attachments });
      }
    }

    if (!res?.data?.has_more) break;
    pageToken = res?.data?.page_token;
  }
  return records;
}

/** Field text Lark có thể là string hoặc [{ text, type }]. Chuẩn hóa về string. */
function normalizeText(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((seg) => (typeof seg === 'string' ? seg : seg?.text || ''))
      .join('')
      .trim();
  }
  if (typeof value === 'object' && value.text) return String(value.text).trim();
  return String(value).trim();
}

/**
 * Trích query param `extra` từ url/tmp_url của attachment. Base attachment có
 * dạng: .../medias/<token>/download?extra=%7B%22bitablePerm%22...%7D
 * media.download cần đúng extra này (bitablePerm), thiếu sẽ trả HTTP 400.
 */
function extractExtra(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.searchParams.get('extra') || undefined;
  } catch {
    return undefined;
  }
}

/** Tải attachment Base về Buffer qua drive.media.download (stream). */
async function downloadAttachment(
  client: lark.Client,
  fileToken: string,
  extra?: string,
): Promise<Buffer> {
  const res: any = await client.drive.media.download({
    path: { file_token: fileToken },
    ...(extra ? { params: { extra } } : {}),
  });
  const stream: Readable = res.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function guessMime(att: LarkAttachment): string {
  if (att.type && ALLOWED_MIMES.has(att.type.toLowerCase())) {
    return att.type.toLowerCase();
  }
  const name = (att.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.heic')) return 'image/heic';
  if (name.endsWith('.heif')) return 'image/heif';
  return 'image/jpeg';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  // Bỏ qua sản phẩm đã có ảnh trong uploads/products/ (dùng để resume sau khi
  // chạy dở dang, tránh tải lại từ đầu).
  const skipExisting = args.includes('--skip-existing');
  const codeFilter = getArgValue(args, '--code');
  const limit = getArgValue(args, '--limit');
  const limitN = limit ? parseInt(limit, 10) : undefined;

  const baseToken = process.env.LARK_PRODUCT_BASE_TOKEN;
  const tableId = process.env.LARK_PRODUCT_SYNC_TABLE_ID;
  if (!baseToken || !tableId) {
    throw new Error(
      'LARK_PRODUCT_BASE_TOKEN / LARK_PRODUCT_SYNC_TABLE_ID phải được cấu hình',
    );
  }

  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
  console.log('Backfill ảnh sản phẩm từ Lark Base ("Hình Ảnh Kiot")');
  console.log(`  Mode: ${dryRun ? '[DRY-RUN]' : '[REAL RUN]'}`);
  console.log(`  Base: ${baseToken} · Table: ${tableId}`);
  if (codeFilter) console.log(`  Lọc theo code: ${codeFilter}`);
  if (limitN) console.log(`  Giới hạn: ${limitN} sản phẩm`);
  console.log(
    '═══════════════════════════════════════════════════════════════\n',
  );

  const client = getClient();

  console.log('Đang kéo records từ Lark...');
  let records = await fetchProductRecords(client, baseToken, tableId);
  console.log(`  → ${records.length} record có "Hình Ảnh Kiot" và mã hàng\n`);

  if (codeFilter) {
    records = records.filter((r) => r.code === codeFilter);
    console.log(`  Sau lọc theo code: ${records.length} record\n`);
  }
  if (limitN) {
    records = records.slice(0, limitN);
  }

  // Resume: bỏ qua các code đã có ảnh uploads/products/ trong DB.
  if (skipExisting && !dryRun) {
    const done = await prisma.productImage.findMany({
      where: { image: { contains: '/uploads/products/' } },
      select: { product: { select: { code: true } } },
    });
    const doneCodes = new Set(done.map((r) => r.product.code));
    const before = records.length;
    records = records.filter((r) => !doneCodes.has(r.code));
    console.log(
      `  --skip-existing: bỏ qua ${before - records.length} sản phẩm đã có ảnh, còn ${records.length}\n`,
    );
  }

  let matched = 0;
  let notFound = 0;
  let imagesSaved = 0;
  let productsUpdated = 0;
  let downloadErrors = 0;
  const missingCodes: string[] = [];

  for (const record of records) {
    const product = await prisma.product.findUnique({
      where: { code: record.code },
      select: { id: true, code: true },
    });

    if (!product) {
      notFound++;
      if (missingCodes.length < 50) missingCodes.push(record.code);
      continue;
    }
    matched++;

    // Tải & lưu từng ảnh về uploads/products/
    const urls: string[] = [];
    for (const att of record.attachments) {
      if (dryRun) {
        urls.push(`(dry) ${att.name || att.file_token}`);
        continue;
      }
      try {
        const buffer = await downloadAttachment(
          client,
          att.file_token,
          att.extra,
        );
        const mime = guessMime(att);
        const saved = await uploadService.saveImage(
          buffer,
          att.name || `${record.code}.jpg`,
          mime,
          'products',
        );
        urls.push(saved.url);
        imagesSaved++;
        await delay(150); // nhẹ tay với drive download (giới hạn ~5 QPS)
      } catch (err) {
        downloadErrors++;
        console.warn(
          `  ⚠ Tải ảnh lỗi: code=${record.code} token=${att.file_token} → ${(err as Error).message}`,
        );
      }
    }

    if (dryRun) {
      console.log(
        `  [DRY] ${record.code} · ${record.attachments.length} ảnh sẽ tải & thay thế`,
      );
      continue;
    }

    if (urls.length === 0) {
      console.warn(`  ⚠ ${record.code}: không tải được ảnh nào, giữ nguyên.`);
      continue;
    }

    // REPLACE toàn bộ ảnh của sản phẩm.
    await prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany({ where: { productId: product.id } });
      await tx.productImage.createMany({
        data: urls.map((url) => ({ productId: product.id, image: url })),
      });
    });
    productsUpdated++;
    console.log(`  ✓ ${record.code}: thay bằng ${urls.length} ảnh`);
  }

  console.log(
    '\n───────────────────────────────────────────────────────────────',
  );
  console.log(`Hoàn tất ${dryRun ? '[DRY-RUN]' : ''}.`);
  console.log(`  Record Lark có ảnh Kiot:   ${records.length}`);
  console.log(`  Match sản phẩm POS:        ${matched}`);
  console.log(`  Không tìm thấy code:       ${notFound}`);
  if (!dryRun) {
    console.log(`  Ảnh đã tải & lưu:          ${imagesSaved}`);
    console.log(`  Sản phẩm đã cập nhật ảnh:  ${productsUpdated}`);
    console.log(`  Lỗi tải ảnh:               ${downloadErrors}`);
  }
  if (missingCodes.length > 0) {
    console.log(
      `\n  Một số code Lark không có trong POS (tối đa 50): ${missingCodes.join(', ')}`,
    );
  }
  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
