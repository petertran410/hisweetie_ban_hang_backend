/**
 * Phân tách nguồn cung: tồn kho, hàng đang về chắc chắn, và ghép xe.
 *
 * Ghép xe (status = 1) là hàng gần tới bước thông quan. Không loại bỏ cảnh báo
 * chỉ vì có ghép xe: trừ vào nhu cầu khi có ETA hợp lệ, còn lại giữ là kịch bản
 * rủi ro để người mua thấy cả thiếu lẫn dư.
 */

import { addDays, toDateKey } from './date';

export interface VehicleSupplyLine {
  id: number | string;
  productId: number;
  quantity: number;
  status: number | string;
  expectedArrivalDate?: string | Date | null;
  orderSupplierId?: number;
  orderCode?: string | null;
  supplierName?: string | null;
}

export interface ClassifySupplyInput {
  snapshotDate: string | Date;
  horizonDays: number;
  vehicleLines: VehicleSupplyLine[];
  /** Phần còn lại trên đơn NCC, đã trừ số đã nhập kho. */
  remainingByOrder: Map<number, number>;
}

export interface ClassifiedSupply {
  vehicleConfirmed: number;
  vehicleRisk: number;
  remainingNotOnVehicle: number;
  vehicleLines: Array<{
    id: number | string;
    orderSupplierId?: number;
    orderCode: string | null;
    supplierName: string | null;
    quantity: number;
    eta: string | null;
    etaType: 'CONFIRMED' | 'ESTIMATED' | 'OVERDUE';
    classifiedAs: 'CONFIRMED' | 'RISK';
  }>;
}

export function classifyVehicleSupply(
  input: ClassifySupplyInput,
): ClassifiedSupply {
  const snapshot = toDateKey(input.snapshotDate);
  const horizonEnd = toDateKey(addDays(snapshot, Math.max(0, input.horizonDays)));
  const remaining = new Map(input.remainingByOrder);
  const vehicleLines: ClassifiedSupply['vehicleLines'] = [];
  let vehicleConfirmed = 0;
  let vehicleRisk = 0;

  for (const line of input.vehicleLines) {
    if (!isInTransit(line.status)) continue;
    const quantity = Math.max(0, Number(line.quantity) || 0);
    if (quantity <= 0) continue;

    const orderId = line.orderSupplierId;
    if (orderId != null) {
      const leftover = remaining.get(orderId) ?? 0;
      remaining.set(orderId, Math.max(0, leftover - quantity));
    }

    const eta = line.expectedArrivalDate
      ? toDateKey(line.expectedArrivalDate)
      : null;
    const overdue = Boolean(eta && eta < snapshot);
    const inHorizon = Boolean(eta && eta >= snapshot && eta <= horizonEnd);
    const classifiedAs: 'CONFIRMED' | 'RISK' =
      eta && (inHorizon || overdue) ? 'CONFIRMED' : 'RISK';

    if (classifiedAs === 'CONFIRMED') vehicleConfirmed += quantity;
    else vehicleRisk += quantity;

    vehicleLines.push({
      id: line.id,
      orderSupplierId: line.orderSupplierId,
      orderCode: line.orderCode ?? null,
      supplierName: line.supplierName ?? null,
      quantity,
      eta,
      etaType: overdue ? 'OVERDUE' : eta ? 'CONFIRMED' : 'ESTIMATED',
      classifiedAs,
    });
  }

  let remainingNotOnVehicle = 0;
  for (const quantity of remaining.values()) remainingNotOnVehicle += quantity;

  return {
    vehicleConfirmed,
    vehicleRisk,
    remainingNotOnVehicle,
    vehicleLines,
  };
}

function isInTransit(status: number | string): boolean {
  return Number(status) === 1;
}
