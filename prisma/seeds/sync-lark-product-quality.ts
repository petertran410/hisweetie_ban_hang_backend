// prisma/seeds/sync-lark-product-quality.ts
//
// Script đồng bộ dữ liệu sự cố chất lượng từ LarkBase (bảng tblF032Qb8D2dcyd) vào POS.
// Hỗ trợ 2 chế độ:
// 1. Chỉ đồng bộ record nhanh (~5-10s):
//    yarn sync:lark-product-quality --records-only
// 2. Chạy tải bổ sung hình ảnh vào uploads/product-quality/:
//    yarn sync:lark-product-quality --media
// 3. Chạy toàn bộ (record + hình):
//    yarn sync:lark-product-quality --all
// 4. Giới hạn số lượng (thử nghiệm):
//    yarn sync:lark-product-quality --limit 10

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ProductQualityLarkService } from '../../src/product-quality/product-quality-lark.service';
import { PrismaService } from '../../src/prisma/prisma.service';

async function main() {
  const startTime = Date.now();
  const args = process.argv.slice(2);

  const recordsOnly = args.includes('--records-only');
  const mediaOnly = args.includes('--media');
  const isAll = args.includes('--all');
  const isDryRun = args.includes('--dry-run');

  // Xử lý --limit <n>
  let limit: number | undefined;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }

  // Mặc định downloadMedia nếu có cờ --media hoặc --all, ngược lại nếu --records-only thì tắt
  const downloadMedia = mediaOnly || isAll ? true : recordsOnly ? false : false;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 ĐỒNG BỘ CHẤT LƯỢNG HÀNG HÓA TỪ LARKBASE VÀO POS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`• Chế độ tải ảnh (Media): ${downloadMedia ? 'BẬT (lưu vào uploads/product-quality/)' : 'TẮT (chỉ đồng bộ record)'}`);
  console.log(`• Chế độ xem trước (Dry run): ${isDryRun ? 'BẬT (không ghi dữ liệu)' : 'TẮT (ghi dữ liệu thật)'}`);
  if (limit) console.log(`• Giới hạn số bản ghi: ${limit}`);
  console.log('---------------------------------------------------------------');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const larkService = app.get(ProductQualityLarkService);

    // Tìm admin user để gán createdById
    const adminUser = await prisma.user.findFirst({
      where: {
        OR: [
          { roles: { contains: 'Super Admin' } },
          { id: 1 },
        ],
      },
      select: { id: true, name: true },
    });
    const actorId = adminUser?.id || 1;

    console.log(`⏳ Đang đọc dữ liệu từ LarkBase...`);

    const result = await larkService.sync(
      {
        baseToken: 'Vx4hb0o0Va3S1RsvbpGl4imYgYc',
        tableId: 'tblF032Qb8D2dcyd',
        dryRun: isDryRun,
        limit,
        downloadMedia,
      },
      actorId,
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ KẾT QUẢ ĐỒNG BỘ:');
    console.log(`• Tổng bản ghi đọc được từ Lark: ${result.totalFetched}`);
    console.log(`• Phiếu tạo mới: ${result.importedCount}`);
    console.log(`• Phiếu cập nhật: ${result.updatedCount}`);
    console.log(`• Phiếu lỗi/bỏ qua: ${result.skippedCount}`);
    console.log(`• Khớp khách hàng POS: ${result.matchedCustomers}`);
    console.log(`• Khớp sản phẩm POS: ${result.matchedProducts}`);
    console.log(`• Khớp hóa đơn POS: ${result.matchedInvoices}`);
    console.log('---------------------------------------------------------------');
    console.log('🖼  THỐNG KÊ HÌNH ẢNH & VIDEO (uploads/product-quality/):');
    console.log(`• Tổng số file phát hiện: ${result.mediaStats.totalDiscovered}`);
    console.log(`• File đã tải về POS: ${result.mediaStats.downloaded}`);
    console.log(`• File đã có sẵn (bỏ qua): ${result.mediaStats.skippedExisting}`);
    console.log(`• File tải lỗi: ${result.mediaStats.failed}`);
    console.log(`⏱ Thời gian thực hiện: ${elapsed} giây`);
    console.log('═══════════════════════════════════════════════════════════════');
  } catch (err: any) {
    console.error('❌ Lỗi đồng bộ LarkBase:', err.message || err);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
