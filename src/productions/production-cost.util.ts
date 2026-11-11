import { Prisma } from '@prisma/client';

export interface OutputSpec {
  unit: string | null;
  weight: string | null;
  weightUnit: string | null;
  conversionValue: string;
  masterUnitId: number | null;
  isPieceUnit: boolean;
}

export function outputSpec(product: {
  unit: string | null;
  weight: Prisma.Decimal | null;
  weightUnit: string | null;
  conversionValue: Prisma.Decimal;
  masterUnitId: number | null;
  isPieceUnit: boolean;
}): OutputSpec {
  return {
    unit: product.unit?.trim() || null,
    weight:
      product.weight == null
        ? null
        : new Prisma.Decimal(product.weight).toString(),
    weightUnit:
      product.weight == null ? null : product.weightUnit?.trim() || null,
    conversionValue: new Prisma.Decimal(product.conversionValue).toString(),
    masterUnitId: product.masterUnitId,
    isPieceUnit: product.isPieceUnit,
  };
}

export function readOutputSpec(
  value: Prisma.JsonValue | null,
): OutputSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.unit !== 'string' || !value.unit.trim()) return null;
  if (!('weight' in value) || !('weightUnit' in value)) return null;
  if (
    typeof value.conversionValue !== 'string' ||
    typeof value.isPieceUnit !== 'boolean' ||
    (value.masterUnitId !== null &&
      (!Number.isInteger(value.masterUnitId) || Number(value.masterUnitId) < 1))
  )
    return null;
  try {
    const conversion = new Prisma.Decimal(value.conversionValue);
    if (!conversion.isFinite() || !conversion.gt(0)) return null;
  } catch {
    return null;
  }
  const weight = value.weight;
  if (weight != null && (typeof weight !== 'string' || !value.weightUnit))
    return null;
  return {
    unit: value.unit,
    weight: weight as string | null,
    weightUnit: (value.weightUnit as string) ?? null,
    conversionValue: value.conversionValue,
    masterUnitId: value.masterUnitId as number | null,
    isPieceUnit: value.isPieceUnit,
  };
}

export function specKey(spec: OutputSpec): string {
  return JSON.stringify([
    spec.unit,
    spec.weight,
    spec.weightUnit,
    spec.conversionValue,
    spec.masterUnitId,
    spec.isPieceUnit,
  ]);
}

export function specLabel(spec: OutputSpec | null): string {
  if (!spec) return 'Thiếu snapshot đơn vị/quy cách';
  return [
    spec.unit,
    spec.weight == null ? null : `${spec.weight} ${spec.weightUnit}`,
    spec.conversionValue === '1' ? null : `quy đổi x${spec.conversionValue}`,
    spec.masterUnitId == null ? null : `gốc #${spec.masterUnitId}`,
    spec.isPieceUnit ? 'đơn vị lẻ' : null,
  ]
    .filter(Boolean)
    .join(' - ');
}
