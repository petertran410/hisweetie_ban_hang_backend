// ====================================================================
// NGUỒN CHÂN LÝ DUY NHẤT cho TỒN KHO (Inventory.onHand).
//
// Tương tự recalcCustomerDebt: onHand KHÔNG được sửa rời rạc mà luôn được
// DẪN XUẤT từ thẻ kho (InventoryLog). Cụ thể:
//
//   onHand = Σ quantity của các log thuộc chứng từ CÒN HIỆU LỰC
//            (không bị hủy / không bị xóa cứng)
//
// Nhờ đó "Tồn cuối" của giao dịch mới nhất trên thẻ kho LUÔN bằng onHand.
// Dùng chung bộ lọc "active" này cho cả thẻ kho (findInventoryLogs) lẫn mọi
// nơi reconcile onHand → đảm bảo một nguồn chân lý duy nhất.
// ====================================================================

// Mapping refType → finder trả về các id CÒN HIỆU LỰC (status != mã hủy).
// Log trỏ tới id không thuộc tập active (bị hủy hoặc xóa cứng) → bị loại.
const ACTIVE_FINDERS: Record<
  string,
  (tx: any, ids: number[]) => Promise<{ id: number }[]>
> = {
  invoice: (tx, ids) =>
    tx.invoice.findMany({
      where: { id: { in: ids }, status: { not: 2 } },
      select: { id: true },
    }),
  return_order: (tx, ids) =>
    tx.returnOrder.findMany({
      where: { id: { in: ids }, status: { not: 5 } },
      select: { id: true },
    }),
  supplier_return: (tx, ids) =>
    tx.supplierReturn.findMany({
      where: { id: { in: ids }, status: { not: 4 } },
      select: { id: true },
    }),
  stock_audit: (tx, ids) =>
    tx.stockAudit.findMany({
      where: { id: { in: ids }, status: { not: 3 } },
      select: { id: true },
    }),
  purchase_order: (tx, ids) =>
    tx.purchaseOrder.findMany({
      where: { id: { in: ids }, status: { not: 2 } },
      select: { id: true },
    }),
  transfer: (tx, ids) =>
    tx.transfer.findMany({
      where: { id: { in: ids }, status: { not: 4 } },
      select: { id: true },
    }),
  production: (tx, ids) =>
    tx.production.findMany({
      where: { id: { in: ids }, status: { not: 3 } },
      select: { id: true },
    }),
  destruction: (tx, ids) =>
    tx.destruction.findMany({
      where: { id: { in: ids }, status: { not: 3 } },
      select: { id: true },
    }),
};

export const KNOWN_REF_TYPES = new Set(Object.keys(ACTIVE_FINDERS));

interface RefLog {
  refType?: string | null;
  refId?: number | null;
}

// Trả về set "refType:refId" các chứng từ CÒN HIỆU LỰC trong tập log đã cho.
export async function getActiveLogKeys(
  tx: any,
  logs: RefLog[],
): Promise<Set<string>> {
  const byType: Record<string, Set<number>> = {};
  for (const l of logs) {
    if (!l.refType || !l.refId) continue;
    (byType[l.refType] ||= new Set()).add(l.refId);
  }

  const activeKeys = new Set<string>();
  await Promise.all(
    Object.entries(byType).map(async ([refType, idSet]) => {
      const finder = ACTIVE_FINDERS[refType];
      if (!finder) return; // refType lạ → coi như luôn active
      const ids = Array.from(idSet);
      if (ids.length === 0) return;
      const rows = await finder(tx, ids);
      rows.forEach((r) => activeKeys.add(`${refType}:${r.id}`));
    }),
  );
  return activeKeys;
}

// 1 log có còn hiệu lực không (dựa trên activeKeys đã tính).
export function isLogActive(log: RefLog, activeKeys: Set<string>): boolean {
  if (!log.refType || !log.refId) return true; // log lẻ — không có chứng từ
  if (!KNOWN_REF_TYPES.has(log.refType)) return true; // refType lạ → giữ
  return activeKeys.has(`${log.refType}:${log.refId}`);
}

// Tính onHand từ thẻ kho (CHỈ ĐỌC, không ghi). = Σ quantity log active.
export async function computeOnHandFromLogs(
  tx: any,
  productId: number,
  branchId: number,
): Promise<number> {
  const logs = await tx.inventoryLog.findMany({
    where: { productId, branchId },
    select: { quantity: true, refType: true, refId: true },
  });
  const activeKeys = await getActiveLogKeys(tx, logs);
  return logs.reduce(
    (s: number, l: any) =>
      isLogActive(l, activeKeys) ? s + Number(l.quantity) : s,
    0,
  );
}

// NGUỒN CHÂN LÝ — tính lại onHand = Σ log active và GHI vào Inventory.
// Trả về onHand mới. Cập nhật cả totalWeight theo weight sản phẩm.
export async function recalcInventoryOnHand(
  tx: any,
  productId: number,
  branchId: number,
): Promise<number> {
  const onHand = await computeOnHandFromLogs(tx, productId, branchId);

  const inv = await tx.inventory.findUnique({
    where: { productId_branchId: { productId, branchId } },
    include: { product: { select: { weight: true } } },
  });
  if (inv) {
    const weight = inv.product?.weight ? Number(inv.product.weight) : 0;
    await tx.inventory.update({
      where: { productId_branchId: { productId, branchId } },
      data: { onHand, totalWeight: weight * onHand },
    });
  }
  return onHand;
}

// ====================================================================
// RE-ANCHOR chuỗi phiếu kiểm (Cách A).
//
// Phiếu kiểm kho mang nghĩa TUYỆT ĐỐI: "tại thời điểm T, tồn thực tế = X"
// (X = StockAuditDetail.actualQuantity — KHÔNG bao giờ bị ghi đè).
// Nhưng InventoryLog chỉ lưu DELTA (= X − tồn ngay trước T) đóng băng lúc
// hoàn thành. Khi có giao dịch/phiếu lùi ngày chèn vào TRƯỚC một phiếu kiểm,
// "tồn ngay trước T" đổi → delta cũ sai → tồn cuối phiếu kiểm lệch.
//
// Hàm này duyệt XUÔI toàn bộ thẻ kho (active) theo thời gian, và với mỗi log
// phiếu kiểm: tính lại delta = actualQuantity − running, GHI ĐÈ
// InventoryLog.quantity + StockAuditDetail (systemQuantity/difference). Log
// thường (bán/nhập/chuyển) chỉ cộng dồn, KHÔNG đụng tới.
//
// Kết thúc: onHand = running cuối cùng (cập nhật luôn).
// ====================================================================
export async function recalcStockAuditChain(
  tx: any,
  productId: number,
  branchId: number,
): Promise<number> {
  const logs = await tx.inventoryLog.findMany({
    where: { productId, branchId },
    orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      quantity: true,
      refType: true,
      refId: true,
      transactionType: true,
    },
  });

  const activeKeys = await getActiveLogKeys(tx, logs);

  // Map auditId → { actualQuantity, costAtCheck, detailId } cho sản phẩm này.
  const auditIds = [
    ...new Set(
      logs
        .filter(
          (l: any) =>
            l.transactionType === 'STOCK_AUDIT' &&
            l.refType === 'stock_audit' &&
            l.refId,
        )
        .map((l: any) => l.refId as number),
    ),
  ];
  const detailMap = new Map<
    number,
    { actualQuantity: number; costAtCheck: number; detailId: number }
  >();
  if (auditIds.length > 0) {
    const details = await tx.stockAuditDetail.findMany({
      where: { stockAuditId: { in: auditIds }, productId },
      select: {
        id: true,
        stockAuditId: true,
        actualQuantity: true,
        costAtCheck: true,
      },
    });
    for (const d of details) {
      detailMap.set(d.stockAuditId, {
        actualQuantity: Number(d.actualQuantity),
        costAtCheck: Number(d.costAtCheck),
        detailId: d.id,
      });
    }
  }

  let running = 0;
  for (const log of logs) {
    if (!isLogActive(log, activeKeys)) continue; // bỏ phiếu/đơn đã hủy

    const isAuditAnchor =
      log.transactionType === 'STOCK_AUDIT' &&
      log.refType === 'stock_audit' &&
      log.refId &&
      detailMap.has(log.refId);

    if (isAuditAnchor) {
      const info = detailMap.get(log.refId as number)!;
      const newDelta = info.actualQuantity - running;

      if (newDelta !== Number(log.quantity)) {
        await tx.inventoryLog.update({
          where: { id: log.id },
          data: { quantity: newDelta },
        });
        await tx.stockAuditDetail.update({
          where: { id: info.detailId },
          data: {
            systemQuantity: running,
            difference: newDelta,
            differenceValue: newDelta * info.costAtCheck,
          },
        });
      }
      running = info.actualQuantity;
    } else {
      running += Number(log.quantity);
    }
  }

  // onHand = running cuối (đã khớp Σ active log sau khi re-anchor).
  const inv = await tx.inventory.findUnique({
    where: { productId_branchId: { productId, branchId } },
    include: { product: { select: { weight: true } } },
  });
  if (inv) {
    const weight = inv.product?.weight ? Number(inv.product.weight) : 0;
    await tx.inventory.update({
      where: { productId_branchId: { productId, branchId } },
      data: { onHand: running, totalWeight: weight * running },
    });
  }
  return running;
}
