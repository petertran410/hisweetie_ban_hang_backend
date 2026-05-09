import { Injectable, Inject, Logger } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { ConfigService } from '@nestjs/config';
import { LARK_CLIENT } from '../lark-client.provider';

@Injectable()
export class LarkBaseService {
  private readonly logger = new Logger(LarkBaseService.name);
  private readonly baseToken: string;

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly config: ConfigService,
  ) {
    const token = this.config.get<string>('LARK_BASE_TOKEN');
    if (!token) {
      throw new Error('LARK_BASE_TOKEN must be configured');
    }
    this.baseToken = token;
    if (!this.baseToken) {
      throw new Error('LARK_BASE_TOKEN must be configured');
    }
  }

  /**
   * Tạo 1 record — dùng cho real-time sync
   */
  async createRecord(
    tableId: string,
    fields: Record<string, any>,
  ): Promise<string | null> {
    try {
      const res = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.baseToken, table_id: tableId },
        data: { fields },
      });

      return res?.data?.record?.record_id || null;
    } catch (error) {
      this.logger.error(`Create record failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cập nhật 1 record — dùng cho real-time sync
   */
  async updateRecord(
    tableId: string,
    recordId: string,
    fields: Record<string, any>,
  ): Promise<void> {
    try {
      await this.client.bitable.appTableRecord.update({
        path: {
          app_token: this.baseToken,
          table_id: tableId,
          record_id: recordId,
        },
        data: { fields },
      });
    } catch (error) {
      this.logger.error(`Update record ${recordId} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Batch tạo records — dùng cho cron/full sync (tối đa 500/lần)
   */
  async batchCreateRecords(
    tableId: string,
    records: Array<{ fields: Record<string, any> }>,
  ): Promise<string[]> {
    const recordIds: string[] = [];
    const chunks = this.chunkArray(records, 500);

    for (const chunk of chunks) {
      try {
        const res = await this.client.bitable.appTableRecord.batchCreate({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { records: chunk },
        });

        const ids =
          res?.data?.records
            ?.map((r) => r.record_id)
            .filter((id): id is string => !!id) || [];
        recordIds.push(...ids);
      } catch (error) {
        this.logger.error(`Batch create failed: ${error.message}`);
        throw error;
      }

      // Tránh rate limit
      if (chunks.length > 1) {
        await this.delay(500);
      }
    }

    return recordIds;
  }

  /**
   * Batch cập nhật records — dùng cho cron/full sync (tối đa 500/lần)
   */
  async batchUpdateRecords(
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, any> }>,
  ): Promise<void> {
    const chunks = this.chunkArray(records, 500);

    for (const chunk of chunks) {
      try {
        await this.client.bitable.appTableRecord.batchUpdate({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { records: chunk },
        });
      } catch (error) {
        this.logger.error(`Batch update failed: ${error.message}`);
        throw error;
      }

      if (chunks.length > 1) {
        await this.delay(500);
      }
    }
  }

  /**
   * Tìm record theo field value — dùng khi không có larkRecordId
   */
  async searchRecord(
    tableId: string,
    fieldName: string,
    value: string,
  ): Promise<string | null> {
    try {
      const res = await this.client.bitable.appTableRecord.search({
        path: { app_token: this.baseToken, table_id: tableId },
        data: {
          field_names: [fieldName],
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: fieldName, operator: 'is', value: [value] },
            ],
          },
        },
      });

      const items = res?.data?.items || [];
      return items.length > 0 ? (items[0].record_id ?? null) : null;
    } catch (error) {
      this.logger.error(`Search record failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Lấy tất cả records từ Lark (có phân trang) — dùng cho full sync
   */
  async fetchAllRecords(
    tableId: string,
    fieldNames: string[],
  ): Promise<Map<string, string>> {
    const codeToRecordId = new Map<string, string>();
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      try {
        const res = await this.client.bitable.appTableRecord.list({
          path: { app_token: this.baseToken, table_id: tableId },
          params: {
            page_size: 500,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        const items = res?.data?.items || [];
        for (const item of items) {
          const code = item.fields?.[fieldNames[0]];
          const recordId = item.record_id;
          if (code && typeof code === 'string' && recordId) {
            codeToRecordId.set(code, recordId);
          }
        }

        hasMore = res?.data?.has_more || false;
        pageToken = res?.data?.page_token;
      } catch (error) {
        this.logger.error(`Fetch all records failed: ${error.message}`);
        break;
      }
    }

    return codeToRecordId;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
