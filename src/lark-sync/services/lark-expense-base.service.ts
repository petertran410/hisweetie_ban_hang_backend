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
    this.baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN') || null;
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
   * Cập nhật 1 record theo record_id. Ném lỗi nếu thất bại (caller bắt
   * isRecordNotFound để fallback search/create).
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
        `Update expense record ${recordId} table=${tableId} failed: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Tìm tất cả record có <fieldName> = value (vd: Mã Báo Đơn = mã phiếu).
   * Trả về mảng { recordId, text } trong đó text là nội dung field `textField`
   * (vd: "NỘI DUNG") đã được flatten về string để caller match theo loại phí.
   */
  async searchRecordsByField(
    tableId: string,
    fieldName: string,
    value: string,
    textField: string,
  ): Promise<Array<{ recordId: string; text: string }>> {
    if (!this.baseToken) return [];

    try {
      const res = await this.client.bitable.appTableRecord.search({
        path: { app_token: this.baseToken, table_id: tableId },
        data: {
          field_names: [fieldName, textField],
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: fieldName, operator: 'is', value: [value] },
            ],
          },
        },
      });

      const items = res?.data?.items || [];
      return items
        .filter((it): it is typeof it & { record_id: string } => !!it.record_id)
        .map((it) => ({
          recordId: it.record_id,
          text: this.flattenText(it.fields?.[textField]),
        }));
    } catch (error: any) {
      this.logger.error(
        `Search expense records table=${tableId} ${fieldName}=${value} failed: ${error.message}`,
      );
      return [];
    }
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

  /**
   * Lark trả code 1254043 khi record_id không còn tồn tại.
   */
  isRecordNotFound(error: any): boolean {
    const code = error?.code ?? error?.response?.data?.code ?? error?.errCode;
    return code === 1254043;
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
