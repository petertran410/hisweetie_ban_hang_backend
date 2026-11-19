import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { amount4 } from './external-production.util';

/**
 * Tồn nguyên liệu của mình đang nằm ở NSX (gửi trước, dùng dần cho nhiều phiếu
 * sản xuất). Không có bảng số dư: tồn luôn được cộng lại từ chứng từ còn hiệu lực
 * (giống tồn kho cộng từ InventoryLog), nên hủy / sửa chứng từ là số tự đúng.
 * - Phiếu nguyên liệu NSX còn hiệu lực: `units` có dấu (gửi +, trả −, điều chỉnh ±).
 * - Dòng hàng mình gửi `source = 'manufacturer'` của phiếu gửi SX chưa hủy và đã gửi: trừ.
 */

type Db = Prisma.TransactionClient;
const D = (value: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(value ?? 0);

export const STOCK_SLIP_ACTIVE = 1;
export const STOCK_SLIP_CANCELLED = 2;
export const STOCK_SLIP_TYPES = ['SEND', 'RETURN', 'ADJUST'] as const;
export type StockSlipType = (typeof STOCK_SLIP_TYPES)[number];
export const STOCK_SLIP_LABEL: Record<StockSlipType, string> = {
  SEND: 'Gửi nguyên liệu', RETURN: 'Trả nguyên liệu', ADJUST: 'Điều chỉnh tồn',
};

/** Nguồn trừ của dòng hàng mình gửi trên phiếu gửi sản xuất. */
export const SOURCE_BRANCH = 'branch';
export const SOURCE_MANUFACTURER = 'manufacturer';
export const COMPONENT_SOURCES = [SOURCE_BRANCH, SOURCE_MANUFACTURER] as const;
export type ComponentSource = (typeof COMPONENT_SOURCES)[number];

/** Phiếu gửi SX đang dùng tồn NSX: Hoàn thành / Đã gửi / Nhận một phần (phiếu tạm chưa trừ, phiếu hủy trả lại). */
export const CONSUMING_STATUSES = [2, 4, 5];

/** Sai số so sánh tồn ở 4 số lẻ. */
const EPSILON = 0.00005;

export interface StockBalance {
  units: Prisma.Decimal;
  value: Prisma.Decimal;
  /** Giá vốn bình quân di động tại NSX / 1 đơn vị kho. */
  avgCost: Prisma.Decimal;
}

/**
 * Tồn tại NSX theo sản phẩm. Giá trị = Σ lượng × giá vốn chụp của từng chứng từ;
 * giá BQ = giá trị / lượng. Mọi dòng xuất ra chụp giá BQ nên giá BQ của phần còn
 * lại không đổi khi dùng dần. Hết hàng (hoặc còn giá trị lẻ) thì lấy giá lần gửi gần nhất.
 */
export async function manufacturerStock(
  db: Db, manufacturerId: number, productIds?: number[],
  opts: { excludeSlipId?: number; excludeProductionId?: number } = {},
): Promise<Map<number, StockBalance>> {
  if (productIds && !productIds.length) return new Map();
  const [lines, components] = await Promise.all([
    db.manufacturerStockSlipLine.findMany({
      where: {
        ...(productIds ? { productId: { in: productIds } } : {}),
        slip: {
          manufacturerId, status: STOCK_SLIP_ACTIVE,
          ...(opts.excludeSlipId ? { id: { not: opts.excludeSlipId } } : {}),
        },
      },
      select: { productId: true, units: true, unitCost: true, amount: true, slip: { select: { id: true, type: true, date: true } } },
    }),
    db.productionComponent.findMany({
      where: {
        source: SOURCE_MANUFACTURER,
        ...(productIds ? { componentProductId: { in: productIds } } : {}),
        production: {
          manufacturerId, status: { in: CONSUMING_STATUSES },
          ...(opts.excludeProductionId ? { id: { not: opts.excludeProductionId } } : {}),
        },
      },
      select: { componentProductId: true, unitsDeducted: true, unitCost: true },
    }),
  ]);
  const sums = new Map<number, { units: Prisma.Decimal; value: Prisma.Decimal; lastSend?: { at: number; id: number; cost: Prisma.Decimal } }>();
  const entry = (productId: number) => {
    let row = sums.get(productId);
    if (!row) sums.set(productId, (row = { units: D(0), value: D(0) }));
    return row;
  };
  for (const line of lines) {
    const row = entry(line.productId);
    row.units = row.units.add(line.units);
    row.value = row.value.add(line.amount);
    if (line.slip.type === 'SEND') {
      const at = new Date(line.slip.date).getTime();
      if (!row.lastSend || at > row.lastSend.at || (at === row.lastSend.at && line.slip.id > row.lastSend.id)) {
        row.lastSend = { at, id: line.slip.id, cost: D(line.unitCost) };
      }
    }
  }
  for (const line of components) {
    const row = entry(line.componentProductId);
    row.units = row.units.sub(line.unitsDeducted);
    row.value = row.value.sub(D(line.unitsDeducted).mul(line.unitCost ?? 0));
  }
  const result = new Map<number, StockBalance>();
  for (const [productId, row] of sums) {
    const units = row.units.toDecimalPlaces(4);
    const avgCost = units.gt(EPSILON) && row.value.gt(0)
      ? row.value.div(units).toDecimalPlaces(6)
      : row.lastSend?.cost ?? D(0);
    result.set(productId, { units, value: row.value.toDecimalPlaces(2), avgCost });
  }
  return result;
}

/** Tồn tại NSX của một mã (0 khi chưa có chứng từ). */
export function balanceOf(stock: Map<number, StockBalance>, productId: number): StockBalance {
  return stock.get(productId) ?? { units: D(0), value: D(0), avgCost: D(0) };
}

/**
 * Sau khi ghi: chặn khi tồn tại NSX của một mã bị âm (đã dùng / trả nhiều hơn đã gửi).
 * Kiểm theo tổng hiện tại, không theo thứ tự thời gian.
 */
export async function assertManufacturerStock(
  db: Db, manufacturerId: number, productIds: number[],
  message?: (name: string, missing: string, unit: string) => string,
) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return;
  const stock = await manufacturerStock(db, manufacturerId, ids);
  const negative = ids.filter((id) => balanceOf(stock, id).units.lt(-EPSILON));
  if (!negative.length) return;
  const products = await db.product.findMany({ where: { id: { in: negative } }, select: { id: true, name: true, unit: true } });
  const product = products.find((item) => item.id === negative[0]);
  const missing = amount4(balanceOf(stock, negative[0]).units.negated());
  const unit = product?.unit || 'đơn vị kho';
  const name = product?.name ?? `#${negative[0]}`;
  throw new BadRequestException(message
    ? message(name, missing, unit)
    : `Không đủ tồn "${name}" tại NSX: thiếu ${missing} ${unit}. Lượng này đã được dùng cho phiếu sản xuất hoặc trả về kho; hãy sửa / hủy các phiếu đó trước`);
}

/** Giá trị nguyên liệu mình còn ở NSX (phần chưa dùng), theo từng NSX. */
export async function manufacturerStockValue(db: Db, manufacturerIds: number[]): Promise<number> {
  let total = D(0);
  for (const id of [...new Set(manufacturerIds)]) {
    const stock = await manufacturerStock(db, id);
    for (const row of stock.values()) {
      if (row.units.gt(EPSILON)) total = total.add(row.units.mul(row.avgCost));
    }
  }
  return total.toDecimalPlaces(2).toNumber();
}
