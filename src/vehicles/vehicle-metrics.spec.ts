import { computeFuelMetrics, type FuelRow } from './vehicle-metrics';

const day = (value: string) => new Date(`${value}T05:00:00+07:00`);
const baseline = new Date('2026-04-13T00:00:00+07:00');

// Số thật của xe "29D - 223.09 - Xăng" trên bảng KHO HN - Xăng dầu.
const rows: FuelRow[] = [
  {
    id: 1,
    vehicleId: 9,
    odo: 58445,
    amount: 680000,
    liters: 25.111,
    occurredAt: day('2026-09-28'),
  },
  {
    id: 2,
    vehicleId: 9,
    odo: 58674,
    amount: 750000,
    liters: 27.594,
    occurredAt: day('2026-10-01'),
  },
  {
    id: 3,
    vehicleId: 9,
    odo: 59465,
    amount: 420000,
    liters: 19.811,
    occurredAt: day('2026-10-05'),
  },
];

describe('computeFuelMetrics', () => {
  it('tính kỳ theo lần đổ kế tiếp như công thức Lark kho HN', () => {
    const metrics = computeFuelMetrics(rows, new Map(), baseline);
    const middle = metrics.get(2);

    expect(middle?.prevOdo).toBe(58445);
    expect(middle?.nextOdo).toBe(59465);
    expect(middle?.kmInPeriod).toBe(791);
    expect(middle?.litersPer100Km).toBeCloseTo(2.505, 3);
    expect(middle?.costPerKm).toBe(860);
  });

  it('để trống kết quả khi chưa có lần đổ kế tiếp', () => {
    const last = computeFuelMetrics(rows, new Map(), baseline).get(3);

    expect(last?.nextOdo).toBeNull();
    expect(last?.kmInPeriod).toBeNull();
    expect(last?.litersPer100Km).toBeNull();
    expect(last?.consumptionCheck).toBeNull();
  });

  it('kiểm tra định mức theo min - 0.01 và trung bình + 1 của chính xe đó', () => {
    const metrics = computeFuelMetrics(
      [
        ...rows,
        {
          id: 4,
          vehicleId: 9,
          odo: 59565,
          amount: 500000,
          liters: 30,
          occurredAt: day('2026-10-08'),
        },
      ],
      new Map(),
      baseline,
    );
    // l/100km: #1 = 12.05, #2 = 2.505, #3 = 30 → trung bình 14.85, ngưỡng trên 15.85.
    expect(metrics.get(1)?.consumptionCheck).toBe('NORMAL');
    expect(metrics.get(2)?.consumptionCheck).toBe('NORMAL');
    expect(metrics.get(3)?.consumptionCheck).toBe('ABNORMAL');
    expect(metrics.get(3)?.normMax).toBeCloseTo(15.852, 2);
  });

  it('chỉ kiểm tra đ/km khi xe đã đặt ngưỡng', () => {
    const without = computeFuelMetrics(rows, new Map(), baseline).get(2);
    const within = computeFuelMetrics(
      rows,
      new Map([[9, { min: 800, max: 2000 }]]),
      baseline,
    ).get(2);
    const outside = computeFuelMetrics(
      rows,
      new Map([[9, { min: 1200, max: 2000 }]]),
      baseline,
    ).get(2);

    expect(without?.costCheck).toBeNull();
    expect(within?.costCheck).toBe('NORMAL');
    expect(outside?.costCheck).toBe('ABNORMAL');
  });

  it('bỏ qua phiếu không có ODO và không trộn giữa các xe', () => {
    const metrics = computeFuelMetrics(
      [
        ...rows,
        {
          id: 5,
          vehicleId: 9,
          odo: 0,
          amount: 70000,
          liters: 2.4,
          occurredAt: day('2026-10-09'),
        },
        {
          id: 6,
          vehicleId: 10,
          odo: 58700,
          amount: 300000,
          liters: 11,
          occurredAt: day('2026-10-02'),
        },
      ],
      new Map(),
      baseline,
    );

    expect(metrics.has(5)).toBe(false);
    expect(metrics.get(2)?.nextOdo).toBe(59465);
    expect(metrics.get(6)?.nextOdo).toBeNull();
  });
});
