import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Đơn vị của nguyên liệu NSX bổ sung: lượng dùng và đơn giá đều chọn một
 * trong ba đơn vị này. g ↔ kg quy đổi được; gói chỉ đi với gói.
 */
export const NSX_UNITS = ['g', 'kg', 'gói'] as const;
export type NsxUnit = (typeof NSX_UNITS)[number];

const GRAMS: Record<string, number> = { g: 1, kg: 1000 };

/** Chuẩn hoá (NFC + trim + lower) để "Gói" / "gói" dạng NFD đều khớp. */
export const normalizeNsxUnit = (value?: string | null) =>
  (value ?? '').normalize('NFC').trim().toLowerCase();

/** class-transformer: chuẩn hoá chuỗi đơn vị, giữ null/undefined (dòng cũ không có priceUnit). */
export const toNsxUnit = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeNsxUnit(value) : value;

export const isNsxUnit = (value?: string | null): value is NsxUnit =>
  (NSX_UNITS as readonly string[]).includes(normalizeNsxUnit(value));

/** Số đơn vị giá trong 1 đơn vị lượng (300 g, giá theo kg → 0.001). */
export function nsxPriceFactor(
  unit: string,
  priceUnit: string,
): Prisma.Decimal {
  const from = normalizeNsxUnit(unit);
  const to = normalizeNsxUnit(priceUnit);
  if (!isNsxUnit(from) || !isNsxUnit(to)) {
    throw new BadRequestException(
      'Đơn vị nguyên liệu NSX phải là g, kg hoặc gói',
    );
  }
  if (from === to) return new Prisma.Decimal(1);
  if (from in GRAMS && to in GRAMS) {
    return new Prisma.Decimal(GRAMS[from]).div(GRAMS[to]);
  }
  throw new BadRequestException(
    'Nguyên liệu tính theo gói thì đơn giá cũng phải theo gói',
  );
}

/** Thành tiền chưa làm tròn = lượng × hệ số quy đổi × đơn giá. */
export function nsxRawAmount(line: {
  quantity: Prisma.Decimal.Value;
  unit: string;
  unitPrice: Prisma.Decimal.Value;
  priceUnit: string;
}): Prisma.Decimal {
  return new Prisma.Decimal(line.quantity)
    .mul(nsxPriceFactor(line.unit, line.priceUnit))
    .mul(line.unitPrice);
}
