import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { LARK_CLIENT } from '../../lark-sync/lark-client.provider';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Đồng bộ một chiều LarkBase -> POS cho phiếu Demand khách hàng OEM/đặt hộ.
 *
 * Nguyên tắc:
 * - Đọc toàn bộ bảng Lark, không phụ thuộc view.
 * - Gộp record trùng khách + tháng + sản phẩm theo quy tắc đơn vị.
 * - Lưu mapping của từng record Lark để chạy lại không tạo trùng.
 * - Record thiếu mapping vẫn được lưu để có thể retry sau.
 * - Không xóa/hủy dữ liệu POS khi record biến mất khỏi Lark.
 */

const TEXT_FIELDS = {
  CUSTOMER_CODE: 'Mã khách',
  CUSTOMER_LINK: 'Tên Khách Hàng',
  PRODUCT_CODE: 'Mã hàng',
  PRODUCT_LINK: 'Mã và Tên Hàng',
  UNIT: 'Đơn Vị Đặt',
  QUANTITY: 'Số lượng',
  QUANTITY_BASE: 'Số lượng quy đổi',
  MONTH: 'Thời Gian (yyyy/mm)',
  NOTE: 'Ghi Chú',
} as const;

const DEFAULT_BASE_TOKEN = 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
const DEFAULT_TABLE_ID = 'tblWBeLHcMlYu8Gr';
const DEFAULT_CUSTOMER_TABLE_ID = 'tbl59MvUCIZY0ckZ';
const DEFAULT_PRODUCT_TABLE_ID = 'tbldKbrNjFkqdzao';

const PAGE_SIZE = 500;
const MAX_PREVIEW_ISSUES = 200;
const SYNC_SOURCE = 'LARK';
const SYNC_DEMAND_NOTE = 'Đồng bộ tự động từ LarkBase';
const SYNC_MONTH_NOTE = 'Đồng bộ từ LarkBase';

type DemandUnit = 'BASE' | 'CARTON';
type PlannedAction = 'CREATE' | 'UPDATE';
type MappingStatus = 'SYNCED' | 'PENDING_MAPPING' | 'ERROR';

export type LarkDemandIssueCode =
  | 'MISSING_CUSTOMER'
  | 'MISSING_PRODUCT'
  | 'MISSING_MONTH'
  | 'MISSING_QUANTITY'
  | 'MISSING_CONVERSION'
  | 'LINE_CONFLICT';

export interface LarkDemandPreviewIssue {
  sourceRecordId: string;
  customerCode: string | null;
  customerName: string | null;
  productCode: string | null;
  productName: string | null;
  month: string | null;
  quantity: number | null;
  code: LarkDemandIssueCode;
  message: string;
}

export interface LarkDemandPreviewSummary {
  totalRecords: number;
  validRecords: number;
  pendingRecords: number;
  conflictedRecords: number;
  mergedRecords: number;
  aggregatedRows: number;
  newLines: number;
  updatedLines: number;
  demandsToCreate: number;
  monthsToCreate: number;
  issues: LarkDemandPreviewIssue[];
  truncatedIssues: boolean;
}

export interface LarkDemandSyncResult extends LarkDemandPreviewSummary {
  syncedLines: number;
  syncedRecords: number;
  unmappedRecords: number;
  orphanedRecords: number;
  syncedAt: string;
}

interface LarkRecordItem {
  record_id?: string;
  fields?: Record<string, any>;
  last_modified_time?: number | string;
}

interface ResolvedLarkRow {
  sourceRecordId: string;
  sourceModifiedAt: Date | null;
  rawFields: Record<string, unknown>;
  customerCode: string | null;
  customerId: number | null;
  customerName: string | null;
  productCode: string | null;
  productId: number | null;
  productName: string | null;
  month: string | null;
  unit: DemandUnit;
  quantity: number | null;
  quantityBase: number | null;
  conversionValue: number;
  note: string | null;
  issue: LarkDemandPreviewIssue | null;
}

interface DemandLineInfo {
  id: number;
  demandId: number;
  monthId: number;
  monthKey: string;
  customerId: number;
  productId: number;
  status: string;
}

interface LinkedCustomerInfo {
  code: string | null;
  name: string | null;
}

interface LinkedProductInfo {
  code: string | null;
  name: string | null;
}

interface PlannedLine {
  customerId: number;
  customerName: string;
  month: string;
  productId: number;
  productName: string;
  inputUnit: DemandUnit;
  inputQuantity: number;
  quantityBase: number;
  conversionValue: number;
  note: string | null;
  sourceRecordIds: string[];
  sourceModifiedAt: Date | null;
  existingDemandId: number | null;
  existingMonthId: number | null;
  existingLineId: number | null;
  existingMonthStatus: string | null;
  syncDemandId: number | null;
  syncMonthId: number | null;
  syncMonthStatus: string | null;
  action: PlannedAction;
}

interface GroupAccumulator {
  line: PlannedLine;
  baseQuantity: number;
  cartonQuantity: number;
  units: Set<DemandUnit>;
}

interface LoadedPlan {
  summary: LarkDemandPreviewSummary;
  groups: PlannedLine[];
  rawRows: ResolvedLarkRow[];
  rawById: Map<string, ResolvedLarkRow>;
  issues: LarkDemandPreviewIssue[];
}

@Injectable()
export class LarkCustomerDemandSyncService {
  private readonly logger = new Logger(LarkCustomerDemandSyncService.name);
  private readonly baseToken: string;
  private readonly tableId: string;
  private readonly customerTableId: string;
  private readonly productTableId: string;

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    config: ConfigService,
  ) {
    this.baseToken =
      config.get<string>('LARK_DEMAND_BASE_TOKEN')?.trim() ||
      config.get<string>('LARK_PRODUCT_BASE_TOKEN')?.trim() ||
      DEFAULT_BASE_TOKEN;
    this.tableId =
      config.get<string>('LARK_DEMAND_TABLE_ID')?.trim() || DEFAULT_TABLE_ID;
    this.customerTableId =
      config.get<string>('LARK_DEMAND_CUSTOMER_TABLE_ID')?.trim() ||
      DEFAULT_CUSTOMER_TABLE_ID;
    this.productTableId =
      config.get<string>('LARK_DEMAND_PRODUCT_TABLE_ID')?.trim() ||
      DEFAULT_PRODUCT_TABLE_ID;
  }

  async preview(): Promise<LarkDemandPreviewSummary> {
    return (await this.loadPlan()).summary;
  }

  async status() {
    const [counts, lastSynced] = await Promise.all([
      this.prisma.customerDemandLarkRecord.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.customerDemandLarkRecord.aggregate({
        _max: { lastSyncedAt: true },
      }),
    ]);

    const countByStatus: Record<string, number> = {};
    for (const row of counts) {
      countByStatus[row.status] = row._count._all;
    }

    return {
      counts: countByStatus,
      synced: countByStatus.SYNCED ?? 0,
      pendingMapping: countByStatus.PENDING_MAPPING ?? 0,
      orphaned: countByStatus.ORPHANED ?? 0,
      error: countByStatus.ERROR ?? 0,
      lastSyncedAt: lastSynced._max.lastSyncedAt?.toISOString() ?? null,
      isConfigured:
        !!this.baseToken &&
        !!this.tableId &&
        !!this.customerTableId &&
        !!this.productTableId,
    };
  }

  async sync(userId: number): Promise<LarkDemandSyncResult> {
    const plan = await this.loadPlan();
    if (plan.summary.totalRecords === 0) {
      throw new BadRequestException('LarkBase không có record Demand nào');
    }

    const now = new Date();
    const persisted = await this.persistPlan(plan, userId, now);

    await this.auditLogs.create({
      actionType: 'UPDATE',
      actionCode: 'CUSTOMER_DEMAND_SYNC_LARK',
      entityType: 'CUSTOMER_DEMAND',
      entityId: 'lark-sync',
      message: `Đã đồng bộ ${persisted.syncedLines} dòng Demand từ LarkBase`,
      userId,
      userName: 'System',
      snapshot: {
        ...plan.summary,
        syncedLines: persisted.syncedLines,
        syncedRecords: persisted.syncedRecords,
        orphanedRecords: persisted.orphanedRecords,
      },
    });

    const result: LarkDemandSyncResult = {
      ...plan.summary,
      syncedLines: persisted.syncedLines,
      syncedRecords: persisted.syncedRecords,
      unmappedRecords: plan.summary.pendingRecords,
      orphanedRecords: persisted.orphanedRecords,
      syncedAt: now.toISOString(),
    };

    this.logger.log(
      `Lark demand sync done: ${persisted.syncedRecords}/${plan.summary.totalRecords} records, ${persisted.syncedLines} POS lines`,
    );
    return result;
  }

  private async loadPlan(): Promise<LoadedPlan> {
    const rawRecords = await this.fetchAllRecords(this.tableId);
    const customerLinkIds = [
      ...new Set(
        rawRecords.flatMap((record) =>
          this.linkRecordIds(record.fields?.[TEXT_FIELDS.CUSTOMER_LINK]),
        ),
      ),
    ];
    const productLinkIds = [
      ...new Set(
        rawRecords.flatMap((record) =>
          this.linkRecordIds(record.fields?.[TEXT_FIELDS.PRODUCT_LINK]),
        ),
      ),
    ];
    const [linkedCustomerRecords, linkedProductRecords] = await Promise.all([
      this.fetchLinkedRecords(this.customerTableId, customerLinkIds),
      this.fetchLinkedRecords(this.productTableId, productLinkIds),
    ]);
    const linkedCustomerByRecordId = new Map<string, LinkedCustomerInfo>(
      linkedCustomerRecords
        .filter((record) => record.record_id)
        .map((record) => [
          record.record_id as string,
          {
            code:
              this.fieldText(record.fields?.['Mã Khách Hàng']).trim() || null,
            name:
              this.fieldText(record.fields?.['Tên Khách Hàng']).trim() || null,
          },
        ]),
    );
    const linkedProductByRecordId = new Map<string, LinkedProductInfo>(
      linkedProductRecords
        .filter((record) => record.record_id)
        .map((record) => [
          record.record_id as string,
          {
            code: this.fieldText(record.fields?.['Mã Hàng Hoá']).trim() || null,
            name:
              this.fieldText(record.fields?.['Tên Hàng Hoá']).trim() || null,
          },
        ]),
    );
    const sourceRecordIds = rawRecords
      .map((record) => record.record_id)
      .filter((recordId): recordId is string => !!recordId);

    const [customers, products, demandMonths, mappings, syncDemands] =
      await Promise.all([
        this.prisma.customer.findMany({
          select: {
            id: true,
            code: true,
            name: true,
            larkRecordId: true,
          },
        }),
        this.prisma.product.findMany({
          select: {
            id: true,
            code: true,
            name: true,
            conversionValue: true,
            larkRecordId: true,
          },
        }),
        this.prisma.customerDemandMonth.findMany({
          select: {
            id: true,
            demandId: true,
            demandMonth: true,
            status: true,
            lines: { select: { id: true, productId: true } },
            demand: { select: { customerId: true } },
          },
        }),
        sourceRecordIds.length
          ? this.prisma.customerDemandLarkRecord.findMany({
              where: { sourceRecordId: { in: sourceRecordIds } },
              select: { sourceRecordId: true, demandLineId: true },
            })
          : Promise.resolve([]),
        this.prisma.customerDemand.findMany({
          where: { sourceSystem: SYNC_SOURCE },
          select: {
            id: true,
            customerId: true,
            months: {
              select: {
                id: true,
                demandMonth: true,
                status: true,
              },
            },
          },
        }),
      ]);

    const customerByLark = new Map(
      customers
        .filter((item) => item.larkRecordId)
        .map((item) => [item.larkRecordId as string, item]),
    );
    const customerByCode = new Map(
      customers
        .filter((item) => item.code)
        .map((item) => [item.code!.trim().toLowerCase(), item]),
    );
    const productByLark = new Map(
      products
        .filter((item) => item.larkRecordId)
        .map((item) => [item.larkRecordId as string, item]),
    );
    const productByCode = new Map(
      products.map((item) => [item.code.trim().toLowerCase(), item]),
    );

    const resolvedRows = rawRecords.map((record) =>
      this.resolveRecord(record, {
        customerByLark,
        customerByCode,
        productByLark,
        productByCode,
        linkedCustomerByRecordId,
        linkedProductByRecordId,
      }),
    );
    const resolvedById = new Map(
      resolvedRows
        .filter((row) => !!row.sourceRecordId)
        .map((row) => [row.sourceRecordId, row]),
    );

    const lineById = new Map<number, DemandLineInfo>();
    const linesByKey = new Map<string, DemandLineInfo[]>();
    for (const month of demandMonths) {
      const monthKey = this.monthKeyOf(month.demandMonth);
      for (const line of month.lines) {
        const info: DemandLineInfo = {
          id: line.id,
          demandId: month.demandId,
          monthId: month.id,
          monthKey,
          customerId: month.demand.customerId,
          productId: line.productId,
          status: month.status,
        };
        lineById.set(line.id, info);
        const key = this.demandKey(
          info.customerId,
          info.monthKey,
          info.productId,
        );
        const list = linesByKey.get(key) ?? [];
        list.push(info);
        linesByKey.set(key, list);
      }
    }

    const mappingByRecord = new Map<string, number | null>(
      mappings.map(
        (item) =>
          [item.sourceRecordId, item.demandLineId] as [string, number | null],
      ),
    );
    const syncDemandsByCustomer = new Map<
      number,
      Array<(typeof syncDemands)[number]>
    >();
    for (const demand of syncDemands) {
      const list = syncDemandsByCustomer.get(demand.customerId) ?? [];
      list.push(demand);
      syncDemandsByCustomer.set(demand.customerId, list);
    }

    const issues: LarkDemandPreviewIssue[] = resolvedRows
      .map((row) => row.issue)
      .filter((issue): issue is LarkDemandPreviewIssue => !!issue);
    const validRows = resolvedRows.filter((row) => !row.issue);
    const mergedLines = this.mergeResolvedRows(validRows);
    const groups: PlannedLine[] = [];

    for (const line of mergedLines) {
      const key = this.demandKey(line.customerId, line.month, line.productId);
      const candidates = linesByKey.get(key) ?? [];
      const mappedLineIds = [
        ...new Set(
          line.sourceRecordIds
            .map((sourceRecordId) => mappingByRecord.get(sourceRecordId))
            .filter((value): value is number => typeof value === 'number'),
        ),
      ];

      let target: DemandLineInfo | null = null;
      let conflictMessage: string | null = null;

      if (mappedLineIds.length > 1) {
        conflictMessage =
          'Các record Lark từng được gắn vào nhiều dòng POS khác nhau';
      } else if (mappedLineIds.length === 1) {
        const mapped = lineById.get(mappedLineIds[0]);
        if (mapped) {
          if (!this.sameDemandKey(mapped, line)) {
            conflictMessage =
              'Mapping cũ không còn khớp khách hàng, tháng và sản phẩm của record Lark';
          } else {
            target = mapped;
          }
        }
      }

      if (!target && !conflictMessage) {
        if (candidates.length === 1) {
          target = candidates[0];
        } else if (candidates.length > 1) {
          conflictMessage = `Có ${candidates.length} dòng POS cùng khách/tháng/sản phẩm nên không xác định được dòng đích`;
        }
      }

      if (target?.status === 'CANCELLED') {
        conflictMessage =
          'Dòng POS tương ứng thuộc tháng đã hủy; cần xử lý thủ công trước khi đồng bộ';
        target = null;
      }

      if (conflictMessage) {
        issues.push(...this.conflictIssues(line, conflictMessage));
        continue;
      }

      if (target) {
        line.existingDemandId = target.demandId;
        line.existingMonthId = target.monthId;
        line.existingLineId = target.id;
        line.existingMonthStatus = target.status;
        line.action = 'UPDATE';
        groups.push(line);
        continue;
      }

      const syncDemandCandidates =
        syncDemandsByCustomer.get(line.customerId) ?? [];
      if (syncDemandCandidates.length > 1) {
        issues.push(
          ...this.conflictIssues(
            line,
            `Có ${syncDemandCandidates.length} phiếu đồng bộ cùng khách hàng; cần xử lý thủ công`,
          ),
        );
        continue;
      }

      const syncDemand = syncDemandCandidates[0];
      if (syncDemand) {
        line.syncDemandId = syncDemand.id;
        const syncMonth = syncDemand.months.find(
          (month) => this.monthKeyOf(month.demandMonth) === line.month,
        );
        if (syncMonth?.status === 'CANCELLED') {
          issues.push(
            ...this.conflictIssues(
              line,
              'Tháng tương ứng trong phiếu đồng bộ đã bị hủy; cần xử lý thủ công',
            ),
          );
          continue;
        }
        if (syncMonth) {
          line.syncMonthId = syncMonth.id;
          line.syncMonthStatus = syncMonth.status;
        }
      }

      line.action = 'CREATE';
      groups.push(line);
    }

    const validRecords = groups.reduce(
      (sum, group) => sum + group.sourceRecordIds.length,
      0,
    );
    const conflicts = issues.filter((issue) => issue.code === 'LINE_CONFLICT');
    const pending = issues.filter((issue) => issue.code !== 'LINE_CONFLICT');
    const demandsToCreate = new Set(
      groups
        .filter((group) => group.action === 'CREATE' && !group.syncDemandId)
        .map((group) => group.customerId),
    ).size;

    const summary: LarkDemandPreviewSummary = {
      totalRecords: resolvedRows.length,
      validRecords,
      pendingRecords: pending.length,
      conflictedRecords: conflicts.length,
      mergedRecords: Math.max(0, validRecords - groups.length),
      aggregatedRows: groups.length,
      newLines: groups.filter((group) => group.action === 'CREATE').length,
      updatedLines: groups.filter((group) => group.action === 'UPDATE').length,
      demandsToCreate,
      monthsToCreate: groups.filter(
        (group) =>
          group.action === 'CREATE' &&
          !group.existingMonthId &&
          !group.syncMonthId,
      ).length,
      issues: issues.slice(0, MAX_PREVIEW_ISSUES),
      truncatedIssues: issues.length > MAX_PREVIEW_ISSUES,
    };

    return {
      summary,
      groups,
      rawRows: resolvedRows,
      rawById: resolvedById,
      issues,
    };
  }

  private async persistPlan(plan: LoadedPlan, userId: number, now: Date) {
    const demandCache = new Map<number, number>();
    const monthCache = new Map<string, { id: number; status: string }>();
    let syncedLines = 0;
    let syncedRecords = 0;

    const orphaned = await this.prisma.$transaction(
      async (tx) => {
        for (const group of plan.groups) {
          const lineData = {
            inputQuantity: group.inputQuantity,
            inputUnit: group.inputUnit,
            quantityBase: group.quantityBase,
            conversionValue: group.conversionValue,
          };

          let lineId: number;
          if (group.existingLineId && group.existingMonthId) {
            await this.ensureConfirmedMonth(
              tx,
              group.existingMonthId,
              group.existingMonthStatus,
              now,
              userId,
            );
            const updated = await tx.customerDemandLine.update({
              where: { id: group.existingLineId },
              data: lineData,
            });
            lineId = updated.id;
          } else {
            const demandId = await this.ensureSyncDemand(
              tx,
              group,
              userId,
              demandCache,
            );
            const month = await this.ensureSyncMonth(
              tx,
              demandId,
              group,
              now,
              userId,
              monthCache,
            );
            const created = await tx.customerDemandLine.upsert({
              where: {
                demandMonthId_productId: {
                  demandMonthId: month.id,
                  productId: group.productId,
                },
              },
              create: {
                demandMonthId: month.id,
                productId: group.productId,
                ...lineData,
              },
              update: lineData,
            });
            lineId = created.id;
          }

          for (const sourceRecordId of group.sourceRecordIds) {
            const raw = plan.rawById.get(sourceRecordId);
            await tx.customerDemandLarkRecord.upsert({
              where: { sourceRecordId },
              create: {
                sourceRecordId,
                sourceModifiedAt: raw?.sourceModifiedAt ?? null,
                rawFields: this.jsonSafe(raw?.rawFields ?? {}),
                status: 'SYNCED',
                customerId: group.customerId,
                productId: group.productId,
                demandLineId: lineId,
                lastSyncedAt: now,
              },
              update: {
                sourceModifiedAt: raw?.sourceModifiedAt ?? null,
                rawFields: this.jsonSafe(raw?.rawFields ?? {}),
                status: 'SYNCED',
                customerId: group.customerId,
                productId: group.productId,
                demandLineId: lineId,
                errorMessage: null,
                lastSyncedAt: now,
              },
            });
          }

          syncedLines += 1;
          syncedRecords += group.sourceRecordIds.length;
        }

        for (const issue of plan.issues) {
          const raw = plan.rawById.get(issue.sourceRecordId);
          const status: MappingStatus =
            issue.code === 'LINE_CONFLICT' ? 'ERROR' : 'PENDING_MAPPING';
          await tx.customerDemandLarkRecord.upsert({
            where: { sourceRecordId: issue.sourceRecordId },
            create: {
              sourceRecordId: issue.sourceRecordId,
              sourceModifiedAt: raw?.sourceModifiedAt ?? null,
              rawFields: this.jsonSafe(raw?.rawFields ?? {}),
              status,
              customerId: raw?.customerId ?? null,
              productId: raw?.productId ?? null,
              demandLineId: null,
              errorMessage: issue.message,
              lastSyncedAt: now,
            },
            update: {
              sourceModifiedAt: raw?.sourceModifiedAt ?? null,
              rawFields: this.jsonSafe(raw?.rawFields ?? {}),
              status,
              customerId: raw?.customerId ?? null,
              productId: raw?.productId ?? null,
              demandLineId: null,
              errorMessage: issue.message,
              lastSyncedAt: now,
            },
          });
        }

        const currentRecordIds = plan.rawRows
          .map((row) => row.sourceRecordId)
          .filter(Boolean);
        return tx.customerDemandLarkRecord.updateMany({
          where: {
            sourceRecordId: { notIn: currentRecordIds },
            status: { in: ['SYNCED', 'PENDING_MAPPING', 'ERROR'] },
          },
          data: {
            status: 'ORPHANED',
            lastSyncedAt: now,
          },
        });
      },
      { timeout: 120_000 },
    );

    return {
      syncedLines,
      syncedRecords,
      orphanedRecords: orphaned.count,
    };
  }

  private async ensureSyncDemand(
    tx: any,
    group: PlannedLine,
    userId: number,
    cache: Map<number, number>,
  ) {
    const cached = cache.get(group.customerId);
    if (cached) return cached;
    if (group.syncDemandId) {
      cache.set(group.customerId, group.syncDemandId);
      return group.syncDemandId;
    }

    const syncKey = this.syncKeyFor(group.customerId);
    let demand = await tx.customerDemand.findFirst({
      where: { sourceSystem: SYNC_SOURCE, syncKey },
      select: { id: true },
    });
    if (!demand) {
      demand = await tx.customerDemand.create({
        data: {
          customerId: group.customerId,
          note: SYNC_DEMAND_NOTE,
          sourceSystem: SYNC_SOURCE,
          syncKey,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
    } else {
      await tx.customerDemand.update({
        where: { id: demand.id },
        data: { updatedBy: userId },
      });
    }

    cache.set(group.customerId, demand.id);
    return demand.id as number;
  }

  private async ensureSyncMonth(
    tx: any,
    demandId: number,
    group: PlannedLine,
    now: Date,
    userId: number,
    cache: Map<string, { id: number; status: string }>,
  ) {
    const cacheKey = `${demandId}|${group.month}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      await this.ensureConfirmedMonth(
        tx,
        cached.id,
        cached.status,
        now,
        userId,
      );
      return cached;
    }

    const demandMonth = this.monthDate(group.month);
    let month = await tx.customerDemandMonth.findUnique({
      where: {
        demandId_demandMonth: {
          demandId,
          demandMonth,
        },
      },
      select: { id: true, status: true },
    });

    if (!month) {
      month = await tx.customerDemandMonth.create({
        data: {
          demandId,
          demandMonth,
          status: 'CONFIRMED',
          note: SYNC_MONTH_NOTE,
          approvedAt: now,
          approvedBy: userId,
        },
        select: { id: true, status: true },
      });
    } else {
      await this.ensureConfirmedMonth(tx, month.id, month.status, now, userId);
    }

    cache.set(cacheKey, month);
    return month as { id: number; status: string };
  }

  private async ensureConfirmedMonth(
    tx: any,
    monthId: number,
    status: string | null,
    now: Date,
    userId: number,
  ) {
    if (status === 'CANCELLED') {
      throw new BadRequestException(
        'Không thể đồng bộ vào tháng Demand đã hủy',
      );
    }
    if (status === 'CONFIRMED') return;

    await tx.customerDemandMonth.update({
      where: { id: monthId },
      data: {
        status: 'CONFIRMED',
        approvedAt: now,
        approvedBy: userId,
      },
    });
  }

  private mergeResolvedRows(rows: ResolvedLarkRow[]): PlannedLine[] {
    const buckets = new Map<string, GroupAccumulator>();

    for (const row of rows) {
      if (
        !row.customerId ||
        !row.productId ||
        !row.month ||
        !row.quantity ||
        !row.quantityBase
      ) {
        continue;
      }

      const key = this.demandKey(row.customerId, row.month, row.productId);
      let bucket = buckets.get(key);
      if (!bucket) {
        const line: PlannedLine = {
          customerId: row.customerId,
          customerName: row.customerName ?? `#${row.customerId}`,
          month: row.month,
          productId: row.productId,
          productName: row.productName ?? `#${row.productId}`,
          inputUnit: row.unit,
          inputQuantity: row.quantity,
          quantityBase: row.quantityBase,
          conversionValue: row.conversionValue,
          note: row.note,
          sourceRecordIds: [row.sourceRecordId],
          sourceModifiedAt: row.sourceModifiedAt,
          existingDemandId: null,
          existingMonthId: null,
          existingLineId: null,
          existingMonthStatus: null,
          syncDemandId: null,
          syncMonthId: null,
          syncMonthStatus: null,
          action: 'CREATE',
        };
        bucket = {
          line,
          baseQuantity: row.unit === 'BASE' ? row.quantity : 0,
          cartonQuantity: row.unit === 'CARTON' ? row.quantity : 0,
          units: new Set([row.unit]),
        };
        buckets.set(key, bucket);
        continue;
      }

      bucket.line.sourceRecordIds.push(row.sourceRecordId);
      bucket.line.quantityBase += row.quantityBase;
      bucket.units.add(row.unit);
      if (row.unit === 'BASE') {
        bucket.baseQuantity += row.quantity;
      } else {
        bucket.cartonQuantity += row.quantity;
      }
      if (
        row.sourceModifiedAt &&
        (!bucket.line.sourceModifiedAt ||
          row.sourceModifiedAt > bucket.line.sourceModifiedAt)
      ) {
        bucket.line.sourceModifiedAt = row.sourceModifiedAt;
      }
      if (!bucket.line.note && row.note) {
        bucket.line.note = row.note;
      }
    }

    for (const bucket of buckets.values()) {
      const units = [...bucket.units];
      if (units.length === 1 && units[0] === 'BASE') {
        bucket.line.inputUnit = 'BASE';
        bucket.line.inputQuantity = this.roundQuantity(bucket.baseQuantity);
        bucket.line.quantityBase = this.roundQuantity(bucket.baseQuantity);
        bucket.line.conversionValue = 1;
      } else if (units.length === 1) {
        bucket.line.inputUnit = 'CARTON';
        bucket.line.inputQuantity = this.roundQuantity(bucket.cartonQuantity);
        bucket.line.quantityBase = this.roundQuantity(bucket.line.quantityBase);
        // conversionValue đã lấy từ product ở resolveRecord().
      } else {
        bucket.line.inputUnit = 'BASE';
        bucket.line.inputQuantity = this.roundQuantity(
          bucket.line.quantityBase,
        );
        bucket.line.quantityBase = this.roundQuantity(bucket.line.quantityBase);
        bucket.line.conversionValue = 1;
      }
    }

    return [...buckets.values()].map((bucket) => bucket.line);
  }

  private resolveRecord(
    record: LarkRecordItem,
    indexes?: {
      customerByLark: Map<string, any>;
      customerByCode: Map<string, any>;
      productByLark: Map<string, any>;
      productByCode: Map<string, any>;
      linkedCustomerByRecordId?: Map<string, LinkedCustomerInfo>;
      linkedProductByRecordId?: Map<string, LinkedProductInfo>;
    },
  ): ResolvedLarkRow {
    const fields = record.fields ?? {};
    const recordId = record.record_id ?? '';
    const customerCodeRaw = this.fieldText(fields[TEXT_FIELDS.CUSTOMER_CODE]);
    const customerCodes = this.splitCodes(customerCodeRaw);
    const productCode = this.fieldText(fields[TEXT_FIELDS.PRODUCT_CODE]).trim();
    const customerLinkIds = this.linkRecordIds(
      fields[TEXT_FIELDS.CUSTOMER_LINK],
    );
    const productLinkIds = this.linkRecordIds(fields[TEXT_FIELDS.PRODUCT_LINK]);
    const month = this.normalizeMonth(
      this.fieldText(fields[TEXT_FIELDS.MONTH]),
    );
    const unit = this.normalizeUnit(this.fieldText(fields[TEXT_FIELDS.UNIT]));
    const quantity = this.numberValue(fields[TEXT_FIELDS.QUANTITY]);
    const quantityBaseFromLark = this.numberValue(
      fields[TEXT_FIELDS.QUANTITY_BASE],
    );
    const note = this.fieldText(fields[TEXT_FIELDS.NOTE]).trim() || null;
    const linkedCustomer = customerLinkIds
      .map((id) => indexes?.linkedCustomerByRecordId?.get(id))
      .find(Boolean);
    const linkedProduct = productLinkIds
      .map((id) => indexes?.linkedProductByRecordId?.get(id))
      .find(Boolean);
    const customerCodesForLookup = [
      linkedCustomer?.code,
      ...customerCodes,
    ].filter((code): code is string => !!code);

    const customer = indexes
      ? (customerLinkIds
          .map((id) => indexes.customerByLark.get(id))
          .find(Boolean) ??
        customerCodesForLookup
          .map((code) => indexes.customerByCode.get(code.toLowerCase()))
          .find(Boolean))
      : undefined;
    const productCodeForLookup =
      productCode || linkedProduct?.code?.trim() || '';
    const product = indexes
      ? (productLinkIds
          .map((id) => indexes.productByLark.get(id))
          .find(Boolean) ??
        (productCodeForLookup
          ? indexes.productByCode.get(productCodeForLookup.toLowerCase())
          : undefined))
      : undefined;

    const conversionValue = Number(product?.conversionValue ?? 1);
    let quantityBase =
      quantity == null
        ? null
        : unit === 'CARTON'
          ? quantity * conversionValue
          : quantity;
    if (
      quantity != null &&
      quantityBaseFromLark != null &&
      quantityBaseFromLark > 0 &&
      (quantityBase == null || !Number.isFinite(quantityBase))
    ) {
      quantityBase = quantityBaseFromLark;
    }
    if (quantityBase != null && Number.isFinite(quantityBase)) {
      quantityBase = this.roundQuantity(quantityBase);
    } else {
      quantityBase = null;
    }

    const row: ResolvedLarkRow = {
      sourceRecordId: recordId,
      sourceModifiedAt: this.modifiedDate(record.last_modified_time),
      rawFields: fields,
      customerCode: customerCodes[0] ?? linkedCustomer?.code ?? null,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? linkedCustomer?.name ?? null,
      productCode: productCode || linkedProduct?.code || null,
      productId: product?.id ?? null,
      productName: product?.name ?? linkedProduct?.name ?? null,
      month,
      unit,
      quantity,
      quantityBase,
      conversionValue,
      note,
      issue: null,
    };

    if (!customer) {
      row.issue = this.issueFor(
        row,
        'MISSING_CUSTOMER',
        `Không tìm thấy khách hàng ${customerCodesForLookup.join(', ') || '(trống mã)'} trong POS`,
      );
    } else if (!product) {
      row.issue = this.issueFor(
        row,
        'MISSING_PRODUCT',
        `Không tìm thấy sản phẩm ${productCodeForLookup || '(trống mã)'} trong POS`,
      );
    } else if (!month) {
      row.issue = this.issueFor(
        row,
        'MISSING_MONTH',
        'Record Lark thiếu tháng cần hàng hợp lệ',
      );
    } else if (quantity == null || quantity <= 0) {
      row.issue = this.issueFor(
        row,
        'MISSING_QUANTITY',
        'Record Lark thiếu số lượng hợp lệ',
      );
    } else if (
      unit === 'CARTON' &&
      (!conversionValue || conversionValue <= 0)
    ) {
      row.issue = this.issueFor(
        row,
        'MISSING_CONVERSION',
        `Sản phẩm ${product.code} thiếu quy đổi thùng`,
      );
    }

    return row;
  }

  private issueFor(
    row: ResolvedLarkRow,
    code: LarkDemandIssueCode,
    message: string,
  ): LarkDemandPreviewIssue {
    return {
      sourceRecordId: row.sourceRecordId,
      customerCode: row.customerCode,
      customerName: row.customerName,
      productCode: row.productCode,
      productName: row.productName,
      month: row.month,
      quantity: row.quantity,
      code,
      message,
    };
  }

  private conflictIssues(
    line: PlannedLine,
    message: string,
  ): LarkDemandPreviewIssue[] {
    return line.sourceRecordIds.map((sourceRecordId) => ({
      sourceRecordId,
      customerCode: null,
      customerName: line.customerName,
      productCode: null,
      productName: line.productName,
      month: line.month,
      quantity: line.inputQuantity,
      code: 'LINE_CONFLICT',
      message,
    }));
  }

  private async fetchAllRecords(tableId: string): Promise<LarkRecordItem[]> {
    const items: LarkRecordItem[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const res = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.baseToken, table_id: tableId },
        params: {
          page_size: PAGE_SIZE,
          automatic_fields: true,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (res.code && res.code !== 0) {
        throw new BadRequestException(
          `LarkBase trả lỗi ${res.code}: ${res.msg ?? 'không xác định'}`,
        );
      }

      items.push(...(res.data?.items ?? []));
      hasMore = !!res.data?.has_more;
      const nextPageToken = res.data?.page_token;
      if (hasMore && !nextPageToken) {
        throw new BadRequestException(
          'LarkBase báo còn dữ liệu nhưng không trả page_token',
        );
      }
      pageToken = nextPageToken;
    }

    return items;
  }

  private async fetchLinkedRecords(
    tableId: string,
    recordIds: string[],
  ): Promise<LarkRecordItem[]> {
    if (!recordIds.length) return [];

    const records: LarkRecordItem[] = [];
    for (let index = 0; index < recordIds.length; index += 100) {
      const chunk = recordIds.slice(index, index + 100);
      try {
        const res = await this.client.bitable.appTableRecord.batchGet({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { record_ids: chunk },
        });
        if (res.code && res.code !== 0) {
          this.logger.warn(
            `Không đọc được bảng liên kết ${tableId}: ${res.code} ${res.msg ?? ''}`,
          );
          continue;
        }
        records.push(...(res.data?.records ?? []));
      } catch (error) {
        this.logger.warn(
          `Không đọc được bảng liên kết ${tableId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return records;
  }

  private fieldText(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.fieldText(item)).join('|');
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.text !== undefined) return this.fieldText(obj.text);
      if (obj.value !== undefined) return this.fieldText(obj.value);
      if (obj.name !== undefined) return this.fieldText(obj.name);
      if (Array.isArray(obj.text_arr)) return this.fieldText(obj.text_arr);
    }
    return '';
  }

  private linkRecordIds(value: unknown): string[] {
    if (value == null) return [];
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.linkRecordIds(item));
    }
    if (typeof value !== 'object') return [];

    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.record_ids)) {
      return obj.record_ids.filter(
        (item): item is string => typeof item === 'string',
      );
    }
    if (typeof obj.record_id === 'string') return [obj.record_id];
    if (typeof obj.id === 'string') return [obj.id];
    return [];
  }

  private numberValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = this.fieldText(value).replace(/[\s,]/g, '');
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private splitCodes(value: string): string[] {
    return value
      .split(/[|,;/\r\n]+/)
      .map((item) => item.trim())
      .filter((item) => item && item !== '.');
  }

  private normalizeUnit(value: string): DemandUnit {
    const normalized = value.trim().toLowerCase();
    return ['thùng', 'thung', 'carton', 'crate'].includes(normalized)
      ? 'CARTON'
      : 'BASE';
  }

  private normalizeMonth(value: string): string | null {
    const text = value.trim();
    if (!text) return null;

    const direct = text.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (direct) return this.validMonth(direct[1], direct[2]);

    const withDay = text.match(/^(\d{4})[-/.](\d{1,2})[-/.]\d{1,2}/);
    if (withDay) return this.validMonth(withDay[1], withDay[2]);

    const compact = text.match(/^(\d{4})(\d{2})$/);
    if (compact) return this.validMonth(compact[1], compact[2]);

    return null;
  }

  private validMonth(year: string, monthValue: string) {
    const month = Number(monthValue);
    if (month < 1 || month > 12) return null;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  private modifiedDate(value?: number | string): Date | null {
    if (value == null) return null;
    const raw =
      typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private monthKeyOf(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().slice(0, 7);
  }

  private monthDate(value: string): Date {
    return new Date(`${value}-01T00:00:00.000Z`);
  }

  private demandKey(customerId: number, month: string, productId: number) {
    return `${customerId}|${month}|${productId}`;
  }

  private sameDemandKey(line: DemandLineInfo, group: PlannedLine) {
    return (
      line.customerId === group.customerId &&
      line.monthKey === group.month &&
      line.productId === group.productId
    );
  }

  private syncKeyFor(customerId: number): string {
    return `lark:${customerId}`;
  }

  private roundQuantity(value: number): number {
    return Number(value.toFixed(4));
  }

  private jsonSafe(value: unknown) {
    try {
      return JSON.parse(JSON.stringify(value ?? {}));
    } catch {
      return {};
    }
  }
}
