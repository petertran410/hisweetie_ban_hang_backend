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

/** Một dòng xe của sheet "Tổng hợp". */
export interface FuelSummaryRow {
  vehicleId: number;
  branchId: number;
  label: string;
  plate: string;
  vehicleType: string;
  fuelType: string | null;
  isActive: boolean;
  /** Định mức do quản lý kho đặt (L/100km). */
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
  /** Đơn giá trung bình (đ/lít) của mọi lần đổ trong kỳ, bình quân theo lít. */
  avgUnitPrice: number | null;
  /** Đơn giá của lần đổ gần nhất (đ/lít). */
  currentUnitPrice: number | null;
  currentPriceAt: Date | null;
  /** Đơn giá hiện tại − đơn giá trung bình. */
  priceDiff: number | null;
  /** Chênh lệch đơn giá × số lít một tháng (lít trong kỳ ÷ số tháng). */
  monthlyExtraCost: number | null;
}

export interface FuelSummaryTotal {
  vehicles: number;
  km: number | null;
  liters: number | null;
  litersPer100Km: number | null;
  avgUnitPrice: number | null;
  monthlyExtraCost: number | null;
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

/** Tổng (đơn giá × lít) và tổng lít có đơn giá, để tính đơn giá bình quân theo lít. */
interface PriceSum {
  value: number;
  liters: number;
}

/** Đơn giá của một phiếu: đơn giá nhập trên phiếu, thiếu thì số tiền ÷ số lít. */
function unitPriceOf(row: FuelRow): number | null {
  if (
    row.unitPrice !== null &&
    row.unitPrice !== undefined &&
    row.unitPrice > 0
  )
    return row.unitPrice;
  if (row.liters !== null && row.liters > 0 && row.amount > 0)
    return row.amount / row.liters;
  return null;
}

const sumOrNull = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
};

function totalOf(rows: FuelSummaryRow[], prices: PriceSum[]): FuelSummaryTotal {
  const km = sumOrNull(rows.map((row) => row.km));
  const liters = sumOrNull(rows.map((row) => row.liters));
  const price = prices.reduce(
    (sum, item) => ({
      value: sum.value + item.value,
      liters: sum.liters + item.liters,
    }),
    { value: 0, liters: 0 },
  );
  const extra = sumOrNull(rows.map((row) => row.monthlyExtraCost));
  return {
    vehicles: rows.length,
    km: km === null ? null : round2(km),
    liters: liters === null ? null : round2(liters),
    litersPer100Km:
      km !== null && liters !== null && km > 0
        ? round2((liters / km) * 100)
        : null,
    avgUnitPrice:
      price.liters > 0 ? Math.round(price.value / price.liters) : null,
    monthlyExtraCost: extra === null ? null : Math.round(extra),
  };
}

const typeOrder = (type: string) => {
  const index = (VEHICLE_TYPES as readonly string[]).indexOf(type);
  return index < 0 ? VEHICLE_TYPES.length : index;
};

/**
 * Sheet "Tổng hợp" của báo cáo xăng dầu: mỗi xe một dòng, nhóm theo kho.
 * - Kỳ = FUEL_RECENT_MONTHS tháng gần nhất tới `now` (cùng kỳ với "L/100km
 *   thực tế" trong Danh sách xe, nên hai nơi ra cùng một số).
 * - Km, lít, L/100km lấy từ `analyzeFuel`: chỉ các lần đổ đã biết km tới lần
 *   đổ kế tiếp (không tính lần đổ mới nhất, phiếu ODO sai, quãng > 2000 km).
 * - Đơn giá trung bình = Σ(đơn giá × lít) ÷ Σ lít của mọi lần đổ trong kỳ;
 *   đơn giá hiện tại = đơn giá của lần đổ gần nhất (kể cả trước kỳ).
 * - Tiền chênh lệch do tăng giá (tháng) = chênh lệch đơn giá × (lít ÷ số tháng),
 *   tính trên số đã làm tròn như cột hiển thị để cộng tay ra đúng số.
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

  const prices = new Map<number, PriceSum>();
  const latest = new Map<number, { row: FuelRow; price: number }>();
  const filledInPeriod = new Set<number>();
  for (const row of rows) {
    if (row.occurredAt > now) continue;
    const price = unitPriceOf(row);
    const inPeriod = row.occurredAt >= from;
    if (inPeriod) filledInPeriod.add(row.vehicleId);
    if (price === null) continue;
    const current = latest.get(row.vehicleId);
    if (
      !current ||
      row.occurredAt.getTime() > current.row.occurredAt.getTime() ||
      (row.occurredAt.getTime() === current.row.occurredAt.getTime() &&
        row.id > current.row.id)
    ) {
      latest.set(row.vehicleId, { row, price });
    }
    if (inPeriod && row.liters !== null && row.liters > 0) {
      const sum = prices.get(row.vehicleId) || { value: 0, liters: 0 };
      sum.value += price * row.liters;
      sum.liters += row.liters;
      prices.set(row.vehicleId, sum);
    }
  }

  const summaryRows = vehicles
    .filter((vehicle) => vehicle.isActive || filledInPeriod.has(vehicle.id))
    .sort(
      (a, b) =>
        typeOrder(a.vehicleType) - typeOrder(b.vehicleType) ||
        a.label.localeCompare(b.label, 'vi'),
    )
    .map((vehicle): FuelSummaryRow => {
      const stats = consumption.get(vehicle.id);
      const price = prices.get(vehicle.id);
      const avgUnitPrice =
        price && price.liters > 0
          ? Math.round(price.value / price.liters)
          : null;
      const last = latest.get(vehicle.id);
      const currentUnitPrice = last ? Math.round(last.price) : null;
      const priceDiff =
        avgUnitPrice !== null && currentUnitPrice !== null
          ? currentUnitPrice - avgUnitPrice
          : null;
      const liters = stats ? stats.liters : null;
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
        liters,
        litersPer100Km: stats ? stats.litersPer100Km : null,
        samples: stats ? stats.samples : 0,
        consumptionCheck: normCheck(
          stats ? stats.litersPer100Km : null,
          vehicle.fuelNorm,
        ),
        avgUnitPrice,
        currentUnitPrice,
        currentPriceAt: last ? last.row.occurredAt : null,
        priceDiff,
        monthlyExtraCost:
          priceDiff !== null && liters !== null
            ? Math.round((priceDiff * liters) / FUEL_RECENT_MONTHS)
            : null,
      };
    });

  const priceList = (list: FuelSummaryRow[]) =>
    list.flatMap((row) => {
      const sum = prices.get(row.vehicleId);
      return sum ? [sum] : [];
    });
  const branchIds = [
    ...branchOrder,
    ...new Set(summaryRows.map((row) => row.branchId)),
  ].filter((id, index, list) => list.indexOf(id) === index);
  const groups = branchIds
    .map((branchId) => {
      const list = summaryRows.filter((row) => row.branchId === branchId);
      return { branchId, rows: list, total: totalOf(list, priceList(list)) };
    })
    .filter((group) => group.rows.length > 0);

  return {
    from,
    to: now,
    months: FUEL_RECENT_MONTHS,
    tolerance: FUEL_NORM_TOLERANCE,
    groups,
    total: totalOf(summaryRows, priceList(summaryRows)),
  };
}
