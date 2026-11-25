import {
  analyzeFuel,
  computeFuelMetrics,
  type FuelRow,
} from './vehicle-metrics';

const day = (value: string) => new Date(`${value}T05:00:00+07:00`);

const fill = (
  id: number,
  date: string,
  odo: number | null,
  liters: number | null,
  amount: number,
  vehicleId = 9,
): FuelRow => ({
  id,
  vehicleId,
  odo,
  liters,
  amount,
  occurredAt: day(date),
});

// Minh họa xe "29D - 223.09 - Xăng": phiếu 01/07 nhập nhầm ODO 59,465
// (cao hơn các lần đổ tháng 10), các phiếu tháng 10 nhập đúng.
const rows: FuelRow[] = [
  fill(1, '2026-07-01', 59465, 19.8113, 420000),
  fill(2, '2026-10-16', 59170, 18.5, 500000),
  fill(3, '2026-10-19', 59352, 7.4, 200000),
  fill(4, '2026-10-20', 59437, 18.5, 500000),
  fill(5, '2026-10-23', 59647, 24.99, 630000),
];

describe('analyzeFuel', () => {
  it('gắn cờ đúng phiếu ODO lệch thứ tự và không để nó làm sai phiếu bên cạnh', () => {
    const metrics = computeFuelMetrics(rows, new Map());

    expect(metrics.get(1)?.odoCheck).toBe('BACKWARD');
    expect(metrics.get(1)?.litersPer100Km).toBeNull();
    expect(metrics.get(1)?.nextOdo).toBe(59170);
    // 20/10: lần trước là 19/10, lần sau là 23/10 (không phải phiếu 01/07).
    expect(metrics.get(4)?.prevOdo).toBe(59352);
    expect(metrics.get(4)?.nextOdo).toBe(59647);
    expect(metrics.get(4)?.odoCheck).toBeNull();
  });

  it('lấy số lít, số tiền của chính phiếu ÷ km tới lần đổ kế tiếp', () => {
    const metrics = computeFuelMetrics(rows, new Map());

    // 16/10: 18.5 L, chạy 59,170 → 59,352 = 182 km.
    expect(metrics.get(2)?.kmInPeriod).toBe(182);
    expect(metrics.get(2)?.litersPer100Km).toBeCloseTo(10.16, 2);
    // 19/10 chỉ đổ 200k: 7.4 L chạy 85 km tới lần sau, vẫn ra số hợp lý.
    expect(metrics.get(3)?.kmInPeriod).toBe(85);
    expect(metrics.get(3)?.litersPer100Km).toBeCloseTo(8.71, 2);
    expect(metrics.get(3)?.costPerKm).toBe(2353);
    expect(metrics.get(4)?.litersPer100Km).toBeCloseTo(8.81, 2);
  });

  it('phiếu mới nhất chờ lần đổ sau mới có kết quả', () => {
    const last = computeFuelMetrics(rows, new Map()).get(5);

    expect(last?.prevOdo).toBe(59437);
    expect(last?.nextOdo).toBeNull();
    expect(last?.kmInPeriod).toBeNull();
    expect(last?.litersPer100Km).toBeNull();
    expect(last?.consumptionCheck).toBeNull();
  });

  const normOf = (fuelNorm: number) =>
    computeFuelMetrics(
      rows,
      new Map([[9, { min: null, max: null, fuelNorm }]]),
    );

  it('so L/100km của từng phiếu với định mức của xe, cho phép lệch ±1', () => {
    // Từng phiếu: 16/10 = 10.16, 19/10 = 8.71, 20/10 = 8.81.
    const metrics = normOf(9);

    expect(metrics.get(2)?.consumptionCheck).toBe('ABNORMAL'); // cao quá
    expect(metrics.get(3)?.consumptionCheck).toBe('NORMAL');
    expect(metrics.get(4)?.consumptionCheck).toBe('NORMAL');
    expect(metrics.get(4)?.norm).toBe(9);
    expect(normOf(10).get(3)?.consumptionCheck).toBe('ABNORMAL'); // thấp quá
  });

  it('lệch đúng 1.00 L/100km (sau khi làm tròn) vẫn bình thường', () => {
    // 20/10 = 8.81.
    expect(normOf(7.81).get(4)?.consumptionCheck).toBe('NORMAL');
    expect(normOf(9.81).get(4)?.consumptionCheck).toBe('NORMAL');
    expect(normOf(7.8).get(4)?.consumptionCheck).toBe('ABNORMAL');
    expect(normOf(9.82).get(4)?.consumptionCheck).toBe('ABNORMAL');
  });

  it('không kết luận định mức khi xe chưa đặt định mức', () => {
    const metrics = computeFuelMetrics(rows, new Map()).get(4);

    expect(metrics?.norm).toBeNull();
    expect(metrics?.consumptionCheck).toBeNull();
  });

  it('kiểm tra đ/km của từng phiếu khi xe đã đặt ngưỡng', () => {
    // 20/10: 500,000 ÷ 210 km = 2,381 đ/km.
    const within = computeFuelMetrics(
      rows,
      new Map([[9, { min: 2000, max: 3000 }]]),
    ).get(4);
    const outside = computeFuelMetrics(
      rows,
      new Map([[9, { min: 2500, max: 3000 }]]),
    ).get(4);

    expect(within?.costPerKm).toBe(2381);
    expect(within?.costCheck).toBe('NORMAL');
    expect(outside?.costCheck).toBe('ABNORMAL');
  });

  it('km tới lần sau quá xa thì gắn cờ JUMP và không tính tiêu hao cho kỳ đó', () => {
    const metrics = computeFuelMetrics(
      [
        fill(11, '2026-10-01', 1000, 20, 500000),
        fill(12, '2026-10-05', 3500, 20, 500000),
        fill(13, '2026-10-08', 3800, 30, 750000),
      ],
      new Map(),
    );

    expect(metrics.get(11)?.odoCheck).toBe('JUMP');
    expect(metrics.get(11)?.kmInPeriod).toBe(2500);
    expect(metrics.get(11)?.litersPer100Km).toBeNull();
    expect(metrics.get(12)?.litersPer100Km).toBeCloseTo(6.67, 2);
    expect(metrics.get(13)?.litersPer100Km).toBeNull();
  });

  it('gộp các phiếu cùng ODO thành một lần đổ', () => {
    const metrics = computeFuelMetrics(
      [
        fill(21, '2026-10-01', 5000, 20, 500000),
        fill(22, '2026-10-04', 5200, 10, 250000),
        fill(23, '2026-10-04', 5200, 12, 300000),
        fill(24, '2026-10-07', 5400, 15, 400000),
      ],
      new Map(),
    );

    expect(metrics.get(21)?.litersPer100Km).toBeCloseTo(10, 6);
    // 10 + 12 L, 250k + 300k cho 200 km tới lần sau.
    expect(metrics.get(22)?.litersPer100Km).toBeCloseTo(11, 6);
    expect(metrics.get(23)?.costPerKm).toBe(2750);
  });

  it('bỏ qua phiếu không có ODO và không trộn giữa các xe', () => {
    const metrics = computeFuelMetrics(
      [
        ...rows,
        fill(31, '2026-10-21', 0, 2.4, 70000),
        fill(32, '2026-10-22', 59500, 11, 300000, 10),
      ],
      new Map(),
    );

    expect(metrics.has(31)).toBe(false);
    expect(metrics.get(4)?.nextOdo).toBe(59647);
    expect(metrics.get(32)?.nextOdo).toBeNull();
    expect(metrics.get(32)?.prevOdo).toBeNull();
  });

  it('L/100km thực tế của xe = tổng lít ÷ tổng km các lần đổ trong 2 tháng gần nhất', () => {
    // Tới 25/11: từ 25/09 → kỳ 16/10, 19/10, 20/10 (23/10 chưa có lần sau).
    const all = analyzeFuel(
      rows,
      new Map(),
      new Date('2026-11-25T12:00:00+07:00'),
    ).vehicles;
    // (18.5 + 7.4 + 18.5) ÷ (182 + 85 + 210) × 100.
    expect(all.get(9)).toEqual({ litersPer100Km: 9.31, samples: 3 });

    // Tới 19/12: từ 19/10 → chỉ kỳ 19/10, 20/10: (7.4 + 18.5) ÷ (85 + 210).
    const recent = analyzeFuel(
      rows,
      new Map(),
      new Date('2026-12-19T00:00:00+07:00'),
    ).vehicles;
    expect(recent.get(9)).toEqual({ litersPer100Km: 8.78, samples: 2 });

    // Không có lần đổ nào trong 2 tháng → không có số.
    const none = analyzeFuel(
      rows,
      new Map(),
      new Date('2027-03-01T00:00:00+07:00'),
    ).vehicles;
    expect(none.has(9)).toBe(false);
  });
});
