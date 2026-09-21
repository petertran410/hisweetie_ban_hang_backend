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
 * - Mỗi record Lark tương ứng một dòng POS, kể cả record trùng SKU/tháng.
 * - Một phiếu POS tương ứng một khách hàng và một tháng.
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
  CREATED_AT: 'Ngày Tạo',
  UPDATED_AT: 'Ngày Cập Nhật',
} as const;

const DEFAULT_BASE_TOKEN = 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
const DEFAULT_TABLE_ID = 'tblWBeLHcMlYu8Gr';
const DEFAULT_CUSTOMER_TABLE_ID = 'tbl59MvUCIZY0ckZ';
const DEFAULT_PRODUCT_TABLE_ID = 'tbldKbrNjFkqdzao';

const PAGE_SIZE = 500;
const MAX_PREVIEW_ISSUES = 200;
const SYNC_SOURCE = 'LARK';
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
  | 'MISSING_SOURCE_TIMESTAMP'
  | 'LEGACY_MERGED_VOUCHER'
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
  invalidTimestampRecords: number;
  conflictedRecords: number;
  mergedRecords: number;
  aggregatedRows: number;
  newLines: number;
  updatedLines: number;
  demandsToCreate: number;
  monthsToCreate: number;
  sourceDatesToRestore: number;
  legacyMergedRecords: number;
  legacyMergedLines: number;
  legacyVouchers: number;
  legacyVoucherRecords: number;
  issues: LarkDemandPreviewIssue[];
  truncatedIssues: boolean;
}

export interface LarkDemandSyncResult extends LarkDemandPreviewSummary {
  syncedDemands: number;
  syncedLines: number;
  syncedRecords: number;
  unmappedRecords: number;
  orphanedRecords: number;
  syncedAt: string;
}

interface LarkRecordItem {
  record_id?: string;
  fields?: Record<string, any>;
  created_time?: number | string;
  last_modified_time?: number | string;
}

interface ResolvedLarkRow {
  sourceRecordId: string;
  sourceCreatedAt: Date | null;
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
  sourceSystem: string | null;
  monthId: number;
  monthKey: string;
  customerId: number;
  productId: number;
  inputQuantity: number;
  inputUnit: DemandUnit;
  quantityBase: number;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
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
  sourceCreatedAt: Date;
  sourceModifiedAt: Date;
  existingDemandId: number | null;
  existingDemandSourceSystem: string | null;
  existingMonthId: number | null;
  existingLineId: number | null;
  existingMonthStatus: string | null;
  syncDemandId: number | null;
  syncMonthId: number | null;
  syncMonthStatus: string | null;
  action: PlannedAction;
}

interface LoadedPlan {
  summary: LarkDemandPreviewSummary;
  groups: PlannedLine[];
  rawRows: ResolvedLarkRow[];
  rawById: Map<string, ResolvedLarkRow>;
  issues: LarkDemandPreviewIssue[];
}

interface LoadedRawRows {
  rawRows: ResolvedLarkRow[];
  rawById: Map<string, ResolvedLarkRow>;
  issues: LarkDemandPreviewIssue[];
}

export interface LarkDemandVoucherSplitIssue {
  demandId: number;
  demandMonthId: number | null;
  sourceRecordIds: string[];
  customerName: string | null;
  month: string | null;
  lineCount: number;
  message: string;
}

export interface LarkDemandVoucherSplitPreview {
  totalMappedRecords: number;
  totalLarkVouchers: number;
  vouchersToSplit: number;
  vouchersToCreate: number;
  linesToMove: number;
  readyVouchers: number;
  conflictedVouchers: number;
  quantityBaseBefore: number;
  quantityBaseAfter: number;
  issues: LarkDemandVoucherSplitIssue[];
}

export interface LarkDemandVoucherSplitResult extends LarkDemandVoucherSplitPreview {
  vouchersSplit: number;
  vouchersCreated: number;
  linesMoved: number;
  splitAt: string;
}

interface VoucherSplitRow {
  lineId: number;
  sourceRecordId: string;
  sourceCreatedAt: Date;
  sourceModifiedAt: Date;
  quantityBase: number;
}

interface VoucherSplitPlanItem {
  demandId: number;
  demandMonthId: number;
  customerId: number;
  customerName: string | null;
  month: string;
  createdBy: number;
  updatedBy: number | null;
  demandNote: string | null;
  monthStatus: string;
  monthNote: string | null;
  approvedAt: Date | null;
  approvedBy: number | null;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  rows: VoucherSplitRow[];
  quantityBase: number;
}

interface VoucherSplitPlan {
  preview: LarkDemandVoucherSplitPreview;
  ready: VoucherSplitPlanItem[];
  legacySourceRecordIds: Set<string>;
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
    if (plan.summary.legacyVouchers > 0) {
      throw new BadRequestException(
        'Còn phiếu Lark cũ chứa nhiều record; hãy tách phiếu cũ trước khi đồng bộ',
      );
    }

    const now = new Date();
    const persisted = await this.persistPlan(plan, userId, now);

    await this.auditLogs.create({
      actionType: 'UPDATE',
      actionCode: 'CUSTOMER_DEMAND_SYNC_LARK',
      entityType: 'CUSTOMER_DEMAND',
      entityId: 'lark-sync',
      message: `Đã đồng bộ ${persisted.syncedDemands} phiếu Demand từ LarkBase`,
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
      syncedDemands: persisted.syncedDemands,
      syncedLines: persisted.syncedLines,
      syncedRecords: persisted.syncedRecords,
      unmappedRecords: plan.summary.pendingRecords,
      orphanedRecords: persisted.orphanedRecords,
      syncedAt: now.toISOString(),
    };

    this.logger.log(
      `Lark demand sync done: ${persisted.syncedRecords}/${plan.summary.totalRecords} records, ${persisted.syncedDemands} POS demands`,
    );
    return result;
  }

  async previewVoucherSplit(): Promise<LarkDemandVoucherSplitPreview> {
    return (await this.loadVoucherSplitPlan()).preview;
  }

  async splitLegacyVouchers(
    userId: number,
  ): Promise<LarkDemandVoucherSplitResult> {
    const plan = await this.loadVoucherSplitPlan();
    const now = new Date();
    if (!plan.ready.length) {
      return {
        ...plan.preview,
        vouchersSplit: 0,
        vouchersCreated: 0,
        linesMoved: 0,
        splitAt: now.toISOString(),
      };
    }

    const persisted = await this.persistVoucherSplit(plan, now);
    await this.auditLogs.create({
      actionType: 'UPDATE',
      actionCode: 'CUSTOMER_DEMAND_SPLIT_LARK_VOUCHERS',
      entityType: 'CUSTOMER_DEMAND',
      entityId: 'lark-voucher-split',
      message: `Đã tách ${persisted.vouchersSplit} phiếu Lark thành ${persisted.vouchersCreated} phiếu riêng`,
      userId,
      userName: 'System',
      snapshot: {
        ...plan.preview,
        ...persisted,
      },
    });

    return {
      ...plan.preview,
      ...persisted,
      splitAt: now.toISOString(),
    };
  }

  // Kept for clients that were deployed before the voucher-split endpoints.
  async previewBackfill(): Promise<LarkDemandVoucherSplitPreview> {
    return this.previewVoucherSplit();
  }

  async backfill(userId: number): Promise<LarkDemandVoucherSplitResult> {
    return this.splitLegacyVouchers(userId);
  }

  private async loadVoucherSplitPlan(): Promise<VoucherSplitPlan> {
    const demands = await this.prisma.customerDemand.findMany({
      where: { sourceSystem: SYNC_SOURCE },
      select: {
        id: true,
        customerId: true,
        createdBy: true,
        updatedBy: true,
        note: true,
        customer: { select: { name: true } },
        months: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            demandMonth: true,
            status: true,
            note: true,
            approvedAt: true,
            approvedBy: true,
            cancelledAt: true,
            cancelledBy: true,
            changeLogs: { select: { id: true } },
            lines: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                quantityBase: true,
                larkRecords: {
                  orderBy: { sourceRecordId: 'asc' },
                  select: {
                    sourceRecordId: true,
                    sourceCreatedAt: true,
                    sourceModifiedAt: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const totalMappedRecords = demands.reduce(
      (sum, demand) =>
        sum +
        demand.months.reduce(
          (monthSum, month) =>
            monthSum +
            month.lines.reduce(
              (lineSum, line) => lineSum + line.larkRecords.length,
              0,
            ),
          0,
        ),
      0,
    );
    const issues: LarkDemandVoucherSplitIssue[] = [];
    const ready: VoucherSplitPlanItem[] = [];
    const legacySourceRecordIds = new Set<string>();
    let vouchersToSplit = 0;
    let vouchersToCreate = 0;
    let linesToMove = 0;
    let quantityBaseBefore = 0;
    let quantityBaseAfter = 0;

    for (const demand of demands) {
      const mappedLines = demand.months.flatMap((month) =>
        month.lines.filter((line) => line.larkRecords.length > 0),
      );
      if (mappedLines.length <= 1) continue;

      vouchersToSplit += 1;
      const sourceRecordIds = mappedLines.flatMap((line) =>
        line.larkRecords.map((record) => record.sourceRecordId),
      );
      sourceRecordIds.forEach((id) => legacySourceRecordIds.add(id));
      const month = demand.months[0];
      const monthKey = month ? this.monthKeyOf(month.demandMonth) : null;
      const issue = (message: string) =>
        issues.push({
          demandId: demand.id,
          demandMonthId: month?.id ?? null,
          sourceRecordIds,
          customerName: demand.customer.name,
          month: monthKey,
          lineCount: mappedLines.length,
          message,
        });

      if (demand.months.length !== 1 || !month || !monthKey) {
        issue('Phiếu Lark cũ có nhiều tháng, cần xử lý thủ công');
        continue;
      }
      if (month.status !== 'CONFIRMED') {
        issue('Tháng Demand Lark không ở trạng thái Hoàn thành');
        continue;
      }
      if (month.changeLogs.length > 0) {
        issue('Tháng Demand đã có lịch sử chỉnh sửa, cần xử lý thủ công');
        continue;
      }
      if (
        month.lines.length !== mappedLines.length ||
        mappedLines.some((line) => line.larkRecords.length !== 1)
      ) {
        issue(
          'Phiếu Lark không có đúng một mapping cho mỗi dòng Demand, không thể tách an toàn',
        );
        continue;
      }

      const rows: VoucherSplitRow[] = [];
      for (const line of mappedLines) {
        const record = line.larkRecords[0];
        if (
          record.status !== 'SYNCED' ||
          !record.sourceCreatedAt ||
          !record.sourceModifiedAt ||
          record.sourceModifiedAt < record.sourceCreatedAt
        ) {
          issue('Có record Lark thiếu ngày nguồn hợp lệ hoặc chưa đồng bộ');
          rows.length = 0;
          break;
        }
        rows.push({
          lineId: line.id,
          sourceRecordId: record.sourceRecordId,
          sourceCreatedAt: record.sourceCreatedAt,
          sourceModifiedAt: record.sourceModifiedAt,
          quantityBase: Number(line.quantityBase),
        });
      }
      if (!rows.length) continue;

      const quantityBase = rows.reduce((sum, row) => sum + row.quantityBase, 0);
      ready.push({
        demandId: demand.id,
        demandMonthId: month.id,
        customerId: demand.customerId,
        customerName: demand.customer.name,
        month: monthKey,
        createdBy: demand.createdBy,
        updatedBy: demand.updatedBy,
        demandNote: demand.note,
        monthStatus: month.status,
        monthNote: month.note,
        approvedAt: month.approvedAt,
        approvedBy: month.approvedBy,
        cancelledAt: month.cancelledAt,
        cancelledBy: month.cancelledBy,
        rows,
        quantityBase,
      });
      vouchersToCreate += rows.length - 1;
      linesToMove += rows.length - 1;
      quantityBaseBefore += quantityBase;
      quantityBaseAfter += quantityBase;
    }

    return {
      preview: {
        totalMappedRecords,
        totalLarkVouchers: demands.length,
        vouchersToSplit,
        vouchersToCreate,
        linesToMove,
        readyVouchers: ready.length,
        conflictedVouchers: vouchersToSplit - ready.length,
        quantityBaseBefore: this.roundQuantity(quantityBaseBefore),
        quantityBaseAfter: this.roundQuantity(quantityBaseAfter),
        issues: issues.slice(0, MAX_PREVIEW_ISSUES),
      },
      ready,
      legacySourceRecordIds,
    };
  }

  private async persistVoucherSplit(plan: VoucherSplitPlan, now: Date) {
    let vouchersSplit = 0;
    let vouchersCreated = 0;
    let linesMoved = 0;

    for (const item of plan.ready) {
      const persisted = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.customerDemand.findUnique({
            where: { id: item.demandId },
            select: {
              id: true,
              customerId: true,
              sourceSystem: true,
              createdBy: true,
              updatedBy: true,
              months: {
                select: {
                  id: true,
                  demandMonth: true,
                  status: true,
                  changeLogs: { select: { id: true } },
                  lines: {
                    select: {
                      id: true,
                      larkRecords: {
                        select: {
                          sourceRecordId: true,
                          sourceCreatedAt: true,
                          sourceModifiedAt: true,
                          status: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          });
          const currentMonth = current?.months[0];
          const currentRows = currentMonth?.lines.flatMap((line) =>
            line.larkRecords.map((record) => ({
              lineId: line.id,
              ...record,
            })),
          );
          const expectedByRecord = new Map(
            item.rows.map((row) => [row.sourceRecordId, row]),
          );
          const validCurrentState =
            current &&
            current.sourceSystem === SYNC_SOURCE &&
            current.customerId === item.customerId &&
            current.createdBy === item.createdBy &&
            current.updatedBy === item.updatedBy &&
            current.months.length === 1 &&
            currentMonth &&
            currentMonth.id === item.demandMonthId &&
            currentMonth.status === item.monthStatus &&
            currentMonth.changeLogs.length === 0 &&
            currentRows?.length === item.rows.length &&
            currentRows.every((row) => {
              const expected = expectedByRecord.get(row.sourceRecordId);
              return (
                !!expected &&
                row.lineId === expected.lineId &&
                row.status === 'SYNCED' &&
                !!row.sourceCreatedAt &&
                !!row.sourceModifiedAt &&
                row.sourceCreatedAt.getTime() ===
                  expected.sourceCreatedAt.getTime() &&
                row.sourceModifiedAt.getTime() ===
                  expected.sourceModifiedAt.getTime()
              );
            });
          if (!validCurrentState || !currentMonth || !currentRows) {
            throw new BadRequestException(
              `Phiếu Demand #${item.demandId} đã thay đổi; hãy kiểm tra lại trước khi tách`,
            );
          }

          const [retained, ...rowsToMove] = item.rows;
          await tx.customerDemand.update({
            where: { id: item.demandId },
            data: {
              syncKey: this.syncKeyFor(retained.sourceRecordId),
              createdAt: retained.sourceCreatedAt,
              updatedAt: retained.sourceModifiedAt,
            },
          });
          await tx.customerDemandMonth.update({
            where: { id: item.demandMonthId },
            data: {
              createdAt: retained.sourceCreatedAt,
              updatedAt: retained.sourceModifiedAt,
            },
          });
          await tx.customerDemandLine.update({
            where: { id: retained.lineId },
            data: {
              sourceCreatedAt: retained.sourceCreatedAt,
              sourceUpdatedAt: retained.sourceModifiedAt,
              createdAt: retained.sourceCreatedAt,
              updatedAt: retained.sourceModifiedAt,
            },
          });
          await tx.customerDemandLarkRecord.update({
            where: { sourceRecordId: retained.sourceRecordId },
            data: {
              status: 'SYNCED',
              demandLineId: retained.lineId,
              errorMessage: null,
              lastSyncedAt: now,
            },
          });

          for (const row of rowsToMove) {
            const createdDemand = await tx.customerDemand.create({
              data: {
                customerId: item.customerId,
                note: item.demandNote,
                sourceSystem: SYNC_SOURCE,
                syncKey: this.syncKeyFor(row.sourceRecordId),
                createdBy: item.createdBy,
                updatedBy: item.updatedBy,
                createdAt: row.sourceCreatedAt,
                updatedAt: row.sourceModifiedAt,
              },
              select: { id: true },
            });
            const createdMonth = await tx.customerDemandMonth.create({
              data: {
                demandId: createdDemand.id,
                demandMonth: this.monthDate(item.month),
                status: item.monthStatus,
                note: item.monthNote,
                approvedAt: item.approvedAt,
                approvedBy: item.approvedBy,
                cancelledAt: item.cancelledAt,
                cancelledBy: item.cancelledBy,
                createdAt: row.sourceCreatedAt,
                updatedAt: row.sourceModifiedAt,
              },
              select: { id: true },
            });
            await tx.customerDemandLine.update({
              where: { id: row.lineId },
              data: {
                demandMonthId: createdMonth.id,
                sourceCreatedAt: row.sourceCreatedAt,
                sourceUpdatedAt: row.sourceModifiedAt,
                createdAt: row.sourceCreatedAt,
                updatedAt: row.sourceModifiedAt,
              },
            });
            await tx.customerDemandLarkRecord.update({
              where: { sourceRecordId: row.sourceRecordId },
              data: {
                status: 'SYNCED',
                demandLineId: row.lineId,
                errorMessage: null,
                lastSyncedAt: now,
              },
            });
          }

          return {
            vouchersCreated: rowsToMove.length,
            linesMoved: rowsToMove.length,
          };
        },
        { timeout: 120_000 },
      );
      vouchersSplit += 1;
      vouchersCreated += persisted.vouchersCreated;
      linesMoved += persisted.linesMoved;
    }

    return { vouchersSplit, vouchersCreated, linesMoved };
  }

  private async loadRawRows(): Promise<LoadedRawRows> {
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
    const [customers, products] = await Promise.all([
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

    return {
      rawRows: resolvedRows,
      rawById: resolvedById,
      issues: resolvedRows
        .map((row) => row.issue)
        .filter((issue): issue is LarkDemandPreviewIssue => !!issue),
    };
  }

  private async loadPlan(): Promise<LoadedPlan> {
    const raw = await this.loadRawRows();
    const sourceRecordIds = raw.rawRows
      .map((row) => row.sourceRecordId)
      .filter(Boolean);
    const [demandMonths, mappings, voucherSplitPlan] = await Promise.all([
      this.prisma.customerDemandMonth.findMany({
        select: {
          id: true,
          demandId: true,
          demandMonth: true,
          status: true,
          lines: {
            select: {
              id: true,
              productId: true,
              inputQuantity: true,
              inputUnit: true,
              quantityBase: true,
              sourceCreatedAt: true,
              sourceUpdatedAt: true,
            },
          },
          demand: { select: { customerId: true, sourceSystem: true } },
        },
      }),
      sourceRecordIds.length
        ? this.prisma.customerDemandLarkRecord.findMany({
            where: { sourceRecordId: { in: sourceRecordIds } },
            select: { sourceRecordId: true, demandLineId: true },
          })
        : Promise.resolve([]),
      this.loadVoucherSplitPlan(),
    ]);

    const lineById = new Map<number, DemandLineInfo>();
    for (const month of demandMonths) {
      const monthKey = this.monthKeyOf(month.demandMonth);
      for (const line of month.lines) {
        const info: DemandLineInfo = {
          id: line.id,
          demandId: month.demandId,
          sourceSystem: month.demand.sourceSystem,
          monthId: month.id,
          monthKey,
          customerId: month.demand.customerId,
          productId: line.productId,
          inputQuantity: Number(line.inputQuantity),
          inputUnit: line.inputUnit as DemandUnit,
          quantityBase: Number(line.quantityBase),
          sourceCreatedAt: line.sourceCreatedAt,
          sourceUpdatedAt: line.sourceUpdatedAt,
          status: month.status,
        };
        lineById.set(line.id, info);
      }
    }

    const mappingByRecord = new Map<string, number | null>(
      mappings.map(
        (item) =>
          [item.sourceRecordId, item.demandLineId] as [string, number | null],
      ),
    );
    const legacyRecordIds = voucherSplitPlan.legacySourceRecordIds;
    const issues: LarkDemandPreviewIssue[] = [
      ...raw.issues,
      ...raw.rawRows
        .filter((row) => legacyRecordIds.has(row.sourceRecordId))
        .map((row) => ({
          sourceRecordId: row.sourceRecordId,
          customerCode: row.customerCode,
          customerName: row.customerName,
          productCode: row.productCode,
          productName: row.productName,
          month: row.month,
          quantity: row.quantity,
          code: 'LEGACY_MERGED_VOUCHER' as const,
          message:
            'Phiếu POS Lark cũ đang gộp nhiều record; cần tách phiếu trước khi đồng bộ',
        })),
    ];
    const validRows = raw.rawRows.filter(
      (row) => !row.issue && !legacyRecordIds.has(row.sourceRecordId),
    );
    const plannedLines = this.planResolvedRows(validRows);
    const groups: PlannedLine[] = [];

    for (const line of plannedLines) {
      const mappedLineId = mappingByRecord.get(line.sourceRecordIds[0]);
      if (typeof mappedLineId === 'number') {
        const mapped = lineById.get(mappedLineId);
        if (!mapped) {
          issues.push(
            ...this.conflictIssues(
              line,
              'Mapping cũ trỏ tới dòng POS không còn tồn tại; cần kiểm tra dữ liệu',
            ),
          );
          continue;
        }
        if (mapped.sourceSystem !== SYNC_SOURCE) {
          issues.push(
            ...this.conflictIssues(
              line,
              'Mapping Lark đang trỏ tới phiếu POS thủ công; cần xử lý thủ công trước khi đồng bộ',
            ),
          );
          continue;
        }
        if (!this.sameDemandKey(mapped, line)) {
          issues.push(
            ...this.conflictIssues(
              line,
              'Mapping cũ không còn khớp khách hàng, tháng và sản phẩm của record Lark',
            ),
          );
          continue;
        }
        if (mapped.status === 'CANCELLED') {
          issues.push(
            ...this.conflictIssues(
              line,
              'Dòng POS tương ứng thuộc tháng đã hủy; cần xử lý thủ công trước khi đồng bộ',
            ),
          );
          continue;
        }

        line.existingDemandId = mapped.demandId;
        line.existingDemandSourceSystem = mapped.sourceSystem;
        line.existingMonthId = mapped.monthId;
        line.existingLineId = mapped.id;
        line.existingMonthStatus = mapped.status;
        line.action = 'UPDATE';
        groups.push(line);
        continue;
      }

      line.action = 'CREATE';
      groups.push(line);
    }

    const validRecords = groups.reduce(
      (sum, group) => sum + group.sourceRecordIds.length,
      0,
    );
    const conflicts = issues.filter((issue) => issue.code === 'LINE_CONFLICT');
    const pending = issues.filter(
      (issue) =>
        issue.code !== 'LINE_CONFLICT' &&
        issue.code !== 'LEGACY_MERGED_VOUCHER' &&
        issue.code !== 'MISSING_SOURCE_TIMESTAMP',
    );
    const newRecords = groups.filter((group) => group.action === 'CREATE');

    const summary: LarkDemandPreviewSummary = {
      totalRecords: raw.rawRows.length,
      validRecords,
      pendingRecords: pending.length,
      invalidTimestampRecords: issues.filter(
        (issue) => issue.code === 'MISSING_SOURCE_TIMESTAMP',
      ).length,
      conflictedRecords: conflicts.length,
      mergedRecords: 0,
      aggregatedRows: groups.length,
      newLines: newRecords.length,
      updatedLines: groups.filter((group) => group.action === 'UPDATE').length,
      demandsToCreate: newRecords.length,
      monthsToCreate: newRecords.length,
      sourceDatesToRestore: groups.filter(
        (group) =>
          group.existingLineId &&
          (!lineById.get(group.existingLineId)?.sourceCreatedAt ||
            !lineById.get(group.existingLineId)?.sourceUpdatedAt),
      ).length,
      legacyMergedRecords: legacyRecordIds.size,
      legacyMergedLines: voucherSplitPlan.preview.vouchersToSplit,
      legacyVouchers: voucherSplitPlan.preview.vouchersToSplit,
      legacyVoucherRecords: legacyRecordIds.size,
      issues: issues.slice(0, MAX_PREVIEW_ISSUES),
      truncatedIssues: issues.length > MAX_PREVIEW_ISSUES,
    };

    return {
      summary,
      groups,
      rawRows: raw.rawRows,
      rawById: raw.rawById,
      issues,
    };
  }

  private async persistPlan(plan: LoadedPlan, userId: number, now: Date) {
    const demandCache = new Map<string, number>();
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
            sourceCreatedAt: group.sourceCreatedAt,
            sourceUpdatedAt: group.sourceModifiedAt,
          };

          let lineId: number;
          if (group.existingLineId && group.existingMonthId) {
            await this.ensureConfirmedMonth(
              tx,
              group.existingMonthId,
              group.existingMonthStatus,
            );
            const updated = await tx.customerDemandLine.update({
              where: { id: group.existingLineId },
              data: {
                ...lineData,
                createdAt: group.sourceCreatedAt,
                updatedAt: group.sourceModifiedAt,
              },
            });
            lineId = updated.id;
            await this.applyLarkVoucherSourceDates(
              tx,
              group.existingDemandId as number,
              group.existingMonthId,
              group,
              userId,
            );
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
            const created = await tx.customerDemandLine.create({
              data: {
                demandMonthId: month.id,
                productId: group.productId,
                ...lineData,
                createdAt: group.sourceCreatedAt,
                updatedAt: group.sourceModifiedAt,
              },
            });
            lineId = created.id;
          }

          for (const sourceRecordId of group.sourceRecordIds) {
            const raw = plan.rawById.get(sourceRecordId);
            await tx.customerDemandLarkRecord.upsert({
              where: { sourceRecordId },
              create: {
                sourceRecordId,
                sourceCreatedAt: raw?.sourceCreatedAt ?? null,
                sourceModifiedAt: raw?.sourceModifiedAt ?? null,
                rawFields: this.jsonSafe(raw?.rawFields ?? {}),
                status: 'SYNCED',
                customerId: group.customerId,
                productId: group.productId,
                demandLineId: lineId,
                lastSyncedAt: now,
              },
              update: {
                sourceCreatedAt: raw?.sourceCreatedAt ?? null,
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
            issue.code === 'LINE_CONFLICT' ||
            issue.code === 'MISSING_SOURCE_TIMESTAMP'
              ? 'ERROR'
              : 'PENDING_MAPPING';
          await tx.customerDemandLarkRecord.upsert({
            where: { sourceRecordId: issue.sourceRecordId },
            create: {
              sourceRecordId: issue.sourceRecordId,
              sourceCreatedAt: raw?.sourceCreatedAt ?? null,
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
              ...(raw?.sourceCreatedAt
                ? { sourceCreatedAt: raw.sourceCreatedAt }
                : {}),
              ...(raw?.sourceModifiedAt
                ? { sourceModifiedAt: raw.sourceModifiedAt }
                : {}),
              rawFields: this.jsonSafe(raw?.rawFields ?? {}),
              status,
              customerId: raw?.customerId ?? null,
              productId: raw?.productId ?? null,
              ...(issue.code === 'MISSING_SOURCE_TIMESTAMP'
                ? {}
                : { demandLineId: null }),
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
      syncedDemands: plan.groups.length,
      syncedLines,
      syncedRecords,
      orphanedRecords: orphaned.count,
    };
  }

  private async ensureSyncDemand(
    tx: any,
    group: PlannedLine,
    userId: number,
    cache: Map<string, number>,
  ) {
    const syncKey = this.syncKeyFor(group.sourceRecordIds[0]);
    const cacheKey = syncKey;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let demand = await tx.customerDemand.findFirst({
      where: { sourceSystem: SYNC_SOURCE, syncKey },
      select: { id: true },
    });
    if (!demand) {
      demand = await tx.customerDemand.create({
        data: {
          customerId: group.customerId,
          sourceSystem: SYNC_SOURCE,
          syncKey,
          createdBy: userId,
          updatedBy: userId,
          createdAt: group.sourceCreatedAt,
          updatedAt: group.sourceModifiedAt,
        },
        select: { id: true },
      });
    } else {
      await tx.customerDemand.update({
        where: { id: demand.id },
        data: {
          updatedBy: userId,
          createdAt: group.sourceCreatedAt,
          updatedAt: group.sourceModifiedAt,
        },
      });
    }

    cache.set(cacheKey, demand.id);
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
          createdAt: group.sourceCreatedAt,
          updatedAt: group.sourceModifiedAt,
        },
        select: { id: true, status: true },
      });
    } else {
      await this.ensureConfirmedMonth(tx, month.id, month.status);
      await tx.customerDemandMonth.update({
        where: { id: month.id },
        data: {
          createdAt: group.sourceCreatedAt,
          updatedAt: group.sourceModifiedAt,
        },
      });
    }

    cache.set(cacheKey, month);
    return month as { id: number; status: string };
  }

  private async applyLarkVoucherSourceDates(
    tx: any,
    demandId: number,
    demandMonthId: number,
    group: PlannedLine,
    userId: number,
  ) {
    await tx.customerDemand.update({
      where: { id: demandId },
      data: {
        syncKey: this.syncKeyFor(group.sourceRecordIds[0]),
        updatedBy: userId,
        createdAt: group.sourceCreatedAt,
        updatedAt: group.sourceModifiedAt,
      },
    });
    await tx.customerDemandMonth.update({
      where: { id: demandMonthId },
      data: {
        createdAt: group.sourceCreatedAt,
        updatedAt: group.sourceModifiedAt,
      },
    });
  }

  private async ensureConfirmedMonth(
    tx: any,
    monthId: number,
    status: string | null,
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
      },
    });
  }

  private planResolvedRows(rows: ResolvedLarkRow[]): PlannedLine[] {
    return rows
      .filter(
        (
          row,
        ): row is ResolvedLarkRow & {
          customerId: number;
          productId: number;
          month: string;
          quantity: number;
          quantityBase: number;
          sourceCreatedAt: Date;
          sourceModifiedAt: Date;
        } =>
          !!row.customerId &&
          !!row.productId &&
          !!row.month &&
          !!row.quantity &&
          !!row.quantityBase &&
          !!row.sourceCreatedAt &&
          !!row.sourceModifiedAt,
      )
      .map((row) => ({
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
        sourceCreatedAt: row.sourceCreatedAt,
        sourceModifiedAt: row.sourceModifiedAt,
        existingDemandId: null,
        existingDemandSourceSystem: null,
        existingMonthId: null,
        existingLineId: null,
        existingMonthStatus: null,
        syncDemandId: null,
        syncMonthId: null,
        syncMonthStatus: null,
        action: 'CREATE',
      }));
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
      sourceCreatedAt:
        this.sourceDate(record.created_time) ??
        this.sourceDate(fields[TEXT_FIELDS.CREATED_AT]),
      sourceModifiedAt:
        this.sourceDate(record.last_modified_time) ??
        this.sourceDate(fields[TEXT_FIELDS.UPDATED_AT]),
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
    } else if (
      !row.sourceCreatedAt ||
      !row.sourceModifiedAt ||
      row.sourceModifiedAt < row.sourceCreatedAt
    ) {
      row.issue = this.issueFor(
        row,
        'MISSING_SOURCE_TIMESTAMP',
        'Record Lark thiếu Ngày Tạo/Ngày Cập Nhật hợp lệ',
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

  private sourceDate(value: unknown): Date | null {
    if (value == null) return null;
    const text = this.fieldText(value).trim();
    if (!text) return null;
    const raw = Number(text);
    const localDate = text.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
    const zonedText = localDate
      ? `${localDate[1]}-${localDate[2].padStart(2, '0')}-${localDate[3].padStart(2, '0')}T${localDate[4].padStart(2, '0')}:${localDate[5]}:${localDate[6] ?? '00'}+07:00`
      : text;
    const date =
      Number.isFinite(raw) && raw > 0
        ? new Date(raw < 10_000_000_000 ? raw * 1000 : raw)
        : new Date(zonedText);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private monthKeyOf(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().slice(0, 7);
  }

  private monthDate(value: string): Date {
    return new Date(`${value}-01T00:00:00.000Z`);
  }

  private sameDemandKey(line: DemandLineInfo, group: PlannedLine) {
    return (
      line.customerId === group.customerId &&
      line.monthKey === group.month &&
      line.productId === group.productId
    );
  }

  private syncKeyFor(sourceRecordId: string): string {
    return `lark:${sourceRecordId}`;
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
