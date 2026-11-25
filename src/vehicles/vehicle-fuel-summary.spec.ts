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
  unitPrice: number | null = null,
): FuelRow => ({
  id,
  vehicleId,
  odo,
  liters,
  amount,
  unitPrice,
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
];

const rows: FuelRow[] = [
  // Xe 9: phiếu 01/07 ODO sai (ngoài kỳ), 4 lần đổ tháng 10 trong kỳ.
  fill(1, 9, '2026-07-01', 59465, 19.8113, 420000),
  fill(2, 9, '2026-10-16', 59170, 18.5, 500000, 27000),
  fill(3, 9, '2026-10-19', 59352, 7.4, 200000, 27000),
  fill(4, 9, '2026-10-20', 59437, 18.5, 500000, 27000),
  fill(5, 9, '2026-10-23', 59647, 24.99, 700000, 28000),
  // Xe 12 ngừng dùng nhưng có một lần đổ trong kỳ (chưa có km), không ghi đơn giá.
  fill(6, 12, '2026-11-01', 1000, 2, 50000),
  // Xe 13 chỉ đổ trước kỳ: có đơn giá hiện tại, không có đơn giá trung bình.
  fill(7, 13, '2026-08-01', 5000, 10, 240000, 24000),
  // Phiếu sau thời điểm báo cáo không được tính.
  fill(8, 13, '2026-12-01', 5300, 10, 300000, 30000),
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

  it('đơn giá TB theo lít trong kỳ, đơn giá hiện tại = lần đổ gần nhất, chênh lệch theo tháng', () => {
    // (27000 × 44.4 + 28000 × 24.99) ÷ 69.39 = 27360.
    expect(row(9)).toMatchObject({
      avgUnitPrice: 27360,
      currentUnitPrice: 28000,
      currentPriceAt: day('2026-10-23'),
      priceDiff: 640,
      // 640 × 44.4 lít ÷ 2 tháng.
      monthlyExtraCost: 14208,
    });
  });

  it('thiếu đơn giá thì lấy số tiền ÷ số lít; chưa có km thì không có tiền chênh lệch', () => {
    expect(row(12)).toMatchObject({
      km: null,
      liters: null,
      litersPer100Km: null,
      samples: 0,
      avgUnitPrice: 25000,
      currentUnitPrice: 25000,
      priceDiff: 0,
      monthlyExtraCost: null,
    });
  });

  it('chỉ đổ trước kỳ: có đơn giá hiện tại nhưng không có trung bình; bỏ phiếu sau thời điểm báo cáo', () => {
    expect(row(13)).toMatchObject({
      avgUnitPrice: null,
      currentUnitPrice: 24000,
      priceDiff: null,
      monthlyExtraCost: null,
    });
    expect(row(11)).toMatchObject({
      km: null,
      avgUnitPrice: null,
      currentUnitPrice: null,
      consumptionCheck: null,
    });
  });

  it('dòng tổng: cộng km, lít, tiền; L/100km và đơn giá tính lại từ tổng', () => {
    expect(summary.groups[0].total).toEqual({
      vehicles: 2,
      km: 477,
      liters: 44.4,
      litersPer100Km: 9.31,
      avgUnitPrice: 27360,
      monthlyExtraCost: 14208,
    });
    expect(summary.groups[1].total).toEqual({
      vehicles: 2,
      km: null,
      liters: null,
      litersPer100Km: null,
      avgUnitPrice: 25000,
      monthlyExtraCost: null,
    });
    // (27000 × 44.4 + 28000 × 24.99 + 25000 × 2) ÷ 71.39 = 27294.
    expect(summary.total).toMatchObject({
      vehicles: 4,
      avgUnitPrice: 27294,
      monthlyExtraCost: 14208,
    });
  });
});
