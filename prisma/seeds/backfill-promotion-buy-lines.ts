// prisma/seeds/backfill-promotion-buy-lines.ts
//
// Backfill promotionId lên các dòng hàng X (hàng mua điều kiện) của HĐ/đơn CŨ,
// để tab "Thống kê hàng khuyến mãi" thống kê được số lượng hàng bán.
//
// Nguồn xác định KM nào áp cho HĐ/đơn nào: bảng invoice_promotion_logs
// (đã gắn invoiceId/orderId + promotionId). Chỉ xử lý các KM loại mua-thưởng:
//   BUY_X_GET_Y | BUY_N_GET_M_SAME | BUY_X_BUY_Y_PRICE
//
// CAVEAT: buyProductIds suy theo cấu hình KM HIỆN TẠI (promotion_products role=buy,
// promotion_rewards.buyProductId/buyCategoryName). Nếu cấu hình đã đổi sau khi HĐ tạo,
// kết quả có thể lệch dòng thực mua — không có snapshot buy-items trong log để đối chiếu.
//
// Idempotent: chỉ cập nhật dòng lineType='normal' đang có promotionId=null.
//
// Chạy: npm run backfill:promo-buy-lines

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BUY_REWARD_TYPES = [
  'BUY_X_GET_Y',
  'BUY_N_GET_M_SAME',
  'BUY_X_BUY_Y_PRICE',
];

/** Dựng tập productId thuộc điều kiện mua (X) của 1 promotion theo cấu hình hiện tại. */
async function resolveBuyProductIds(promotionId: number): Promise<number[]> {
  const [products, rewards] = await Promise.all([
    prisma.promotionProduct.findMany({
      where: { promotionId, role: 'buy' },
      select: { productId: true, categoryName: true },
    }),
    prisma.promotionReward.findMany({
      where: { promotionId },
      select: { buyProductId: true, buyCategoryName: true },
    }),
  ]);

  const ids = new Set<number>();
  const categoryNames = new Set<string>();

  for (const p of products) {
    if (p.productId != null) ids.add(p.productId);
    if (p.categoryName) categoryNames.add(p.categoryName);
  }
  for (const r of rewards) {
    if (r.buyProductId != null) ids.add(r.buyProductId);
    if (r.buyCategoryName) categoryNames.add(r.buyCategoryName);
  }

  if (categoryNames.size > 0) {
    const catList = [...categoryNames];
    const catProducts = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { parentName: { in: catList } },
          { middleName: { in: catList } },
          { childName: { in: catList } },
        ],
      },
      select: { id: true },
    });
    catProducts.forEach((cp) => ids.add(cp.id));
  }

  return [...ids];
}

async function main() {
  console.log('🌱 Backfill promotionId lên dòng hàng X của HĐ/đơn cũ...');

  const logs = await prisma.invoicePromotionLog.findMany({
    where: { type: { in: BUY_REWARD_TYPES }, status: 'applied' },
    select: { invoiceId: true, orderId: true, promotionId: true },
  });
  console.log(`  → ${logs.length} log KM mua-thưởng cần xử lý`);

  const buyIdsCache = new Map<number, number[]>();
  let invoiceUpdated = 0;
  let orderUpdated = 0;
  let skipped = 0;

  for (const log of logs) {
    let buyIds = buyIdsCache.get(log.promotionId);
    if (!buyIds) {
      buyIds = await resolveBuyProductIds(log.promotionId);
      buyIdsCache.set(log.promotionId, buyIds);
    }
    if (buyIds.length === 0) {
      skipped++;
      continue;
    }

    if (log.invoiceId != null) {
      const res = await prisma.invoiceDetail.updateMany({
        where: {
          invoiceId: log.invoiceId,
          productId: { in: buyIds },
          lineType: 'normal',
          promotionId: null,
        },
        data: { promotionId: log.promotionId },
      });
      invoiceUpdated += res.count;
    }
    if (log.orderId != null) {
      const res = await prisma.orderItem.updateMany({
        where: {
          orderId: log.orderId,
          productId: { in: buyIds },
          lineType: 'normal',
          promotionId: null,
        },
        data: { promotionId: log.promotionId },
      });
      orderUpdated += res.count;
    }
  }

  // Nguồn 2 (cho invoice): HĐ tạo-từ-đơn ghi log với orderId, KHÔNG có invoiceId,
  // nên nhánh log ở trên không stamp được invoice. Thay vào đó suy KM trực tiếp từ
  // dòng reward (gift / discounted_buy) đã gắn promotionId trên chính HĐ đó.
  const rewardDetails = await prisma.invoiceDetail.findMany({
    where: {
      promotionId: { not: null },
      lineType: { in: ['gift', 'discounted_buy'] },
    },
    select: { invoiceId: true, promotionId: true },
  });
  const invPromoMap = new Map<number, Set<number>>();
  for (const d of rewardDetails) {
    if (!invPromoMap.has(d.invoiceId)) invPromoMap.set(d.invoiceId, new Set());
    invPromoMap.get(d.invoiceId)!.add(d.promotionId!);
  }
  console.log(
    `  → ${invPromoMap.size} HĐ có dòng reward gắn KM (nguồn suy dòng X)`,
  );

  for (const [invoiceId, promoSet] of invPromoMap) {
    for (const promotionId of promoSet) {
      let buyIds = buyIdsCache.get(promotionId);
      if (!buyIds) {
        buyIds = await resolveBuyProductIds(promotionId);
        buyIdsCache.set(promotionId, buyIds);
      }
      if (buyIds.length === 0) continue;
      const res = await prisma.invoiceDetail.updateMany({
        where: {
          invoiceId,
          productId: { in: buyIds },
          lineType: 'normal',
          promotionId: null,
        },
        data: { promotionId },
      });
      invoiceUpdated += res.count;
    }
  }

  console.log(`✅ Hoàn tất:`);
  console.log(`   - invoice_details cập nhật: ${invoiceUpdated}`);
  console.log(`   - order_items cập nhật:     ${orderUpdated}`);
  console.log(`   - log bỏ qua (không có buyIds): ${skipped}`);
}

main()
  .catch((e) => {
    console.error('❌ Backfill lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
