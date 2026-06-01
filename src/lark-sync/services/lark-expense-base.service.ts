import { Injectable, Inject, Logger } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { ConfigService } from '@nestjs/config';
import { LARK_CLIENT } from '../lark-client.provider';

/**
 * Service riêng cho base "Quản lý Tài chính" (LARK_EXPENSE_BASE_TOKEN).
 * Tách khỏi LarkBaseService (vốn khoá vào base Order) để tránh lẫn token.
 */
@Injectable()
export class LarkExpenseBaseService {
  private readonly logger = new Logger(LarkExpenseBaseService.name);
  private readonly baseToken: string | null;

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly config: ConfigService,
  ) {
    this.baseToken =
      this.config.get<string>('LARK_EXPENSE_BASE_TOKEN') || null;
    if (!this.baseToken) {
      this.logger.warn(
        'LARK_EXPENSE_BASE_TOKEN chưa cấu hình — sync phiếu chi sẽ bị skip',
      );
    }
  }

  isEnabled(): boolean {
    return !!this.baseToken;
  }

  getBaseToken(): string | null {
    return this.baseToken;
  }

  /**
   * Tạo 1 record. Trả về record_id, hoặc null nếu thất bại.
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
      this.logger.error(
        `Create expense record table=${tableId} failed: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Upload 1 file (image/pdf/...) vào Lark Drive với parent_type=bitable
   * → trả về file_token để gắn vào field Attachment.
   *
   * Reference: POST /open-apis/drive/v1/medias/upload_all
   */
  async uploadMediaForBitable(
    fileName: string,
    parentNode: string, // app_token
    fileBuffer: Buffer,
    mimeType?: string,
  ): Promise<string | null> {
    try {
      const res: any = await this.client.drive.media.uploadAll({
        data: {
          file_name: fileName,
          parent_type: 'bitable_file',
          parent_node: parentNode,
          size: fileBuffer.length,
          file: fileBuffer as any,
          ...(mimeType ? { extra: JSON.stringify({ mimeType }) } : {}),
        },
      });

      // SDK trả về 2 dạng tuỳ version:
      // - Dạng 1 (mới): { file_token?: string } | null
      // - Dạng 2 (cũ): { code, msg, data: { file_token } }
      if (res === null || res === undefined) {
        this.logger.warn(
          `uploadMediaForBitable returned null for file=${fileName}`,
        );
        return null;
      }

      // Dạng 2: có code field
      if ('code' in res) {
        if (res.code !== 0) {
          this.logger.warn(
            `uploadMediaForBitable code=${res.code} msg=${res.msg} file=${fileName}`,
          );
          return null;
        }
        return res?.data?.file_token || null;
      }

      // Dạng 1: trả trực tiếp { file_token }
      return res?.file_token || null;
    } catch (error: any) {
      this.logger.error(
        `Upload media "${fileName}" to base ${parentNode} failed: ${error.message}`,
      );
      return null;
    }
  }
}
