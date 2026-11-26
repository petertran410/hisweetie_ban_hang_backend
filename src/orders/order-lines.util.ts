// So dòng hàng của đơn đã lưu với dòng hàng FE gửi lên khi sửa đơn, để chặn
// thêm/sửa/xóa sản phẩm trên đơn không còn ở trạng thái Phiếu tạm.
//
// Chỉ so dòng người dùng tự nhập:
// - dòng thường, kể cả dòng KM đã cộng giảm giá (lineType 'promo_discount');
// - quà thủ công (lineType 'gift' không có promotionId).
// Quà KM và dòng mua kèm giá KM do BE sinh lại mỗi lần lưu nên bỏ qua. Giảm
// giá từng dòng cũng không so, vì KM cộng thêm vào cột này khi lưu.

const QUANTITY_EPSILON = 0.0001;

interface OrderLineBase {
  productId: number;
  quantity: unknown;
  quantityUnit?: string | null;
  conditionType?: string | null;
  lineType?: string | null;
  promotionId?: number | null;
}

export interface SavedOrderLine extends OrderLineBase {
  price: unknown;
}

export interface IncomingOrderLine extends OrderLineBase {
  unitPrice: unknown;
}

function summarizeLines(
  lines: OrderLineBase[],
  priceOf: (line: OrderLineBase) => unknown,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const lineType = line.lineType || 'normal';
    const manualGift = lineType === 'gift' && line.promotionId == null;
    if (!manualGift && lineType !== 'normal' && lineType !== 'promo_discount') {
      continue;
    }
    const price = manualGift
      ? 0
      : Math.round(Number(priceOf(line)) * 100) / 100;
    const key = [
      line.productId,
      line.quantityUnit === 'carton' ? 'carton' : 'base',
      line.conditionType || 'normal',
      manualGift ? 'gift' : 'normal',
      price.toFixed(2),
    ].join('|');
    totals.set(key, (totals.get(key) ?? 0) + Number(line.quantity || 0));
  }
  return totals;
}

/** true khi sản phẩm, số lượng, đơn vị, tình trạng và đơn giá không đổi. */
export function isSameOrderLines(
  saved: SavedOrderLine[],
  incoming: IncomingOrderLine[],
): boolean {
  const before = summarizeLines(
    saved,
    (line) => (line as SavedOrderLine).price,
  );
  const after = summarizeLines(
    incoming,
    (line) => (line as IncomingOrderLine).unitPrice,
  );
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const diff = (before.get(key) ?? 0) - (after.get(key) ?? 0);
    if (Math.abs(diff) > QUANTITY_EPSILON) return false;
  }
  return true;
}
