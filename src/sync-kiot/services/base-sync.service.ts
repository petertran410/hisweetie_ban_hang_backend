import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
}

export abstract class BaseSyncService {
  protected abstract readonly entityName: string;
  protected abstract readonly endpoint: string;
  protected readonly logger: Logger;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly api: SyncKiotApiService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  async syncAll(): Promise<SyncResult> {
    this.logger.log(`🔄 Syncing all ${this.entityName}...`);
    const data = await this.api.fetchAll(this.endpoint);
    return this.processRecords(data);
  }

  async syncIncremental(): Promise<SyncResult> {
    const control = await this.prisma.syncControl.findUnique({
      where: { entityType: this.entityName },
    });
    const modifiedFrom = control?.lastSyncAt?.toISOString();

    this.logger.log(
      `🔄 Incremental sync ${this.entityName} since ${modifiedFrom || 'beginning'}...`,
    );

    const data = await this.api.fetchAll(this.endpoint, modifiedFrom);
    return this.processRecords(data);
  }

  async syncWindow(fromDate: string): Promise<SyncResult> {
    this.logger.log(`🔄 Window sync ${this.entityName} since ${fromDate}...`);
    const data = await this.api.fetchAll(this.endpoint, fromDate);
    return this.processRecords(data);
  }

  protected async processRecords(records: any[]): Promise<SyncResult> {
    let created = 0,
      updated = 0,
      skipped = 0;

    for (const record of records) {
      try {
        const result = await this.upsertRecord(record);
        if (result === 'created') created++;
        else if (result === 'updated') updated++;
        else skipped++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to sync ${this.entityName} record: ${error.message}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `✅ ${this.entityName}: ${created} created, ${updated} updated, ${skipped} skipped`,
    );
    return { created, updated, skipped };
  }

  protected abstract upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'>;
}
