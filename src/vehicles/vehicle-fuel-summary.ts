import {
  FUEL_NORM_TOLERANCE,
  FUEL_RECENT_MONTHS,
  VEHICLE_TYPES,
} from './vehicles.constants';
import {
  analyzeFuel,
  monthsAgo,
  normCheck,
  round2,
  type FuelRow,
  type VehicleThreshold,
} from './vehicle-metrics';

/** Thông tin xe cần cho báo cáo tổng hợp xăng dầu. */
export interface FuelSummaryVehicle {
  id: number;
  branchId: number;
  label: string;
  plate: string;
  vehicleType: string;
  fuelType: string | null;
  isActive: boolean;
  fuelNorm: number | null;
}

/** Một dòng xe của tab "Tổng hợp". */
export interface FuelSummaryRow {
  vehicleId: number;
  branchId: number;
  label: string;
  plate: string;
  vehicleType: string;
  fuelType: string | null;
  isActive: boolean;
  /** Định mức đang cài cho xe (L/100km). */
  fuelNorm: number | null;
  /** Tổng km đã đi trong kỳ (mỗi lần đổ: km tới lần đổ kế tiếp). */
  km: number | null;
  /** Tổng lít của các lần đổ đã tính km (lít ÷ km = L/100km thực tế). */
  liters: number | null;
  /** L/100km thực tế trong kỳ = lít ÷ km × 100 (giống Danh sách xe). */
  litersPer100Km: number | null;
  /** Số lần đổ đã dùng để tính km và lít. */
  samples: number;
  /** So L/100km thực tế với định mức ±FUEL_NORM_TOLERANCE. */
  consumptionCheck: string | null;
}

export interface FuelSummaryTotal {
  vehicles: number;
  km: number | null;
  liters: number | null;
  litersPer100Km: number | null;
}

export interface FuelSummaryGroup {
  branchId: number;
  rows: FuelSummaryRow[];
  total: FuelSummaryTotal;
}

export interface FuelSummary {
  from: Date;
  to: Date;
  months: number;
  tolerance: number;
  groups: FuelSummaryGroup[];
  total: FuelSummaryTotal;
}

const sumOrNull = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
};

function totalOf(rows: FuelSummaryRow[]): FuelSummaryTotal {
  const km = sumOrNull(rows.map((row) => row.km));
  const liters = sumOrNull(rows.map((row) => row.liters));
  return {
    vehicles: rows.length,
    km: km === null ? null : round2(km),
    liters: liters === null ? null : round2(liters),
    litersPer100Km:
      km !== null && liters !== null && km > 0
        ? round2((liters / km) * 100)
        : null,
  };
}

const typeOrder = (type: string) => {
  const index = (VEHICLE_TYPES as readonly string[]).indexOf(type);
  return index < 0 ? VEHICLE_TYPES.length : index;
};

/**
 * Tab "Tổng hợp" xăng dầu: mỗi xe một dòng (cài đặt hiện tại + thực tế), nhóm
 * theo kho.
 * - Kỳ = FUEL_RECENT_MONTHS tháng gần nhất tới `now` (cùng kỳ với "L/100km
 *   thực tế" trong Danh sách xe, nên hai nơi ra cùng một số).
 * - Km, lít, L/100km lấy từ `analyzeFuel`: chỉ các lần đổ đã biết km tới lần
 *   đổ kế tiếp (không tính lần đổ mới nhất, phiếu ODO sai, quãng > 2000 km).
 * - Dòng tổng cộng km và lít; L/100km tính lại từ hai tổng đó.
 * Xe ngừng dùng chỉ hiện khi có lần đổ trong kỳ.
 */
export function summarizeFuel(
  vehicles: FuelSummaryVehicle[],
  rows: FuelRow[],
  branchOrder: number[],
  now: Date = new Date(),
): FuelSummary {
  const from = monthsAgo(now, FUEL_RECENT_MONTHS);
  const thresholds = new Map<number, VehicleThreshold>(
    vehicles.map((vehicle) => [
      vehicle.id,
      { min: null, max: null, fuelNorm: vehicle.fuelNorm },
    ]),
  );
  const consumption = analyzeFuel(rows, thresholds, now).vehicles;
  const filledInPeriod = new Set(
    rows
      .filter((row) => row.occurredAt >= from && row.occurredAt <= now)
      .map((row) => row.vehicleId),
  );

  const summaryRows = vehicles
    .filter((vehicle) => vehicle.isActive || filledInPeriod.has(vehicle.id))
    .sort(
      (a, b) =>
        typeOrder(a.vehicleType) - typeOrder(b.vehicleType) ||
        a.label.localeCompare(b.label, 'vi'),
    )
    .map((vehicle): FuelSummaryRow => {
      const stats = consumption.get(vehicle.id);
      return {
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        label: vehicle.label,
        plate: vehicle.plate,
        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        isActive: vehicle.isActive,
        fuelNorm: vehicle.fuelNorm,
        km: stats ? stats.km : null,
        liters: stats ? stats.liters : null,
        litersPer100Km: stats ? stats.litersPer100Km : null,
        samples: stats ? stats.samples : 0,
        consumptionCheck: normCheck(
          stats ? stats.litersPer100Km : null,
          vehicle.fuelNorm,
        ),
      };
    });

  const branchIds = [
    ...branchOrder,
    ...new Set(summaryRows.map((row) => row.branchId)),
  ].filter((id, index, list) => list.indexOf(id) === index);
  const groups = branchIds
    .map((branchId) => {
      const list = summaryRows.filter((row) => row.branchId === branchId);
      return { branchId, rows: list, total: totalOf(list) };
    })
    .filter((group) => group.rows.length > 0);

  return {
    from,
    to: now,
    months: FUEL_RECENT_MONTHS,
    tolerance: FUEL_NORM_TOLERANCE,
    groups,
    total: totalOf(summaryRows),
  };
}
