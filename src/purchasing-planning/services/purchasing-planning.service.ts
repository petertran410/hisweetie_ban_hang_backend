import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import {
  analyzeDemandStability,
  calculateOrderTiming,
  calculatePriority,
  calculatePromotionUplift,
  calculateReplenishment,
  calculateSoq,
  classifyVehicleSupply,
  coverageDaysFor,
  ConfigScope,
  ConfigValue,
  buildDecisionTimeline,
  DecisionTimeline,
  DEFAULT_PLANNING_CONFIG,
  forecastDemand,
  MonthlySales,
  moqSpecToPacks,
  OPERATIONAL_PLANNING_DEFAULTS,
  PlanningConfigKey,
  projectInventory,
  PromotionWindow,
  resolveDemand,
  resolveIncoming,
  resolveLeadtimePipeline,
  resolvePlanningConfig,
  safetyDaysFromStability,
} from '../domain';
import {
  CreatePlanningConfigDto,
  RecommendationQueryDto,
  ResolvedPlanningConfigQueryDto,
  RunCalculationDto,
  UpdatePlanningConfigDto,
} from '../dto';
import {
  PurchasingBranchScope,
  PurchasingPlanningRepository,
} from '../repositories/purchasing-planning.repository';
import { PlanningNetworkService } from './planning-network.service';
import { resolveCustomerDemand } from '../../customer-demand/domain';

type Flag = {
  code: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  blocksRecommendation: boolean;
  message: string;
  context?: Record<string, unknown>;
};

type ConfigActor = { id: number; name: string };

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_PLANNING_CONFIG));
const DEMAND_LOG_TYPES = new Set([
  'INTERNAL_USE',
  'PRODUCTION_OUT',
  'CONSIGNMENT_OUT',
  'RETURN_IN',
  'CONSIGNMENT_RETURN_IN',
]);
const SOURCE_LABEL: Record<string, string> = {
  GLOBAL: 'Mặc định toàn hệ thống',
  CATEGORY: 'Theo nhóm hàng',
  SUPPLIER: 'Theo nhà cung cấp',
  SKU: 'Cấu hình riêng SKU',
  DEFAULT: 'Mặc định toàn hệ thống',
  PRODUCT: 'Sản phẩm · Định lượng đóng gói',
};
const FLAG_DEFINITIONS: Record<string, Omit<Flag, 'context'>> = {
  MISSING_SUPPLIER: {
    code: 'MISSING_SUPPLIER',
    severity: 'HIGH',
    blocksRecommendation: false,
    message: 'Chưa xác định được nhà cung cấp cho sản phẩm.',
  },
  MULTI_SUPPLIER: {
    code: 'MULTI_SUPPLIER',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message: 'Sản phẩm có lịch sử đặt từ nhiều nhà cung cấp.',
  },
  MISSING_FACTORY: {
    code: 'MISSING_FACTORY',
    severity: 'HIGH',
    blocksRecommendation: false,
    message:
      'Chưa gán nhà máy chính cho sản phẩm; leadtime sản xuất chưa có cơ sở.',
  },
  MISSING_LEADTIME: {
    code: 'MISSING_LEADTIME',
    severity: 'HIGH',
    blocksRecommendation: false,
    message: 'Nhà máy chưa khai báo thời gian sản xuất dự kiến.',
  },
  MOQ_NOT_CONVERTIBLE: {
    code: 'MOQ_NOT_CONVERTIBLE',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message:
      'Không quy đổi được MOQ của nhà máy sang số lượng đặt — sản phẩm thiếu quy cách đóng gói hoặc khối lượng.',
  },
  MISSING_FORECAST: {
    code: 'MISSING_FORECAST',
    severity: 'CRITICAL',
    blocksRecommendation: true,
    message: 'Không đủ dữ liệu để lập dự báo nhu cầu.',
  },
  LOW_CONFIDENCE_FORECAST: {
    code: 'LOW_CONFIDENCE_FORECAST',
    severity: 'HIGH',
    blocksRecommendation: false,
    message: 'Dự báo có độ tin cậy thấp, cần kiểm tra trước khi đặt.',
  },
  NEGATIVE_INVENTORY: {
    code: 'NEGATIVE_INVENTORY',
    severity: 'CRITICAL',
    blocksRecommendation: false,
    message: 'Tổng tồn kho vật lý đang âm.',
  },
  RESERVED_DATA_UNRELIABLE: {
    code: 'RESERVED_DATA_UNRELIABLE',
    severity: 'HIGH',
    blocksRecommendation: false,
    message:
      'Dữ liệu tồn giữ chỗ chưa đáng tin cậy; phiên bản này đang dùng reserved = 0.',
  },
  PRICE_MISSING: {
    code: 'PRICE_MISSING',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message: 'Chưa có giá nhập hợp lệ gần nhất.',
  },
  OUT_OF_STOCK: {
    code: 'OUT_OF_STOCK',
    severity: 'CRITICAL',
    blocksRecommendation: false,
    message: 'Sản phẩm hiện đã hết hàng.',
  },
  ORDER_DEFERRED: {
    code: 'ORDER_DEFERRED',
    severity: 'LOW',
    blocksRecommendation: false,
    message: 'Nhu cầu chưa đạt ngưỡng MOQ nên tạm hoãn đặt hàng.',
  },
  MOQ_OVERSHOOT: {
    code: 'MOQ_OVERSHOOT',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message: 'Số lượng đề xuất vượt nhu cầu do áp dụng MOQ.',
  },
  SHIPMENT_DELAYED: {
    code: 'SHIPMENT_DELAYED',
    severity: 'HIGH',
    blocksRecommendation: false,
    message: 'Có lô hàng đang về đã trễ ETA.',
  },
  SHIPMENT_STALE: {
    code: 'SHIPMENT_STALE',
    severity: 'CRITICAL',
    blocksRecommendation: false,
    message: 'Có lô hàng quá hạn lâu, cần xác minh trạng thái.',
  },
  UNEXPLAINED_ANOMALY: {
    code: 'UNEXPLAINED_ANOMALY',
    severity: 'HIGH',
    blocksRecommendation: false,
    message:
      'Có tháng bán bất thường chưa giải thích được bằng khuyến mãi hoặc trend.',
  },
  VEHICLE_SHIPMENT_RISK: {
    code: 'VEHICLE_SHIPMENT_RISK',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message:
      'Có hàng ghép xe chưa chắc ETA nên chưa trừ hết khỏi đề xuất chắc chắn.',
  },
  VEHICLE_OVERSTOCK_RISK: {
    code: 'VEHICLE_OVERSTOCK_RISK',
    severity: 'MEDIUM',
    blocksRecommendation: false,
    message:
      'Nếu ghép xe về đúng hạn, lượng đặt thêm có thể dư so với nhu cầu.',
  },
};

const GROWTH_FACTOR_MIN = 0.8;
const GROWTH_FACTOR_MAX = 1.5;

function clampGrowthFactor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return (
    Math.round(
      Math.min(GROWTH_FACTOR_MAX, Math.max(GROWTH_FACTOR_MIN, value)) * 10000,
    ) / 10000
  );
}

@Injectable()
export class PurchasingPlanningService {
  constructor(
    private readonly repository: PurchasingPlanningRepository,
    private readonly auditLogs: AuditLogsService,
    private readonly networkService: PlanningNetworkService,
  ) {}

  async getConfigs() {
    const rows = await this.repository.findActiveConfigs();
    const entities = await this.loadConfigEntities(rows);
    return { groups: this.groupConfigRows(rows, entities) };
  }

  async getResolvedConfig(query: ResolvedPlanningConfigQueryDto) {
    const derivedContext = query.skuId
      ? await this.repository.findResolvedConfigContext(query.skuId)
      : null;
    if (query.skuId && !derivedContext) {
      throw new NotFoundException('SKU không tồn tại');
    }
    const context = {
      skuId: query.skuId,
      supplierId: query.supplierId ?? derivedContext?.supplierId ?? undefined,
      categoryId: query.categoryId ?? derivedContext?.categoryId ?? undefined,
    };
    await this.validateContext(context, query.skuId != null);
    const rows = await this.repository.findActiveConfigs();
    const entities = await this.loadConfigEntities(rows, context);
    const validRows = rows.filter((row) =>
      this.hasConfigEntity(row.scopeType as ConfigScope, row.scopeId, entities),
    );
    const values = this.toConfigValues(validRows);
    const resolved = resolvePlanningConfig(values, context);
    const currentScope = query.skuId
      ? { scopeType: 'SKU' as ConfigScope, scopeId: query.skuId }
      : query.supplierId
        ? { scopeType: 'SUPPLIER' as ConfigScope, scopeId: query.supplierId }
        : query.categoryId
          ? { scopeType: 'CATEGORY' as ConfigScope, scopeId: query.categoryId }
          : { scopeType: 'GLOBAL' as ConfigScope, scopeId: null };
    const currentValues = values.filter(
      (value) =>
        value.scope === currentScope.scopeType &&
        (value.scope === 'GLOBAL' || value.scopeId === currentScope.scopeId),
    );
    const inherited = resolvePlanningConfig(
      values.filter((value) => !currentValues.includes(value)),
      context,
    );
    const product = derivedContext?.product ?? null;
    const packSize = this.productPackSize(product?.conversionValue);
    const source = Object.fromEntries(
      Object.keys(DEFAULT_PLANNING_CONFIG).map((key) => {
        const typedKey = key as PlanningConfigKey;
        const sourceValue = resolved.sourceValues[typedKey];
        const sourceEntity = sourceValue
          ? this.configEntity(
              sourceValue.scope,
              sourceValue.scopeId ?? null,
              entities,
            )
          : null;
        const genericLabel = SOURCE_LABEL[resolved.sources[typedKey]];
        return [
          key,
          {
            scopeType: resolved.sources[typedKey],
            scopeId: sourceValue?.scopeId ?? null,
            id: sourceEntity?.id ?? null,
            code: sourceEntity?.code ?? null,
            name: sourceEntity?.name ?? null,
            entity: sourceEntity,
            label: sourceEntity?.name
              ? `${genericLabel}: ${sourceEntity.name}`
              : genericLabel,
          },
        ];
      }),
    );
    const overrides = this.valuesObject(currentValues);
    const currentEntity = this.configEntity(
      currentScope.scopeType,
      currentScope.scopeId,
      entities,
    );
    const fields = Object.fromEntries(
      Object.keys(DEFAULT_PLANNING_CONFIG).map((key) => [
        key,
        {
          effective: resolved.config[key as PlanningConfigKey],
          source: source[key],
          current: overrides[key] ?? null,
          inherited: inherited.config[key as PlanningConfigKey],
        },
      ]),
    );

    return {
      effective: resolved.config,
      source,
      raw: {
        current: overrides,
        inherited: inherited.config,
      },
      fields,
      scope: currentScope.scopeType,
      entity: currentEntity,
      configId: currentValues.length
        ? this.groupId(currentScope.scopeType, currentScope.scopeId)
        : null,
      overrides,
      productParameters: {
        packSize,
        conversionValue: product ? Number(product.conversionValue) : null,
        source: 'PRODUCT',
        label: SOURCE_LABEL.PRODUCT,
      },
    };
  }

  async createConfig(dto: CreatePlanningConfigDto, actor?: ConfigActor) {
    const scopeId = this.normalizedScopeId(dto.scopeType, dto.scopeId);
    await this.validateScopeEntity(dto.scopeType, scopeId);
    const values = this.dtoValues(dto);
    this.assertCreateValuesPresent(values);
    const rows = await this.upsertConfigGroup(
      dto.scopeType,
      scopeId,
      values,
      actor?.id,
      dto.note,
    );
    const entities = await this.loadConfigEntities(
      rows,
      this.scopeContext(dto.scopeType, scopeId),
    );
    const group = this.mapConfigGroup(dto.scopeType, scopeId, rows, entities);
    await this.auditConfig(
      'POST',
      'PLANNING_CONFIG_CREATE',
      group.id,
      `Đã tạo cấu hình dự kiến đặt hàng ${group.id}`,
      actor,
      { snapshot: group },
    );
    return group;
  }

  async updateConfig(
    id: string,
    dto: UpdatePlanningConfigDto,
    actor?: ConfigActor,
  ) {
    const { scopeType, scopeId } = this.parseGroupId(id);
    const existing = await this.repository.findActiveConfigGroup(
      scopeType,
      scopeId,
    );
    if (!existing.length)
      throw new NotFoundException('Không tìm thấy cấu hình');
    const values = this.dtoValues(dto);
    this.assertUpdateValuesPresent(values);
    const rows = await this.upsertConfigGroup(
      scopeType,
      scopeId,
      values,
      actor?.id,
      dto.note,
    );
    const entities = await this.loadConfigEntities(
      rows,
      this.scopeContext(scopeType, scopeId),
    );
    const group = this.mapConfigGroup(scopeType, scopeId, rows, entities);
    const resetFields = Object.entries(values)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    const isReset = resetFields.length > 0;
    await this.auditConfig(
      'PATCH',
      isReset ? 'PLANNING_CONFIG_RESET' : 'PLANNING_CONFIG_UPDATE',
      group.id,
      isReset
        ? `Đã đặt lại trường ${resetFields.join(', ')} của cấu hình dự kiến đặt hàng ${group.id}`
        : `Đã cập nhật cấu hình dự kiến đặt hàng ${group.id}`,
      actor,
      {
        changes: {
          before: this.valuesObject(this.toConfigValues(existing)),
          after: group.overrides,
          ...(isReset ? { resetFields } : {}),
        },
      },
    );
    return group;
  }

  async deleteConfig(id: string, actor?: ConfigActor) {
    const { scopeType, scopeId } = this.parseGroupId(id);
    const existing = await this.repository.findActiveConfigGroup(
      scopeType,
      scopeId,
    );
    if (!existing.length)
      throw new NotFoundException('Không tìm thấy cấu hình');
    const result = await this.repository.deactivateConfigGroup(
      scopeType,
      scopeId,
      actor?.id,
    );
    if (!result.count) throw new NotFoundException('Không tìm thấy cấu hình');
    const groupId = this.groupId(scopeType, scopeId);
    await this.auditConfig(
      'DELETE',
      'PLANNING_CONFIG_DELETE',
      groupId,
      `Đã xóa cấu hình dự kiến đặt hàng ${groupId}`,
      actor,
      {
        snapshot: {
          id: groupId,
          scope: scopeType,
          scopeId,
          overrides: this.valuesObject(this.toConfigValues(existing)),
        },
      },
    );
    return { id: groupId, deleted: true };
  }

  async getRecommendations(query: RecommendationQueryDto) {
    const snapshot = await this.repository.findRecommendation(
      this.parseDate(query.date),
    );
    if (!snapshot) return this.emptyList(query);

    const legacyCategory = query.categoryId
      ? await this.repository.findCategory(query.categoryId)
      : null;

    let items = snapshot.items.map((item) => this.mapListItem(item));
    items = this.filter(
      items,
      query,
      legacyCategory?.type === 'child' ? legacyCategory.name : undefined,
    );
    this.sort(items, query.sortBy, query.sortDir);
    const total = items.length;
    const counts = this.countPriorities(items);
    const totalEstimatedValue = items.reduce(
      (sum, item) => sum + Number(item.estimatedValue ?? 0),
      0,
    );
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const paged = items.slice((page - 1) * limit, page * limit);

    return {
      items: paged,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      meta: {
        snapshotDate: this.dateOnly(snapshot.snapshotDate),
        isStale:
          Date.now() - snapshot.snapshotDate.getTime() > 26 * 60 * 60 * 1000,
        lastRunAt: snapshot.run.completedAt?.toISOString() ?? null,
        counts,
        totalEstimatedValue: total ? totalEstimatedValue : null,
      },
    };
  }

  async getRecommendationDetail(itemId: number) {
    const item = await this.repository.findItem(itemId);
    if (!item) throw new NotFoundException('Không tìm thấy đề xuất');
    const trace = item.calculationTrace as any;
    return {
      ...this.mapListItem(item),
      safetyDays: item.safetyDays,
      coverageDays: item.coverageDays,
      leadTimeDemand: Number(item.leadTimeDemand),
      safetyBuffer: Number(item.safetyBuffer),
      soqRaw: Number(item.soqRaw),
      moqApplied: item.moqApplied == null ? null : Number(item.moqApplied),
      branchBreakdown: trace.inputs.inventory.branches,
      shipments: trace.inputs.shipments,
      forecastComparison: trace.inputs.forecast,
      decisionTimeline: trace.decisionTimeline ?? null,
      calculationTrace: trace,
      snapshotDate: this.dateOnly((item as any).recommendation?.snapshotDate),
    };
  }

  async runCalculation(dto: RunCalculationDto, userId?: number) {
    const snapshotDate = this.parseDate(dto.snapshotDate) ?? this.today();
    let run: Awaited<ReturnType<PurchasingPlanningRepository['createRun']>>;
    try {
      run = await this.repository.createRun(dto.runType, snapshotDate, userId);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Đang có một lần tính Purchasing Planning chạy',
        );
      }
      throw error;
    }

    try {
      const end = new Date(snapshotDate);
      end.setUTCDate(end.getUTCDate() + 1);
      const start = new Date(snapshotDate);
      // Cần đủ lịch sử cho biểu đồ 5 tháng: 3 tháng gần nhất và 2 tháng
      // đối chiếu trước đó. Lấy dư khoảng 180 ngày để không hụt tháng biên.
      start.setUTCDate(start.getUTCDate() - 180);
      const data = await this.repository.loadCalculationData(start, end);
      const configValues = data.configs
        .filter((row) => CONFIG_KEYS.has(row.paramKey))
        .map((row) => ({
          scope: row.scopeType as ConfigScope,
          scopeId: row.scopeId,
          key: row.paramKey as PlanningConfigKey,
          value: Number(row.paramValue),
          active: row.isActive,
        })) as ConfigValue[];
      const categoryByName = new Map(
        data.categories.map((item) => [item.name, item.id]),
      );
      // Gộp snapshot tồn kho thành map (sản phẩm → ngày → có hàng).
      // Một SKU coi là "có hàng" trong ngày nếu BẤT KỲ kho đầu mối nào còn
      // hàng — khớp cách engine cộng gộp tồn kho các kho khi tính vị thế tồn.
      const stockHistory = new Map<number, Map<string, boolean>>();
      for (const row of data.stockSnapshots ?? []) {
        let byDate = stockHistory.get(row.productId);
        if (!byDate) {
          byDate = new Map<string, boolean>();
          stockHistory.set(row.productId, byDate);
        }
        const key = row.date.toISOString().slice(0, 10);
        byDate.set(key, (byDate.get(key) ?? false) || row.hadStock);
      }
      const dataWithStock = { ...data, stockHistory };
      const [networkConfig, factoryLeadtimes, productFactories] =
        await Promise.all([
          this.networkService.getNetworkConfig(),
          this.networkService.getFactoryLeadtimes(),
          this.networkService.getProductFactoryMap(
            data.products.map((product) => product.id),
          ),
        ]);
      const networkContext = {
        networkConfig,
        factoryLeadtimes,
        productFactories,
      };
      const items = data.products.map((product) =>
        this.calculateProduct(
          product,
          dataWithStock,
          configValues,
          categoryByName,
          snapshotDate,
          networkContext,
        ),
      );
      const globalConfig = resolvePlanningConfig(configValues, {}).config;
      const recommendation = await this.repository.completeRun(
        run.id,
        snapshotDate,
        run.startedAt,
        items,
        { ...globalConfig, branchScope: data.branchScope },
      );
      return {
        runId: run.id,
        recommendationId: recommendation.id,
        status: 'COMPLETED',
        snapshotDate: this.dateOnly(snapshotDate),
        skuTotal: items.length,
        skuBlocked: items.filter((item) => item.status === 'BLOCKED').length,
      };
    } catch (error) {
      await this.repository.failRun(run.id, error);
      throw error;
    }
  }

  /**
   * Dựng leadtime pipeline cho một SKU.
   *
   * Pipeline dừng ở mốc **hàng về công ty**: Sản xuất → Thông quan → Về công
   * ty. Không còn cộng chặng điều chuyển tới từng chi nhánh, vì quyết định mua
   * hàng là quyết định của cả công ty chứ không của riêng kho nào.
   */
  private resolveNetworkLeadtime(product: any, networkContext: any) {
    if (!networkContext) return null;

    const { networkConfig, factoryLeadtimes, productFactories } =
      networkContext;

    const mapping = productFactories.get(product.id) ?? null;
    const factory = mapping
      ? (factoryLeadtimes.get(mapping.factoryId) ?? null)
      : null;

    const cargoType = product.cargoType === 'COLD' ? 'COLD' : 'NORMAL';
    const pipeline = resolveLeadtimePipeline({
      network: networkConfig,
      factory,
      skuProductionOverrideDays: mapping?.leadtimeDays ?? null,
    });

    return {
      pipeline,
      cargoType,
      factoryId: mapping?.factoryId ?? null,
      factoryName: factory?.factoryName ?? null,
      factoryRole: mapping?.role ?? null,
      moq: mapping?.moq ?? null,
      hasFactory: Boolean(mapping),
    };
  }

  /** Gom doanh số thành từng tháng để phân tích độ ổn định. */
  private monthlySales(invoiceRows: any[], snapshotDate: Date): MonthlySales[] {
    const buckets = new Map<string, number>();
    for (const row of invoiceRows) {
      const date: Date = row.invoice?.purchaseDate;
      if (!date) continue;
      const key = date.toISOString().slice(0, 7);
      buckets.set(key, (buckets.get(key) ?? 0) + Number(row.quantity));
    }

    const currentMonth = snapshotDate.toISOString().slice(0, 7);
    const months = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, quantity]) => ({
        month,
        quantity,
        days:
          month === currentMonth
            ? snapshotDate.getUTCDate()
            : daysInMonth(month),
      }));
    const completed = months.filter((month) => month.month < currentMonth);
    return completed.length ? completed : months;
  }

  /** Các đợt khuyến mãi có áp dụng cho sản phẩm này. */
  private promotionsForProduct(
    product: any,
    promotions: any[],
  ): PromotionWindow[] {
    return promotions
      .filter((promotion) => {
        if (!promotion.startDate || !promotion.endDate) return false;
        const targets = promotion.products ?? [];
        // Không khai sản phẩm nào = áp cho toàn bộ danh mục.
        if (targets.length === 0) return true;
        return targets.some(
          (target: any) =>
            target.productId === product.id ||
            (target.categoryName != null &&
              [
                product.parentName,
                product.middleName,
                product.childName,
              ].includes(target.categoryName)),
        );
      })
      .map((promotion) => ({
        startDate: promotion.startDate,
        endDate: promotion.endDate,
        name: promotion.name,
      }));
  }

  /**
   * Vị thế tồn của toàn công ty: tồn hiện có, tốc độ bán gộp và hàng đang về.
   *
   * Gộp mọi chi nhánh lại thành một con số duy nhất. Hàng nằm ở kho nào không
   * đổi kết luận mua hàng — nếu một kho thiếu trong khi kho khác dư thì đó là
   * việc điều chuyển nội bộ, không phải lý do đặt thêm hàng nhà máy.
   */
  private companyPosition(
    inventoryRows: any[],
    orderRows: any[],
    productId: number,
    forecastDailyDemand: number,
  ) {
    const onHand = inventoryRows.reduce(
      (sum: number, row: any) => sum + Number(row.onHand),
      0,
    );
    const incomingByBranch = this.incomingByBranch(orderRows, productId);
    let incoming = 0;
    for (const quantity of incomingByBranch.values()) incoming += quantity;

    return { onHand, dailyDemand: forecastDailyDemand, incoming };
  }

  /**
   * Số lượng đang trên đường về từng chi nhánh, gom từ các chuyến ghép xe.
   *
   * Chỉ tính chuyến đã xác nhận giao (status = 1): phiếu tạm (0) chưa chắc
   * chạy, còn đã nhập kho (2) thì hàng đã nằm trong tồn — cộng thêm sẽ đếm
   * hai lần.
   */
  private incomingByBranch(
    orderRows: any[],
    productId: number,
  ): Map<number, number> {
    const result = new Map<number, number>();

    for (const row of orderRows) {
      const shipmentItems = row.orderSupplier?.vehicleShipmentItems ?? [];
      for (const item of shipmentItems) {
        if (item.productId !== productId) continue;
        const shipment = item.vehicleShipment;
        if (!shipment?.branchId || shipment.status !== 1) continue;
        result.set(
          shipment.branchId,
          (result.get(shipment.branchId) ?? 0) + Number(item.quantity ?? 0),
        );
      }
    }

    return result;
  }

  /**
   * Câu kết luận hiển thị cho người mua hàng.
   *
   * Ghép 3 phần: khi nào phải đặt → đặt bao nhiêu → cảnh báo nếu con số này
   * chưa đáng tin.
   */
  private buildSummary(
    timing: any,
    stability: any,
    soq: any,
    flags: Flag[],
  ): string {
    const parts: string[] = [timing.recommendation];

    if (soq.suggestedQuantity > 0) {
      parts.push(
        `Đề xuất nhập ${Math.round(soq.suggestedQuantity).toLocaleString('vi-VN')}.`,
      );
    }

    if (stability.unexplainedAnomaly) {
      const anomalyMonths = stability.months
        .filter((month: any) => month.anomaly !== 'NORMAL')
        .map((month: any) => month.month)
        .join(', ');
      parts.push(
        `Phát hiện doanh số bất thường${anomalyMonths ? ` ở tháng ${anomalyMonths}` : ''}; hệ số tăng trưởng cần được người mua kiểm tra.`,
      );
    } else if (stability.stability === 'VOLATILE') {
      parts.push('Doanh số dao động mạnh, số liệu dự báo kém chắc chắn.');
    }
    if (
      soq.scenarioQuantity != null &&
      soq.scenarioQuantity < soq.suggestedQuantity
    ) {
      parts.push(
        `Nếu ghép xe về đúng hạn chỉ cần khoảng ${Math.round(soq.scenarioQuantity).toLocaleString('vi-VN')}.`,
      );
    }

    const blocking = flags.find((flag) => flag.blocksRecommendation);
    if (blocking) parts.push(blocking.message);

    return parts.join(' ');
  }

  private calculateProduct(
    product: any,
    data: any,
    configValues: ConfigValue[],
    categoryByName: Map<string, number>,
    snapshotDate: Date,
    networkContext?: any,
  ) {
    const inventoryRows = data.inventories.filter(
      (row: any) => row.productId === product.id,
    );
    const invoiceRows = data.invoiceDetails.filter(
      (row: any) => row.productId === product.id,
    );
    const logRows = data.inventoryLogs.filter(
      (row: any) => row.productId === product.id,
    );
    const stockHistory: Map<number, Map<string, boolean>> = data.stockHistory ??
    new Map();
    const supplierRows = data.orderSupplierItems
      .filter((row: any) => row.productId === product.id)
      .sort(
        (a: any, b: any) =>
          b.orderSupplier.orderDate.getTime() -
          a.orderSupplier.orderDate.getTime(),
      );
    const supplierIds = new Set(
      supplierRows.map((row: any) => row.orderSupplier.supplierId),
    );
    const latestSupplier = supplierRows[0]?.orderSupplier ?? null;
    const childCategoryId = product.childName
      ? categoryByName.get(product.childName)
      : undefined;
    const packSize = this.productPackSize(product.conversionValue);
    // Leadtime áp vào SKU lấy từ pipeline mạng lưới: Sản xuất → Thông quan →
    // Về công ty. Không phân biệt chi nhánh nhận.
    const leadtimeInfo = this.resolveNetworkLeadtime(product, networkContext);
    const leadTimeDays =
      leadtimeInfo?.pipeline.days ?? leadtimeInfo?.pipeline.max ?? 0;
    const productPromotions = this.promotionsForProduct(
      product,
      data.promotions ?? [],
    );
    const monthlySales = this.monthlySales(invoiceRows, snapshotDate);
    // Trend thủ công đã bị loại khỏi forecast. Các tháng bất thường chỉ được
    // dùng để cảnh báo và suy hệ số tăng trưởng từ lịch sử đã làm sạch.
    const stability = analyzeDemandStability(monthlySales, productPromotions);
    // Tồn dự phòng suy từ chính mức dao động đó thay vì một hằng số: SKU bán
    // đều cần đệm mỏng, SKU tháng cao tháng thấp cần đệm dày.
    const safetyDays = safetyDaysFromStability(stability, leadTimeDays);
    // MOQ lấy từ khai báo ở nhà máy / mapping SKU × nhà máy, quy về gói lẻ để
    // engine SOQ dùng được. `null` = có khai MOQ nhưng thiếu dữ liệu quy đổi
    // (sản phẩm chưa có quy cách đóng gói hoặc khối lượng) → cảnh báo thay vì
    // âm thầm bỏ qua ràng buộc.
    const moqPacks = moqSpecToPacks(leadtimeInfo?.moq ?? null, {
      productId: product.id,
      productName: product.name,
      conversionValue: product.conversionValue,
      weight: product.weight,
      weightUnit: product.weightUnit,
    });
    const moqUnits = moqPacks ?? 0;
    // Hệ số tăng trưởng có hai nguồn: hệ thống tự suy từ lịch sử hoặc override
    // theo scope (SKU → nhà cung cấp → nhóm hàng → toàn hệ thống).
    const resolvedConfig = resolvePlanningConfig(configValues, {
      skuId: product.id,
      supplierId: latestSupplier?.supplierId ?? undefined,
      categoryId: childCategoryId,
    });
    const configuredGrowthFactor = resolvedConfig.sourceValues.growthFactor
      ? Number(resolvedConfig.config.growthFactor)
      : null;
    const systemGrowthFactor = Number(stability.systemGrowthFactor ?? 1);
    const appliedGrowthFactor = clampGrowthFactor(
      configuredGrowthFactor ?? systemGrowthFactor,
    );
    const config = {
      ...OPERATIONAL_PLANNING_DEFAULTS,
      packSize,
      safetyDays,
      growthFactor: appliedGrowthFactor,
    };
    const rawPhysical = inventoryRows.reduce(
      (sum: number, row: any) => sum + Number(row.onHand),
      0,
    );
    const physical = rawPhysical;
    const customerOrders = Number(data.pendingOrderQty?.get(product.id) ?? 0);
    const companyNeed = inventoryRows.reduce(
      (sum: number, row: any) => sum + Number(row.minQuality ?? 0),
      0,
    );
    const available = Math.max(0, physical);
    const branches = inventoryRows.map((row: any) => ({
      branchId: row.branchId,
      branchName: row.branch.name,
      branchCode: row.branch.code,
      onHand: Number(row.onHand),
    }));
    const firstSale = invoiceRows.reduce(
      (first: Date | null, row: any) =>
        !first || row.invoice.purchaseDate < first
          ? row.invoice.purchaseDate
          : first,
      null as Date | null,
    ) as Date | null;
    const firstActivity =
      firstSale && firstSale > product.createdAt
        ? firstSale
        : product.createdAt;
    const dates = this.calendar(firstActivity, snapshotDate);
    const demand = resolveDemand({
      invoiceDetails: invoiceRows.map((row: any) => ({
        date: row.invoice.purchaseDate,
        quantity: Number(row.quantity),
      })),
      inventoryLogs: logRows
        .filter((row: any) =>
          DEMAND_LOG_TYPES.has(row.transactionType.toUpperCase()),
        )
        .map((row: any) => ({
          date: row.transactionDate,
          quantity: Number(row.quantity),
          transactionType: row.transactionType,
        })),
      dates,
    });
    // Gắn cờ "ngày đó SKU có hàng hay không" từ snapshot tồn kho thật.
    // Ngày nào chưa có snapshot thì để `undefined` — forecast engine sẽ tự
    // lùi về heuristic và hạ độ tin cậy cho riêng trường hợp đó.
    const stockByDate = stockHistory.get(product.id);
    const demandWithStock = stockByDate
      ? demand.map((day) => ({
          ...day,
          hadStock: stockByDate.get(day.date),
        }))
      : demand;
    const forecast = forecastDemand({
      days: demandWithStock,
      asOfDate: snapshotDate,
      firstActivityDate: firstActivity,
      minDays: config.minDays,
      growthFactor: appliedGrowthFactor,
    });
    // MA ngắn hạn vẫn được giữ để so sánh/hiển thị. Mức nền đã khử tháng bất
    // thường là cơ sở, sau đó nhân hệ số hệ thống hoặc hệ số người dùng áp dụng.
    const baselineDailyDemand =
      stability.baselineDailyDemand > 0
        ? stability.baselineDailyDemand
        : forecast.forecastDailyDemand / Math.max(appliedGrowthFactor, 0.0001);
    const forecastDailyDemand =
      Math.round(baselineDailyDemand * appliedGrowthFactor * 10000) / 10000;

    if (stability.unexplainedAnomaly && forecast.confidence !== 'NO_DATA') {
      const flags = new Set(forecast.flags ?? []);
      flags.add('LOW_CONFIDENCE_FORECAST');
      forecast.flags = [...flags] as typeof forecast.flags;
      const rank = ['NO_DATA', 'VERY_LOW', 'LOW', 'MEDIUM', 'HIGH'] as const;
      const next = Math.max(
        1,
        rank.indexOf(forecast.confidence as (typeof rank)[number]) - 1,
      );
      forecast.confidence = rank[next];
    }

    const purchaseRows = data.purchaseOrderItems.filter(
      (row: any) => row.productId === product.id,
    );
    const receivedByOrder = new Map<number, number>();
    for (const row of purchaseRows) {
      const orderId = row.purchaseOrder.orderSupplierId;
      if (orderId != null)
        receivedByOrder.set(
          orderId,
          (receivedByOrder.get(orderId) ?? 0) + Number(row.quantity),
        );
    }
    const activeOrders = supplierRows.filter((row: any) =>
      [1, 2].includes(row.orderSupplier.status),
    );
    const incoming = resolveIncoming({
      snapshotDate,
      leadTimeDays,
      lines: activeOrders.map((row: any) => ({
        id: row.orderSupplier.id,
        status: row.orderSupplier.status,
        orderedQuantity: Number(row.quantity),
        receivedQuantity: receivedByOrder.get(row.orderSupplier.id) ?? 0,
        expectedArrivalDate: this.shipmentEta(row),
        orderDate: row.orderSupplier.orderDate,
      })),
    });
    const remainingByOrder = new Map<number, number>();
    for (const row of activeOrders) {
      const leftover = Math.max(
        0,
        Number(row.quantity) - (receivedByOrder.get(row.orderSupplier.id) ?? 0),
      );
      remainingByOrder.set(
        row.orderSupplier.id,
        (remainingByOrder.get(row.orderSupplier.id) ?? 0) + leftover,
      );
    }
    const horizonDays =
      leadTimeDays + safetyDays + coverageDaysFor(leadTimeDays);
    const customerDemandResolution = resolveCustomerDemand(
      (data.customerDemandMonths ?? []).map((row: any) => ({
        id: row.id,
        demandMonth: row.demandMonth,
        status: row.status,
        customerId: row.demand?.customerId ?? null,
        customerName: row.demand?.customer?.name ?? null,
        lines: (row.lines ?? []).map((line: any) => ({
          productId: line.productId,
          quantityBase: Number(line.quantityBase),
          inputQuantity: Number(line.inputQuantity),
          inputUnit: line.inputUnit,
          conversionValue: Number(line.conversionValue),
        })),
      })),
      snapshotDate,
      horizonDays,
    );
    const customerDemand =
      customerDemandResolution.totalByProduct.get(product.id) ?? 0;
    const customerDemandDetails =
      customerDemandResolution.detailsByProduct.get(product.id) ?? [];
    const vehicleLines = supplierRows.flatMap((row: any) =>
      (row.orderSupplier?.vehicleShipmentItems ?? [])
        .filter((item: any) => item.productId === product.id)
        .map((item: any) => ({
          id: item.id ?? `${row.orderSupplier.id}-${item.productId}`,
          productId: product.id,
          quantity: Number(item.quantity ?? 0),
          status: item.vehicleShipment?.status,
          expectedArrivalDate:
            item.vehicleShipment?.expectedArrivalDate ?? null,
          orderSupplierId: row.orderSupplier.id,
          orderCode: row.orderSupplier.code,
          supplierName: row.orderSupplier.supplier?.name ?? null,
        })),
    );
    const vehicleSupply = classifyVehicleSupply({
      snapshotDate,
      horizonDays,
      vehicleLines,
      remainingByOrder,
    });
    const shipments = [
      ...activeOrders
        .map((row: any) =>
          this.mapShipment(row, receivedByOrder, leadTimeDays, snapshotDate),
        )
        .filter((shipment: any) => shipment.quantity > 0),
      ...vehicleSupply.vehicleLines.map((line) => ({
        orderSupplierId: line.orderSupplierId ?? 0,
        orderCode: line.orderCode ?? 'GHÉP XE',
        supplierName: line.supplierName,
        quantity: line.quantity,
        eta: line.eta,
        etaType: line.etaType,
        classifiedAs: line.classifiedAs,
      })),
    ];
    const confirmedIncoming =
      vehicleSupply.vehicleConfirmed + vehicleSupply.remainingNotOnVehicle;
    const firmReceipts = this.firmIncomingReceipts(
      incoming.receipts,
      vehicleSupply.vehicleLines,
    );
    const replenishment = calculateReplenishment({
      forecastDailyDemand: forecastDailyDemand,
      leadTimeDays,
      safetyDays: config.safetyDays,
      availableStock: available,
      incomingTotal: confirmedIncoming,
    });
    // Demand OEM đã Confirmed phải có thể kích hoạt đặt hàng ngay cả khi
    // nhu cầu bán thông thường chưa chạm điểm đặt.
    const customerDemandNeedsOrder =
      customerDemand > available + confirmedIncoming;
    const needsOrder = replenishment.needsOrder || customerDemandNeedsOrder;
    const projection = projectInventory({
      snapshotDate,
      availableStock: available,
      forecastDailyDemand: forecastDailyDemand,
      incoming: incoming.receipts,
      horizonDays: config.projectionDays,
    });
    const usableIncoming = confirmedIncoming;
    // Trả lời "tháng sau có phải đặt không": chiếu tồn gộp toàn công ty với
    // tốc độ bán nền, rồi lùi lại đúng bằng leadtime để ra hạn đặt.
    const timing = calculateOrderTiming({
      today: snapshotDate,
      leadTimeMaxDays: leadTimeDays,
      safetyDays: config.safetyDays,
      position: this.companyPosition(
        inventoryRows,
        supplierRows,
        product.id,
        forecastDailyDemand,
      ),
    });
    const priority = calculatePriority({
      confidence: forecast.confidence,
      forecastDailyDemand: forecastDailyDemand,
      availableStock: available,
      inventoryPosition: replenishment.inventoryPosition,
      reorderPoint: replenishment.reorderPoint,
      leadTimeDays,
      safetyDays: config.safetyDays,
      overstockDays: config.overstockDays,
      needsOrder,
      daysUntilStockout: projection.daysUntilStockout,
    });
    // Khuyến mãi đang chạy / sắp chạy trong horizon đặt hàng sẽ kéo nhu cầu
    // lên trên mức nền. Không cộng phần này thì đợt KM tháng sau chắc chắn
    // thiếu hàng, vì lịch sử bán ba tháng qua không hề biết tới nó.
    const promotionUplift = calculatePromotionUplift({
      today: snapshotDate,
      horizonDays,
      baselineDailyDemand: forecastDailyDemand,
      promotions: productPromotions,
      months: stability.months,
    });
    const extraDemand = promotionUplift.extraDemand;
    const soq = calculateSoq({
      forecastDailyDemand: forecastDailyDemand,
      leadTimeDays,
      safetyDays: config.safetyDays,
      availableStock: available,
      usableIncoming,
      customerOrders,
      customerDemand,
      companyNeed,
      extraDemand,
      riskIncoming: vehicleSupply.vehicleRisk,
      daysOfSupply: priority.daysOfSupply,
      packSize: config.packSize,
      moq: moqUnits,
      purchaseMultiple: config.purchaseMultiple,
      moqTolerance: config.moqTolerance,
      needsOrder,
    });
    const decisionTimeline = this.buildDecisionTimelineData({
      snapshotDate,
      monthlySales,
      stability,
      firmReceipts,
      vehicleLines: vehicleSupply.vehicleLines,
      promotions: productPromotions,
      shipments,
      forecastDailyDemand,
      available,
      reorderPoint: replenishment.reorderPoint,
      safetyBuffer: replenishment.safetyBuffer,
      latestOrderDate: timing.latestOrderDate,
      leadTimeDays,
      suggestedQuantity: soq.suggestedQuantity,
      scenarioQuantity: soq.scenarioQuantity,
    });
    const latestPriceRow = purchaseRows.find(
      (row: any) => Number(row.price) > 0,
    );
    const unitPrice = latestPriceRow ? Number(latestPriceRow.price) : null;
    const flags = this.buildFlags({
      forecast,
      supplierIds,
      latestSupplier,
      rawPhysical,
      inventoryRows,
      unitPrice,
      soq,
      shipments,
      incomingFlags: incoming.flags,
      leadtimeInfo,
      moqNotConvertible: leadtimeInfo?.moq != null && moqPacks == null,
      unexplainedAnomaly: stability.unexplainedAnomaly,
      vehicleRisk: vehicleSupply.vehicleRisk,
      scenarioQuantity: soq.scenarioQuantity,
      customerDemand,
    });
    const reliability = this.reliability(forecast.confidence, flags);
    const status = flags.some((flag) => flag.blocksRecommendation)
      ? 'BLOCKED'
      : 'PENDING';
    const trendRatio =
      forecast.ma30 != null && forecast.ma90
        ? forecast.ma30 / forecast.ma90
        : null;
    const totalDemand = demand.reduce((sum, day) => sum + day.demand, 0);
    const demandSources = new Set(
      demand.filter((day) => day.source !== 'NONE').map((day) => day.source),
    );
    const demandSource =
      demandSources.size > 1 || demandSources.has('HYBRID')
        ? 'HYBRID'
        : (demandSources.values().next().value ?? 'INVOICE_DETAIL');
    const forecastComparison = {
      used: forecastDailyDemand,
      windowUsed: forecast.windowDays,
      ma30: forecast.ma30,
      ma60: forecast.ma60,
      ma90: forecast.ma90,
      trendRatio,
      // Giữ field cũ để snapshot/API cũ vẫn đọc được; đây là hệ số áp dụng.
      growthFactor: appliedGrowthFactor,
      totalDemand,
      validDays: forecast.validStockDays,
      windowDays: forecast.windowDays,
      stockoutDaysExcluded: Math.max(
        0,
        forecast.windowDays - forecast.validStockDays,
      ),
      baselineDailyDemand: stability.baselineDailyDemand,
      demandStability: stability.stability,
      variationCoefficient: stability.variationCoefficient,
      monthsAnalyzed: stability.monthsUsed,
      monthBreakdown: stability.months,
      // Trend thủ công đã bị loại khỏi contract forecast mới.
      trendMonths: [],
      promotionMonths: stability.promotionMonths,
      // Khuyến mãi đang/sắp chạy đã được cộng vào số lượng đề xuất.
      upcomingPromotions: promotionUplift.windows,
      promotionExtraDemand: promotionUplift.extraDemand,
      promotionDays: promotionUplift.promotionDays,
      promotionUpliftFactor: promotionUplift.upliftFactor,
      systemGrowthFactor,
      appliedGrowthFactor,
      growthFactorOverridden: configuredGrowthFactor != null,
      growthFactorSource:
        configuredGrowthFactor != null
          ? resolvedConfig.sources.growthFactor
          : 'DERIVED',
      growthFactorNote:
        configuredGrowthFactor != null
          ? (resolvedConfig.sourceValues.growthFactor?.note ?? null)
          : null,
      lookbackMonths: stability.lookbackMonths,
      lookbackRepeatsAnomaly: stability.lookbackRepeatsAnomaly,
      unexplainedAnomaly: stability.unexplainedAnomaly,
      demandBreakdown: {
        customerOrders,
        customerDemand,
        customerDemandDetails,
        companyNeed,
        salesDemand:
          forecastDailyDemand *
          (leadTimeDays + config.safetyDays + coverageDaysFor(leadTimeDays)),
        promotionExtra: promotionUplift.extraDemand,
      },
      supplyBreakdown: {
        available,
        confirmedIncoming,
        vehicleConfirmed: vehicleSupply.vehicleConfirmed,
        vehicleRisk: vehicleSupply.vehicleRisk,
      },
      suggestedQuantityScenario: soq.scenarioQuantity,
      demandSource,
    };
    const trace = this.buildTrace(
      snapshotDate,
      config,
      branches,
      shipments,
      forecastComparison,
      replenishment,
      soq,
      priority,
      flags,
      confirmedIncoming,
      data.branchScope,
      leadtimeInfo,
      decisionTimeline,
    );
    if (status === 'BLOCKED') trace.result.suggestedQuantity = 0;
    // Câu tóm tắt lấy thẳng khuyến nghị thời điểm đặt — đó là thứ người mua
    // hàng cần đọc, không phải mô tả kỹ thuật về mức tồn.
    const summaryText = this.buildSummary(timing, stability, soq, flags);

    return {
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unit: product.unit,
      parentName: product.parentName,
      middleName: product.middleName,
      childName: product.childName,
      tradeMarkId: product.tradeMarkId,
      tradeMarkName: product.tradeMark?.name ?? null,
      supplierId: latestSupplier?.supplierId ?? null,
      supplierName: latestSupplier?.supplier?.name ?? null,
      forecastDailyDemand: forecastDailyDemand,
      confidence: forecast.confidence,
      demandSource,
      ma30: forecast.ma30,
      ma60: forecast.ma60,
      ma90: forecast.ma90,
      trendRatio,
      leadTimeDays: Math.round(leadTimeDays),
      // Cột `lead_time_source` là VarChar(15) và FE chỉ hiểu tập giá trị
      // ConfigSource. 'NETWORK_PIPELINE' (16 ký tự) vừa tràn cột vừa nằm ngoài
      // contract → dùng 'DERIVED': leadtime được suy ra từ pipeline mạng lưới
      // (nhà máy + thông quan + về công ty) chứ không do ai khai tay.
      leadTimeSource: leadtimeInfo ? 'DERIVED' : 'GLOBAL',
      safetyDays: Math.round(config.safetyDays),
      coverageDays: coverageDaysFor(leadTimeDays),
      leadTimeDemand: replenishment.leadTimeDemand,
      safetyBuffer: replenishment.safetyBuffer,
      reorderPoint: replenishment.reorderPoint,
      physicalStock: physical,
      reservedStock: customerOrders,
      availableStock: available,
      incomingTotal: confirmedIncoming + vehicleSupply.vehicleRisk,
      inventoryPosition: replenishment.inventoryPosition,
      reorderGap: replenishment.reorderGap,
      needsOrder,
      soqRaw: soq.rawQuantity,
      suggestedQuantity: status === 'BLOCKED' ? 0 : soq.suggestedQuantity,
      suggestedPackCount: status === 'BLOCKED' ? null : soq.suggestedPackCount,
      packSize: config.packSize,
      moqApplied: soq.moqApplied,
      estimatedUnitPrice: unitPrice,
      estimatedValue:
        unitPrice == null || status === 'BLOCKED'
          ? null
          : unitPrice * soq.suggestedQuantity,
      priority: priority.priority,
      priorityRank: priority.rank,
      reliability,
      urgencyRatio: priority.urgencyRatio,
      daysUntilStockout: projection.daysUntilStockout,
      daysOfSupply: priority.daysOfSupply,
      projectedStockoutDate: projection.projectedStockoutDate
        ? new Date(`${projection.projectedStockoutDate}T00:00:00.000Z`)
        : null,
      // ── Kết quả trả lời "khi nào phải đặt" ──
      orderUrgency: timing.urgency,
      latestOrderDate: timing.latestOrderDate,
      // Đã gộp toàn công ty — không còn khái niệm chi nhánh thiếu trước. Giữ
      // cột để đọc được snapshot cũ, nhưng lần chạy mới luôn ghi null.
      criticalBranchId: null,
      criticalBranchName: null,
      demandStability: stability.stability,
      variationCoefficient: stability.variationCoefficient,
      leadTimeMinDays: leadTimeDays || null,
      status,
      summaryText,
      calculationTrace: trace,
    };
  }

  /**
   * Chuẩn bị dữ liệu cho biểu đồ quyết định nhập hàng.
   * Business logic vẫn ở backend; frontend chỉ vẽ các giá trị đã được tính.
   */
  private buildDecisionTimelineData(input: {
    snapshotDate: Date;
    monthlySales: MonthlySales[];
    stability: any;
    firmReceipts: any[];
    vehicleLines: any[];
    promotions: PromotionWindow[];
    shipments: any[];
    forecastDailyDemand: number;
    available: number;
    reorderPoint: number;
    safetyBuffer: number;
    latestOrderDate: Date | null;
    leadTimeDays: number;
    suggestedQuantity: number;
    scenarioQuantity: number;
  }): DecisionTimeline {
    const today = this.dateOnly(input.snapshotDate);
    const projectionDays = 90;
    const riskReceipts = input.vehicleLines
      .filter((line) => line.classifiedAs === 'RISK' && line.eta)
      .map((line) => ({
        id: line.id,
        date: line.eta,
        quantity: line.quantity,
        overdue: false,
      }));
    const firmProjection = projectInventory({
      snapshotDate: input.snapshotDate,
      availableStock: input.available,
      forecastDailyDemand: input.forecastDailyDemand,
      incoming: input.firmReceipts,
      horizonDays: projectionDays,
    });
    const scenarioProjection = projectInventory({
      snapshotDate: input.snapshotDate,
      availableStock: input.available,
      forecastDailyDemand: input.forecastDailyDemand,
      incoming: [...input.firmReceipts, ...riskReceipts],
      horizonDays: projectionDays,
    });
    const monthlyByKey = new Map(
      input.monthlySales.map((month) => [month.month, month]),
    );
    const history = (input.stability.historyMonths ?? []).map((month: any) => ({
      month: month.month,
      quantity: Number(monthlyByKey.get(month.month)?.quantity ?? 0),
      dailyRate: Number(month.dailyRate ?? 0),
      // Baseline cùng đơn vị với quantity (theo tháng) để vẽ cùng trục.
      baseline:
        Number(input.stability.baselineDailyDemand ?? 0) *
        Number(monthlyByKey.get(month.month)?.days ?? 30),
      anomaly: month.anomaly,
      hasPromotion: Boolean(month.hasPromotion),
      hasTrend: Boolean(month.hasTrend),
      promotionNames: month.promotionNames ?? [],
      trendNames: month.trendNames ?? [],
    }));
    const confirmedIncomingByDate = this.sumReceiptsByDate(input.firmReceipts);
    const vehicleIncomingByDate = new Map<string, number>();
    for (const line of input.vehicleLines) {
      if (!line.eta) continue;
      vehicleIncomingByDate.set(
        line.eta,
        (vehicleIncomingByDate.get(line.eta) ?? 0) + Number(line.quantity ?? 0),
      );
    }
    const events = [
      ...input.promotions.map((promotion) => ({
        type: 'PROMOTION' as const,
        name: promotion.name ?? null,
        startDate: this.dateOnly(promotion.startDate),
        endDate: this.dateOnly(promotion.endDate),
        quantity: null,
        etaType: null,
      })),
      ...input.shipments.map((shipment) => ({
        type: shipment.classifiedAs
          ? ('VEHICLE_SHIPMENT' as const)
          : ('INCOMING' as const),
        name: shipment.orderCode ?? null,
        startDate: shipment.eta ? this.dateOnly(new Date(shipment.eta)) : today,
        endDate: null,
        quantity: Number(shipment.quantity ?? 0),
        etaType: shipment.etaType ?? null,
      })),
    ];
    const orderArrivalDate =
      input.leadTimeDays > 0
        ? this.dateOnly(this.addDays(input.snapshotDate, input.leadTimeDays))
        : null;

    return buildDecisionTimeline({
      history,
      firmProjection,
      scenarioProjection,
      demandDaily: input.forecastDailyDemand,
      todayStock: input.available,
      confirmedIncomingByDate,
      vehicleIncomingByDate,
      today,
      latestOrderDate: input.latestOrderDate
        ? this.dateOnly(input.latestOrderDate)
        : null,
      orderArrivalDate,
      reorderPoint: input.reorderPoint,
      safetyStock: input.safetyBuffer,
      events,
      firmSuggestedQuantity: input.suggestedQuantity,
      vehicleScenarioQuantity: input.scenarioQuantity,
    });
  }

  private firmIncomingReceipts(receipts: any[], vehicleLines: any[]) {
    const riskByOrder = new Map<number, number>();
    for (const line of vehicleLines) {
      if (line.classifiedAs !== 'RISK' || line.orderSupplierId == null)
        continue;
      const id = Number(line.orderSupplierId);
      riskByOrder.set(
        id,
        (riskByOrder.get(id) ?? 0) + Number(line.quantity ?? 0),
      );
    }
    return receipts
      .map((receipt) => {
        const orderId = Number(receipt.id);
        const risk = riskByOrder.get(orderId) ?? 0;
        const quantity = Math.max(0, Number(receipt.quantity ?? 0) - risk);
        const consumed = Math.min(risk, Number(receipt.quantity ?? 0));
        if (consumed > 0) riskByOrder.set(orderId, risk - consumed);
        return { ...receipt, quantity };
      })
      .filter((receipt) => receipt.quantity > 0);
  }

  private sumReceiptsByDate(receipts: any[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const receipt of receipts) {
      const date = String(receipt.date).slice(0, 10);
      result.set(date, (result.get(date) ?? 0) + Number(receipt.quantity ?? 0));
    }
    return result;
  }

  private buildTrace(
    snapshotDate: Date,
    config: any,
    branches: any[],
    shipments: any[],
    forecast: any,
    replenishment: any,
    soq: any,
    priority: any,
    flags: Flag[],
    incomingTotal: number,
    branchScope: PurchasingBranchScope,
    leadtimeInfo?: any,
    decisionTimeline?: DecisionTimeline,
  ) {
    return {
      version: '1.1',
      computedAt: new Date().toISOString(),
      decisionTimeline: decisionTimeline ?? null,
      inputs: {
        branchScope,
        // Chi tiết từng chặng leadtime — để UI giải thích được vì sao ra con
        // số tổng, thay vì chỉ hiện một số ngày không rõ nguồn gốc.
        leadtime: leadtimeInfo
          ? {
              cargoType: leadtimeInfo.cargoType,
              factoryId: leadtimeInfo.factoryId,
              factoryName: leadtimeInfo.factoryName,
              factoryRole: leadtimeInfo.factoryRole,
              days: leadtimeInfo.pipeline.days ?? leadtimeInfo.pipeline.max,
              min: leadtimeInfo.pipeline.days ?? leadtimeInfo.pipeline.min,
              max: leadtimeInfo.pipeline.days ?? leadtimeInfo.pipeline.max,
              stages: leadtimeInfo.pipeline.stages,
              customsLeadTimeDays: 10,
              inboundLeadTimeDays: 10,
            }
          : null,
        // Tham số đã dùng — tất cả đều do hệ thống suy ra, không phải khai tay.
        config: {
          safetyDays: {
            value: config.safetyDays,
            source: 'DERIVED',
            label: 'Suy từ độ dao động doanh số',
          },
          coverageDays: {
            value: coverageDaysFor(
              leadtimeInfo?.pipeline.days ?? leadtimeInfo?.pipeline.max ?? 0,
            ),
            source: 'DERIVED',
            label: 'Suy từ thời gian chờ hàng',
          },
          growthFactor: {
            value: Number(
              forecast.appliedGrowthFactor ?? config.growthFactor ?? 1,
            ),
            source: forecast.growthFactorSource ?? 'DERIVED',
            label: forecast.growthFactorOverridden
              ? 'Người dùng điều chỉnh theo SKU'
              : 'Tự suy từ lịch sử bán hàng',
            systemValue: Number(forecast.systemGrowthFactor ?? 1),
            overridden: Boolean(forecast.growthFactorOverridden),
            note: forecast.growthFactorNote ?? null,
          },
          packSize: {
            value: config.packSize,
            source: 'PRODUCT',
            label: 'Quy cách đóng gói sản phẩm',
          },
        },
        inventory: {
          physical: branches.reduce((sum, row) => sum + row.onHand, 0),
          reserved: 0,
          available: Math.max(
            0,
            branches.reduce((sum, row) => sum + row.onHand, 0),
          ),
          branches,
        },
        shipments,
        forecast,
      },
      steps: [
        {
          step: 1,
          name: 'Nhu cầu trong lead time',
          formula: 'FDD × leadTimeDays',
          values: {
            FDD: forecast.used,
            leadTimeDays:
              leadtimeInfo?.pipeline.days ?? leadtimeInfo?.pipeline.max ?? 0,
          },
          result: replenishment.leadTimeDemand,
        },
        {
          step: 2,
          name: 'Tồn kho an toàn',
          formula: 'FDD × safetyDays',
          values: { FDD: forecast.used, safetyDays: config.safetyDays },
          result: replenishment.safetyBuffer,
        },
        {
          step: 3,
          name: 'Điểm đặt hàng',
          formula: 'leadTimeDemand + safetyBuffer',
          values: {
            leadTimeDemand: replenishment.leadTimeDemand,
            safetyBuffer: replenishment.safetyBuffer,
          },
          result: replenishment.reorderPoint,
        },
        {
          step: 4,
          name: 'Vị thế tồn kho',
          formula: 'available + incoming',
          values: {
            available: Math.max(
              0,
              branches.reduce((sum, row) => sum + row.onHand, 0),
            ),
            incoming: incomingTotal,
          },
          result: replenishment.inventoryPosition,
        },
        ...soq.steps.map((step: any, index: number) => ({
          step: index + 5,
          name: step.code,
          formula: step.formula,
          values: {},
          result: step.value,
        })),
      ],
      result: {
        reorderPoint: replenishment.reorderPoint,
        inventoryPosition: replenishment.inventoryPosition,
        reorderGap: replenishment.reorderGap,
        suggestedQuantity: soq.suggestedQuantity,
        suggestedQuantityScenario: soq.scenarioQuantity ?? 0,
        priority: priority.priority,
      },
      flags,
    };
  }

  private buildFlags(input: any): Flag[] {
    const codes: Array<{ code: string; context?: Record<string, unknown> }> =
      [];
    if (!input.latestSupplier) codes.push({ code: 'MISSING_SUPPLIER' });
    if (input.leadtimeInfo && !input.leadtimeInfo.hasFactory)
      codes.push({ code: 'MISSING_FACTORY' });
    if (
      input.leadtimeInfo?.hasFactory &&
      input.leadtimeInfo.pipeline.stages[0]?.max === 0
    )
      codes.push({
        code: 'MISSING_LEADTIME',
        context: { factoryName: input.leadtimeInfo.factoryName },
      });
    if (input.supplierIds.size > 1)
      codes.push({
        code: 'MULTI_SUPPLIER',
        context: { supplierCount: input.supplierIds.size },
      });
    if (input.moqNotConvertible) codes.push({ code: 'MOQ_NOT_CONVERTIBLE' });
    if (input.forecast.confidence === 'NO_DATA' && input.customerDemand <= 0)
      codes.push({ code: 'MISSING_FORECAST' });
    else if (
      ['LOW', 'VERY_LOW'].includes(input.forecast.confidence) ||
      input.forecast.flags.includes('LOW_CONFIDENCE_FORECAST')
    )
      codes.push({ code: 'LOW_CONFIDENCE_FORECAST' });
    if (input.rawPhysical < 0)
      codes.push({
        code: 'NEGATIVE_INVENTORY',
        context: { physicalStock: input.rawPhysical },
      });
    if (input.unexplainedAnomaly) codes.push({ code: 'UNEXPLAINED_ANOMALY' });
    if (input.vehicleRisk > 0) codes.push({ code: 'VEHICLE_SHIPMENT_RISK' });
    if (
      input.vehicleRisk > 0 &&
      input.scenarioQuantity != null &&
      input.soq.suggestedQuantity > input.scenarioQuantity
    ) {
      codes.push({ code: 'VEHICLE_OVERSTOCK_RISK' });
    }
    if (input.unitPrice == null) codes.push({ code: 'PRICE_MISSING' });
    if (input.rawPhysical <= 0) codes.push({ code: 'OUT_OF_STOCK' });
    for (const code of input.soq.flags) codes.push({ code });
    if (input.incomingFlags.includes('SHIPMENT_STALE'))
      codes.push({ code: 'SHIPMENT_STALE' });
    if (
      input.shipments.some(
        (row: any) => row.etaType === 'OVERDUE' && row.overdueDays > 30,
      )
    )
      codes.push({ code: 'SHIPMENT_STALE' });
    else if (input.shipments.some((row: any) => row.etaType === 'OVERDUE'))
      codes.push({ code: 'SHIPMENT_DELAYED' });
    return [...new Map(codes.map((item) => [item.code, item])).values()].map(
      (item) => ({ ...FLAG_DEFINITIONS[item.code], context: item.context }),
    ) as Flag[];
  }

  private reliability(confidence: string, flags: Flag[]) {
    if (flags.some((flag) => flag.blocksRecommendation)) return 'BLOCKED';
    if (confidence === 'VERY_LOW') return 'UNRELIABLE';
    if (
      confidence === 'LOW' ||
      flags.some((flag) => ['CRITICAL', 'HIGH'].includes(flag.severity))
    )
      return 'CAUTION';
    return 'RELIABLE';
  }

  private mapShipment(
    row: any,
    received: Map<number, number>,
    leadTimeDays: number,
    snapshotDate: Date,
  ) {
    const eta =
      this.shipmentEta(row) ??
      this.addDays(row.orderSupplier.orderDate, leadTimeDays);
    const quantity = Math.max(
      0,
      Number(row.quantity) - (received.get(row.orderSupplier.id) ?? 0),
    );
    const overdueDays = Math.max(
      0,
      Math.floor((snapshotDate.getTime() - eta.getTime()) / 86400000),
    );
    return {
      orderSupplierId: row.orderSupplier.id,
      orderCode: row.orderSupplier.code,
      supplierName: row.orderSupplier.supplier?.name ?? null,
      quantity,
      eta: eta.toISOString(),
      etaType:
        overdueDays > 0
          ? 'OVERDUE'
          : this.shipmentEta(row)
            ? 'CONFIRMED'
            : 'ESTIMATED',
      ...(overdueDays > 0 ? { overdueDays } : {}),
    };
  }

  private shipmentEta(row: any): Date | null {
    return (
      row.orderSupplier.vehicleShipmentItems.find(
        (item: any) => item.productId === row.productId,
      )?.vehicleShipment.expectedArrivalDate ?? null
    );
  }

  private calendar(firstActivity: Date, snapshot: Date) {
    const floor = new Date(snapshot);
    floor.setUTCDate(floor.getUTCDate() - 89);
    const cursor = firstActivity > floor ? new Date(firstActivity) : floor;
    cursor.setUTCHours(0, 0, 0, 0);
    const dates: string[] = [];
    while (cursor <= snapshot) {
      dates.push(this.dateOnly(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  private mapListItem(item: any) {
    const trace = item.calculationTrace;
    return {
      itemId: Number(item.id),
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      unit: item.unit,
      packSize: Number(item.packSize),
      parentName: item.parentName,
      middleName: item.middleName,
      childName: item.childName,
      tradeMarkId: item.tradeMarkId,
      tradeMarkName: item.tradeMarkName,
      supplierId: item.supplierId,
      supplierName: item.supplierName,
      /** Tổng leadtime cận trên dùng làm deadline đặt hàng. */
      leadTimeDays: item.leadTimeDays,
      leadTimeMinDays: item.leadTimeMinDays,
      leadTimeSource: item.leadTimeSource,
      orderUrgency: item.orderUrgency,
      latestOrderDate: item.latestOrderDate
        ? this.dateOnly(item.latestOrderDate)
        : null,
      criticalBranchId: item.criticalBranchId,
      criticalBranchName: item.criticalBranchName,
      demandStability: item.demandStability,
      variationCoefficient:
        item.variationCoefficient == null
          ? null
          : Number(item.variationCoefficient),
      priority: item.priority,
      priorityRank: item.priorityRank,
      reliability: item.reliability,
      physicalStock: Number(item.physicalStock),
      reservedStock: Number(item.reservedStock),
      availableStock: Number(item.availableStock),
      incomingTotal: Number(item.incomingTotal),
      forecastDailyDemand: Number(item.forecastDailyDemand),
      confidence: item.confidence,
      ma30: item.ma30 == null ? null : Number(item.ma30),
      ma60: item.ma60 == null ? null : Number(item.ma60),
      ma90: item.ma90 == null ? null : Number(item.ma90),
      trendRatio: item.trendRatio == null ? null : Number(item.trendRatio),
      customerDemand: Number(
        trace?.inputs?.forecast?.demandBreakdown?.customerDemand ?? 0,
      ),
      daysOfSupply:
        item.daysOfSupply == null ? null : Number(item.daysOfSupply),
      daysUntilStockout: item.daysUntilStockout,
      projectedStockoutDate: item.projectedStockoutDate
        ? this.dateOnly(item.projectedStockoutDate)
        : null,
      urgencyRatio:
        item.urgencyRatio == null ? null : Number(item.urgencyRatio),
      reorderPoint: Number(item.reorderPoint),
      inventoryPosition: Number(item.inventoryPosition),
      reorderGap: Number(item.reorderGap),
      needsOrder: item.needsOrder,
      suggestedQuantity: Number(item.suggestedQuantity),
      suggestedQuantityScenario:
        trace?.result?.suggestedQuantityScenario == null
          ? null
          : Number(trace.result.suggestedQuantityScenario),
      suggestedPackCount:
        item.suggestedPackCount == null
          ? null
          : Number(item.suggestedPackCount),
      estimatedUnitPrice:
        item.estimatedUnitPrice == null
          ? null
          : Number(item.estimatedUnitPrice),
      estimatedValue:
        item.estimatedValue == null ? null : Number(item.estimatedValue),
      summaryText: item.summaryText,
      flags: trace.flags ?? [],
      status: item.status,
    };
  }

  private filter(
    items: any[],
    query: RecommendationQueryDto,
    legacyCategoryName?: string,
  ) {
    const includes = (values: any[] | undefined, value: any) =>
      !values?.length || values.includes(value);
    const from = (value: number | null, bound?: number) =>
      bound === undefined || (value !== null && value >= bound);
    const to = (value: number | null, bound?: number) =>
      bound === undefined || (value !== null && value <= bound);
    const supplierIds = query.supplierIds?.length
      ? query.supplierIds
      : query.supplierId
        ? [query.supplierId]
        : undefined;
    return items.filter((item) => {
      const q = query.search?.trim().toLowerCase();
      return (
        (!q ||
          item.productCode.toLowerCase().includes(q) ||
          item.productName.toLowerCase().includes(q)) &&
        includes(query.priority, item.priority) &&
        includes(query.reliability, item.reliability) &&
        includes(query.confidence, item.confidence) &&
        includes(query.parentNames, item.parentName) &&
        includes(query.middleNames, item.middleName) &&
        includes(query.childNames, item.childName) &&
        (!query.categoryId || item.childName === legacyCategoryName) &&
        includes(query.tradeMarkIds, item.tradeMarkId) &&
        includes(supplierIds, item.supplierId) &&
        from(item.daysUntilStockout, query.daysUntilStockoutFrom) &&
        to(item.daysUntilStockout, query.daysUntilStockoutTo) &&
        from(item.daysOfSupply, query.daysOfSupplyFrom) &&
        to(item.daysOfSupply, query.daysOfSupplyTo) &&
        from(item.estimatedValue ?? 0, query.estimatedValueFrom) &&
        to(item.estimatedValue ?? 0, query.estimatedValueTo) &&
        (query.hasFlags === undefined ||
          item.flags.length > 0 === query.hasFlags) &&
        (!query.flagCodes?.length ||
          item.flags.some((flag: Flag) =>
            query.flagCodes!.includes(flag.code),
          )) &&
        (query.isBlocked === undefined ||
          item.flags.some((flag: Flag) => flag.blocksRecommendation) ===
            query.isBlocked) &&
        (!query.status || item.status === query.status) &&
        (!query.needsOrderOnly || item.needsOrder)
      );
    });
  }

  private sort(
    items: any[],
    sortBy = 'priority',
    direction: 'asc' | 'desc' = 'asc',
  ) {
    const field: Record<string, string> = {
      value: 'estimatedValue',
      gap: 'reorderGap',
      code: 'productCode',
      name: 'productName',
      supplier: 'supplierName',
      stock: 'physicalStock',
      available: 'availableStock',
      incoming: 'incomingTotal',
      forecast: 'forecastDailyDemand',
      dos: 'daysOfSupply',
      rop: 'reorderPoint',
      position: 'inventoryPosition',
      soq: 'suggestedQuantity',
      leadtime: 'leadTimeDays',
      stockout: 'daysUntilStockout',
      priority: 'priorityRank',
    };
    const key = field[sortBy] ?? 'priorityRank';
    const dir = direction === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let result: number;
      if (av == null || bv == null) {
        result = av == null && bv == null ? 0 : av == null ? 1 : -1;
      } else {
        result =
          typeof av === 'string'
            ? av.localeCompare(String(bv))
            : Number(av) - Number(bv);
      }
      return result === 0 && key === 'priorityRank'
        ? (a.daysUntilStockout ?? Number.MAX_SAFE_INTEGER) -
            (b.daysUntilStockout ?? Number.MAX_SAFE_INTEGER)
        : result * dir;
    });
  }

  private countPriorities(items: any[]) {
    const counts: Record<string, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      HEALTHY: 0,
      OVERSTOCK: 0,
      NO_DATA: 0,
    };
    for (const item of items) counts[item.priority]++;
    return counts;
  }

  private groupConfigRows(rows: any[], entities: any) {
    const groups = new Map<string, any>();
    for (const row of rows) {
      if (!CONFIG_KEYS.has(row.paramKey)) continue;
      if (!this.hasConfigEntity(row.scopeType, row.scopeId, entities)) continue;
      const id = this.groupId(row.scopeType as ConfigScope, row.scopeId);
      const group = groups.get(id) ?? {
        id,
        scope: row.scopeType,
        entity: this.configEntity(row.scopeType, row.scopeId, entities),
        overrides: {},
        isActive: true,
        updatedAt: row.updatedAt,
      };
      group.overrides[row.paramKey] = Number(row.paramValue);
      if (row.updatedAt > group.updatedAt) group.updatedAt = row.updatedAt;
      groups.set(id, group);
    }
    return [...groups.values()];
  }

  private mapConfigGroup(
    scopeType: ConfigScope,
    scopeId: number | null,
    rows: any[],
    entities: any,
  ) {
    return (
      this.groupConfigRows(rows, entities)[0] ?? {
        id: this.groupId(scopeType, scopeId),
        scope: scopeType,
        entity: this.configEntity(scopeType, scopeId, entities),
        overrides: {},
        isActive: false,
        updatedAt: null,
      }
    );
  }

  private async loadConfigEntities(
    rows: any[],
    context: ResolvedPlanningConfigQueryDto = {},
  ) {
    const ids = (scope: ConfigScope, contextId?: number) => [
      ...new Set([
        ...rows
          .filter((row) => row.scopeType === scope && row.scopeId != null)
          .map((row) => row.scopeId as number),
        ...(contextId == null ? [] : [contextId]),
      ]),
    ];
    const loaded = await this.repository.findConfigEntities(
      ids('CATEGORY', context.categoryId),
      ids('SUPPLIER', context.supplierId),
      ids('SKU', context.skuId),
    );
    return {
      CATEGORY: new Map<number, any>(
        loaded.categories.map((entity) => [entity.id, entity] as const),
      ),
      SUPPLIER: new Map<number, any>(
        loaded.suppliers.map((entity) => [entity.id, entity] as const),
      ),
      SKU: new Map<number, any>(
        loaded.products.map((entity) => [entity.id, entity] as const),
      ),
    };
  }

  private configEntity(
    scope: ConfigScope,
    scopeId: string | number | null | undefined,
    entities: any,
  ): { id: number; code?: string | null; name: string } | null {
    if (scope === 'GLOBAL' || scopeId == null) return null;
    return entities[scope].get(Number(scopeId)) ?? null;
  }

  private hasConfigEntity(
    scope: ConfigScope,
    scopeId: number | null,
    entities: any,
  ) {
    return (
      scope === 'GLOBAL' || this.configEntity(scope, scopeId, entities) != null
    );
  }

  private toConfigValues(rows: any[]): ConfigValue[] {
    return rows
      .filter((row) => CONFIG_KEYS.has(row.paramKey))
      .map((row) => ({
        scope: row.scopeType as ConfigScope,
        scopeId: row.scopeId,
        key: row.paramKey as PlanningConfigKey,
        value: Number(row.paramValue),
        active: row.isActive,
        note: row.note ?? null,
      }));
  }

  private valuesObject(values: ConfigValue[]) {
    return Object.fromEntries(values.map((value) => [value.key, value.value]));
  }

  private dtoValues(dto: UpdatePlanningConfigDto) {
    return Object.fromEntries(
      Object.keys(DEFAULT_PLANNING_CONFIG).map((key) => [
        key,
        dto[key as keyof UpdatePlanningConfigDto],
      ]),
    ) as Record<string, number | null | undefined>;
  }

  private assertCreateValuesPresent(values: Record<string, unknown>) {
    if (Object.values(values).every((value) => value == null)) {
      throw new BadRequestException(
        'Phải cung cấp ít nhất một cấu hình có giá trị',
      );
    }
  }

  private assertUpdateValuesPresent(values: Record<string, unknown>) {
    if (Object.values(values).every((value) => value === undefined)) {
      throw new BadRequestException('Phải cung cấp ít nhất một cấu hình');
    }
  }

  private async upsertConfigGroup(
    scopeType: ConfigScope,
    scopeId: number | null,
    values: Record<string, number | null | undefined>,
    userId?: number,
    note?: string | null,
  ) {
    try {
      return await this.repository.upsertConfigGroup(
        scopeType,
        scopeId,
        values,
        userId,
        note,
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Cấu hình bị trùng hoặc vừa được cập nhật đồng thời',
        );
      }
      throw error;
    }
  }

  private auditConfig(
    actionType: string,
    actionCode: string,
    entityId: string,
    message: string,
    actor?: ConfigActor,
    details: { snapshot?: unknown; changes?: unknown } = {},
  ) {
    return this.auditLogs.create({
      actionType,
      actionCode,
      entityType: 'planning_config',
      entityId,
      entityCode: entityId,
      category: 'Mua hàng',
      snapshot: details.snapshot,
      changes: details.changes,
      message,
      userId: actor?.id ?? 0,
      userName: actor?.name || 'System',
    });
  }

  private normalizedScopeId(
    scopeType: ConfigScope,
    scopeId?: number | null,
  ): number | null {
    if (scopeType === 'GLOBAL') {
      if (scopeId != null) {
        throw new BadRequestException('GLOBAL không được có scopeId');
      }
      return null;
    }
    if (scopeId == null) {
      throw new BadRequestException(`${scopeType} bắt buộc có scopeId`);
    }
    return scopeId;
  }

  private groupId(scopeType: ConfigScope, scopeId: number | null) {
    return scopeType === 'GLOBAL' ? 'GLOBAL' : `${scopeType}:${scopeId}`;
  }

  private scopeContext(
    scopeType: ConfigScope,
    scopeId: number | null,
  ): ResolvedPlanningConfigQueryDto {
    if (scopeId == null) return {};
    if (scopeType === 'CATEGORY') return { categoryId: scopeId };
    if (scopeType === 'SUPPLIER') return { supplierId: scopeId };
    return { skuId: scopeId };
  }

  private parseGroupId(id: string): {
    scopeType: ConfigScope;
    scopeId: number | null;
  } {
    if (id === 'GLOBAL') return { scopeType: 'GLOBAL', scopeId: null };
    const match = /^(CATEGORY|SUPPLIER|SKU):([1-9]\d*)$/.exec(id);
    if (!match) throw new BadRequestException('Group id không hợp lệ');
    return {
      scopeType: match[1] as ConfigScope,
      scopeId: Number(match[2]),
    };
  }

  private async validateContext(
    query: ResolvedPlanningConfigQueryDto,
    skuAlreadyValidated = false,
  ) {
    if (query.categoryId != null)
      await this.validateScopeEntity('CATEGORY', query.categoryId);
    if (query.supplierId != null)
      await this.validateScopeEntity('SUPPLIER', query.supplierId);
    if (query.skuId != null && !skuAlreadyValidated)
      await this.validateScopeEntity('SKU', query.skuId);
  }

  private async validateScopeEntity(
    scopeType: ConfigScope,
    scopeId: number | null,
  ) {
    if (scopeType === 'GLOBAL') return;
    const entity =
      scopeType === 'CATEGORY'
        ? await this.repository.findCategory(scopeId!)
        : scopeType === 'SUPPLIER'
          ? await this.repository.findSupplierEntity(scopeId!)
          : await this.repository.findProductParameters(scopeId!);
    if (!entity) throw new NotFoundException(`${scopeType} không tồn tại`);
    if (scopeType === 'CATEGORY' && (entity as any).type !== 'child') {
      throw new BadRequestException('Chỉ category cấp child được cấu hình');
    }
  }

  private productPackSize(value: unknown) {
    const conversionValue = Number(value);
    return Number.isInteger(conversionValue) && conversionValue > 0
      ? conversionValue
      : 1;
  }

  private emptyList(query: RecommendationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    return {
      items: [],
      pagination: { page, limit, total: 0, totalPages: 1 },
      meta: {
        snapshotDate: query.date ?? this.dateOnly(this.today()),
        isStale: false,
        lastRunAt: null,
        counts: this.countPriorities([]),
        totalEstimatedValue: null,
      },
    };
  }

  async listTrends() {
    const rows = await this.repository.listTrends();
    return { items: rows.map((row) => this.mapTrend(row)) };
  }

  async createTrend(dto: Record<string, any>, actor?: ConfigActor) {
    this.assertTrend(dto);
    const row = await this.repository.createTrend({
      ...this.trendData(dto),
      createdBy: actor?.id ?? null,
    });
    return this.mapTrend(row);
  }

  async updateTrend(id: number, dto: Record<string, any>) {
    const existing = await this.repository.findTrend(id);
    if (!existing || existing.isActive === false) {
      throw new NotFoundException('Không tìm thấy trend');
    }
    this.assertTrend({ ...existing, ...dto });
    const row = await this.repository.updateTrend(
      id,
      this.trendData(dto, existing),
    );
    return this.mapTrend(row);
  }

  async deleteTrend(id: number) {
    const existing = await this.repository.findTrend(id);
    if (!existing) throw new NotFoundException('Không tìm thấy trend');
    await this.repository.deactivateTrend(id);
    return { id, deleted: true };
  }

  private assertTrend(dto: Record<string, any>) {
    if (!dto.productId && !dto.categoryName) {
      throw new BadRequestException('Trend cần chọn sản phẩm hoặc nhóm hàng');
    }
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException('Trend cần ngày bắt đầu và kết thúc');
    }
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('Ngày kết thúc phải sau ngày bắt đầu');
    }
    if (dto.upliftFactor == null && dto.extraQuantity == null) {
      throw new BadRequestException(
        'Trend cần hệ số tăng hoặc số lượng tăng thêm',
      );
    }
  }

  private trendData(
    dto: Record<string, any>,
    existing: Record<string, any> = {},
  ) {
    const startDate = new Date(
      `${String(dto.startDate ?? existing.startDate).slice(0, 10)}T00:00:00.000Z`,
    );
    const endDate = new Date(
      `${String(dto.endDate ?? existing.endDate).slice(0, 10)}T00:00:00.000Z`,
    );
    const extraQuantity = dto.extraQuantity ?? existing.extraQuantity;
    const upliftFactor = dto.upliftFactor ?? existing.upliftFactor;
    return {
      productId: dto.productId ?? existing.productId ?? null,
      categoryName: dto.categoryName ?? existing.categoryName ?? null,
      startDate,
      endDate,
      kind: extraQuantity != null ? 'QUANTITY' : 'UPLIFT',
      upliftFactor: extraQuantity != null ? null : upliftFactor,
      extraQuantity: extraQuantity ?? null,
      note: dto.note ?? existing.note ?? null,
      isActive: true,
    };
  }

  private mapTrend(row: any) {
    return {
      id: row.id,
      productId: row.productId,
      product: row.product
        ? { id: row.product.id, code: row.product.code, name: row.product.name }
        : null,
      categoryName: row.categoryName,
      startDate: this.dateOnly(row.startDate),
      endDate: this.dateOnly(row.endDate),
      kind: row.kind,
      upliftFactor: row.upliftFactor == null ? null : Number(row.upliftFactor),
      extraQuantity:
        row.extraQuantity == null ? null : Number(row.extraQuantity),
      note: row.note,
      isActive: row.isActive,
      updatedAt: row.updatedAt,
    };
  }

  private contractSource(source: string) {
    return source === 'DEFAULT' ? 'GLOBAL' : source;
  }
  private dateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }
  private today() {
    return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  private addDays(date: Date, days: number) {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }
  private parseDate(value?: string) {
    return value ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : undefined;
  }
}

/** Số ngày của tháng `YYYY-MM`. */
function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}
