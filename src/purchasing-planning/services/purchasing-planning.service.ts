import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import {
  calculatePriority,
  calculateReplenishment,
  calculateSoq,
  ConfigScope,
  ConfigValue,
  DEFAULT_PLANNING_CONFIG,
  forecastDemand,
  OPERATIONAL_PLANNING_DEFAULTS,
  PlanningConfigKey,
  projectInventory,
  resolveDemand,
  resolveIncoming,
  resolvePlanningConfig,
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
};

@Injectable()
export class PurchasingPlanningService {
  constructor(
    private readonly repository: PurchasingPlanningRepository,
    private readonly auditLogs: AuditLogsService,
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
      start.setUTCDate(start.getUTCDate() - 89);
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
      const items = data.products.map((product) =>
        this.calculateProduct(
          product,
          data,
          configValues,
          categoryByName,
          snapshotDate,
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

  private calculateProduct(
    product: any,
    data: any,
    configValues: ConfigValue[],
    categoryByName: Map<string, number>,
    snapshotDate: Date,
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
    const resolved = resolvePlanningConfig(configValues, {
      skuId: product.id,
      supplierId: latestSupplier?.supplierId,
      categoryId: childCategoryId,
    });
    const packSize = this.productPackSize(product.conversionValue);
    const config = {
      ...resolved.config,
      ...OPERATIONAL_PLANNING_DEFAULTS,
      packSize,
    };
    const configSources = {
      ...resolved.sources,
      packSize: 'PRODUCT',
    };
    const rawPhysical = inventoryRows.reduce(
      (sum: number, row: any) => sum + Number(row.onHand),
      0,
    );
    const physical = rawPhysical;
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
    let demand = resolveDemand({
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
    const forecast = forecastDemand({
      days: demand,
      asOfDate: snapshotDate,
      firstActivityDate: firstActivity,
      growthFactor: config.growthFactor,
      minDays: config.minDays,
    });

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
      leadTimeDays: config.leadTimeDays,
      lines: activeOrders.map((row: any) => ({
        id: row.orderSupplier.id,
        status: row.orderSupplier.status,
        orderedQuantity: Number(row.quantity),
        receivedQuantity: receivedByOrder.get(row.orderSupplier.id) ?? 0,
        expectedArrivalDate: this.shipmentEta(row),
        orderDate: row.orderSupplier.orderDate,
      })),
    });
    const shipments = activeOrders
      .map((row: any) =>
        this.mapShipment(
          row,
          receivedByOrder,
          config.leadTimeDays,
          snapshotDate,
        ),
      )
      .filter((shipment: any) => shipment.quantity > 0);
    const replenishment = calculateReplenishment({
      forecastDailyDemand: forecast.forecastDailyDemand,
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      availableStock: available,
      incomingTotal: incoming.total,
    });
    const projection = projectInventory({
      snapshotDate,
      availableStock: available,
      forecastDailyDemand: forecast.forecastDailyDemand,
      incoming: incoming.receipts,
      horizonDays: config.projectionDays,
    });
    const usableIncomingCutoff = this.addDays(
      snapshotDate,
      config.leadTimeDays + config.safetyDays + config.coverageDays,
    );
    const usableIncoming = incoming.receipts
      .filter(
        (receipt) =>
          new Date(`${receipt.date}T00:00:00.000Z`) <= usableIncomingCutoff,
      )
      .reduce((sum, receipt) => sum + receipt.quantity, 0);
    const priority = calculatePriority({
      confidence: forecast.confidence,
      forecastDailyDemand: forecast.forecastDailyDemand,
      availableStock: available,
      inventoryPosition: replenishment.inventoryPosition,
      reorderPoint: replenishment.reorderPoint,
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      overstockDays: config.overstockDays,
      needsOrder: replenishment.needsOrder,
      daysUntilStockout: projection.daysUntilStockout,
    });
    const soq = calculateSoq({
      forecastDailyDemand: forecast.forecastDailyDemand,
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      coverageDays: config.coverageDays,
      availableStock: available,
      usableIncoming,
      daysOfSupply: priority.daysOfSupply,
      packSize: config.packSize,
      moq: config.moq,
      purchaseMultiple: config.purchaseMultiple,
      moqTolerance: config.moqTolerance,
      needsOrder: replenishment.needsOrder,
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
      used: forecast.forecastDailyDemand,
      windowUsed: forecast.windowDays,
      ma30: forecast.ma30,
      ma60: forecast.ma60,
      ma90: forecast.ma90,
      trendRatio,
      totalDemand,
      validDays: forecast.validStockDays,
      windowDays: forecast.windowDays,
      stockoutDaysExcluded: Math.max(
        0,
        forecast.windowDays - forecast.validStockDays,
      ),
      growthFactor: forecast.growthFactor,
      demandSource,
    };
    const trace = this.buildTrace(
      snapshotDate,
      config,
      configSources,
      branches,
      shipments,
      forecastComparison,
      replenishment,
      soq,
      priority,
      flags,
      incoming.total,
      data.branchScope,
    );
    if (status === 'BLOCKED') trace.result.suggestedQuantity = 0;
    const summaryText = this.summary(
      priority.priority,
      projection.daysUntilStockout,
      config.leadTimeDays,
      soq.suggestedQuantity,
      flags,
    );

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
      forecastDailyDemand: forecast.forecastDailyDemand,
      confidence: forecast.confidence,
      demandSource,
      ma30: forecast.ma30,
      ma60: forecast.ma60,
      ma90: forecast.ma90,
      trendRatio,
      leadTimeDays: Math.round(config.leadTimeDays),
      leadTimeSource: this.contractSource(resolved.sources.leadTimeDays),
      safetyDays: Math.round(config.safetyDays),
      coverageDays: Math.round(config.coverageDays),
      leadTimeDemand: replenishment.leadTimeDemand,
      safetyBuffer: replenishment.safetyBuffer,
      reorderPoint: replenishment.reorderPoint,
      physicalStock: physical,
      reservedStock: 0,
      availableStock: available,
      incomingTotal: incoming.total,
      inventoryPosition: replenishment.inventoryPosition,
      reorderGap: replenishment.reorderGap,
      needsOrder: replenishment.needsOrder,
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
      status,
      summaryText,
      calculationTrace: trace,
    };
  }

  private buildTrace(
    snapshotDate: Date,
    config: any,
    sources: any,
    branches: any[],
    shipments: any[],
    forecast: any,
    replenishment: any,
    soq: any,
    priority: any,
    flags: Flag[],
    incomingTotal: number,
    branchScope: PurchasingBranchScope,
  ) {
    const configValue = (key: string) => ({
      value: config[key],
      source: this.contractSource(sources[key]),
      label: SOURCE_LABEL[sources[key]] ?? SOURCE_LABEL.DEFAULT,
    });
    return {
      version: '1.0',
      computedAt: new Date().toISOString(),
      inputs: {
        branchScope,
        config: {
          leadTimeDays: configValue('leadTimeDays'),
          safetyDays: configValue('safetyDays'),
          coverageDays: configValue('coverageDays'),
          growthFactor: configValue('growthFactor'),
          packSize: configValue('packSize'),
          moq: configValue('moq'),
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
          values: { FDD: forecast.used, leadTimeDays: config.leadTimeDays },
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
        priority: priority.priority,
      },
      flags,
    };
  }

  private buildFlags(input: any): Flag[] {
    const codes: Array<{ code: string; context?: Record<string, unknown> }> =
      [];
    if (!input.latestSupplier) codes.push({ code: 'MISSING_SUPPLIER' });
    if (input.supplierIds.size > 1)
      codes.push({
        code: 'MULTI_SUPPLIER',
        context: { supplierCount: input.supplierIds.size },
      });
    if (input.forecast.confidence === 'NO_DATA')
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
    if (input.inventoryRows.some((row: any) => Number(row.reserved) !== 0))
      codes.push({ code: 'RESERVED_DATA_UNRELIABLE' });
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

  private summary(
    priority: string,
    stockout: number | null,
    leadTime: number,
    quantity: number,
    flags: Flag[],
  ) {
    if (flags.some((flag) => flag.blocksRecommendation))
      return 'Thiếu dữ liệu dự báo · Cần bổ sung dữ liệu trước khi đặt hàng';
    if (priority === 'NO_DATA')
      return 'Chưa có đủ nhu cầu lịch sử để lập đề xuất';
    if (stockout === 0)
      return `Đã hết hàng · Đề xuất đặt ${quantity} đơn vị ngay`;
    if (stockout != null && stockout < leadTime)
      return `Hết sau ${stockout} ngày · Hàng dự kiến về sau ${leadTime} ngày → nguy cơ đứt ${leadTime - stockout} ngày`;
    if (quantity > 0)
      return `Còn hàng khoảng ${stockout ?? 'chưa xác định'} ngày · Đề xuất đặt ${quantity} đơn vị`;
    return 'Tồn kho hiện tại đáp ứng nhu cầu dự kiến';
  }

  private mapListItem(item: any) {
    const trace = item.calculationTrace as any;
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
      leadTimeDays: item.leadTimeDays,
      leadTimeSource: item.leadTimeSource,
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
  ) {
    try {
      return await this.repository.upsertConfigGroup(
        scopeType,
        scopeId,
        values,
        userId,
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
