import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ManufacturerMaterialDto } from './dto';

export const money = (value: Prisma.Decimal.Value) =>
  new Prisma.Decimal(value).toDecimalPlaces(2).toNumber();

export function materialAmount(line: ManufacturerMaterialDto): number {
  if (line.pricingMode === 'TOTAL') return money(line.amount ?? 0);
  if (!(Number(line.quantity) > 0) || !line.unit?.trim()) {
    throw new BadRequestException('Nguyên liệu tính theo đơn giá cần số lượng và đơn vị');
  }
  return money(new Prisma.Decimal(line.quantity!).mul(line.unitPrice ?? 0));
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
