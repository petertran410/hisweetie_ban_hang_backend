export type CustomerDemandStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
export type CustomerDemandUnit = 'BASE' | 'CARTON';

export interface CustomerDemandLineInput {
  productId: number;
  quantityBase: number;
  inputQuantity?: number;
  inputUnit?: CustomerDemandUnit | string;
  conversionValue?: number;
}

export interface CustomerDemandMonthInput {
  id?: number;
  demandMonth: Date | string;
  status: CustomerDemandStatus | string;
  customerId?: number;
  customerName?: string | null;
  lines: CustomerDemandLineInput[];
}

export interface CustomerDemandDetail {
  monthId: number | null;
  customerId: number | null;
  customerName: string | null;
  demandMonth: string;
  quantityBase: number;
}

export interface ResolvedCustomerDemand {
  totalByProduct: Map<number, number>;
  detailsByProduct: Map<number, CustomerDemandDetail[]>;
  includedMonths: string[];
}

/**
 * Chọn Demand OEM được phép đưa vào một lần tính Purchasing Planning.
 *
 * Chỉ tháng CONFIRMED, từ tháng hiện tại trở đi và bắt đầu trong planning
 * horizon mới được tính. Demand tháng đã qua chỉ còn để tra cứu lịch sử.
 */
export function resolveCustomerDemand(
  months: CustomerDemandMonthInput[],
  snapshotDate: Date | string,
  horizonDays: number,
): ResolvedCustomerDemand {
  const totalByProduct = new Map<number, number>();
  const detailsByProduct = new Map<number, CustomerDemandDetail[]>();
  const includedMonths = new Set<string>();
  const snapshot = toDate(snapshotDate);
  const currentMonthStart = new Date(
    Date.UTC(snapshot.getUTCFullYear(), snapshot.getUTCMonth(), 1),
  );
  const horizonEnd = new Date(
    snapshot.getTime() + Math.max(0, horizonDays) * 86_400_000,
  );

  for (const month of months ?? []) {
    if (String(month.status).toUpperCase() !== 'CONFIRMED') continue;
    const demandMonth = startOfMonth(toDate(month.demandMonth));
    if (demandMonth < currentMonthStart || demandMonth > horizonEnd) continue;

    const monthKey = dateKey(demandMonth);
    includedMonths.add(monthKey.slice(0, 7));
    for (const line of month.lines ?? []) {
      const productId = Number(line.productId);
      const quantityBase = Number(line.quantityBase);
      if (!Number.isInteger(productId) || productId <= 0) continue;
      if (!Number.isFinite(quantityBase) || quantityBase <= 0) continue;
      totalByProduct.set(
        productId,
        (totalByProduct.get(productId) ?? 0) + quantityBase,
      );
      const detail = {
        monthId: month.id ?? null,
        customerId: month.customerId ?? null,
        customerName: month.customerName ?? null,
        demandMonth: monthKey.slice(0, 7),
        quantityBase,
      };
      const details = detailsByProduct.get(productId) ?? [];
      details.push(detail);
      detailsByProduct.set(productId, details);
    }
  }

  return {
    totalByProduct,
    detailsByProduct,
    includedMonths: [...includedMonths].sort(),
  };
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) return new Date(value.getTime());
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
