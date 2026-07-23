// ====================================================================
// NGUỒN CHÂN LÝ cho 3 LOẠI TỒN (bucket): DAMAGED / NEAR_EXPIRY / PROMO.
//
// Tương tự inventory-onhand.util (onHand dẫn xuất từ InventoryLog), các cột
// damagedQuantity / nearExpiryQuantity / promoQuantity trên Inventory là
// CACHE dẫn xuất từ sổ cái StockConditionLog:
//
//   tồn bucket = Σ quantity (có dấu) của log CÒN HIỆU LỰC thuộc bucket đó
//
// "Còn hiệu lực" dùng chung bộ lọc active với thẻ kho: log tham chiếu chứng từ
// đã hủy (CLT chưa duyệt/đã hủy, hóa đơn đã hủy) sẽ bị loại. Nhờ đó "Tồn cuối"
// của giao dịch mới nhất trên thẻ kho loại tồn LUÔN bằng cache.
//
// LƯU Ý QUAN TRỌNG: bucket NẰM TRONG onHand (chỉ là phân loại), KHÔNG cộng
// thêm vào onHand. Hàng tốt (available) = onHand − damaged − nearExpiry − promo.
// ====================================================================

import { getActiveLogKeys, isLogActive } from './inventory-onhand.util';

export const BUCKET_DAMAGED = 'DAMAGED';
export const BUCKET_NEAR_EXPIRY = 'NEAR_EXPIRY';
export const BUCKET_PROMO = 'PROMO';
export const ALL_BUCKETS = [
  BUCKET_DAMAGED,
  BUCKET_NEAR_EXPIRY,
  BUCKET_PROMO,
] as const;
export type Bucket = (typeof ALL_BUCKETS)[number];

export interface BucketTotals {
  damaged: number;
  nearExpiry: number;
  promo: number;
}

// Tính tổng 3 bucket từ sổ cái (CHỈ ĐỌC). = Σ quantity log active theo bucket.
export async function computeBucketTotals(
  tx: any,
  productId: number,
  branchId: number,
): Promise<BucketTotals> {
  const logs = await tx.stockConditionLog.findMany({
    where: { productId, branchId },
    select: { quantity: true, bucket: true, refType: true, refId: true },
  });
  const activeKeys = await getActiveLogKeys(tx, logs);

  const totals: BucketTotals = { damaged: 0, nearExpiry: 0, promo: 0 };
  for (const l of logs) {
    if (!isLogActive(l, activeKeys)) continue;
    const q = Number(l.quantity);
    if (l.bucket === BUCKET_DAMAGED) totals.damaged += q;
    else if (l.bucket === BUCKET_NEAR_EXPIRY) totals.nearExpiry += q;
    else if (l.bucket === BUCKET_PROMO) totals.promo += q;
  }
  return totals;
}

// NGUỒN CHÂN LÝ — tính lại 3 bucket từ sổ cái và GHI cache vào Inventory.
// Trả về tổng bucket mới. KHÔNG đụng onHand.
export async function recalcConditionBuckets(
  tx: any,
  productId: number,
  branchId: number,
): Promise<BucketTotals> {
  const totals = await computeBucketTotals(tx, productId, branchId);
  const inv = await tx.inventory.findUnique({
    where: { productId_branchId: { productId, branchId } },
    select: { id: true },
  });
  if (inv) {
    await tx.inventory.update({
      where: { productId_branchId: { productId, branchId } },
      data: {
        damagedQuantity: totals.damaged,
        nearExpiryQuantity: totals.nearExpiry,
        promoQuantity: totals.promo,
      },
    });
  }
  return totals;
}

// Recalc bucket cho NHIỀU cặp (productId, branchId) — dùng sau khi 1 phiếu/đơn
// ghi/void log ở nhiều dòng. Tự khử trùng lặp cặp.
export async function recalcConditionBucketsForPairs(
  tx: any,
  pairs: Array<{
    productId: number | null | undefined;
    branchId: number | null | undefined;
  }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.productId == null || p.branchId == null) continue;
    const key = `${p.productId}|${p.branchId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recalcConditionBuckets(tx, p.productId, p.branchId);
  }
}

export interface NearExpiryLot {
  expiryDate: string | null; // ISO date (yyyy-mm-dd) hoặc null = lô chưa xác định
  quantity: number;
}

// Tồn cận date theo từng lô (expiryDate). Chỉ trả lô có tồn > 0, sắp xếp theo
// hạn dùng tăng dần (lô gần hết hạn nhất lên đầu). Lô null xếp cuối.
export async function computeNearExpiryLots(
  tx: any,
  productId: number,
  branchId: number,
): Promise<NearExpiryLot[]> {
  const logs = await tx.stockConditionLog.findMany({
    where: { productId, branchId, bucket: BUCKET_NEAR_EXPIRY },
    select: {
      quantity: true,
      expiryDate: true,
      refType: true,
      refId: true,
    },
  });
  const activeKeys = await getActiveLogKeys(tx, logs);

  const byLot = new Map<string, number>();
  for (const l of logs) {
    if (!isLogActive(l, activeKeys)) continue;
    const key = l.expiryDate
      ? new Date(l.expiryDate).toISOString().slice(0, 10)
      : '';
    byLot.set(key, (byLot.get(key) ?? 0) + Number(l.quantity));
  }

  const lots: NearExpiryLot[] = [];
  for (const [key, qty] of byLot.entries()) {
    if (qty <= 0) continue;
    lots.push({ expiryDate: key === '' ? null : key, quantity: qty });
  }
  lots.sort((a, b) => {
    if (a.expiryDate == null) return 1;
    if (b.expiryDate == null) return -1;
    return a.expiryDate.localeCompare(b.expiryDate);
  });
  return lots;
}
