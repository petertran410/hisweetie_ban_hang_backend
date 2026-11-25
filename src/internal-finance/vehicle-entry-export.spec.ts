import { Prisma } from '@prisma/client';
import type { FuelMetrics } from '../vehicles/vehicle-metrics';
import {
  createVehicleSummary,
  vehicleCheckText,
  vehicleEntryExportColumns,
  vehicleEntryExportRow,
  vehicleStatusText,
  type VehicleEntryExportEntry,
} from './vehicle-entry-export';

const metrics = (patch: Partial<FuelMetrics> = {}): FuelMetrics => ({
  prevOdo: 60191,
  nextOdo: 60431,
  kmInPeriod: 240,
  costPerKm: 2083,
  litersPer100Km: 8.0958,
  norm: 9,
  odoCheck: null,
  consumptionCheck: 'NORMAL',
  costCheck: null,
  ...patch,
});

const entry = (
  patch: Partial<VehicleEntryExportEntry> = {},
): VehicleEntryExportEntry =>
  ({
    id: 1,
    code: 'TCNB-XD-HN-20261031-000063',
    branchId: 6,
    category: 'FUEL',
    occurredAt: new Date('2026-10-31T12:26:00Z'),
    amount: 500000,
    status: 'READY_FOR_WEEKLY_APPROVAL',
    cancelReason: null,
    note: null,
    vehicleId: 9,
    vehicleName: '29D - 223.09 - Xăng',
    vehicleLocation: 'Cụm công nghiệp',
    vehicleUnitPrice: 25730,
    vehicleLiters: 19.43,
    vehicleOdo: 60191,
    vehicleDueAt: null,
    vehicleServiceType: null,
    vehicleServiceTypes: [],
    managerReviewedAt: null,
    accountantReviewedAt: null,
    branch: { name: 'Kho Hà Nội' },
    creator: { name: 'Lái xe A' },
    payer: { name: 'Người chi B' },
    vehicle: { label: '29D - 223.09 - Xăng' },
    weeklyBatch: null,
    attachments: [],
    ...patch,
  }) as unknown as VehicleEntryExportEntry;

describe('vehicleCheckText', () => {
  it('ghép các nhãn như cột Kiểm tra trên bảng', () => {
    expect(vehicleCheckText(metrics())).toBe('Định mức: Bình thường');
    expect(
      vehicleCheckText(
        metrics({ odoCheck: 'JUMP', consumptionCheck: 'ABNORMAL' }),
      ),
    ).toBe('ODO: Bất thường; Định mức: Bất thường');
    expect(
      vehicleCheckText(metrics({ norm: null, consumptionCheck: null })),
    ).toBe('Định mức: Chưa đặt');
    expect(vehicleCheckText(null)).toBe('Chờ lần đổ sau');
    expect(
      vehicleCheckText(
        metrics({
          nextOdo: null,
          kmInPeriod: null,
          litersPer100Km: null,
          consumptionCheck: null,
        }),
      ),
    ).toBe('Chờ lần đổ sau');
  });
});

describe('vehicleEntryExportRow', () => {
  it('phiếu xăng: số đo, kỳ sau và l/100km làm tròn 2 số lẻ', () => {
    const row = vehicleEntryExportRow(entry(), 1, metrics());

    expect(row).toMatchObject({
      stt: 1,
      vehicle: '29D - 223.09 - Xăng',
      liters: 19.43,
      odo: 60191,
      nextOdo: 60431,
      km: 240,
      litersPer100Km: 8.1,
      norm: 9,
      check: 'Định mức: Bình thường',
      status: 'Sẵn sàng tổng hợp',
    });
    // Giờ VN: 12:26 UTC → 19:26.
    expect((row.date as Date).toISOString()).toBe('2026-10-31T19:26:00.000Z');
  });

  it('phiếu chăm sóc xe: loại dịch vụ và hạn theo ngày VN', () => {
    const row = vehicleEntryExportRow(
      entry({
        category: 'VEHICLE_CARE',
        vehicleServiceTypes: ['Rửa xe', 'Thay nhớt'],
        vehicleDueAt: new Date('2027-01-29T17:00:00Z'),
        status: 'CANCELLED',
        cancelReason: 'Nhập trùng',
      }),
      2,
    );

    expect(row.services).toBe('Rửa xe, Thay nhớt');
    expect((row.dueAt as Date).toISOString()).toBe('2027-01-30T00:00:00.000Z');
    expect(row.cancelReason).toBe('Nhập trùng');
    expect(row).not.toHaveProperty('check');
  });

  it('phiếu xăng Kho HN đủ 2 tick hiện "Trừ tiền ứng xăng"', () => {
    // Phiếu xăng Kho HN từ mốc 14/11/2026 mới trừ vào tiền ứng xăng.
    const reviewed = entry({
      occurredAt: new Date('2026-11-16T11:23:00Z'),
      managerReviewedAt: new Date(),
      accountantReviewedAt: new Date(),
    });

    expect(vehicleStatusText(reviewed)).toBe('Trừ tiền ứng xăng');
    expect(vehicleStatusText({ ...reviewed, status: 'CANCELLED' })).toBe(
      'Đã hủy',
    );
  });
});

describe('createVehicleSummary', () => {
  it('l/100km thực tế = tổng lít ÷ tổng km, kỳ dùng chung chỉ cộng một lần', () => {
    const summary = createVehicleSummary();
    const shared = metrics({ kmInPeriod: 200, litersPer100Km: 11 });
    summary.add(entry({ id: 1 }), metrics());
    summary.add(
      entry({ id: 2, vehicleLiters: new Prisma.Decimal(10) }),
      shared,
    );
    summary.add(
      entry({ id: 3, vehicleLiters: new Prisma.Decimal(12) }),
      shared,
    );
    summary.add(
      entry({ id: 4 }),
      metrics({ odoCheck: 'BACKWARD', litersPer100Km: null }),
    );

    const [row] = summary.rows();
    expect(row.count).toBe(4);
    expect(row.km).toBe(440);
    expect(row.kmLiters).toBeCloseTo(19.43 + 22, 2);
    expect(row.abnormal).toBe(1);
  });

  it('cột "Ảnh n" theo số ảnh nhiều nhất', () => {
    const keys = vehicleEntryExportColumns(true, 2).map((column) => column.key);

    expect(keys).toEqual(expect.arrayContaining(['nextOdo', 'file1', 'file2']));
    expect(keys).not.toContain('file3');
  });
});
