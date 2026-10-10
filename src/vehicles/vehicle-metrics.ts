import { VEHICLE_CHECK } from './vehicles.constants';

export interface FuelRow {
  id: number;
  vehicleId: number;
  odo: number | null;
  amount: number;
  liters: number | null;
  occurredAt: Date;
}

export interface CostThreshold {
  min: number | null;
  max: number | null;
}

export interface FuelMetrics {
  prevOdo: number | null;
  nextOdo: number | null;
  kmInPeriod: number | null;
  prevAmount: number | null;
  nextLiters: number | null;
  costPerKm: number | null;
  litersPer100Km: number | null;
  normMin: number | null;
  normMax: number | null;
  consumptionCheck: string | null;
  costCheck: string | null;
}

const maxOf = (values: Array<number | null>) => {
  const numbers = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  return numbers.length ? Math.max(...numbers) : null;
};

/**
 * Công thức bảng "KHO HN - Xăng dầu" trên Lark (bản 13/04/2026), tính theo
 * từng xe: kỳ của một lần đổ kéo dài tới lần đổ kế tiếp, số lít tiêu hao là số
 * lít của lần đổ kế tiếp, còn đ/km lấy số tiền của lần đổ liền trước.
 */
export function computeFuelMetrics(
  rows: FuelRow[],
  thresholds: Map<number, CostThreshold>,
  baselineFrom: Date,
): Map<number, FuelMetrics> {
  const result = new Map<number, FuelMetrics>();
  const byVehicle = new Map<number, FuelRow[]>();
  for (const row of rows) {
    if (row.odo === null || !(row.odo > 0)) continue;
    const list = byVehicle.get(row.vehicleId) || [];
    list.push(row);
    byVehicle.set(row.vehicleId, list);
  }

  for (const [vehicleId, list] of byVehicle) {
    list.sort(
      (a, b) =>
        (a.odo as number) - (b.odo as number) ||
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        a.id - b.id,
    );
    const odos = Array.from(new Set(list.map((row) => row.odo as number)));
    const rowsAtOdo = (odo: number) => list.filter((row) => row.odo === odo);
    const threshold = thresholds.get(vehicleId);
    const partial = new Map<number, FuelMetrics>();
    const baseline: number[] = [];

    for (const row of list) {
      const index = odos.indexOf(row.odo as number);
      const prevOdo = index > 0 ? odos[index - 1] : null;
      const nextOdo = index < odos.length - 1 ? odos[index + 1] : null;
      const kmInPeriod =
        nextOdo !== null ? nextOdo - (row.odo as number) : null;
      const prevAmount =
        prevOdo !== null
          ? maxOf(rowsAtOdo(prevOdo).map((item) => item.amount))
          : null;
      const nextLiters =
        nextOdo !== null
          ? maxOf(rowsAtOdo(nextOdo).map((item) => item.liters))
          : null;
      const litersPer100Km =
        kmInPeriod && nextLiters !== null
          ? (nextLiters / kmInPeriod) * 100
          : null;
      const costPerKm =
        kmInPeriod && prevAmount ? Math.round(prevAmount / kmInPeriod) : null;
      if (litersPer100Km !== null && row.occurredAt >= baselineFrom) {
        baseline.push(litersPer100Km);
      }
      partial.set(row.id, {
        prevOdo,
        nextOdo,
        kmInPeriod,
        prevAmount,
        nextLiters,
        costPerKm,
        litersPer100Km,
        normMin: null,
        normMax: null,
        consumptionCheck: null,
        costCheck: null,
      });
    }

    const normMin = baseline.length ? Math.min(...baseline) - 0.01 : null;
    const normMax = baseline.length
      ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length + 1
      : null;

    for (const [id, metrics] of partial) {
      const consumptionCheck =
        metrics.litersPer100Km === null || normMin === null || normMax === null
          ? null
          : metrics.litersPer100Km > normMin && metrics.litersPer100Km < normMax
            ? VEHICLE_CHECK.NORMAL
            : VEHICLE_CHECK.ABNORMAL;
      const hasThreshold =
        threshold &&
        threshold.min !== null &&
        threshold.max !== null &&
        Number.isFinite(threshold.min) &&
        Number.isFinite(threshold.max);
      const costCheck =
        metrics.costPerKm === null || !hasThreshold
          ? null
          : metrics.costPerKm > (threshold.min as number) &&
              metrics.costPerKm < (threshold.max as number)
            ? VEHICLE_CHECK.NORMAL
            : VEHICLE_CHECK.ABNORMAL;
      result.set(id, {
        ...metrics,
        normMin,
        normMax,
        consumptionCheck,
        costCheck,
      });
    }
  }

  return result;
}
