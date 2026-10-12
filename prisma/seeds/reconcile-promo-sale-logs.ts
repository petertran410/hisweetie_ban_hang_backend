// prisma/seeds/reconcile-promo-sale-logs.ts
//
// Mục đích: ĐỐI SOÁT log xuất bán bucket PROMO (StockConditionLog, SALE_OUT,
// refType='invoice') với các dòng hóa đơn hiện tại, sửa các HĐ bị lệch.
//
// Vì sao cần: trước bản vá, sửa hóa đơn "tại chỗ" (không tạo .xx) ghi lại
// promotionId của dòng nhưng KHÔNG ghi lại log PROMO → bật/tắt KM theo dòng làm
// tồn KM lệch (dòng đã bỏ KM vẫn bị trừ, hoặc dòng mới bật KM không bị trừ).
//
// Kỳ vọng mỗi (hóa đơn, sản phẩm) = Σ SL các dòng conditionType='normal' mà:
//   - là quà (isGift / lineType='gift'), hoặc
//   - có promotionId thuộc CT BUY_X_GET_Y / BUY_N_GET_M_SAME bật deductPromoStock.
// (khớp markPromoStockDeductionItems + writeSaleConditionLog trong invoices.service)
//
// AN TOÀN:
//   - Mặc định DRY-RUN: chỉ in danh sách lệch, không ghi gì.
//   - --apply: với (HĐ, SP) lệch, xóa log PROMO SALE_OUT của cặp đó, ghi lại
//     1 log đúng số kỳ vọng, rồi recalc cache bucket. KHÔNG đụng onHand, KHÔNG
//     sửa dòng hóa đơn, bỏ qua HĐ đã hủy (status = 2).
//   - HĐ hoàn toàn KHÔNG có log PROMO cho SP đó (sổ cái đang trừ 0) thường là
//     HĐ tạo trước khi có sổ cái loại tồn / HĐ gộp → chỉ báo cáo, KHÔNG sửa trừ
//     khi thêm --include-missing.
//   - Idempotent.
//
// Cách chạy:
//   npx ts-node prisma/seeds/reconcile-promo-sale-logs.ts            (dry-run)
//   npx ts-node prisma/seeds/reconcile-promo-sale-logs.ts --apply
//   npx ts-node prisma/seeds/reconcile-promo-sale-logs.ts --apply --include-missing

import { PrismaClient } from '@prisma/client';
import {
  BUCKET_PROMO,
  recalcConditionBucketsForPairs,
} from '../../src/common/stock-condition-onhand.util';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const INCLUDE_MISSING = process.argv.includes('--include-missing');

async function main() {
  const deductPromotions = await prisma.promotion.findMany({
    where: {
      type: { in: ['BUY_X_GET_Y', 'BUY_N_GET_M_SAME'] },
      deductPromoStock: true,
    },
    select: { id: true },
  });
  const deductPromoIds = new Set(deductPromotions.map((p) => p.id));

  // Ứng viên: HĐ chưa hủy có log PROMO hoặc có dòng quà / dòng mang promotionId.
  const [logged, lined] = await Promise.all([
    prisma.stockConditionLog.findMany({
      where: {
        refType: 'invoice',
        bucket: BUCKET_PROMO,
        transactionType: 'SALE_OUT',
      },
      distinct: ['refId'],
      select: { refId: true },
    }),
    prisma.invoiceDetail.findMany({
      where: {
        OR: [
          { isGift: true },
          { lineType: 'gift' },
          { promotionId: { not: null } },
        ],
      },
      distinct: ['invoiceId'],
      select: { invoiceId: true },
    }),
  ]);
  const candidateIds = Array.from(
    new Set([...logged.map((l) => l.refId), ...lined.map((d) => d.invoiceId)]),
  );

  const invoices = await prisma.invoice.findMany({
    where: { id: { in: candidateIds }, status: { not: 2 } },
    select: {
      id: true,
      code: true,
      branchId: true,
      purchaseDate: true,
      branch: { select: { name: true } },
      details: {
        select: {
          productId: true,
          productCode: true,
          productName: true,
          quantity: true,
          conditionType: true,
          isGift: true,
          lineType: true,
          promotionId: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(
    `${APPLY ? 'APPLY' : 'DRY-RUN'} — kiểm tra ${invoices.length} hóa đơn.`,
  );

  let mismatches = 0;
  let skippedMissing = 0;
  for (const inv of invoices) {
    const expected = new Map<
      number,
      { qty: number; code: string; name: string }
    >();
    for (const d of inv.details) {
      if (d.productId == null) continue;
      if ((d.conditionType || 'normal') !== 'normal') continue;
      const isGift = d.isGift || d.lineType === 'gift';
      const deduct =
        isGift || (d.promotionId != null && deductPromoIds.has(d.promotionId));
      if (!deduct) continue;
      const cur = expected.get(d.productId) || {
        qty: 0,
        code: d.productCode || '',
        name: d.productName || '',
      };
      cur.qty += Number(d.quantity);
      expected.set(d.productId, cur);
    }

    const logs = await prisma.stockConditionLog.findMany({
      where: {
        refType: 'invoice',
        refId: inv.id,
        bucket: BUCKET_PROMO,
        transactionType: 'SALE_OUT',
      },
    });
    const actual = new Map<number, number>();
    for (const l of logs) {
      actual.set(
        l.productId,
        (actual.get(l.productId) || 0) - Number(l.quantity),
      );
    }

    const productIds = new Set([...expected.keys(), ...actual.keys()]);
    for (const productId of productIds) {
      const exp = expected.get(productId)?.qty || 0;
      const act = actual.get(productId) || 0;
      if (Math.abs(exp - act) < 1e-9) continue;
      const missing = act === 0 && !INCLUDE_MISSING;
      if (missing) skippedMissing += 1;
      else mismatches += 1;

      const sample = logs.find((l) => l.productId === productId);
      const code = expected.get(productId)?.code || sample?.productCode || '';
      console.log(
        `  [${inv.code}] SP ${code} (#${productId}): kỳ vọng trừ ${exp}, sổ cái đang trừ ${act}` +
          (missing ? ' (chưa từng ghi sổ — bỏ qua)' : ''),
      );
      if (!APPLY || missing) continue;

      const branchId = inv.branchId || sample?.branchId || 1;
      await prisma.$transaction(async (tx) => {
        await tx.stockConditionLog.deleteMany({
          where: {
            refType: 'invoice',
            refId: inv.id,
            bucket: BUCKET_PROMO,
            transactionType: 'SALE_OUT',
            productId,
          },
        });
        if (exp > 0) {
          await tx.stockConditionLog.create({
            data: {
              productId,
              productCode: code,
              productName:
                expected.get(productId)?.name || sample?.productName || '',
              branchId,
              branchName: inv.branch?.name || sample?.branchName || '',
              bucket: BUCKET_PROMO,
              transactionType: 'SALE_OUT',
              refCode: inv.code,
              refType: 'invoice',
              refId: inv.id,
              quantity: -exp,
              costPrice: sample ? Number(sample.costPrice) : 0,
              transactionDate: sample?.transactionDate ?? inv.purchaseDate,
              createdByName: sample?.createdByName ?? null,
            },
          });
        }
        await recalcConditionBucketsForPairs(tx, [{ productId, branchId }]);
      });
    }
  }

  console.log(
    `Hoàn tất. ${mismatches} cặp (hóa đơn, sản phẩm) lệch` +
      (APPLY ? ' — đã sửa.' : ' — chạy lại với --apply để sửa.') +
      (skippedMissing
        ? ` ${skippedMissing} cặp chưa từng ghi sổ bị bỏ qua (--include-missing để tính cả).`
        : ''),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
