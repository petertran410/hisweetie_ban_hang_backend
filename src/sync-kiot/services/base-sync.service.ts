import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Concurrency-limited Promise.all
 */
export async function pMapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    runWorker,
  );
  await Promise.all(workers);
  return results;
}

export abstract class BaseSyncService {
  protected abstract readonly entityName: string;
  protected abstract readonly endpoint: string;
  protected readonly logger: Logger;

  /**
   * Default concurrency cho upsert song song. Override nếu entity nặng.
   */
  protected concurrency = 8;

  /**
   * Page size khi fetch từ sync_kiot_data. Có thể override.
   * Lưu ý: sync_kiot_data giới hạn max 500/page (parsePagination).
   */
  protected pageSize = 500;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly api: SyncKiotApiService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  /**
   * Hook cho subclass: pre-load tất cả lookup map cho 1 page records
   * Trả về context shared cho cả page (ví dụ Map customerCode → id).
   * Default: không có context.
   */
  protected async preloadLookups(_records: any[]): Promise<any> {
    return {};
  }

  /**
   * Hook chính: subclass override để upsert 1 record với context đã preload.
   * Default: gọi upsertRecord không context (để giữ tương thích cũ).
   */
  protected async upsertRecordWithContext(
    record: any,
    _context: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    return this.upsertRecord(record);
  }

  protected abstract upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'>;

  async syncAll(): Promise<SyncResult> {
    this.logger.log(`🔄 Syncing all ${this.entityName} (streaming)...`);
    return this.streamSync();
  }

  async syncIncremental(): Promise<SyncResult> {
    const control = await this.prisma.syncControl.findUnique({
      where: { entityType: this.entityName },
    });
    const modifiedFrom = control?.lastSyncAt?.toISOString();

    this.logger.log(
      `🔄 Incremental sync ${this.entityName} since ${modifiedFrom || 'beginning'}...`,
    );

    return this.streamSync(modifiedFrom);
  }

  async syncWindow(fromDate: string): Promise<SyncResult> {
    this.logger.log(`🔄 Window sync ${this.entityName} since ${fromDate}...`);
    return this.streamSync(fromDate);
  }

  /**
   * Pipeline: fetch page N+1 đồng thời với process page N.
   * Trong mỗi page: preload lookup map, sau đó upsert song song chunk-concurrency.
   */
  protected async streamSync(modifiedFrom?: string): Promise<SyncResult> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let totalProcessed = 0;
    let totalExpected = 0;

    let nextFetch: Promise<{ data: any[]; total: number } | null> =
      this.api.fetchPage(this.endpoint, 0, this.pageSize, modifiedFrom);

    let currentItem = 0;

    while (true) {
      const page = await nextFetch;
      if (!page || !page.data || page.data.length === 0) break;

      const { data, total } = page;
      totalExpected = total;

      // Trigger fetch trang kế song song với processing
      const nextOffset = currentItem + data.length;
      nextFetch =
        nextOffset < total
          ? this.api.fetchPage(
              this.endpoint,
              nextOffset,
              this.pageSize,
              modifiedFrom,
            )
          : Promise.resolve(null);

      // Preload lookup cho page hiện tại
      const context = await this.preloadLookups(data);

      // Upsert song song với concurrency limit
      const results = await pMapLimit(data, this.concurrency, (record) =>
        this.upsertRecordWithContext(record, context).catch((error) => {
          this.logger.error(
            `❌ Failed to sync ${this.entityName} record ${record?.code ?? '(unknown)'}: ${error.message}`,
          );
          return 'skipped' as const;
        }),
      );

      for (const r of results) {
        if (r === 'created') created++;
        else if (r === 'updated') updated++;
        else skipped++;
      }

      totalProcessed += data.length;
      currentItem = nextOffset;

      this.logger.log(
        `📄 ${this.entityName}: ${totalProcessed}/${total} processed (${created} created, ${updated} updated, ${skipped} skipped)`,
      );

      if (totalProcessed >= total) break;
    }

    this.logger.log(
      `✅ ${this.entityName}: ${created} created, ${updated} updated, ${skipped} skipped (total ${totalProcessed}/${totalExpected})`,
    );

    return { created, updated, skipped };
  }

  /**
   * Backward-compat: vẫn còn vài service cũ gọi processRecords trực tiếp.
   * Dùng pMapLimit để cũng tận dụng concurrency.
   */
  protected async processRecords(records: any[]): Promise<SyncResult> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const context = await this.preloadLookups(records);

    const results = await pMapLimit(records, this.concurrency, (record) =>
      this.upsertRecordWithContext(record, context).catch((error) => {
        this.logger.error(
          `❌ Failed to sync ${this.entityName} record: ${error.message}`,
        );
        return 'skipped' as const;
      }),
    );

    for (const r of results) {
      if (r === 'created') created++;
      else if (r === 'updated') updated++;
      else skipped++;
    }

    this.logger.log(
      `✅ ${this.entityName}: ${created} created, ${updated} updated, ${skipped} skipped`,
    );
    return { created, updated, skipped };
  }
}
