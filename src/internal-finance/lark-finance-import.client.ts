import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import type { LarkTableRef } from './internal-finance-lark-import.mapper';

export interface LarkImportRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface LarkRecordPageInfo {
  page: number;
  pageRecords: number;
  totalFetched: number;
  hasMore: boolean;
}

interface LarkItem {
  table_id?: string;
  name?: string;
  field_name?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

interface LarkResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  data?: {
    items?: LarkItem[];
    records?: LarkItem[];
    has_more?: boolean;
    page_token?: string;
  };
}

@Injectable()
export class LarkFinanceImportClient {
  constructor(private readonly config: ConfigService) {}

  async getToken(): Promise<string> {
    const appId = this.config.get<string>('LARK_APP_ID');
    const appSecret = this.config.get<string>('LARK_APP_SECRET');
    if (!appId || !appSecret) {
      throw new Error('LARK_APP_ID hoặc LARK_APP_SECRET chưa được cấu hình');
    }
    const payload = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const response = await this.requestJson({
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: payload,
    });
    if (!response.tenant_access_token) {
      throw new Error(response.msg || 'Không lấy được token Lark');
    }
    return String(response.tenant_access_token);
  }

  async listTables(baseToken: string, token: string): Promise<LarkTableRef[]> {
    const tables: LarkTableRef[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.requestJson({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${baseToken}/tables?${query.toString()}`,
        token,
      });
      this.assertOk(response, 'Không đọc được danh sách bảng Lark');
      for (const item of response.data?.items || []) {
        if (item?.table_id && item?.name) {
          tables.push({
            tableId: String(item.table_id),
            name: String(item.name),
          });
        }
      }
      hasMore = Boolean(response.data?.has_more);
      pageToken = response.data?.page_token;
    }
    return tables;
  }

  async listFieldNames(
    baseToken: string,
    tableId: string,
    token: string,
  ): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.requestJson({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?${query.toString()}`,
        token,
      });
      this.assertOk(response, 'Không đọc được field Lark');
      for (const item of response.data?.items || []) {
        if (item?.field_name) names.push(String(item.field_name));
      }
      hasMore = Boolean(response.data?.has_more);
      pageToken = response.data?.page_token;
    }
    return names;
  }

  async forEachRecordPage(
    baseToken: string,
    tableId: string,
    token: string,
    onPage: (
      records: LarkImportRecord[],
      pageInfo?: LarkRecordPageInfo,
    ) => Promise<void>,
  ): Promise<number> {
    let pageToken: string | undefined;
    let hasMore = true;
    let total = 0;
    let page = 0;
    while (hasMore) {
      page += 1;
      const query = new URLSearchParams({
        page_size: '500',
        automatic_fields: 'true',
      });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.requestJson({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${query.toString()}`,
        token,
      });
      this.assertOk(response, 'Không đọc được record Lark');
      const records = (response.data?.items || []).flatMap((item) => {
        if (!item.record_id) return [];
        return [
          {
            recordId: item.record_id,
            fields: item.fields || {},
          },
        ];
      });
      total += records.length;
      hasMore = Boolean(response.data?.has_more);
      pageToken = response.data?.page_token;
      if (records.length) {
        await onPage(records, {
          page,
          pageRecords: records.length,
          totalFetched: total,
          hasMore,
        });
      }
    }
    return total;
  }

  async getRecordsByIds(
    baseToken: string,
    tableId: string,
    token: string,
    recordIds: string[],
  ): Promise<LarkImportRecord[]> {
    const records: LarkImportRecord[] = [];
    for (let index = 0; index < recordIds.length; index += 100) {
      const batch = recordIds.slice(index, index + 100);
      const response = await this.requestJson({
        method: "POST",
        path: `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_get`,
        token,
        body: JSON.stringify({ record_ids: batch }),
      });
      this.assertOk(response, "Không đọc được khách hàng Lark");
      const rows = response.data?.records?.length
        ? response.data.records
        : response.data?.items || [];
      for (const item of rows) {
        const recordId = item.record_id ? String(item.record_id) : "";
        if (!recordId) continue;
        records.push({ recordId, fields: item.fields || {} });
      }
    }
    return records;
  }

  async download(url: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 45000,
        },
        (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`Tải file Lark thất bại (${response.statusCode})`),
            );
            response.resume();
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Tải file Lark quá thời gian'));
      });
    });
  }

  private assertOk(response: LarkResponse, fallback: string) {
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || fallback);
    }
  }

  private requestJson(input: {
    method: 'GET' | 'POST';
    path: string;
    token?: string;
    body?: string;
  }): Promise<LarkResponse> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: 'open.larksuite.com',
          path: input.path,
          method: input.method,
          headers: {
            ...(input.body
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(input.body),
                }
              : {}),
            ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
          },
          timeout: 45000,
        },
        (response) => {
          let data = '';
          response.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          response.on('end', () => {
            try {
              resolve(parseLarkResponse(data));
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error('Lark trả JSON lỗi'),
              );
            }
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Lark quá thời gian phản hồi'));
      });
      if (input.body) request.write(input.body);
      request.end();
    });
  }
}

function parseLarkResponse(raw: string): LarkResponse {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return {};
  const record = parsed as Record<string, unknown>;
  const data = record.data;
  const dataRecord =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    code: typeof record.code === 'number' ? record.code : undefined,
    msg: typeof record.msg === 'string' ? record.msg : undefined,
    tenant_access_token:
      typeof record.tenant_access_token === 'string'
        ? record.tenant_access_token
        : undefined,
    data: {
      has_more: dataRecord.has_more === true,
      page_token:
        typeof dataRecord.page_token === 'string'
          ? dataRecord.page_token
          : undefined,
      items: Array.isArray(dataRecord.items)
        ? dataRecord.items.filter(isLarkItem)
        : [],
      records: Array.isArray(dataRecord.records)
        ? dataRecord.records.filter(isLarkItem)
        : [],
    },
  };
}

function isLarkItem(value: unknown): value is LarkItem {
  return Boolean(value) && typeof value === 'object';
}
