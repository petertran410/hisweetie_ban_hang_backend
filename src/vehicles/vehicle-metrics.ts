import {
  FUEL_MAX_KM_BETWEEN_FILLS,
  FUEL_NORM_TOLERANCE,
  FUEL_RECENT_MONTHS,
  VEHICLE_CHECK,
  VEHICLE_ODO_CHECK,
} from './vehicles.constants';

export interface FuelRow {
  id: number;
  vehicleId: number;
  odo: number | null;
  amount: number;
  liters: number | null;
  occurredAt: Date;
}

/** Ngưỡng đặt trên từng xe: đ/km (min, max) và định mức L/100km. */
export interface VehicleThreshold {
  min: number | null;
  max: number | null;
  fuelNorm?: number | null;
}

export interface FuelMetrics {
  /** ODO của lần đổ liền trước theo ngày (bỏ qua phiếu ODO lệch thứ tự). */
  prevOdo: number | null;
  /** ODO của lần đổ kế tiếp theo ngày (bỏ qua phiếu ODO lệch thứ tự). */
  nextOdo: number | null;
  /** Km từ lần đổ này tới lần đổ kế tiếp (quãng đường chạy bằng xăng vừa đổ). */
  kmInPeriod: number | null;
  /** Số tiền của lần đổ này ÷ km tới lần đổ kế tiếp. */
  costPerKm: number | null;
  /** Số lít của lần đổ này ÷ km tới lần đổ kế tiếp × 100. */
  litersPer100Km: number | null;
  /** Định mức L/100km của xe (cho phép lệch ±FUEL_NORM_TOLERANCE); null khi chưa đặt. */
  norm: number | null;
  /** VEHICLE_ODO_CHECK khi ODO của phiếu bất thường, ngược lại null. */
  odoCheck: string | null;
  consumptionCheck: string | null;
  costCheck: string | null;
}

export interface ConsumptionStats {
  /** Tổng lít ÷ tổng km × 100 của các lần đổ trong FUEL_RECENT_MONTHS tháng gần nhất. */
  litersPer100Km: number | null;
  /** Số lần đổ đã dùng để tính. */
  samples: number;
  /** Tổng km của các lần đổ đó (mỗi lần: km tới lần đổ kế tiếp). */
  km: number;
  /** Tổng lít của các lần đổ đó. */
  liters: number;
}

export interface FuelAnalysis {
  /** Chỉ số theo id phiếu. */
  metrics: Map<number, FuelMetrics>;
  /** L/100km thực tế gần đây theo id xe. */
  vehicles: Map<number, ConsumptionStats>;
}

/** Số hữu hạn hoặc null (ngưỡng chưa đặt). */
const pick = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : null;

export const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * So L/100km với định mức, cho phép lệch ±FUEL_NORM_TOLERANCE cả hai chiều.
 * So số đã làm tròn 2 số lẻ như cột hiển thị (và làm tròn cả độ lệch để tránh
 * sai số dấu phẩy động), nên lệch đúng 1.00 vẫn "Bình thường". Thiếu một trong
 * hai số thì không kết luận (null).
 */
export function normCheck(
  litersPer100Km: number | null,
  norm: number | null,
): string | null {
  if (litersPer100Km === null || norm === null) return null;
  return round2(Math.abs(round2(litersPer100Km) - norm)) <= FUEL_NORM_TOLERANCE
    ? VEHICLE_CHECK.NORMAL
    : VEHICLE_CHECK.ABNORMAL;
}

/** Một lần dừng đổ: các phiếu liên tiếp cùng ODO gộp làm một. */
interface FillEvent {
  odo: number;
  liters: number | null;
  amount: number;
  rows: FuelRow[];
}

/** Một cặp (số lít của lần đổ, km tới lần đổ kế tiếp) và ngày đổ. */
interface Segment {
  km: number;
  value: number;
  at: Date;
}

/** Mốc bắt đầu của "N tháng gần nhất" tính từ `now`. */
export function monthsAgo(now: Date, months: number) {
  const from = new Date(now);
  from.setMonth(from.getMonth() - months);
  return from;
}

const sumSegments = (segments: Segment[]) => ({
  km: segments.reduce((sum, item) => sum + item.km, 0),
  value: segments.reduce((sum, item) => sum + item.value, 0),
});

/**
 * Vị trí các phiếu thuộc dãy ODO không giảm dài nhất (theo thứ tự ngày).
 * Phiếu nằm ngoài dãy là phiếu nhập sai ODO: bỏ ít phiếu nhất để ODO tăng dần,
 * nên lỗi gắn đúng vào phiếu sai chứ không vào phiếu đúng ngay sau nó.
 */
function monotonicIndexes(odos: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(odos.length).fill(-1);
  for (let i = 0; i < odos.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (odos[tails[mid]] <= odos[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; ) {
    keep.add(i);
    i = prev[i];
  }
  return keep;
}

const emptyMetrics = (norm: number | null): FuelMetrics => ({
  prevOdo: null,
  nextOdo: null,
  kmInPeriod: null,
  costPerKm: null,
  litersPer100Km: null,
  norm,
  odoCheck: null,
  consumptionCheck: null,
  costCheck: null,
});

/**
 * Tiêu hao xăng theo từng xe, xét theo ngày đổ. Tài xế đổ theo số tiền khi gần
 * hết xăng (không đổ đầy bình), nên xăng đổ ở một lần dùng cho quãng đường tới
 * lần đổ kế tiếp:
 * - Lần đổ trước / kế tiếp = phiếu liền trước / liền sau theo ngày (không theo
 *   ODO). Phiếu có ODO lệch thứ tự bị gắn cờ BACKWARD và bỏ qua.
 * - L/100km, đ/km của một phiếu = số lít, số tiền của chính phiếu ÷ km từ phiếu
 *   đó tới lần đổ kế tiếp; phiếu mới nhất chờ lần đổ sau mới có kết quả. Km tới
 *   lần sau vượt FUEL_MAX_KM_BETWEEN_FILLS thì gắn cờ JUMP, không tính.
 * - Kiểm tra định mức: L/100km của từng phiếu so với định mức của xe
 *   (`fuelNorm`), lệch quá ±FUEL_NORM_TOLERANCE (cao hơn hoặc thấp hơn) là bất
 *   thường. Xe chưa đặt định mức thì không kết luận. đ/km của từng phiếu so với
 *   ngưỡng đ/km đặt trên xe.
 * - "L/100km thực tế" của xe = tổng lít ÷ tổng km của các lần đổ trong
 *   FUEL_RECENT_MONTHS tháng gần nhất (tính tới `now`).
 */
export function analyzeFuel(
  rows: FuelRow[],
  thresholds: Map<number, VehicleThreshold>,
  now: Date = new Date(),
): FuelAnalysis {
  const recentFrom = monthsAgo(now, FUEL_RECENT_MONTHS);
  const metrics = new Map<number, FuelMetrics>();
  const vehicles = new Map<number, ConsumptionStats>();
  const byVehicle = new Map<number, FuelRow[]>();
  for (const row of rows) {
    if (row.odo === null || !(row.odo > 0)) continue;
    const list = byVehicle.get(row.vehicleId) || [];
    list.push(row);
    byVehicle.set(row.vehicleId, list);
  }

  for (const [vehicleId, list] of byVehicle) {
    list.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id,
    );
    const threshold = thresholds.get(vehicleId);
    const norm = pick(threshold?.fuelNorm);
    const costMin = pick(threshold?.min);
    const costMax = pick(threshold?.max);
    const odos = list.map((row) => row.odo as number);
    const keep = monotonicIndexes(odos);

    // ODO hợp lệ gần nhất phía sau mỗi vị trí, để phiếu bị cờ vẫn hiện ODO kỳ sau.
    const keptOdoAfter: Array<number | null> = new Array(list.length).fill(
      null,
    );
    for (let i = list.length - 2; i >= 0; i--) {
      keptOdoAfter[i] = keep.has(i + 1) ? odos[i + 1] : keptOdoAfter[i + 1];
    }

    const events: FillEvent[] = [];
    let lastKeptOdo: number | null = null;
    list.forEach((row, index) => {
      const odo = row.odo as number;
      if (!keep.has(index)) {
        metrics.set(row.id, {
          ...emptyMetrics(norm),
          prevOdo: lastKeptOdo,
          nextOdo: keptOdoAfter[index],
          odoCheck: VEHICLE_ODO_CHECK.BACKWARD,
        });
        return;
      }
      const last = events[events.length - 1];
      if (last && last.odo === odo) {
        last.liters =
          last.liters !== null && row.liters !== null
            ? last.liters + row.liters
            : null;
        last.amount += row.amount;
        last.rows.push(row);
      } else {
        events.push({
          odo,
          liters: row.liters,
          amount: row.amount,
          rows: [row],
        });
      }
      lastKeptOdo = odo;
    });

    // Các cặp (lít, km) hợp lệ, chỉ dùng cho "L/100km thực tế" của xe.
    const literSegments: Segment[] = [];
    events.forEach((event, index) => {
      const prev = index > 0 ? events[index - 1] : null;
      const next = index < events.length - 1 ? events[index + 1] : null;
      const km = next ? next.odo - event.odo : null;
      const jump = km !== null && km > FUEL_MAX_KM_BETWEEN_FILLS;
      const usable = km !== null && km > 0 && !jump;
      const hasLiters = usable && event.liters !== null;
      const hasAmount = usable && event.amount > 0;
      if (hasLiters) {
        literSegments.push({
          km: km,
          value: event.liters as number,
          at: event.rows[0].occurredAt,
        });
      }
      const litersPer100Km = hasLiters
        ? ((event.liters as number) / (km as number)) * 100
        : null;
      const costPerKm = hasAmount
        ? Math.round(event.amount / (km as number))
        : null;

      const value: FuelMetrics = {
        prevOdo: prev ? prev.odo : null,
        nextOdo: next ? next.odo : null,
        kmInPeriod: km,
        costPerKm,
        litersPer100Km,
        norm,
        odoCheck: jump ? VEHICLE_ODO_CHECK.JUMP : null,
        consumptionCheck: normCheck(litersPer100Km, norm),
        costCheck:
          costPerKm === null || costMin === null || costMax === null
            ? null
            : costPerKm > costMin && costPerKm < costMax
              ? VEHICLE_CHECK.NORMAL
              : VEHICLE_CHECK.ABNORMAL,
      };
      for (const row of event.rows) metrics.set(row.id, value);
    });

    const recent = literSegments.filter((item) => item.at >= recentFrom);
    const total = sumSegments(recent);
    if (total.km > 0) {
      vehicles.set(vehicleId, {
        litersPer100Km: round2((total.value / total.km) * 100),
        samples: recent.length,
        km: round2(total.km),
        liters: round2(total.value),
      });
    }
  }

  return { metrics, vehicles };
}

/** Chỉ số tiêu hao theo id phiếu (xem `analyzeFuel`). */
export function computeFuelMetrics(
  rows: FuelRow[],
  thresholds: Map<number, VehicleThreshold>,
): Map<number, FuelMetrics> {
  return analyzeFuel(rows, thresholds).metrics;
}
