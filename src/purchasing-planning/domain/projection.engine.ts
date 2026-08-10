import { addDays, toDateKey } from './date';
import { IncomingReceipt, ProjectionResult } from './models';

export interface ProjectionInput {
  snapshotDate: string | Date;
  availableStock: number;
  forecastDailyDemand: number;
  incoming?: IncomingReceipt[];
  horizonDays?: number;
}

export function projectInventory(input: ProjectionInput): ProjectionResult {
  const snapshotDate = toDateKey(input.snapshotDate);
  const horizonDays = input.horizonDays ?? 180;
  const incomingByDate = new Map<string, number>();
  for (const receipt of input.incoming ?? []) {
    const date = receipt.date < snapshotDate ? snapshotDate : receipt.date;
    incomingByDate.set(
      date,
      (incomingByDate.get(date) ?? 0) + receipt.quantity,
    );
  }
  let stock = input.availableStock;
  let projectedStockoutDate: string | null = stock <= 0 ? snapshotDate : null;
  let daysUntilStockout: number | null = stock <= 0 ? 0 : null;
  let minProjectedStock = stock;
  let minStockDate = snapshotDate;
  const days = Array.from({ length: Math.max(0, horizonDays) }, (_, index) => {
    const day = index + 1;
    const date = addDays(snapshotDate, day);
    const openingStock = stock;
    const incoming = incomingByDate.get(date) ?? 0;
    // TD §6.3: mỗi ngày trừ nhu cầu trước, sau đó nhận lô về trong ngày.
    stock = stock - Math.max(0, input.forecastDailyDemand) + incoming;
    if (stock < minProjectedStock) {
      minProjectedStock = stock;
      minStockDate = date;
    }
    if (projectedStockoutDate === null && stock <= 0) {
      projectedStockoutDate = date;
      daysUntilStockout = day;
    }
    return {
      date,
      openingStock,
      incoming,
      demand: Math.max(0, input.forecastDailyDemand),
      closingStock: stock,
    };
  });
  return {
    days,
    projectedStockoutDate,
    daysUntilStockout,
    minProjectedStock,
    minStockDate,
  };
}
