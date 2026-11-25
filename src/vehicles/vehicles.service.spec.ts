import { Prisma } from '@prisma/client';
import { FinanceAuditService } from '../finance-audit';
import { VehiclesService } from './vehicles.service';

// Lịch sử xe (Cài đặt → Lịch sử): thêm, sửa, đổi tên, ngừng/dùng lại; ghi cùng
// transaction với thay đổi.

function fixture() {
  const vehicles: any[] = [];
  const prisma: any = {
    vehicle: {
      // Bản sao như Prisma trả về (không dùng chung object với "DB").
      findUnique: jest.fn(async ({ where }: any) => {
        const row =
          where.id !== undefined
            ? vehicles.find((item) => item.id === where.id)
            : vehicles.find(
                (item) =>
                  item.branchId === where.branchId_label.branchId &&
                  item.label === where.branchId_label.label,
              );
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: vehicles.length + 1,
          isActive: true,
          ...data,
        };
        vehicles.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = vehicles.find((item) => item.id === where.id);
        for (const [key, value] of Object.entries(data))
          if (value !== undefined) row[key] = value;
        return { ...row };
      }),
    },
    internalFinanceEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        name: `Lái xe ${where.id}`,
      })),
      findMany: jest.fn(async ({ where }: any) =>
        where.id.in.map((id: number) => ({
          id,
          name: id === 7 ? 'Quản lý kho' : `Lái xe ${id}`,
          email: null,
        })),
      ),
    },
    auditLog: { createMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const access: any = { can: jest.fn().mockResolvedValue(true) };
  const service = new VehiclesService(
    prisma,
    access,
    new FinanceAuditService(),
  );
  const logs = (): any[] =>
    prisma.auditLog.createMany.mock.calls.flatMap(([arg]: any) => arg.data);
  return { service, prisma, vehicles, logs };
}

const user = { id: 7 };

describe('VehiclesService audit log', () => {
  it('logs a new vehicle with its details', async () => {
    const f = fixture();
    await f.service.create(
      {
        branchId: 6,
        label: ' Xe tải 1 ',
        plate: '29C-123.45',
        driverId: 12,
        costPerKmMax: 3000,
      },
      user,
    );
    expect(f.prisma.$transaction).toHaveBeenCalled();
    const rows = f.logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionCode: 'FIN_VEHICLE_CREATE',
      actionType: 'POST',
      category: 'internal_finance',
      entityType: 'vehicles',
      entityId: '1',
      entityCode: '29C-123.45',
      branchId: 6,
      userName: 'Quản lý kho',
      message: 'Thêm xe Xe tải 1 (29C-123.45)',
    });
    expect(rows[0].snapshot.lines).toEqual(
      expect.arrayContaining([
        { label: 'Tài xế', value: 'Lái xe 12' },
        { label: 'Định mức tối đa/km', value: '3.000 đ' },
      ]),
    );
  });

  it('splits an update into field changes, rename and deactivate rows of one operation', async () => {
    const f = fixture();
    f.vehicles.push({
      id: 5,
      branchId: 6,
      label: 'Xe tải 1',
      plate: '29C-123.45',
      vehicleType: 'CAR',
      fuelType: 'DIESEL',
      driverId: 12,
      costPerKmMin: null,
      costPerKmMax: new Prisma.Decimal(3000),
      oilChangeIntervalKm: null,
      isActive: true,
      note: null,
    });
    await f.service.update(
      5,
      { label: 'Xe tải lớn', driverId: 13, isActive: false },
      user,
    );
    expect(f.prisma.internalFinanceEntry.updateMany).toHaveBeenCalledWith({
      where: { vehicleId: 5 },
      data: { vehicleName: 'Xe tải lớn' },
    });
    const rows = f.logs();
    expect(f.prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.actionCode)).toEqual([
      'FIN_VEHICLE_UPDATE',
      'FIN_VEHICLE_RENAME',
      'FIN_VEHICLE_DEACTIVATE',
    ]);
    expect(rows[0].changes).toEqual([
      expect.objectContaining({
        field: 'driverId',
        from: 'Lái xe 12',
        to: 'Lái xe 13',
      }),
    ]);
    expect(rows[1]).toMatchObject({
      message: 'Đổi tên xe Xe tải 1 → Xe tải lớn (3 phiếu cũ đổi theo)',
      metadata: expect.objectContaining({ renamedEntries: 3 }),
    });
    expect(rows[2]).toMatchObject({
      message: 'Ngừng dùng xe Xe tải lớn (29C-123.45)',
      changes: [expect.objectContaining({ from: 'Có', to: 'Không' })],
    });
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
  });

  it('logs a reactivation and writes nothing when nothing changed', async () => {
    const f = fixture();
    f.vehicles.push({
      id: 5,
      branchId: 6,
      label: 'Xe tải 1',
      plate: '29C-123.45',
      vehicleType: 'CAR',
      fuelType: null,
      driverId: null,
      costPerKmMin: null,
      costPerKmMax: null,
      oilChangeIntervalKm: null,
      isActive: false,
      note: null,
    });
    await f.service.update(5, { label: 'Xe tải 1', plate: '29C-123.45' }, user);
    expect(f.logs()).toEqual([]);
    expect(f.prisma.internalFinanceEntry.updateMany).not.toHaveBeenCalled();

    await f.service.update(5, { isActive: true }, user);
    expect(f.logs()).toEqual([
      expect.objectContaining({
        actionCode: 'FIN_VEHICLE_REACTIVATE',
        message: 'Dùng lại xe Xe tải 1 (29C-123.45)',
      }),
    ]);
  });
});

describe('VehiclesService fuel summary', () => {
  function summaryFixture(viewBranches: number[]) {
    const prisma: any = {
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      internalFinanceEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const access: any = {
      branchesFor: jest.fn(async (_user: any, permissions: string[]) =>
        permissions.includes('vehicles:view') ? viewBranches : [],
      ),
    };
    const service = new VehiclesService(
      prisma,
      access,
      new FinanceAuditService(),
    );
    return { service, prisma, access };
  }

  it('chỉ cần quyền xem xe, không có quyền thì từ chối', async () => {
    const f = summaryFixture([]);
    await expect(f.service.fuelSummary({}, user)).rejects.toThrow(
      'Không có quyền xem báo cáo xăng dầu',
    );
    expect(f.access.branchesFor.mock.calls[0][1]).toEqual(['vehicles:view']);
  });

  it('từ chối lọc kho không có quyền xem', async () => {
    const f = summaryFixture([6]);
    await expect(f.service.fuelSummary({ branchId: 1 }, user)).rejects.toThrow(
      'Không có quyền xem báo cáo xăng dầu của chi nhánh này',
    );
    expect(f.prisma.vehicle.findMany).not.toHaveBeenCalled();
  });

  it('tất cả kho: chỉ lấy xe của các kho được xem', async () => {
    const f = summaryFixture([6]);
    const result = await f.service.fuelSummary({}, user);
    expect(f.prisma.vehicle.findMany.mock.calls[0][0].where).toEqual({
      branchId: { in: [6] },
    });
    expect(result.groups).toEqual([]);
    expect(f.prisma.internalFinanceEntry.findMany).not.toHaveBeenCalled();
  });
});
