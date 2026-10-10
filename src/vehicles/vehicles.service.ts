import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { fundDayStart } from '../internal-fund/internal-fund-ledger.service';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleQueryDto,
} from './dto/vehicle.dto';
import {
  FUEL_NORM_BASELINE_FROM,
  VEHICLE_SCOPES,
  VEHICLE_SERVICE,
  type VehiclePermissionAction,
} from './vehicles.constants';
import {
  computeFuelMetrics,
  type CostThreshold,
  type FuelMetrics,
} from './vehicle-metrics';

const NOT_CANCELLED = { not: 'CANCELLED' };
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
    private readonly authService: AuthService,
  ) {}

  scopeForBranch(branchId: number) {
    return VEHICLE_SCOPES.find((scope) =>
      (scope.branchIds as readonly number[]).includes(Number(branchId)),
    );
  }

  /** Chi nhánh mà user có ít nhất một trong các quyền `vehicles:{action}_{scope}`. */
  async allowedBranches(
    user: any,
    actions: VehiclePermissionAction[],
  ): Promise<number[]> {
    if (!user?.id) return [];
    if (user.roles?.includes('Super Admin')) {
      return VEHICLE_SCOPES.flatMap((scope) => [...scope.branchIds]);
    }
    const branches: number[] = [];
    for (const scope of VEHICLE_SCOPES) {
      for (const branchId of scope.branchIds) {
        const permissions = await this.authService.getPermissionsForBranch(
          user.id,
          branchId,
        );
        if (
          actions.some((action) =>
            permissions.includes(`vehicles:${action}_${scope.key}`),
          )
        ) {
          branches.push(branchId);
        }
      }
    }
    return branches;
  }

  async assertPermission(
    user: any,
    branchId: number,
    action: VehiclePermissionAction,
  ) {
    const scope = this.scopeForBranch(branchId);
    if (!scope) {
      throw new ForbiddenException(
        'Chi nhánh không thuộc phạm vi xe cộ của kho',
      );
    }
    if (user?.roles?.includes('Super Admin')) return;
    const permissions = await this.authService.getPermissionsForBranch(
      user.id,
      branchId,
    );
    if (!permissions.includes(`vehicles:${action}_${scope.key}`)) {
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
    const [odoRows, registrationRows, insuranceRows, oilRows] =
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
      ]);
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
      };
    });
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
    await this.assertDriver(dto.driverId);
    return this.prisma.vehicle.create({
      data: {
        branchId: dto.branchId,
        label,
        plate,
        vehicleType: dto.vehicleType || 'CAR',
        fuelType: dto.fuelType || null,
        driverId: dto.driverId || null,
        costPerKmMin: dto.costPerKmMin ?? null,
        costPerKmMax: dto.costPerKmMax ?? null,
        oilChangeIntervalKm: dto.oilChangeIntervalKm ?? null,
        note: dto.note?.trim() || null,
        createdBy: user.id,
      },
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
          oilChangeIntervalKm: dto.oilChangeIntervalKm,
          note: dto.note !== undefined ? dto.note?.trim() || null : undefined,
          isActive: dto.isActive,
        },
      });
      // vehicleName là bản sao tên xe trên phiếu, phiếu chi kho đang đọc cột này.
      if (label && label !== vehicle.label) {
        await tx.internalFinanceEntry.updateMany({
          where: { vehicleId: id },
          data: { vehicleName: label },
        });
      }
      return updated;
    });
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
          occurredAt: true,
        },
      }),
      this.prisma.vehicle.findMany({
        where: { id: { in: ids } },
        select: { id: true, costPerKmMin: true, costPerKmMax: true },
      }),
    ]);
    const thresholds = new Map<number, CostThreshold>(
      vehicles.map((vehicle) => [
        vehicle.id,
        {
          min: toNumber(vehicle.costPerKmMin),
          max: toNumber(vehicle.costPerKmMax),
        },
      ]),
    );
    return computeFuelMetrics(
      rows.map((row) => ({
        id: row.id,
        vehicleId: row.vehicleId as number,
        odo: toNumber(row.vehicleOdo),
        amount: Number(row.amount),
        liters: toNumber(row.vehicleLiters),
        occurredAt: row.occurredAt,
      })),
      thresholds,
      fundDayStart(FUEL_NORM_BASELINE_FROM),
    );
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
    if (!driverId) return;
    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
    if (!driver) throw new BadRequestException('Không tìm thấy lái xe');
  }
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
