import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { APPROVAL_DEFINITIONS } from '../approval-lifecycle/approval-lifecycle.constants';
import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_EVIDENCE_STATUS,
  INTERNAL_FINANCE_BRANCH_CODES,
  INTERNAL_FINANCE_REVIEW_DECISION,
  INTERNAL_FINANCE_REVIEW_ROLE,
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
} from './internal-finance.constants';
import { InternalFinanceCodeService } from './internal-finance-code.service';
import {
  LARK_IMPORT_SOURCES,
  LARK_APPROVAL_TABLE_FALLBACKS,
  LARK_VEHICLE_BASE_FALLBACK,
  PROTECTED_IMPORT_STATUSES,
  type LarkImportSource,
  type LarkPersonRef,
  type LarkTableRef,
  type MappedLarkEntry,
  defaultBranchForSource,
  mapLarkRecord,
  requiredFieldError,
  readLarkDate,
  readLarkAlias,
  readLarkNumber,
  readLarkPersonAlias,
  readLarkText,
  selectTablesForSource,
} from './internal-finance-lark-import.mapper';
import {
  LarkFinanceImportClient,
  type LarkImportRecord,
  type LarkRecordPageInfo,
} from './lark-finance-import.client';

export interface LarkImportTableResult {
  source: LarkImportSource;
  baseToken: string | null;
  tableId: string | null;
  tableName: string | null;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  attachmentsDownloaded: number;
  attachmentsFailed: number;
  unmatchedInvoices: string[];
  error?: string;
  sampleErrors: string[];
}

export interface LarkFinanceImportResult {
  dryRun: boolean;
  tables: LarkImportTableResult[];
}

const FINANCE_SOURCES = new Set<LarkImportSource>([
  'EXPENSE_HN',
  'EXPENSE_SG',
  'EXPENSE_VP',
  'RECEIPT',
  'SALARY_ADVANCE',
  'APPROVAL_HN',
  'APPROVAL_SG',
  'APPROVAL_VP',
]);

type ResolvedLarkUsers = {
  creatorId?: number;
  accountantId?: number;
  managerId?: number;
  creatorName?: string;
  accountantName?: string;
  managerName?: string;
};

@Injectable()
export class InternalFinanceLarkImportService {
  private readonly logger = new Logger(InternalFinanceLarkImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly uploadService: UploadService,
    private readonly lark: LarkFinanceImportClient,
    private readonly codeService: InternalFinanceCodeService,
  ) {}

  async importHistory(
    dto: { dryRun?: boolean; sources?: string[] },
    userId: number,
  ): Promise<LarkFinanceImportResult> {
    if (!userId) throw new BadRequestException('Thiếu người thực hiện import');
    const dryRun = dto.dryRun !== false;
    const sources = this.resolveSources(dto.sources);
    const mode = dryRun ? 'DRY_RUN' : 'COMMIT';
    const startedAt = Date.now();
    this.logger.log(
      `[LARK_IMPORT] start mode=${mode} userId=${userId} sources=${sources.join(',')}`,
    );
    const financeBase =
      this.config.get<string>('LARK_EXPENSE_BASE_TOKEN') || null;
    const vehicleBase =
      this.config.get<string>('LARK_VEHICLE_BASE_TOKEN') ||
      LARK_VEHICLE_BASE_FALLBACK;
    const token = await this.lark.getToken();
    const financeTables = financeBase
      ? await this.safeListTables(financeBase, token)
      : { tables: [], error: 'LARK_EXPENSE_BASE_TOKEN chưa được cấu hình' };
    const vehicleTables = await this.safeListTables(vehicleBase, token);
    this.logger.log(
      `[LARK_IMPORT] bases ready financeTables=${financeTables.tables.length} vehicleTables=${vehicleTables.tables.length}`,
    );
    const results: LarkImportTableResult[] = [];

    for (const source of sources) {
      this.logger.log(`[LARK_IMPORT] source start source=${source}`);
      const baseToken = FINANCE_SOURCES.has(source) ? financeBase : vehicleBase;
      const listed = FINANCE_SOURCES.has(source)
        ? financeTables
        : vehicleTables;
      if (!baseToken || listed.error) {
        this.logger.warn(
          `[LARK_IMPORT] source skipped source=${source} reason=${listed.error || 'missing base'}`,
        );
        results.push(
          this.emptyResult(source, baseToken, listed.error || 'Không có base'),
        );
        continue;
      }
      const selected = selectTablesForSource(
        source,
        listed.tables,
        this.preferredTableId(source),
      );
      if (!selected.length) {
        this.logger.warn(
          `[LARK_IMPORT] source skipped source=${source} reason=no matching table`,
        );
        results.push(this.emptyResult(source, baseToken));
        continue;
      }
      this.logger.log(
        `[LARK_IMPORT] source tables source=${source} count=${selected.length}`,
      );
      for (const table of selected) {
        const tableResult = await this.importTable({
          source,
          baseToken,
          table,
          token,
          dryRun,
          userId,
        });
        results.push(tableResult);
        this.logTableSummary(tableResult, mode);
      }
    }

    const totals = results.reduce(
      (summary, table) => ({
        fetched: summary.fetched + table.fetched,
        created: summary.created + table.created,
        updated: summary.updated + table.updated,
        skipped: summary.skipped + table.skipped,
        attachmentsDownloaded:
          summary.attachmentsDownloaded + table.attachmentsDownloaded,
        attachmentsFailed: summary.attachmentsFailed + table.attachmentsFailed,
      }),
      {
        fetched: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        attachmentsDownloaded: 0,
        attachmentsFailed: 0,
      },
    );
    this.logger.log(
      `[LARK_IMPORT] complete mode=${mode} fetched=${totals.fetched} created=${totals.created} updated=${totals.updated} skipped=${totals.skipped} attachments=${totals.attachmentsDownloaded} attachmentErrors=${totals.attachmentsFailed} durationMs=${Date.now() - startedAt}`,
    );
    return { dryRun, tables: results };
  }

  private resolveSources(sources?: string[]): LarkImportSource[] {
    if (!sources?.length) return [...LARK_IMPORT_SOURCES];
    const unknown = sources.filter(
      (source) => !LARK_IMPORT_SOURCES.includes(source as LarkImportSource),
    );
    if (unknown.length) {
      throw new BadRequestException(
        `Nguồn import không hợp lệ: ${unknown.join(', ')}`,
      );
    }
    return sources as LarkImportSource[];
  }

  private preferredTableId(source: LarkImportSource): string | null {
    if (source === 'EXPENSE_HN') {
      return this.config.get<string>('LARK_EXPENSE_TABLE_HN') || null;
    }
    if (source === 'EXPENSE_SG') {
      return this.config.get<string>('LARK_EXPENSE_TABLE_SG') || null;
    }
    if (source in LARK_APPROVAL_TABLE_FALLBACKS) {
      const key = source as keyof typeof LARK_APPROVAL_TABLE_FALLBACKS;
      return (
        this.config.get<string>(`LARK_${key}_TABLE`) ||
        LARK_APPROVAL_TABLE_FALLBACKS[key]
      );
    }
    return null;
  }

  private async safeListTables(baseToken: string, token: string) {
    try {
      return {
        tables: await this.lark.listTables(baseToken, token),
        error: null,
      };
    } catch (error) {
      return {
        tables: [] as LarkTableRef[],
        error:
          error instanceof Error ? error.message : 'Không đọc được bảng Lark',
      };
    }
  }

  private emptyResult(
    source: LarkImportSource,
    baseToken: string | null,
    error?: string,
  ): LarkImportTableResult {
    return {
      source,
      baseToken,
      tableId: null,
      tableName: null,
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      attachmentsDownloaded: 0,
      attachmentsFailed: 0,
      unmatchedInvoices: [],
      ...(error ? { error } : {}),
      sampleErrors: error ? [error] : ['Không tìm thấy bảng, đã bỏ qua'],
    };
  }

  private async importTable(input: {
    source: LarkImportSource;
    baseToken: string;
    table: LarkTableRef;
    token: string;
    dryRun: boolean;
    userId: number;
  }): Promise<LarkImportTableResult> {
    if (
      input.source === 'APPROVAL_HN' ||
      input.source === 'APPROVAL_SG' ||
      input.source === 'APPROVAL_VP'
    ) {
      return this.importApprovalTable(input);
    }
    const result = this.emptyResult(input.source, input.baseToken);
    result.tableId = input.table.tableId;
    result.tableName = input.table.name;
    result.sampleErrors = [];
    const branchId = defaultBranchForSource(input.source, input.table.name);
    this.logger.log(
      `[LARK_IMPORT] table start source=${input.source} table="${input.table.name}" tableId=${input.table.tableId} branchId=${branchId ?? 'unknown'} mode=${input.dryRun ? 'DRY_RUN' : 'COMMIT'}`,
    );
    if (!branchId) {
      result.error = `Không xác định được chi nhánh của bảng ${input.table.name}`;
      result.sampleErrors.push(result.error);
      return result;
    }
    try {
      const fieldNames = await this.lark.listFieldNames(
        input.baseToken,
        input.table.tableId,
        input.token,
      );
      const fieldError = requiredFieldError(fieldNames, input.source);
      if (fieldError) {
        result.error = fieldError;
        result.sampleErrors.push(fieldError);
        return result;
      }
      result.fetched = await this.lark.forEachRecordPage(
        input.baseToken,
        input.table.tableId,
        input.token,
        async (records, pageInfo) => {
          await this.persistPage(records, {
            ...input,
            branchId,
            result,
          });
          this.logPageProgress(input.source, input.table, pageInfo, result, input.dryRun);
        },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Import bảng thất bại';
      result.error = message;
      this.pushError(result, message);
      this.logger.error(
        `[LARK_IMPORT] table failed source=${input.source} tableId=${input.table.tableId} error=${message}`,
      );
    }
    return result;
  }

  private async importApprovalTable(input: {
    source: LarkImportSource;
    baseToken: string;
    table: LarkTableRef;
    token: string;
    dryRun: boolean;
    userId: number;
  }): Promise<LarkImportTableResult> {
    const result = this.emptyResult(input.source, input.baseToken);
    result.tableId = input.table.tableId;
    result.tableName = input.table.name;
    result.sampleErrors = [];
    const branchId =
      input.source === 'APPROVAL_HN'
        ? 6
        : input.source === 'APPROVAL_SG'
          ? 1
          : 7;
    const kind =
      input.source === 'APPROVAL_HN'
        ? 'EXPENSE_HN'
        : input.source === 'APPROVAL_SG'
          ? 'EXPENSE_SG'
          : 'EXPENSE_VP';
    this.logger.log(
      `[LARK_IMPORT] approval table start source=${input.source} table="${input.table.name}" tableId=${input.table.tableId} branchId=${branchId} mode=${input.dryRun ? 'DRY_RUN' : 'COMMIT'}`,
    );

    try {
      const fieldNames = await this.lark.listFieldNames(
        input.baseToken,
        input.table.tableId,
        input.token,
      );
      const required = [
        'Tuần chi',
        'Năm chi',
        'Ngày bắt đầu',
        'Ngày kết thúc',
        'Số tiền',
        'Trạng thái duyệt',
      ];
      const missing = required.filter(
        (field) => !fieldNames.some((name) => normalizeText(name) === normalizeText(field)),
      );
      if (missing.length) {
        result.error = `Bảng Approval thiếu field: ${missing.join(', ')}`;
        result.sampleErrors.push(
          `${result.error}. Field hiện có: ${fieldNames.join(', ')}`,
        );
        return result;
      }

      result.fetched = await this.lark.forEachRecordPage(
        input.baseToken,
        input.table.tableId,
        input.token,
        async (records, pageInfo) => {
          for (const record of records) {
            const row = this.mapApprovalRow({
              source: input.source,
              baseToken: input.baseToken,
              table: input.table,
              branchId,
              kind,
              record,
            });
            if (!row) {
              result.skipped += 1;
              continue;
            }
            const existing = await this.prisma.internalFinanceWeeklyBatch.findUnique({
              where: {
                branchId_weekStart_weekEnd: {
                  branchId: row.branchId,
                  weekStart: row.weekStart,
                  weekEnd: row.weekEnd,
                },
              },
              select: { id: true, approvalRequestId: true },
            });
            if (input.dryRun) {
              if (existing) result.updated += 1;
              else result.created += 1;
              continue;
            }
            try {
              await this.persistApprovalRow(row, input.userId);
              if (existing) result.updated += 1;
              else result.created += 1;
            } catch (error) {
              result.skipped += 1;
              this.pushError(
                result,
                error instanceof Error
                  ? error.message
                  : 'Không lưu được Approval tuần',
              );
            }
          }
          this.logPageProgress(input.source, input.table, pageInfo, result, input.dryRun);
        },
      );
    } catch (error) {
      result.error =
        error instanceof Error ? error.message : 'Import Approval thất bại';
      this.pushError(result, result.error);
      this.logger.error(
        `[LARK_IMPORT] approval table failed source=${input.source} tableId=${input.table.tableId} error=${result.error}`,
      );
    }
    return result;
  }

  private mapApprovalRow(input: {
    source: LarkImportSource;
    baseToken: string;
    table: LarkTableRef;
    branchId: number;
    kind: 'EXPENSE_HN' | 'EXPENSE_SG' | 'EXPENSE_VP';
    record: LarkImportRecord;
  }) {
    const fields = input.record.fields;
    const week = readLarkNumber(
      readLarkAlias(fields, ['Tuần chi', 'Tuần']),
    );
    const year = readLarkNumber(
      readLarkAlias(fields, ['Năm chi', 'Năm']),
    );
    const weekStart = readLarkDate(
      readLarkAlias(fields, ['Ngày bắt đầu']),
    );
    const weekEnd = readLarkDate(
      readLarkAlias(fields, ['Ngày kết thúc']),
    );
    const totalAmount = readLarkNumber(
      readLarkAlias(fields, ['Số tiền', 'Tổng tiền', 'Thành tiền']),
    );
    if (
      !week ||
      !year ||
      !weekStart ||
      !weekEnd ||
      !totalAmount ||
      totalAmount <= 0
    ) {
      return null;
    }
    const rawStatus = normalizeText(
      readLarkText(readLarkAlias(fields, ['Trạng thái duyệt', 'Status'])),
    );
    const status =
      rawStatus.includes('approved') || rawStatus.includes('da duyet')
        ? INTERNAL_FINANCE_WEEKLY_STATUS.APPROVED
        : rawStatus.includes('reject') || rawStatus.includes('tu choi')
          ? INTERNAL_FINANCE_WEEKLY_STATUS.REJECTED
          : readLarkText(readLarkAlias(fields, ['instance_code_1']))
            ? INTERNAL_FINANCE_WEEKLY_STATUS.IN_APPROVAL
            : INTERNAL_FINANCE_WEEKLY_STATUS.READY;
    const instanceCode =
      readLarkText(readLarkAlias(fields, ['instance_code_1'])) || null;
    const creatorRef = readLarkPersonAlias(fields, ['Người tạo phiếu']);

    return {
      source: input.source,
      baseToken: input.baseToken,
      tableId: input.table.tableId,
      tableName: input.table.name,
      recordId: input.record.recordId,
      branchId: input.branchId,
      kind: input.kind,
      week: Math.trunc(week),
      year: Math.trunc(year),
      weekStart,
      weekEnd,
      totalAmount,
      status,
      instanceCode,
      creatorRef,
      fields,
    };
  }

  private async persistApprovalRow(
    row: ReturnType<InternalFinanceLarkImportService['mapApprovalRow']>,
    importUserId: number,
  ) {
    if (!row) return;
    const creatorId = await this.findUserId(row.creatorRef);
    const createdById = creatorId || importUserId;
    const branchCode = INTERNAL_FINANCE_BRANCH_CODES[row.branchId] || `B${row.branchId}`;
    const year = row.year;
    const week = String(row.week).padStart(2, '0');
    const batchCode = `TCNB-TUAN-${branchCode}-${year}-W${week}`;
    const clientUuid = `INTERNAL_FINANCE_WEEK:${row.branchId}:${this.dateKey(row.weekStart)}`;
    const approvalCode = APPROVAL_DEFINITIONS[row.kind].approvalCode;
    const terminal =
      row.status === INTERNAL_FINANCE_WEEKLY_STATUS.APPROVED ||
      row.status === INTERNAL_FINANCE_WEEKLY_STATUS.REJECTED;
    const approvalStatus =
      row.status === INTERNAL_FINANCE_WEEKLY_STATUS.APPROVED
        ? 'APPROVED'
        : row.status === INTERNAL_FINANCE_WEEKLY_STATUS.REJECTED
          ? 'REJECTED'
          : 'PENDING';
    const formSnapshot = JSON.parse(
      JSON.stringify({
        source: 'LARK_IMPORT_WEEKLY',
        lark: {
          baseToken: row.baseToken,
          tableId: row.tableId,
          tableName: row.tableName,
          recordId: row.recordId,
        },
        fields: row.fields,
        creatorName: row.creatorRef?.name || null,
        creatorLarkUserId: row.creatorRef?.id || null,
      }),
    ) as Prisma.InputJsonValue;

    await this.prisma.$transaction(async (tx) => {
      const batch = await tx.internalFinanceWeeklyBatch.upsert({
        where: {
          branchId_weekStart_weekEnd: {
            branchId: row.branchId,
            weekStart: row.weekStart,
            weekEnd: row.weekEnd,
          },
        },
        create: {
          code: batchCode,
          branchId: row.branchId,
          weekStart: row.weekStart,
          weekEnd: row.weekEnd,
          totalAmount: row.totalAmount,
          status: row.status,
          preparedAt: row.weekStart,
          createdBy: createdById,
        },
        update: {
          totalAmount: row.totalAmount,
          status: row.status,
          preparedAt: row.weekStart,
        },
      });
      const request = await tx.approvalRequest.upsert({
        where: { clientUuid },
        create: {
          kind: row.kind,
          approvalCode,
          instanceCode: row.instanceCode,
          clientUuid,
          status: approvalStatus,
          branchId: row.branchId,
          sourceType: 'LARK_IMPORT_WEEKLY',
          sourceId: batch.id,
          createdById,
          formSnapshot,
          lastEventAt: terminal ? row.weekEnd : undefined,
          completedAt: terminal ? row.weekEnd : undefined,
        },
        update: {
          approvalCode,
          ...(row.instanceCode ? { instanceCode: row.instanceCode } : {}),
          status: approvalStatus,
          branchId: row.branchId,
          sourceType: 'LARK_IMPORT_WEEKLY',
          sourceId: batch.id,
          formSnapshot,
          lastEventAt: terminal ? row.weekEnd : undefined,
          completedAt: terminal ? row.weekEnd : null,
        },
      });
      await tx.internalFinanceWeeklyBatch.update({
        where: { id: batch.id },
        data: { approvalRequestId: request.id },
      });
      const entries = await tx.internalFinanceEntry.findMany({
        where: {
          branchId: row.branchId,
          direction: 'EXPENSE',
          occurredAt: { gte: row.weekStart, lte: row.weekEnd },
          OR: [{ weeklyBatchId: null }, { weeklyBatchId: batch.id }],
          cashFlowId: null,
        },
        select: { id: true },
      });
      if (entries.length) {
        await tx.internalFinanceEntry.updateMany({
          where: { id: { in: entries.map((entry) => entry.id) } },
          data: {
            weeklyBatchId: batch.id,
            status:
              row.status === INTERNAL_FINANCE_WEEKLY_STATUS.APPROVED
                ? INTERNAL_FINANCE_STATUS.APPROVED
                : row.status === INTERNAL_FINANCE_WEEKLY_STATUS.REJECTED
                  ? INTERNAL_FINANCE_STATUS.REJECTED
                  : INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL,
          },
        });
      }
      if (row.instanceCode) {
        const eventKey = `LARK_IMPORT:${row.baseToken}:${row.tableId}:${row.recordId}`;
        await tx.approvalRequestEvent.upsert({
          where: { eventKey },
          create: {
            eventKey,
            approvalRequestId: request.id,
            approvalCode,
            instanceCode: row.instanceCode,
            status: approvalStatus,
            instanceOperateTime: terminal ? row.weekEnd : undefined,
            payload: formSnapshot,
            processedAt: new Date(),
          },
          update: {
            approvalRequestId: request.id,
            status: approvalStatus,
            payload: formSnapshot,
            processedAt: new Date(),
            error: null,
          },
        });
      }
    });
  }

  private async findUserId(ref: LarkPersonRef | null) {
    if (!ref) return null;
    if (ref.id) {
      const byLarkId = await this.prisma.user.findMany({
        where: { larkUserId: ref.id },
        select: { id: true },
        take: 2,
      });
      if (byLarkId.length === 1) return byLarkId[0].id;
    }
    if (!ref.name) return null;
    const byName = await this.prisma.user.findMany({
      where: { name: ref.name.trim() },
      select: { id: true },
      take: 2,
    });
    return byName.length === 1 ? byName[0].id : null;
  }

  private async persistPage(
    records: LarkImportRecord[],
    input: {
      source: LarkImportSource;
      baseToken: string;
      table: LarkTableRef;
      token: string;
      dryRun: boolean;
      userId: number;
      branchId: number;
      result: LarkImportTableResult;
    },
  ) {
    const mapped: MappedLarkEntry[] = [];
    for (const record of records) {
      const outcome = mapLarkRecord({
        source: input.source,
        baseToken: input.baseToken,
        tableId: input.table.tableId,
        tableName: input.table.name,
        defaultBranchId: input.branchId,
        recordId: record.recordId,
        fields: record.fields,
      });
      if (!outcome.entry) {
        input.result.skipped += 1;
        continue;
      }
      mapped.push(outcome.entry);
    }
    if (!mapped.length) return;

    const existing = await this.prisma.internalFinanceEntry.findMany({
      where: { sourceKey: { in: mapped.map((entry) => entry.sourceKey) } },
      select: {
        id: true,
        sourceKey: true,
        status: true,
        cashFlowId: true,
        cashIssued: true,
        code: true,
        sourceSnapshot: true,
      },
    });
    const existingByKey = new Map(
      existing.map((entry) => [entry.sourceKey, entry]),
    );
    const invoiceIds = await this.matchInvoices(mapped, input.result);
    const slipIds = await this.matchSlips(mapped);
    const customerIds = await this.matchCustomers(mapped);
    const larkUsers = await this.resolveLarkUsers(mapped);

    for (const entry of mapped) {
      const current = existingByKey.get(entry.sourceKey);
      if (
        current &&
        (current.cashFlowId ||
          current.cashIssued ||
          PROTECTED_IMPORT_STATUSES.has(current.status))
      ) {
        input.result.skipped += 1;
        continue;
      }
      const matchedInvoices = entry.invoiceCodes
        .map((code) => invoiceIds.get(code))
        .filter((id): id is number => Boolean(id));
      const category =
        input.source === 'RECEIPT' &&
        (matchedInvoices.length || customerIds.get(entry.customerName || ''))
          ? INTERNAL_FINANCE_CATEGORY.CUSTOMER_RECEIPT
          : entry.category;
      if (input.dryRun) {
        if (current) input.result.updated += 1;
        else input.result.created += 1;
        continue;
      }
      try {
        const savedFiles = await this.downloadAttachments(
          entry,
          current,
          input,
        );
        const evidenceStatus =
          savedFiles.length || currentHasFiles(current)
            ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
            : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING;
        const snapshot = {
          ...entry.sourceSnapshot,
          importedByUserId: input.userId,
          unmatchedLarkUsers:
            larkUsers.unmatchedByEntry.get(entry.sourceKey) || [],
          unmatchedInvoiceCodes: entry.invoiceCodes.filter(
            (code) => !invoiceIds.has(code),
          ),
          importedFileTokens: Array.from(
            new Set([
              ...readImportedTokens(current?.sourceSnapshot),
              ...savedFiles.map((file) => file.token),
            ]),
          ),
          missingDate: !entry.occurredAt,
        };
        const data = await this.entryData({
          entry: { ...entry, category, evidenceStatus },
          existingCode: current?.code,
          resolvedUsers: larkUsers.byEntry.get(entry.sourceKey),
          userId: input.userId,
          snapshot,
          invoiceIds: matchedInvoices,
          customerId: customerIds.get(entry.customerName || '') || null,
          packingSlipId: entry.slipCode
            ? slipIds.get(entry.slipCode) || null
            : null,
          attachments: savedFiles,
        });
        if (current) {
          await this.prisma.internalFinanceEntry.update({
            where: { id: current.id },
            data: {
              ...data,
              invoiceLinks: {
                deleteMany: {},
                ...(matchedInvoices.length
                  ? {
                      create: matchedInvoices.map((invoiceId) => ({
                        invoiceId,
                      })),
                    }
                  : {}),
              },
              reviews: {
                deleteMany: { note: { startsWith: 'Lark import:' } },
                ...(data.reviews ? { create: data.reviews.create } : {}),
              },
              attachments: savedFiles.length
                ? { create: data.attachments?.create }
                : undefined,
            },
          });
          input.result.updated += 1;
        } else {
          await this.prisma.internalFinanceEntry.create({ data });
          input.result.created += 1;
        }
      } catch (error) {
        input.result.skipped += 1;
        this.pushError(
          input.result,
          error instanceof Error ? error.message : 'Không lưu được dòng import',
        );
      }
    }
  }

  private async matchInvoices(
    entries: MappedLarkEntry[],
    result: LarkImportTableResult,
  ) {
    const codes = Array.from(
      new Set(entries.flatMap((entry) => entry.invoiceCodes)),
    );
    const found = new Map<string, number>();
    if (!codes.length) return found;
    const invoices = await this.prisma.invoice.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    for (const invoice of invoices) found.set(invoice.code, invoice.id);
    for (const code of codes) {
      if (!found.has(code) && !result.unmatchedInvoices.includes(code)) {
        result.unmatchedInvoices.push(code);
      }
    }
    return found;
  }

  private async matchSlips(entries: MappedLarkEntry[]) {
    const codes = Array.from(
      new Set(
        entries
          .map((entry) => entry.slipCode)
          .filter((code): code is string => Boolean(code)),
      ),
    );
    const found = new Map<string, number>();
    if (!codes.length) return found;
    const slips = await this.prisma.packingSlip.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    for (const slip of slips) {
      if (slip.code) found.set(slip.code, slip.id);
    }
    return found;
  }

  private async matchCustomers(entries: MappedLarkEntry[]) {
    const names = Array.from(
      new Set(
        entries
          .map((entry) => entry.customerName)
          .filter((name): name is string => Boolean(name)),
      ),
    );
    const found = new Map<string, number>();
    if (!names.length) return found;
    const customers = await this.prisma.customer.findMany({
      where: { name: { in: names } },
      select: { id: true, name: true },
    });
    const counts = new Map<string, number>();
    for (const customer of customers) {
      counts.set(customer.name, (counts.get(customer.name) || 0) + 1);
    }
    for (const customer of customers) {
      if (counts.get(customer.name) === 1)
        found.set(customer.name, customer.id);
    }
    return found;
  }

  private async resolveLarkUsers(entries: MappedLarkEntry[]) {
    const refs = entries.flatMap((entry) => [
      entry.larkCreator,
      entry.larkPayer,
      entry.larkAccountant,
      entry.larkManager,
    ]);
    const larkUserIds = Array.from(
      new Set(
        refs
          .map((ref) => ref?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const users = larkUserIds.length
      ? await this.prisma.user.findMany({
          where: { larkUserId: { in: larkUserIds } },
          select: { id: true, name: true, larkUserId: true },
        })
      : [];
    const byLarkId = new Map(
      users
        .filter((user) => user.larkUserId)
        .map((user) => [user.larkUserId as string, user]),
    );
    const nameCounts = new Map<string, number>();
    for (const user of users) {
      const key = normalizePersonName(user.name);
      if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }

    const byEntry = new Map<string, ResolvedLarkUsers>();
    const unmatchedByEntry = new Map<
      string,
      Array<Record<string, string>>
    >();

    for (const entry of entries) {
      const unmatched: Array<Record<string, string>> = [];
      const resolve = (role: string, ref: LarkPersonRef | null) => {
        if (!ref) return undefined;
        const byId = ref.id ? byLarkId.get(ref.id) : undefined;
        if (byId) return byId;
        const nameKey = normalizePersonName(ref.name);
        if (nameKey && nameCounts.get(nameKey) === 1) {
          const byName = users.find(
            (user) => normalizePersonName(user.name) === nameKey,
          );
          if (byName) return byName;
        }
        unmatched.push({
          role,
          ...(ref.id ? { larkUserId: ref.id } : {}),
          ...(ref.name ? { name: ref.name } : {}),
        });
        return undefined;
      };

      const creator = resolve('creator', entry.larkCreator);
      const accountant = resolve('accountant', entry.larkAccountant);
      const manager = resolve('manager', entry.larkManager);
      byEntry.set(entry.sourceKey, {
        ...(creator ? { creatorId: creator.id, creatorName: creator.name || undefined } : {}),
        ...(accountant
          ? { accountantId: accountant.id, accountantName: accountant.name || undefined }
          : {}),
        ...(manager
          ? { managerId: manager.id, managerName: manager.name || undefined }
          : {}),
      });
      if (unmatched.length) unmatchedByEntry.set(entry.sourceKey, unmatched);
    }

    return { byEntry, unmatchedByEntry };
  }

  private async downloadAttachments(
    entry: MappedLarkEntry,
    current: { sourceSnapshot: Prisma.JsonValue | null } | undefined,
    input: {
      token: string;
      userId: number;
      result: LarkImportTableResult;
    },
  ) {
    const previous = new Set(readImportedTokens(current?.sourceSnapshot));
    const saved: Array<{
      token: string;
      fileUrl: string;
      fileName?: string;
      fileType?: string;
      fileSize?: number;
      kind: string;
      createdBy: number;
    }> = [];
    for (const attachment of entry.attachments) {
      if (previous.has(attachment.fileToken)) {
        saved.push({
          token: attachment.fileToken,
          fileUrl: '',
          kind: 'EVIDENCE',
          createdBy: input.userId,
        });
        continue;
      }
      const url =
        attachment.url ||
        attachment.tmpUrl ||
        `https://open.larksuite.com/open-apis/drive/v1/medias/${attachment.fileToken}/download`;
      try {
        const buffer = await this.lark.download(url, input.token);
        const stored = await this.uploadService.saveFile(
          buffer,
          attachment.name || `${attachment.fileToken}.bin`,
          attachment.type || 'application/octet-stream',
          'internal-finance',
        );
        saved.push({
          token: attachment.fileToken,
          fileUrl: stored.url,
          fileName: attachment.name,
          fileType: attachment.type,
          fileSize: stored.size,
          kind: 'EVIDENCE',
          createdBy: input.userId,
        });
        previous.add(attachment.fileToken);
        input.result.attachmentsDownloaded += 1;
        if (
          input.result.attachmentsDownloaded === 1 ||
          input.result.attachmentsDownloaded % 25 === 0
        ) {
          this.logger.log(
            `[LARK_IMPORT] attachments downloaded=${input.result.attachmentsDownloaded} failed=${input.result.attachmentsFailed}`,
          );
        }
      } catch (error) {
        input.result.attachmentsFailed += 1;
        this.logger.warn(
          `[LARK_IMPORT] attachment failed name=${attachment.name || attachment.fileToken} failed=${input.result.attachmentsFailed}`,
        );
        this.pushError(
          input.result,
          error instanceof Error ? error.message : 'Không tải được chứng từ',
        );
      }
    }
    return saved.filter((file) => file.fileUrl);
  }

  private async entryData(input: {
    entry: MappedLarkEntry;
    existingCode?: string;
    resolvedUsers?: ResolvedLarkUsers;
    userId: number;
    snapshot: Record<string, unknown>;
    invoiceIds: number[];
    customerId: number | null;
    packingSlipId: number | null;
    attachments: Array<{
      token: string;
      fileUrl: string;
      fileName?: string;
      fileType?: string;
      fileSize?: number;
      kind: string;
      createdBy: number;
    }>;
  }): Promise<Prisma.InternalFinanceEntryCreateInput> {
    const reviews = this.reviewRows(
      input.entry,
      input.resolvedUsers,
    );
    const occurredAt = input.entry.occurredAt || new Date();
    const code =
      input.existingCode?.startsWith('TCNB-')
        ? input.existingCode
        : await this.codeService.nextCode(this.prisma, {
            direction: input.entry.direction,
            category: input.entry.category,
            branchId: input.entry.branchId,
            occurredAt,
          });
    const snapshot = input.entry.sourceSnapshot;
    return {
      code,
      direction: input.entry.direction,
      category: input.entry.category,
      subCategory: input.entry.subCategory,
      branch: { connect: { id: input.entry.branchId } },
      amount: input.entry.amount,
      occurredAt,
      sourceType: 'LARK_IMPORT',
      sourceId: input.entry.sourceSnapshot.lark
        ? String(
            (input.entry.sourceSnapshot.lark as { recordId?: string })
              .recordId || '',
          )
        : undefined,
      sourceKey: input.entry.sourceKey,
      sourceSnapshot: input.snapshot as Prisma.InputJsonValue,
      description: input.entry.description,
      evidenceStatus: input.entry.evidenceStatus,
      status: input.entry.status,
      requiresEvidence: input.entry.direction === 'EXPENSE',
      cashIssued: input.entry.cashIssued,
      cashIssuedAt: input.entry.cashIssued ? occurredAt : undefined,
      creator: {
        connect: { id: input.resolvedUsers?.creatorId || input.userId },
      },
      vehicleName:
        typeof snapshot.vehicle === 'string' ? snapshot.vehicle : undefined,
      vehicleServiceType:
        typeof snapshot.serviceType === 'string'
          ? snapshot.serviceType
          : undefined,
      vehicleLocation:
        typeof snapshot.location === 'string' ? snapshot.location : undefined,
      vehicleOdo: readLarkNumber(snapshot.odo) ?? undefined,
      vehicleLiters: readLarkNumber(snapshot.liters) ?? undefined,
      vehicleUnitPrice: readLarkNumber(snapshot.unitPrice) ?? undefined,
      vehicleAnomalyStatus:
        typeof snapshot.anomalyNote === 'string'
          ? snapshot.anomalyNote
          : undefined,
      ...(input.customerId
        ? { customer: { connect: { id: input.customerId } } }
        : {}),
      ...(input.packingSlipId
        ? { packingSlip: { connect: { id: input.packingSlipId } } }
        : {}),
      ...(input.entry.accountantTicked
        ? input.resolvedUsers?.accountantId
          ? {
              accountantReviewer: {
                connect: { id: input.resolvedUsers.accountantId },
              },
              accountantReviewedAt: input.entry.occurredAt || new Date(),
            }
          : {}
        : {}),
      ...(input.entry.managerTicked
        ? input.resolvedUsers?.managerId
          ? {
              managerReviewer: {
                connect: { id: input.resolvedUsers.managerId },
              },
              managerReviewedAt: input.entry.occurredAt || new Date(),
            }
          : {}
        : {}),
      ...(input.invoiceIds.length
        ? {
            invoiceLinks: {
              create: input.invoiceIds.map((invoiceId) => ({ invoiceId })),
            },
          }
        : {}),
      ...(input.attachments.length
        ? {
            attachments: {
              create: input.attachments.map(storedAttachment),
            },
          }
        : {}),
      ...(reviews.length ? { reviews: { create: reviews } } : {}),
    };
  }

  private reviewRows(
    entry: MappedLarkEntry,
    resolvedUsers?: ResolvedLarkUsers,
  ) {
    const rows: Array<{
      role: string;
      decision: string;
      note: string;
      reviewerId?: number;
      reviewerNameSnapshot?: string;
    }> = [];
    if (entry.status === 'REJECTED') {
      rows.push({
        role: INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
        decision: INTERNAL_FINANCE_REVIEW_DECISION.REJECT,
        note: 'Lark import: từ chối',
        reviewerId: resolvedUsers?.managerId,
        reviewerNameSnapshot:
          resolvedUsers?.managerName || entry.larkManager?.name || undefined,
      });
      return rows;
    }
    if (entry.accountantTicked) {
      rows.push({
        role: INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
        decision: INTERNAL_FINANCE_REVIEW_DECISION.APPROVE,
        note: 'Lark import: kế toán đã tick',
        reviewerId: resolvedUsers?.accountantId,
        reviewerNameSnapshot:
          resolvedUsers?.accountantName ||
          entry.larkAccountant?.name ||
          undefined,
      });
    }
    if (entry.managerTicked) {
      rows.push({
        role: INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
        decision: INTERNAL_FINANCE_REVIEW_DECISION.APPROVE,
        note: 'Lark import: quản lý đã tick',
        reviewerId: resolvedUsers?.managerId,
        reviewerNameSnapshot:
          resolvedUsers?.managerName || entry.larkManager?.name || undefined,
      });
    }
    return rows;
  }

  private dateKey(value: Date) {
    const vietnamTime = new Date(value.getTime() + 7 * 60 * 60 * 1000);
    const year = vietnamTime.getUTCFullYear();
    const month = String(vietnamTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(vietnamTime.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  private logPageProgress(
    source: LarkImportSource,
    table: LarkTableRef,
    pageInfo: LarkRecordPageInfo | undefined,
    result: LarkImportTableResult,
    dryRun: boolean,
  ) {
    const page = pageInfo?.page ?? '?';
    const pageRecords = pageInfo?.pageRecords ?? '?';
    const fetched = pageInfo?.totalFetched ?? result.fetched;
    this.logger.log(
      `[LARK_IMPORT] page source=${source} tableId=${table.tableId} page=${page} pageRecords=${pageRecords} fetched=${fetched} created=${result.created} updated=${result.updated} skipped=${result.skipped} mode=${dryRun ? 'DRY_RUN' : 'COMMIT'}`,
    );
  }

  private logTableSummary(result: LarkImportTableResult, mode: string) {
    this.logger.log(
      `[LARK_IMPORT] table complete source=${result.source} table="${result.tableName || '-'}" fetched=${result.fetched} created=${result.created} updated=${result.updated} skipped=${result.skipped} attachments=${result.attachmentsDownloaded} attachmentErrors=${result.attachmentsFailed} unmatchedInvoices=${result.unmatchedInvoices.length} errors=${result.sampleErrors.length} mode=${mode}`,
    );
  }

  private pushError(result: LarkImportTableResult, message: string) {
    if (result.sampleErrors.length < 5) result.sampleErrors.push(message);
    this.logger.warn(message);
  }
}

function normalizePersonName(value: string | null | undefined) {
  return value?.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase() || '';
}

function currentHasFiles(
  current: { sourceSnapshot: Prisma.JsonValue | null } | undefined,
) {
  return readImportedTokens(current?.sourceSnapshot).length > 0;
}

function readImportedTokens(snapshot: Prisma.JsonValue | null | undefined) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return [];
  const tokens = (snapshot as { importedFileTokens?: unknown })
    .importedFileTokens;
  return Array.isArray(tokens) ? tokens.map(String) : [];
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function storedAttachment(file: {
  token: string;
  fileUrl: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  kind: string;
  createdBy: number;
}) {
  return {
    fileUrl: file.fileUrl,
    fileName: file.fileName,
    fileType: file.fileType,
    fileSize: file.fileSize,
    kind: file.kind,
    createdBy: file.createdBy,
  };
}
