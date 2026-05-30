import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export interface SyncDataResponse<T = any> {
  data: T[];
  total: number;
  pageSize: number;
  currentItem: number;
}

@Injectable()
export class SyncKiotApiService {
  private readonly logger = new Logger(SyncKiotApiService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'SYNC_KIOT_API_URL',
      'http://localhost:8083',
    );
    this.apiKey = this.configService.get<string>('SYNC_KIOT_API_KEY', '');
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
    };
  }

  /**
   * Fetch 1 page. Dùng cho pipeline streaming (fetch song song với process).
   */
  async fetchPage<T = any>(
    endpoint: string,
    currentItem: number,
    pageSize: number,
    modifiedFrom?: string,
  ): Promise<{ data: T[]; total: number } | null> {
    const params: Record<string, string> = {
      pageSize: String(pageSize),
      currentItem: String(currentItem),
    };
    if (modifiedFrom) params.modifiedFrom = modifiedFrom;

    try {
      const response = await firstValueFrom(
        this.httpService.get<SyncDataResponse<T>>(
          `${this.baseUrl}/sync-data/${endpoint}`,
          { headers: this.headers, params, timeout: 60000 },
        ),
      );
      const { data, total } = response.data;
      return { data: data || [], total: total || 0 };
    } catch (error) {
      const status = error.response?.status;
      const responseData = error.response?.data;
      const errorCode = error.code;
      this.logger.error(
        `❌ fetchPage ${endpoint} offset=${currentItem}: ` +
          `code=${errorCode}, status=${status}, message=${error.message}, ` +
          `data=${JSON.stringify(responseData)}`,
      );
      throw error;
    }
  }

  /**
   * Eager fetch all (cũ — dồn vào RAM trước khi process).
   * Giữ để các service chưa migrate sang streaming vẫn dùng được.
   */
  async fetchAll<T = any>(
    endpoint: string,
    modifiedFrom?: string,
  ): Promise<T[]> {
    const allData: T[] = [];
    let currentItem = 0;
    const pageSize = 1000;

    while (true) {
      const page = await this.fetchPage<T>(
        endpoint,
        currentItem,
        pageSize,
        modifiedFrom,
      );
      if (!page) break;
      const { data, total } = page;
      if (!data || data.length === 0) break;
      allData.push(...data);
      currentItem += data.length;
      this.logger.log(`📄 ${endpoint}: ${allData.length}/${total} fetched`);
      if (allData.length >= total) break;
    }

    return allData;
  }

  async fetchByCode<T = any>(
    endpoint: string,
    code: string,
  ): Promise<T | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<T>(
          `${this.baseUrl}/sync-data/${endpoint}/${code}`,
          { headers: this.headers, timeout: 15000 },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`⚠️ ${endpoint}/${code} not found: ${error.message}`);
      return null;
    }
  }
}
