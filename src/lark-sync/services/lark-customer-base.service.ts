import { Injectable, Inject, Logger } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { ConfigService } from '@nestjs/config';
import { LARK_CLIENT } from '../lark-client.provider';

/**
 * Service riêng cho base khách hàng (LARK_EXPENSE_BASE_TOKEN — base "Quản lý
 * Tài chính", cùng base với phiếu chi). Tách khỏi LarkBaseService (vốn khoá vào
 * base Order) để tránh lẫn token. Cấu trúc method mirror LarkBaseService.
 */
@Injectable()
export class LarkCustomerBaseService {
  private readonly logger = new Logger(LarkCustomerBaseService.name);
  private readonly baseToken: string | null;

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly config: ConfigService,
  ) {
    this.baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN') || null;
    if (!this.baseToken) {
      this.logger.warn(
        'LARK_EXPENSE_BASE_TOKEN chưa cấu hình — sync khách hàng sẽ bị skip',
      );
    }
  }

  isEnabled(): boolean {
    return !!this.baseToken;
  }

  /**
   * Tạo 1 record — dùng cho real-time sync
   */
  async createRecord(
    tableId: string,
    fields: Record<string, any>,
  ): Promise<string | null> {
    if (!this.baseToken) return null;
    try {
      const res = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.baseToken, table_id: tableId },
        data: { fields },
      });

      if (res?.code && res.code !== 0) {
        const err: any = new Error(
          res.msg || `Lark API error code: ${res.code}`,
        );
        err.code = res.code;
        throw err;
      }

      return res?.data?.record?.record_id || null;
    } catch (error: any) {
      this.logger.error(`Create customer record failed: ${error.message}`);
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
    if (!this.baseToken) return;
    try {
      const res = await this.client.bitable.appTableRecord.update({
        path: {
          app_token: this.baseToken,
          table_id: tableId,
          record_id: recordId,
        },
        data: { fields },
      });

      if (res?.code && res.code !== 0) {
        const err: any = new Error(
          res.msg || `Lark API error code: ${res.code}`,
        );
        err.code = res.code;
        throw err;
      }
    } catch (error: any) {
      this.logger.error(
        `Update customer record ${recordId} failed: ${error.message}`,
      );
      throw error;
    }
  }

  async batchCreateRecords(
    tableId: string,
    records: Array<{ fields: Record<string, any> }>,
  ): Promise<string[]> {
    if (!this.baseToken) return [];
    const recordIds: string[] = [];
    const chunks = this.chunkArray(records, 500);

    for (const chunk of chunks) {
      try {
        const res = await this.client.bitable.appTableRecord.batchCreate({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { records: chunk },
        });

        if (res?.code && res.code !== 0) {
          const err: any = new Error(
            res.msg || `Lark API error code: ${res.code}`,
          );
          err.code = res.code;
          throw err;
        }

        const ids =
          res?.data?.records
            ?.map((r) => r.record_id)
            .filter((id): id is string => !!id) || [];

        this.logger.log(
          `Batch created chunk: ${chunk.length} input → ${ids.length} IDs returned`,
        );

        recordIds.push(...ids);
      } catch (error: any) {
        this.logger.error(`Batch create failed: ${error.message}`);
        throw error;
      }

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
    if (!this.baseToken) return;
    const chunks = this.chunkArray(records, 500);

    for (const chunk of chunks) {
      try {
        const res = await this.client.bitable.appTableRecord.batchUpdate({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { records: chunk },
        });

        if (res?.code && res.code !== 0) {
          const err: any = new Error(
            res.msg || `Lark API error code: ${res.code}`,
          );
          err.code = res.code;
          throw err;
        }
      } catch (error: any) {
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
    if (!this.baseToken) return null;
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
    } catch (error: any) {
      this.logger.error(`Search record failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Lấy tất cả records từ Lark (có phân trang) — dùng cho full sync.
   * Trả về Map<fieldValue, recordId> theo fieldNames[0].
   */
  async fetchAllRecords(
    tableId: string,
    fieldNames: string[],
  ): Promise<Map<string, string>> {
    const codeToRecordId = new Map<string, string>();
    if (!this.baseToken) return codeToRecordId;
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
          const raw = item.fields?.[fieldNames[0]];
          const code = this.flattenText(raw);
          const recordId = item.record_id;
          if (code && recordId) {
            codeToRecordId.set(code, recordId);
          }
        }

        hasMore = res?.data?.has_more || false;
        pageToken = res?.data?.page_token;
      } catch (error: any) {
        this.logger.error(`Fetch all records failed: ${error.message}`);
        break;
      }
    }

    return codeToRecordId;
  }

  /**
   * Kiểm tra record IDs nào còn tồn tại trên Lark (batch, tối đa 100/lần)
   */
  async verifyRecordIds(
    tableId: string,
    recordIds: string[],
  ): Promise<Set<string>> {
    const existingIds = new Set<string>();
    if (!this.baseToken) return existingIds;
    const chunks = this.chunkArray(recordIds, 100);

    for (const chunk of chunks) {
      try {
        const res = await this.client.bitable.appTableRecord.batchGet({
          path: { app_token: this.baseToken, table_id: tableId },
          data: { record_ids: chunk },
        });

        if (res?.code && res.code !== 0) {
          this.logger.warn(`batchGet returned code ${res.code}: ${res.msg}`);
          chunk.forEach((id) => existingIds.add(id));
          continue;
        }

        const records = res?.data?.records || [];
        for (const record of records) {
          if (record.record_id) {
            existingIds.add(record.record_id);
          }
        }
      } catch (error: any) {
        this.logger.error(`Verify records failed: ${error.message}`);
        chunk.forEach((id) => existingIds.add(id));
      }

      if (chunks.length > 1) {
        await this.delay(300);
      }
    }

    return existingIds;
  }

  /**
   * Lark trả code 1254043 khi record_id không còn tồn tại.
   */
  isRecordNotFound(error: any): boolean {
    const code = error?.code ?? error?.response?.data?.code ?? error?.errCode;
    return code === 1254043;
  }

  /**
   * Lark text field có thể trả về string, hoặc mảng segment { text }.
   */
  private flattenText(value: any): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((seg) => (typeof seg === 'string' ? seg : (seg?.text ?? '')))
        .join('');
    }
    if (typeof value === 'object' && typeof value.text === 'string') {
      return value.text;
    }
    return String(value);
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
