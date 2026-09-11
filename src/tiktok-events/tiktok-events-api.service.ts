import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TIKTOK_ERROR_CLASSIFICATION,
  TiktokEventPayload,
} from './tiktok-events-payload';

const HTTP_TIMEOUT_MS = 10_000;
const TIKTOK_API_URL =
  'https://business-api.tiktok.com/open_api/v1.3/event/track/';

export interface TiktokSendResult {
  success: boolean;
  classification: string;
  httpStatus?: number;
  errorMessage?: string;
}

@Injectable()
export class TiktokEventsApiService {
  private readonly logger = new Logger(TiktokEventsApiService.name);

  constructor(private configService: ConfigService) {}

  async sendEvent(payload: TiktokEventPayload): Promise<TiktokSendResult> {
    const accessToken =
      this.configService.get<string>('TIKTOK_ACCESS_TOKEN') || '';

    if (!accessToken) {
      return {
        success: false,
        classification: TIKTOK_ERROR_CLASSIFICATION.PERMANENT,
        errorMessage: 'Missing TIKTOK_ACCESS_TOKEN',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(TIKTOK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': accessToken,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const httpStatus = response.status;
        const code = responseBody?.code;
        const message = responseBody?.message || `HTTP ${httpStatus}`;

        const classification = this.classifyError(httpStatus, code);

        return {
          success: false,
          classification,
          httpStatus,
          errorMessage: `code=${code} ${message}`,
        };
      }

      const code = responseBody?.code;
      if (code !== undefined && code !== 0) {
        const message = responseBody?.message || 'Unknown TikTok error';
        const classification = this.classifyBusinessError(code);
        return {
          success: false,
          classification,
          httpStatus: response.status,
          errorMessage: `code=${code} ${message}`,
        };
      }

      return {
        success: true,
        classification: TIKTOK_ERROR_CLASSIFICATION.RETRYABLE,
        httpStatus: response.status,
      };
    } catch (err: any) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        return {
          success: false,
          classification: TIKTOK_ERROR_CLASSIFICATION.RETRYABLE,
          errorMessage: 'Request timed out',
        };
      }

      return {
        success: false,
        classification: TIKTOK_ERROR_CLASSIFICATION.RETRYABLE,
        errorMessage: err.message || 'Network error',
      };
    }
  }

  private classifyError(httpStatus: number, code: number | undefined): string {
    if (httpStatus === 429 || httpStatus === 408) {
      return TIKTOK_ERROR_CLASSIFICATION.RETRYABLE;
    }
    if (httpStatus >= 500 && httpStatus < 600) {
      return TIKTOK_ERROR_CLASSIFICATION.RETRYABLE;
    }
    if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) {
      return TIKTOK_ERROR_CLASSIFICATION.PERMANENT;
    }
    return TIKTOK_ERROR_CLASSIFICATION.RETRYABLE;
  }

  private classifyBusinessError(code: number): string {
    // TikTok API business error codes:
    // 40001-40099 = auth/permission → permanent
    // 40101-40199 = rate limit → retryable
    // 50001+ = server error → retryable
    if (code >= 40101 && code <= 40199) {
      return TIKTOK_ERROR_CLASSIFICATION.RETRYABLE;
    }
    if (code >= 50001) {
      return TIKTOK_ERROR_CLASSIFICATION.RETRYABLE;
    }
    return TIKTOK_ERROR_CLASSIFICATION.PERMANENT;
  }
}
