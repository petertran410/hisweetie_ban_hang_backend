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

// Tính tổng 3 bucket cho NHIỀU sản phẩm trong 1 chi nhánh (CHỈ ĐỌC).
// Dùng cho màn bán hàng: dropdown hiển thị nhiều sản phẩm cùng lúc, cần đọc
// tồn bucket TỪ SỔ CÁI (không đọc cache Inventory vốn có thể trôi khỏi sổ cái
// do các module cũ còn ghi trực tiếp vào cột cache).
// Gom 1 query log cho toàn bộ productIds → tránh N+1.
export async function computeBucketTotalsBatch(
  tx: any,
  productIds: number[],
  branchId: number,
): Promise<Record<number, BucketTotals>> {
  const result: Record<number, BucketTotals> = {};
  const ids = [...new Set(productIds.filter((id) => !!id))];
  for (const id of ids) {
    result[id] = { damaged: 0, nearExpiry: 0, promo: 0 };
  }
  if (ids.length === 0) return result;

  const logs = await tx.stockConditionLog.findMany({
    where: { productId: { in: ids }, branchId },
    select: {
      productId: true,
      quantity: true,
      bucket: true,
      refType: true,
      refId: true,
    },
  });
  const activeKeys = await getActiveLogKeys(tx, logs);

  for (const l of logs) {
    if (!isLogActive(l, activeKeys)) continue;
    const totals = result[l.productId];
    if (!totals) continue;
    const q = Number(l.quantity);
    if (l.bucket === BUCKET_DAMAGED) totals.damaged += q;
    else if (l.bucket === BUCKET_NEAR_EXPIRY) totals.nearExpiry += q;
    else if (l.bucket === BUCKET_PROMO) totals.promo += q;
  }
  return result;
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

// ====================================================================
// GHI SỔ CÁI cho các chứng từ làm THAY ĐỔI tồn bucket ngoài phiếu CLT và hóa
// đơn (trả hàng khách, trả hàng NCC, hoàn hàng ký gửi...).
//
// Trước đây các module này ghi TRỰC TIẾP vào cột cache
// (Inventory.damagedQuantity/...) mà không ghi sổ → cache trôi khỏi sổ cái và
// không có cách nào kéo về. Dùng helper này để mọi thay đổi bucket đều đi qua
// sổ cái, giữ đúng bất biến: tồn bucket = Σ log active.
//
// quantity mang DẤU: + là cộng vào bucket, − là trừ khỏi bucket.
// refType BẮT BUỘC phải có finder trong ACTIVE_FINDERS, nếu không log của
// chứng từ đã hủy sẽ không bị loại khỏi tổng.
// ====================================================================
export async function writeConditionLogs(
  tx: any,
  params: {
    productId: number;
    productCode: string;
    productName: string;
    branchId: number;
    branchName: string;
    refCode: string;
    refType: string;
    refId: number;
    transactionType: string;
    transactionDate?: Date;
    costPrice?: number;
    createdByName?: string | null;
    note?: string | null;
    // Số lượng theo từng bucket (mang dấu). Bỏ qua giá trị 0.
    damaged?: number;
    nearExpiry?: number;
    promo?: number;
    // Lô (NSX) cho bucket cận date. Không có → null = lô chưa xác định.
    nearExpiryDate?: Date | null;
  },
): Promise<void> {
  const base = {
    productId: params.productId,
    productCode: params.productCode || '',
    productName: params.productName || '',
    branchId: params.branchId,
    branchName: params.branchName || '',
    transactionType: params.transactionType,
    refCode: params.refCode,
    refType: params.refType,
    refId: params.refId,
    costPrice: params.costPrice ?? 0,
    transactionDate: params.transactionDate ?? new Date(),
    createdByName: params.createdByName ?? null,
    note: params.note ?? null,
  };

  const rows: any[] = [];
  if (params.damaged && params.damaged !== 0) {
    rows.push({ ...base, bucket: BUCKET_DAMAGED, quantity: params.damaged });
  }
  if (params.nearExpiry && params.nearExpiry !== 0) {
    rows.push({
      ...base,
      bucket: BUCKET_NEAR_EXPIRY,
      quantity: params.nearExpiry,
      expiryDate: params.nearExpiryDate ?? null,
    });
  }
  if (params.promo && params.promo !== 0) {
    rows.push({ ...base, bucket: BUCKET_PROMO, quantity: params.promo });
  }

  for (const row of rows) {
    await tx.stockConditionLog.create({ data: row });
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
