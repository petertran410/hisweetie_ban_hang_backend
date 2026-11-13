import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeNsxUnit, nsxRawAmount } from '../common/nsx-pricing.util';
import { outputSpec } from '../productions/production-cost.util';
import { ManufacturerMaterialDto } from './dto';

export const money = (value: Prisma.Decimal.Value) =>
  new Prisma.Decimal(value).toDecimalPlaces(2).toNumber();

/** Lượng trên phiếu lưu 4 số lẻ (Decimal(18,4)); thành tiền tính từ lượng đã làm tròn. */
export const slipQuantity = (value: Prisma.Decimal.Value) =>
  new Prisma.Decimal(value).toDecimalPlaces(4).toNumber();

/**
 * Thành tiền dòng NSX bổ sung.
 * - TOTAL: chỉ còn cho dòng cũ.
 * - UNIT_PRICE có `priceUnit`: lượng × quy đổi (g ↔ kg) × đơn giá.
 * - UNIT_PRICE không có `priceUnit` (dòng cũ): lượng × đơn giá, đơn vị tự do.
 */
export function materialAmount(line: ManufacturerMaterialDto): number {
  if (line.pricingMode === 'TOTAL') return money(line.amount ?? 0);
  if (!(Number(line.quantity) > 0) || !line.unit?.trim()) {
    throw new BadRequestException('Nguyên liệu tính theo đơn giá cần số lượng và đơn vị');
  }
  const quantity = slipQuantity(line.quantity!);
  if (!(quantity > 0)) throw new BadRequestException('Số lượng nguyên liệu NSX quá nhỏ');
  if (line.priceUnit) {
    return money(nsxRawAmount({
      quantity, unit: line.unit, unitPrice: line.unitPrice ?? 0, priceUnit: line.priceUnit,
    }));
  }
  return money(new Prisma.Decimal(quantity).mul(line.unitPrice ?? 0));
}

export function externalCosts(
  lines: ManufacturerMaterialDto[],
  fee: number,
  currency: string,
  rate: number,
  materialValue = 0,
) {
  const material = lines.reduce((sum, line) => sum.add(materialAmount(line)), new Prisma.Decimal(0));
  const total = material.add(fee);
  if (currency === 'CNY' && total.gt(0) && !(rate > 0)) {
    throw new BadRequestException('Vui lòng nhập tỷ giá CNY hợp lệ');
  }
  const convert = (value: Prisma.Decimal) =>
    currency === 'CNY' ? value.mul(rate).toDecimalPlaces(0).toNumber() : money(value);
  const totalPayable = convert(total);
  const processingFee = convert(new Prisma.Decimal(fee));
  return {
    manufacturerMaterialCost: money(totalPayable - processingFee),
    processingFee,
    totalPayable,
    totalForeignPayable: currency === 'CNY' ? money(total) : null,
    totalCost: money(new Prisma.Decimal(materialValue).add(totalPayable)),
  };
}

export function ownConversion(product: { unit?: string | null; weight?: any; weightUnit?: string | null }, unit: string): number {
  if (unit === product.unit || unit === 'unit') return 1;
  const grams = Number(product.weight ?? 0) * (product.weightUnit === 'kg' ? 1000 : 1);
  if (grams > 0 && (unit === 'g' || unit === 'kg')) return (unit === 'kg' ? 1000 : 1) / grams;
  throw new BadRequestException('Đơn vị nguyên liệu không quy đổi được sang đơn vị kho');
}

/**
 * Giá thành dự kiến / 1 sp của phiếu gửi NSX, chốt từ lúc gửi:
 * (giá vốn NL mình đã gửi + phải trả NSX dự kiến) / sản lượng dự kiến.
 */
export function planUnitCost(row: {
  materialValue: Prisma.Decimal.Value | null;
  processingFee: Prisma.Decimal.Value | null;
  manufacturerMaterialCost: Prisma.Decimal.Value | null;
  quantity: Prisma.Decimal.Value | null;
}): Prisma.Decimal {
  const quantity = new Prisma.Decimal(row.quantity ?? 0);
  if (!quantity.gt(0)) return new Prisma.Decimal(0);
  return new Prisma.Decimal(row.materialValue ?? 0)
    .add(row.processingFee ?? 0)
    .add(row.manufacturerMaterialCost ?? 0)
    .div(quantity)
    .toDecimalPlaces(6);
}

/**
 * Chia một dòng NSX dự kiến (cả lô) theo tỷ lệ đợt nhận. Lượng lưu 4 số lẻ:
 * kg bị cắt mất số lẻ thì đổi sang g (đơn giá vẫn theo priceUnit).
 */
export function scaleSuppliedLine(
  line: ManufacturerMaterialDto,
  ratio: Prisma.Decimal.Value,
): ManufacturerMaterialDto {
  if (line.pricingMode === 'TOTAL') {
    return { ...line, amount: money(new Prisma.Decimal(line.amount ?? 0).mul(ratio)) };
  }
  const raw = new Prisma.Decimal(line.quantity ?? 0).mul(ratio);
  const unit = line.priceUnit ? normalizeNsxUnit(line.unit) : line.unit;
  if (unit === 'kg' && !raw.toDecimalPlaces(4).equals(raw.toDecimalPlaces(6))) {
    return { ...line, quantity: raw.mul(1000).toDecimalPlaces(4).toNumber(), unit: 'g' };
  }
  return { ...line, quantity: raw.toDecimalPlaces(4).toNumber(), unit };
}

/**
 * Phiếu gửi trước khi có giá thành chốt lúc gửi: bổ sung batchUnitCost +
 * quy cách thành phẩm để nhận đợt / áp giá vốn được.
 */
export async function ensureExternalCostSnapshot(
  tx: Prisma.TransactionClient,
  row: {
    id: number; productId: number; batchUnitCost: Prisma.Decimal | null;
    outputSpecSnapshot: Prisma.JsonValue | null; costSnapshotAt: Date | null;
    materialValue: Prisma.Decimal; processingFee: Prisma.Decimal;
    manufacturerMaterialCost: Prisma.Decimal; quantity: Prisma.Decimal;
  },
) {
  if (row.batchUnitCost != null && row.outputSpecSnapshot && row.costSnapshotAt) return {};
  const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId } });
  const data = {
    batchUnitCost: row.batchUnitCost ?? planUnitCost(row),
    outputSpecSnapshot: (row.outputSpecSnapshot ?? { ...outputSpec(product) }) as Prisma.InputJsonValue,
    costSnapshotAt: row.costSnapshotAt ?? new Date(),
  };
  await tx.production.update({ where: { id: row.id }, data });
  return data;
}
