import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Vehicle } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceAccessService } from '../auth/finance-access.service';
import {
  EMPTY_VALUE,
  FINANCE_AUDIT_ENTITY,
  FinanceAuditService,
  auditActor,
  fieldLabel,
  formatFieldValue,
  type FinanceAuditEntry,
} from '../finance-audit';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleFuelSummaryQueryDto,
  VehicleQueryDto,
} from './dto/vehicle.dto';
import {
  VEHICLE_SCOPES,
  VEHICLE_SERVICE,
  type VehiclePermissionAction,
} from './vehicles.constants';
import {
  analyzeFuel,
  computeFuelMetrics,
  type FuelMetrics,
  type FuelRow,
  type VehicleThreshold,
} from './vehicle-metrics';
import { summarizeFuel } from './vehicle-fuel-summary';

const NOT_CANCELLED = { not: 'CANCELLED' };

/** Người dùng đăng nhập (req.user) dùng cho lịch sử. */
type AuditUser = { id: number; name?: string | null; email?: string | null };

// Trường của xe in ra khi thêm xe (lịch sử tài chính nội bộ).
const VEHICLE_LINE_FIELDS = [
  'label',
  'plate',
  'vehicleType',
  'fuelType',
  'branchId',
  'driverId',
  'costPerKmMin',
  'costPerKmMax',
  'fuelNorm',
  'oilChangeIntervalKm',
  'note',
] as const;

/** Tên xe kèm biển số cho câu lịch sử. */
const vehicleLabel = (vehicle: Pick<Vehicle, 'label' | 'plate'>) =>
  vehicle.plate ? `${vehicle.label} (${vehicle.plate})` : vehicle.label;

function vehicleLines(vehicle: Vehicle, driverName?: string | null) {
  return VEHICLE_LINE_FIELDS.map((field) => ({
    label: fieldLabel(FINANCE_AUDIT_ENTITY.VEHICLE, field),
    value:
      field === 'driverId'
        ? driverName ||
          (vehicle.driverId ? `#${vehicle.driverId}` : EMPTY_VALUE)
        : formatFieldValue(FINANCE_AUDIT_ENTITY.VEHICLE, field, vehicle[field]),
  }));
}
const ALL_ACTIONS: VehiclePermissionAction[] = [
  'view',
  'create',
  'update',
  'manage',
];

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  scopeForBranch(branchId: number) {
    return VEHICLE_SCOPES.find((scope) =>
      (scope.branchIds as readonly number[]).includes(Number(branchId)),
    );
  }

  /** Chi nhánh kho mà user được truy cập và có ít nhất một quyền `vehicles:{action}`. */
  async allowedBranches(
    user: any,
    actions: VehiclePermissionAction[],
  ): Promise<number[]> {
    if (!user?.id) return [];
    return this.access.branchesFor(
      user,
      actions.map((action) => `vehicles:${action}`),
      VEHICLE_SCOPES.flatMap((scope) => [...scope.branchIds]),
    );
  }

  async assertPermission(
    user: any,
    branchId: number,
    action: VehiclePermissionAction,
  ) {
    if (!this.scopeForBranch(branchId)) {
      throw new ForbiddenException(
        'Chi nhánh không thuộc phạm vi xe cộ của kho',
      );
    }
    if (!(await this.access.can(user, branchId, `vehicles:${action}`))) {
      throw new ForbiddenException(
        `Không có quyền ${action} xe cộ cho chi nhánh này`,
      );
    }
  }

  async list(query: VehicleQueryDto, user: any) {
    // Người chỉ có quyền tạo phiếu vẫn cần danh sách xe để chọn.
    const allowed = await this.allowedBranches(user, ALL_ACTIONS);
    if (!allowed.length) {
      throw new ForbiddenException('Không có quyền xem danh sách xe');
    }
    if (query.branchId !== undefined && !allowed.includes(query.branchId)) {
      throw new ForbiddenException('Không có quyền xem xe của chi nhánh này');
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        branchId: { in: query.branchId ? [query.branchId] : allowed },
        ...(query.includeInactive === 'true' ? {} : { isActive: true }),
      },
      orderBy: [{ branchId: 'asc' }, { isActive: 'desc' }, { label: 'asc' }],
      include: {
        branch: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
      },
    });
    const ids = vehicles.map((vehicle) => vehicle.id);
    if (!ids.length) return [];

    const careWhere = {
      vehicleId: { in: ids },
      category: 'VEHICLE_CARE',
      status: NOT_CANCELLED,
    };
    const [odoRows, registrationRows, insuranceRows, oilRows, fuel] =
      await Promise.all([
        this.prisma.internalFinanceEntry.groupBy({
          by: ['vehicleId'],
          where: {
            vehicleId: { in: ids },
            category: 'FUEL',
            status: NOT_CANCELLED,
          },
          _max: { vehicleOdo: true },
        }),
        this.prisma.internalFinanceEntry.groupBy({
          by: ['vehicleId'],
          where: {
            ...careWhere,
            vehicleServiceTypes: { has: VEHICLE_SERVICE.REGISTRATION },
          },
          _max: { vehicleDueAt: true },
        }),
        this.prisma.internalFinanceEntry.groupBy({
          by: ['vehicleId'],
          where: {
            ...careWhere,
            vehicleServiceTypes: { has: VEHICLE_SERVICE.INSURANCE },
          },
          _max: { vehicleDueAt: true },
        }),
        this.prisma.internalFinanceEntry.groupBy({
          by: ['vehicleId'],
          where: {
            ...careWhere,
            vehicleServiceTypes: { has: VEHICLE_SERVICE.OIL_CHANGE },
          },
          _max: { vehicleOdo: true },
        }),
        this.loadFuel(ids),
      ]);
    const consumption = analyzeFuel(fuel.rows, fuel.thresholds).vehicles;
    const odo = new Map(
      odoRows.map((row) => [row.vehicleId, row._max.vehicleOdo]),
    );
    const registration = new Map(
      registrationRows.map((row) => [row.vehicleId, row._max.vehicleDueAt]),
    );
    const insurance = new Map(
      insuranceRows.map((row) => [row.vehicleId, row._max.vehicleDueAt]),
    );
    const oil = new Map(
      oilRows.map((row) => [row.vehicleId, row._max.vehicleOdo]),
    );

    return vehicles.map((vehicle) => {
      const currentOdo = toNumber(odo.get(vehicle.id));
      const lastOilChangeOdo = toNumber(oil.get(vehicle.id));
      const kmSinceOilChange =
        currentOdo !== null && lastOilChangeOdo !== null
          ? currentOdo - lastOilChangeOdo
          : null;
      return {
        ...vehicle,
        currentOdo,
        registrationDueAt: registration.get(vehicle.id) || null,
        insuranceDueAt: insurance.get(vehicle.id) || null,
        lastOilChangeOdo,
        kmSinceOilChange,
        oilChangeDue:
          vehicle.oilChangeIntervalKm && kmSinceOilChange !== null
            ? kmSinceOilChange >= vehicle.oilChangeIntervalKm
            : false,
        // L/100km thực tế gần đây, để đối chiếu khi đặt định mức.
        recentLitersPer100Km:
          consumption.get(vehicle.id)?.litersPer100Km ?? null,
        recentFuelSamples: consumption.get(vehicle.id)?.samples ?? 0,
      };
    });
  }

  /**
   * Báo cáo tổng hợp xăng dầu theo xe (sheet "Tổng hợp"): định mức, km, lít,
   * L/100km thực tế FUEL_RECENT_MONTHS tháng gần nhất và chênh lệch đơn giá.
   */
  async fuelSummary(query: VehicleFuelSummaryQueryDto, user: any) {
    const allowed = await this.allowedBranches(user, ['view']);
    if (!allowed.length) {
      throw new ForbiddenException('Không có quyền xem báo cáo xăng dầu');
    }
    if (query.branchId !== undefined && !allowed.includes(query.branchId)) {
      throw new ForbiddenException(
        'Không có quyền xem báo cáo xăng dầu của chi nhánh này',
      );
    }
    const branchIds = query.branchId ? [query.branchId] : allowed;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { branchId: { in: branchIds } },
      select: {
        id: true,
        branchId: true,
        label: true,
        plate: true,
        vehicleType: true,
        fuelType: true,
        isActive: true,
        fuelNorm: true,
        branch: { select: { id: true, name: true } },
      },
    });
    const { rows } = await this.loadFuel(vehicles.map((vehicle) => vehicle.id));
    const summary = summarizeFuel(
      vehicles.map((vehicle) => ({
        ...vehicle,
        fuelNorm: toNumber(vehicle.fuelNorm),
      })),
      rows,
      VEHICLE_SCOPES.flatMap((scope) => [...scope.branchIds]),
    );
    const branchNames = new Map(
      vehicles.map((vehicle) => [vehicle.branchId, vehicle.branch?.name]),
    );
    return {
      ...summary,
      groups: summary.groups.map((group) => ({
        ...group,
        branchName: branchNames.get(group.branchId) || null,
      })),
    };
  }

  async create(dto: CreateVehicleDto, user: any) {
    await this.assertPermission(user, dto.branchId, 'manage');
    this.assertThresholds(dto.costPerKmMin, dto.costPerKmMax);
    const label = dto.label.trim();
    const plate = dto.plate.trim();
    if (!label || !plate) {
      throw new BadRequestException('Cần nhập tên xe và biển số');
    }
    await this.assertLabelFree(dto.branchId, label);
    const driver = await this.assertDriver(dto.driverId);
    const actor = auditActor.user(user as AuditUser);
    // Thêm xe và ghi lịch sử trong cùng transaction.
    return this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({
        data: {
          branchId: dto.branchId,
          label,
          plate,
          vehicleType: dto.vehicleType || 'CAR',
          fuelType: dto.fuelType || null,
          driverId: dto.driverId || null,
          costPerKmMin: dto.costPerKmMin ?? null,
          costPerKmMax: dto.costPerKmMax ?? null,
          fuelNorm: dto.fuelNorm ?? null,
          oilChangeIntervalKm: dto.oilChangeIntervalKm ?? null,
          note: dto.note?.trim() || null,
          createdBy: user.id,
        },
      });
      await this.financeAudit.write(tx, {
        action: 'FIN_VEHICLE_CREATE',
        entityType: FINANCE_AUDIT_ENTITY.VEHICLE,
        entityId: vehicle.id,
        entityCode: vehicle.plate,
        branchId: vehicle.branchId,
        actor,
        params: { label: vehicleLabel(vehicle) },
        snapshot: { lines: vehicleLines(vehicle, driver?.name) },
      });
      return vehicle;
    });
  }

  async update(id: number, dto: UpdateVehicleDto, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException('Không tìm thấy xe');
    await this.assertPermission(user, vehicle.branchId, 'manage');
    const min =
      dto.costPerKmMin !== undefined
        ? dto.costPerKmMin
        : toNumber(vehicle.costPerKmMin);
    const max =
      dto.costPerKmMax !== undefined
        ? dto.costPerKmMax
        : toNumber(vehicle.costPerKmMax);
    this.assertThresholds(min, max);
    const label = dto.label !== undefined ? dto.label.trim() : undefined;
    const plate = dto.plate !== undefined ? dto.plate.trim() : undefined;
    if (label === '' || plate === '') {
      throw new BadRequestException('Cần nhập tên xe và biển số');
    }
    if (label && label !== vehicle.label) {
      await this.assertLabelFree(vehicle.branchId, label);
    }
    if (dto.driverId) await this.assertDriver(dto.driverId);
    const actor = auditActor.user(user as AuditUser);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.vehicle.update({
        where: { id },
        data: {
          label,
          plate,
          vehicleType: dto.vehicleType,
          fuelType: dto.fuelType,
          driverId: dto.driverId,
          costPerKmMin: dto.costPerKmMin,
          costPerKmMax: dto.costPerKmMax,
          fuelNorm: dto.fuelNorm,
          oilChangeIntervalKm: dto.oilChangeIntervalKm,
          note: dto.note !== undefined ? dto.note?.trim() || null : undefined,
          isActive: dto.isActive,
        },
      });
      // vehicleName là bản sao tên xe trên phiếu, phiếu chi kho đang đọc cột này.
      let renamedEntries = 0;
      if (label && label !== vehicle.label) {
        const renamed = await tx.internalFinanceEntry.updateMany({
          where: { vehicleId: id },
          data: { vehicleName: label },
        });
        renamedEntries = renamed.count;
      }
      await this.financeAudit.write(
        tx,
        this.updateEntries(vehicle, updated, renamedEntries, actor),
      );
      return updated;
    });
  }

  /**
   * Lịch sử sửa xe: đổi tên (kèm số phiếu cũ đổi theo), ngừng/dùng lại và các
   * trường khác tách thành từng dòng; không đổi gì thì không ghi.
   */
  private updateEntries(
    before: Vehicle,
    after: Vehicle,
    renamedEntries: number,
    actor: FinanceAuditEntry['actor'],
  ): FinanceAuditEntry[] {
    const changes = this.financeAudit.diff(
      FINANCE_AUDIT_ENTITY.VEHICLE,
      before,
      after,
    );
    const base = {
      entityType: FINANCE_AUDIT_ENTITY.VEHICLE,
      entityId: after.id,
      entityCode: after.plate,
      branchId: after.branchId,
      actor,
    };
    const entries: FinanceAuditEntry[] = [];
    const fieldChanges = changes.filter(
      (change) => change.field !== 'label' && change.field !== 'isActive',
    );
    if (fieldChanges.length)
      entries.push({
        ...base,
        action: 'FIN_VEHICLE_UPDATE',
        params: { label: vehicleLabel(after) },
        changes: fieldChanges,
      });
    const rename = changes.find((change) => change.field === 'label');
    if (rename)
      entries.push({
        ...base,
        action: 'FIN_VEHICLE_RENAME',
        params: { from: before.label, to: after.label, count: renamedEntries },
        changes: [rename],
        metadata: { renamedEntries },
      });
    const active = changes.find((change) => change.field === 'isActive');
    if (active)
      entries.push({
        ...base,
        action: after.isActive
          ? 'FIN_VEHICLE_REACTIVATE'
          : 'FIN_VEHICLE_DEACTIVATE',
        params: { label: vehicleLabel(after) },
        changes: [active],
      });
    return entries;
  }

  /** Xe hợp lệ để gắn vào một phiếu của chi nhánh. */
  async requireForBranch(vehicleId: number, branchId: number) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle || vehicle.branchId !== Number(branchId)) {
      throw new BadRequestException('Xe không thuộc chi nhánh đã chọn');
    }
    if (!vehicle.isActive) {
      throw new BadRequestException('Xe đã ngừng sử dụng');
    }
    return vehicle;
  }

  /** Chỉ số tiêu hao của mọi phiếu xăng thuộc các xe truyền vào, theo id phiếu. */
  async fuelMetrics(vehicleIds: number[]): Promise<Map<number, FuelMetrics>> {
    const ids = Array.from(new Set(vehicleIds.filter(Boolean)));
    if (!ids.length) return new Map();
    const { rows, thresholds } = await this.loadFuel(ids);
    return computeFuelMetrics(rows, thresholds);
  }

  /** Phiếu xăng chưa hủy và ngưỡng (đ/km, định mức L/100km) của các xe. */
  private async loadFuel(ids: number[]): Promise<{
    rows: FuelRow[];
    thresholds: Map<number, VehicleThreshold>;
  }> {
    if (!ids.length) return { rows: [], thresholds: new Map() };
    const [rows, vehicles] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where: {
          vehicleId: { in: ids },
          category: 'FUEL',
          status: NOT_CANCELLED,
        },
        select: {
          id: true,
          vehicleId: true,
          vehicleOdo: true,
          amount: true,
          vehicleLiters: true,
          vehicleUnitPrice: true,
          occurredAt: true,
        },
      }),
      this.prisma.vehicle.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          costPerKmMin: true,
          costPerKmMax: true,
          fuelNorm: true,
        },
      }),
    ]);
    return {
      rows: rows.map((row) => ({
        id: row.id,
        vehicleId: row.vehicleId as number,
        odo: toNumber(row.vehicleOdo),
        amount: Number(row.amount),
        liters: toNumber(row.vehicleLiters),
        unitPrice: toNumber(row.vehicleUnitPrice),
        occurredAt: row.occurredAt,
      })),
      thresholds: new Map(
        vehicles.map((vehicle) => [
          vehicle.id,
          {
            min: toNumber(vehicle.costPerKmMin),
            max: toNumber(vehicle.costPerKmMax),
            fuelNorm: toNumber(vehicle.fuelNorm),
          },
        ]),
      ),
    };
  }

  private assertThresholds(min?: number | null, max?: number | null) {
    if (min != null && max != null && min >= max) {
      throw new BadRequestException(
        'Ngưỡng đ/km tối thiểu phải nhỏ hơn ngưỡng tối đa',
      );
    }
  }

  private async assertLabelFree(branchId: number, label: string) {
    const existing = await this.prisma.vehicle.findUnique({
      where: { branchId_label: { branchId, label } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Chi nhánh này đã có xe cùng tên');
    }
  }

  private async assertDriver(driverId?: number | null) {
    if (!driverId) return null;
    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { id: true, name: true },
    });
    if (!driver) throw new BadRequestException('Không tìm thấy lái xe');
    return driver;
  }
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
