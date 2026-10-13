import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';
import { InternalFundHistorySyncService } from './internal-fund-history-sync.service';

export const FINANCE_SYNC_STEPS = [
  'EXPENSES',
  'WEEKLY_APPROVALS',
  'WAREHOUSE_CASH',
  'FUND_LEDGER',
  'DOCUMENTS',
] as const;
export type FinanceSyncStepKey = (typeof FINANCE_SYNC_STEPS)[number];

export interface FinanceSyncStep {
  key: FinanceSyncStepKey;
  state: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
}

export interface FinanceSyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  steps: FinanceSyncStep[];
  error: string | null;
}

type StepCounts = Pick<
  FinanceSyncStep,
  'fetched' | 'created' | 'updated' | 'skipped'
>;

/**
 * Một lần bấm đồng bộ toàn bộ dữ liệu thu chi kho: xe cộ + phiếu chi kho,
 * approval tuần, tiền mặt kho, sổ quỹ, cuối cùng là chứng từ đính kèm. Bước nào lỗi thì ghi lại và chạy
 * tiếp bước sau; chạy lại nhiều lần không tạo trùng.
 */
@Injectable()
export class InternalFinanceSyncService {
  private readonly logger = new Logger(InternalFinanceSyncService.name);
  private status: FinanceSyncStatus = this.emptyStatus();

  constructor(
    private readonly larkImport: InternalFinanceLarkImportService,
    private readonly fundHistory: InternalFundHistorySyncService,
  ) {}

  getStatus(): FinanceSyncStatus {
    return {
      ...this.status,
      steps: this.status.steps.map((step) => ({ ...step })),
    };
  }

  start(userId: number): FinanceSyncStatus {
    if (!userId) throw new BadRequestException('Thiếu người thực hiện');
    if (
      this.status.running ||
      this.larkImport.getImportStatus().running ||
      this.fundHistory.getStatus().running
    ) {
      throw new BadRequestException('Đang đồng bộ dữ liệu, vui lòng chờ');
    }
    this.status = {
      ...this.emptyStatus(),
      running: true,
      startedAt: new Date().toISOString(),
    };
    this.larkImport.setExclusive(true);
    void this.run(userId).finally(() => {
      this.larkImport.setExclusive(false);
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
    });
    return this.getStatus();
  }

  private async run(userId: number) {
    await this.step('EXPENSES', (report) =>
      this.importSources(
        ['FUEL', 'VEHICLE_CARE', 'EXPENSE_HN', 'EXPENSE_SG'],
        userId,
        report,
      ),
    );
    await this.step('WEEKLY_APPROVALS', (report) =>
      this.importSources(['APPROVAL_HN', 'APPROVAL_SG'], userId, report),
    );
    await this.step('WAREHOUSE_CASH', async () => {
      const result = await this.larkImport.importWarehouseCash(
        { dryRun: false },
        userId,
      );
      return {
        fetched: result.fetched,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      };
    });
    await this.step('FUND_LEDGER', async () => {
      const result = await this.fundHistory.runAndWait(userId);
      if (result.error) throw new Error(result.error);
      return {
        fetched: result.fetched,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      };
    });
    // Chứng từ tải sau cùng: lâu nhất và không ảnh hưởng số liệu.
    await this.step('DOCUMENTS', async (report) => {
      const toCounts = (progress: {
        total: number;
        downloaded: number;
        failed: number;
      }) => ({
        fetched: progress.total,
        created: progress.downloaded,
        updated: 0,
        skipped: progress.failed,
      });
      return toCounts(
        await this.larkImport.downloadPendingAttachments(userId, (progress) =>
          report(toCounts(progress)),
        ),
      );
    });
    const failed = this.status.steps.filter((step) => step.state === 'FAILED');
    if (failed.length)
      this.status.error = `Có ${failed.length} bước đồng bộ lỗi`;
  }

  private async importSources(
    sources: string[],
    userId: number,
    report: (counts: Partial<StepCounts>) => void,
  ): Promise<StepCounts> {
    const result = await this.larkImport.importHistory(
      { dryRun: false, sources, skipAttachments: true },
      userId,
      {
        onProgress: (patch) =>
          report({
            fetched: patch.fetched,
            created: patch.created,
            updated: patch.updated,
            skipped: patch.skipped,
          }),
      },
    );
    const failed = result.tables.find((table) => table.error);
    if (failed?.error) throw new Error(failed.error);
    return result.tables.reduce(
      (sum, table) => ({
        fetched: sum.fetched + table.fetched,
        created: sum.created + table.created,
        updated: sum.updated + table.updated,
        skipped: sum.skipped + table.skipped,
      }),
      { fetched: 0, created: 0, updated: 0, skipped: 0 },
    );
  }

  private async step(
    key: FinanceSyncStepKey,
    work: (
      report: (counts: Partial<StepCounts>) => void,
    ) => Promise<StepCounts>,
  ) {
    const step = this.status.steps.find((item) => item.key === key)!;
    step.state = 'RUNNING';
    const report = (counts: Partial<StepCounts>) => {
      for (const [name, value] of Object.entries(counts))
        if (typeof value === 'number') step[name as keyof StepCounts] = value;
    };
    try {
      report(await work(report));
      step.state = 'DONE';
    } catch (error) {
      step.state = 'FAILED';
      step.error = error instanceof Error ? error.message : 'Đồng bộ thất bại';
      this.logger.error(`[FINANCE_SYNC] step=${key} error=${step.error}`);
    }
  }

  private emptyStatus(): FinanceSyncStatus {
    return {
      running: false,
      startedAt: null,
      finishedAt: null,
      steps: FINANCE_SYNC_STEPS.map((key) => ({
        key,
        state: 'PENDING',
        fetched: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        error: null,
      })),
      error: null,
    };
  }
}
