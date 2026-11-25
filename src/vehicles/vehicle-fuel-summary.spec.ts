import { summarizeFuel, type FuelSummaryVehicle } from './vehicle-fuel-summary';
import type { FuelRow } from './vehicle-metrics';

const day = (value: string) => new Date(`${value}T05:00:00+07:00`);
const NOW = new Date('2026-11-25T12:00:00+07:00');

const fill = (
  id: number,
  vehicleId: number,
  date: string,
  odo: number | null,
  liters: number | null,
  amount: number,
): FuelRow => ({
  id,
  vehicleId,
  odo,
  liters,
  amount,
  occurredAt: day(date),
});

const vehicle = (
  id: number,
  patch: Partial<FuelSummaryVehicle> = {},
): FuelSummaryVehicle => ({
  id,
  branchId: 6,
  label: `Xe ${id}`,
  plate: `29D-${id}`,
  vehicleType: 'CAR',
  fuelType: 'GASOLINE',
  isActive: true,
  fuelNorm: null,
  ...patch,
});

const vehicles = [
  vehicle(9, { fuelNorm: 8 }),
  vehicle(10, { isActive: false }),
  vehicle(11, { branchId: 1, label: 'A' }),
  vehicle(12, {
    branchId: 1,
    vehicleType: 'MOTORBIKE',
    label: 'B',
    isActive: false,
  }),
  vehicle(13, { label: 'Z' }),
  vehicle(14, { label: 'Y', isActive: false }),
];

const rows: FuelRow[] = [
  // Xe 9: phiếu 01/07 ODO sai (ngoài kỳ), 4 lần đổ tháng 10 trong kỳ.
  fill(1, 9, '2026-07-01', 59465, 19.8113, 420000),
  fill(2, 9, '2026-10-16', 59170, 18.5, 500000),
  fill(3, 9, '2026-10-19', 59352, 7.4, 200000),
  fill(4, 9, '2026-10-20', 59437, 18.5, 500000),
  fill(5, 9, '2026-10-23', 59647, 24.99, 700000),
  // Xe 12 ngừng dùng nhưng có một lần đổ trong kỳ (chưa có km).
  fill(6, 12, '2026-11-01', 1000, 2, 50000),
  // Xe 13 chỉ đổ trước kỳ.
  fill(7, 13, '2026-08-01', 5000, 10, 240000),
  // Xe 14 ngừng dùng, chỉ có phiếu sau thời điểm báo cáo: không tính là đổ trong kỳ.
  fill(8, 14, '2026-12-01', 5300, 10, 300000),
];

describe('summarizeFuel', () => {
  const summary = summarizeFuel(vehicles, rows, [6, 1], NOW);
  const row = (id: number) =>
    summary.groups
      .flatMap((group) => group.rows)
      .find((item) => item.vehicleId === id);

  it('kỳ là 2 tháng gần nhất, nhóm theo thứ tự kho truyền vào', () => {
    expect(summary.months).toBe(2);
    expect(summary.tolerance).toBe(1);
    expect(summary.from).toEqual(new Date('2026-09-25T12:00:00+07:00'));
    expect(summary.to).toEqual(NOW);
    expect(summary.groups.map((group) => group.branchId)).toEqual([6, 1]);
  });

  it('bỏ xe ngừng dùng không đổ trong kỳ, giữ xe ngừng dùng có đổ; Ô tô trước Xe máy', () => {
    expect(row(10)).toBeUndefined();
    expect(row(14)).toBeUndefined();
    expect(summary.groups[0].rows.map((item) => item.vehicleId)).toEqual([
      9, 13,
    ]);
    expect(summary.groups[1].rows.map((item) => item.vehicleId)).toEqual([
      11, 12,
    ]);
  });

  it('km, lít, L/100km giống "L/100km thực tế" của Danh sách xe', () => {
    expect(row(9)).toMatchObject({
      km: 477,
      liters: 44.4,
      litersPer100Km: 9.31,
      samples: 3,
      fuelNorm: 8,
      // |9.31 − 8| = 1.31 > 1.
      consumptionCheck: 'ABNORMAL',
    });
  });

  it('chưa có km (một lần đổ, hoặc chỉ đổ trước kỳ) thì để trống, không kết luận', () => {
    expect(row(12)).toMatchObject({
      km: null,
      liters: null,
      litersPer100Km: null,
      samples: 0,
      consumptionCheck: null,
    });
    expect(row(13)).toMatchObject({ km: null, samples: 0 });
    expect(row(11)).toMatchObject({ km: null, consumptionCheck: null });
  });

  it('dòng tổng: cộng km, lít; L/100km tính lại từ tổng', () => {
    expect(summary.groups[0].total).toEqual({
      vehicles: 2,
      km: 477,
      liters: 44.4,
      litersPer100Km: 9.31,
    });
    expect(summary.groups[1].total).toEqual({
      vehicles: 2,
      km: null,
      liters: null,
      litersPer100Km: null,
    });
    expect(summary.total).toEqual({
      vehicles: 4,
      km: 477,
      liters: 44.4,
      litersPer100Km: 9.31,
    });
  });
});
