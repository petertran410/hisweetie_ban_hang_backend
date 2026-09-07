import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { META_ERROR_CLASSIFICATION, MetaPurchasePayload } from './meta-purchase-payload';

const HTTP_TIMEOUT_MS = 10_000;

export interface CapiSendResult {
  success: boolean;
  classification: string;
  httpStatus?: number;
  metaErrorCode?: number;
  errorMessage?: string;
}

@Injectable()
export class MetaConversionsApiService {
  private readonly logger = new Logger(MetaConversionsApiService.name);

  constructor(private configService: ConfigService) {}

  private getConfig(): {
    accessToken: string;
    datasetId: string;
    apiVersion: string;
    testEventCode: string;
  } {
    return {
      accessToken:
        this.configService.get<string>('META_CAPI_ACCESS_TOKEN') || '',
      datasetId:
        this.configService.get<string>('META_DATASET_ID') || '',
      apiVersion:
        this.configService.get<string>('META_GRAPH_API_VERSION') || 'v21.0',
      testEventCode:
        this.configService.get<string>('META_TEST_EVENT_CODE') || '',
    };
  }

  async sendEvent(payload: MetaPurchasePayload): Promise<CapiSendResult> {
    const config = this.getConfig();

    if (!config.accessToken || !config.datasetId) {
      return {
        success: false,
        classification: META_ERROR_CLASSIFICATION.PERMANENT,
        errorMessage: 'Missing META_CAPI_ACCESS_TOKEN or META_DATASET_ID',
      };
    }

    const url = `https://graph.facebook.com/${config.apiVersion}/${config.datasetId}/events`;

    const body: Record<string, any> = {
      data: [payload],
    };

    if (config.testEventCode) {
      body.test_event_code = config.testEventCode;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const metaError = responseBody?.error;
        const httpStatus = response.status;
        const metaErrorCode = metaError?.code ?? null;
        const errorMessage = metaError?.message || `HTTP ${httpStatus}`;

        const classification = this.classifyError(
          httpStatus,
          metaErrorCode,
          metaError?.is_transient,
        );

        return {
          success: false,
          classification,
          httpStatus,
          metaErrorCode,
          errorMessage,
        };
      }

      const eventsReceived = responseBody?.events_received ?? 0;
      const messages = responseBody?.messages;

      if (eventsReceived < 1) {
        const firstMessage = messages?.[0];
        return {
          success: false,
          classification: META_ERROR_CLASSIFICATION.RETRYABLE,
          httpStatus: response.status,
          metaErrorCode: firstMessage?.error_code ?? null,
          errorMessage:
            firstMessage?.description ||
            `events_received=${eventsReceived}`,
        };
      }

      return {
        success: true,
        classification: META_ERROR_CLASSIFICATION.RETRYABLE,
        httpStatus: response.status,
      };
    } catch (err: any) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        return {
          success: false,
          classification: META_ERROR_CLASSIFICATION.RETRYABLE,
          errorMessage: 'Request timed out',
        };
      }

      return {
        success: false,
        classification: META_ERROR_CLASSIFICATION.RETRYABLE,
        errorMessage: err.message || 'Network error',
      };
    }
  }

  private classifyError(
    httpStatus: number,
    metaErrorCode: number | null,
    isTransient: boolean | undefined,
  ): string {
    if (isTransient === true) {
      return META_ERROR_CLASSIFICATION.RETRYABLE;
    }

    if (httpStatus === 408 || httpStatus === 429) {
      return META_ERROR_CLASSIFICATION.RETRYABLE;
    }

    if (httpStatus >= 500 && httpStatus < 600) {
      return META_ERROR_CLASSIFICATION.RETRYABLE;
    }

    if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
      return META_ERROR_CLASSIFICATION.PERMANENT;
    }

    if (metaErrorCode === 190) {
      return META_ERROR_CLASSIFICATION.PERMANENT;
    }

    if (metaErrorCode !== null && metaErrorCode >= 100 && metaErrorCode < 200) {
      return META_ERROR_CLASSIFICATION.PERMANENT;
    }

    return META_ERROR_CLASSIFICATION.RETRYABLE;
  }
}