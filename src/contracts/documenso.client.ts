import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as FormData from 'form-data';

/**
 * ⚠️ Documenso self-host bản 2.13 — model "Envelope" (gộp document + template).
 * API v2 khác docs cũ:
 *  - Tạo từ template: POST /template/use (trả id:number + envelopeId:string)
 *  - Gửi: POST /envelope/distribute  body {envelopeId}  (trả recipients[].signingUrl)
 *  - Tải PDF: GET /document/{numericId}/download  (id số, lấy từ secondaryId "document_N")
 *  - Lấy chi tiết: GET /envelope/{envelopeId}
 */

export interface DocumensoTemplateField {
  id: number;
  type: string;
  recipientId?: number;
  fieldMeta?: { label?: string; [k: string]: any };
  [k: string]: any;
}

export interface DocumensoTemplateRecipient {
  id: number;
  email: string;
  name?: string;
  role: string;
  signingOrder?: number;
}

export interface DocumensoTemplate {
  id: number;
  envelopeId: string;
  title: string;
  recipients: DocumensoTemplateRecipient[];
  fields: DocumensoTemplateField[];
  [k: string]: any;
}

export interface DocumensoRecipientResult {
  id: number;
  email: string;
  name?: string;
  role: string;
  token?: string;
  signingStatus?: string;
  signingUrl?: string;
}

/** Kết quả chuẩn hóa sau khi tạo/gửi — gói các id cần lưu. */
export interface DocumensoEnvelopeResult {
  /** envelope id string, vd "envelope_abc123" — dùng cho /envelope/{id}. */
  envelopeId: string;
  /** id số (document) — dùng cho /document/{id}/download. */
  documentNumericId: number | null;
  /** secondaryId vd "document_3". */
  secondaryId: string | null;
  status: string;
  externalId: string | null;
  recipients: DocumensoRecipientResult[];
}

export interface PrefillField {
  id: number;
  type: string;
  value: string | string[];
  label?: string;
}

@Injectable()
export class DocumensoClient {
  private readonly logger = new Logger(DocumensoClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly publicUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // vd: http://localhost:3000/api/v2
    this.baseUrl = (
      this.configService.get<string>('DOCUMENSO_URL') || ''
    ).replace(/\/$/, '');
    this.apiKey = this.configService.get<string>('DOCUMENSO_API_KEY') || '';
    // Public URL để build signingUrl từ token (suy ra từ DOCUMENSO_URL nếu thiếu).
    this.publicUrl = (
      this.configService.get<string>('DOCUMENSO_PUBLIC_URL') ||
      this.baseUrl.replace(/\/api\/v2$/, '')
    ).replace(/\/$/, '');
  }

  private ensureConfigured() {
    if (!this.baseUrl || !this.apiKey) {
      throw new InternalServerErrorException(
        'Documenso chưa được cấu hình (thiếu DOCUMENSO_URL hoặc DOCUMENSO_API_KEY)',
      );
    }
  }

  private get authHeaders() {
    return { Authorization: this.apiKey };
  }

  /** Chuẩn hóa response (template/use hoặc envelope GET) → DocumensoEnvelopeResult. */
  private normalizeEnvelope(raw: any): DocumensoEnvelopeResult {
    const envelopeId: string =
      typeof raw?.envelopeId === 'string'
        ? raw.envelopeId
        : typeof raw?.id === 'string'
          ? raw.id
          : '';
    const secondaryId: string | null = raw?.secondaryId || null;
    // numeric document id: ưu tiên secondaryId "document_N", fallback raw.id nếu number.
    let documentNumericId: number | null = null;
    if (secondaryId && /^document_(\d+)$/.test(secondaryId)) {
      documentNumericId = Number(secondaryId.replace('document_', ''));
    } else if (typeof raw?.id === 'number') {
      documentNumericId = raw.id;
    }
    const recipients: DocumensoRecipientResult[] = (raw?.recipients || []).map(
      (r: any) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        token: r.token,
        signingStatus: r.signingStatus,
        signingUrl:
          r.signingUrl ||
          (r.token ? `${this.publicUrl}/sign/${r.token}` : undefined),
      }),
    );
    return {
      envelopeId,
      documentNumericId,
      secondaryId,
      status: raw?.status || 'DRAFT',
      externalId: raw?.externalId ?? null,
      recipients,
    };
  }

  /** Lấy template (resolve field label → id cho prefill + tìm recipient slot). */
  async getTemplate(templateId: number): Promise<DocumensoTemplate> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get<DocumensoTemplate>(
          `${this.baseUrl}/template/${templateId}`,
          { headers: this.authHeaders },
        ),
      );
      return res.data;
    } catch (err) {
      this.handleError('getTemplate', err);
    }
  }

  /**
   * Tạo document từ template (+ tùy chọn distribute ngay).
   * POST /template/use
   */
  async useTemplate(body: {
    templateId: number;
    recipients: { id: number; email: string; name?: string }[];
    prefillFields?: PrefillField[];
    override?: Record<string, any>;
    distributeDocument?: boolean;
    externalId?: string;
  }): Promise<DocumensoEnvelopeResult> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/template/use`, body, {
          headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
        }),
      );
      return this.normalizeEnvelope(res.data);
    } catch (err) {
      this.handleError('useTemplate', err);
    }
  }

  /**
   * Tạo envelope từ PDF upload (multipart). payload + files.
   * POST /envelope/create
   */
  async createEnvelope(params: {
    title: string;
    recipientEmail: string;
    recipientName?: string;
    externalId?: string;
    fileBuffer: Buffer;
    fileName: string;
  }): Promise<DocumensoEnvelopeResult> {
    this.ensureConfigured();
    const payload: any = {
      type: 'DOCUMENT',
      title: params.title,
      externalId: params.externalId,
      recipients: [
        {
          email: params.recipientEmail,
          name: params.recipientName || params.recipientEmail,
          role: 'SIGNER',
          fields: [
            {
              identifier: 0,
              type: 'SIGNATURE',
              page: 1,
              positionX: 10,
              positionY: 85,
              width: 30,
              height: 5,
            },
            {
              identifier: 0,
              type: 'DATE',
              page: 1,
              positionX: 50,
              positionY: 85,
              width: 20,
              height: 3,
            },
          ],
        },
      ],
    };

    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('files', params.fileBuffer, {
      filename: params.fileName,
      contentType: 'application/pdf',
    });

    try {
      const res = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/envelope/create`, form, {
          headers: { ...this.authHeaders, ...form.getHeaders() },
        }),
      );
      return this.normalizeEnvelope(res.data);
    } catch (err) {
      this.handleError('createEnvelope', err);
    }
  }

  /**
   * Gửi document cho recipient. POST /envelope/distribute  body {envelopeId}.
   * Trả về recipients kèm signingUrl.
   */
  async distribute(envelopeId: string): Promise<DocumensoEnvelopeResult> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/envelope/distribute`,
          { envelopeId },
          { headers: { ...this.authHeaders, 'Content-Type': 'application/json' } },
        ),
      );
      return this.normalizeEnvelope(res.data);
    } catch (err) {
      this.handleError('distribute', err);
    }
  }

  /** Lấy chi tiết envelope. GET /envelope/{envelopeId} */
  async getEnvelope(envelopeId: string): Promise<DocumensoEnvelopeResult> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/envelope/${envelopeId}`, {
          headers: this.authHeaders,
        }),
      );
      return this.normalizeEnvelope(res.data);
    } catch (err) {
      this.handleError('getEnvelope', err);
    }
  }

  /**
   * Tải PDF đã ký. GET /document/{numericId}/download — trả PDF buffer trực tiếp.
   * Chỉ có khi tất cả recipient đã ký xong.
   */
  async downloadSignedPdf(documentNumericId: number): Promise<Buffer> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/document/${documentNumericId}/download`,
          { headers: this.authHeaders, responseType: 'arraybuffer' },
        ),
      );
      return Buffer.from(res.data);
    } catch (err) {
      this.handleError('downloadSignedPdf', err);
    }
  }

  private handleError(method: string, err: any): never {
    const status = err?.response?.status;
    const data = err?.response?.data;
    let dataStr = '';
    try {
      dataStr = Buffer.isBuffer(data)
        ? data.toString('utf8').slice(0, 500)
        : JSON.stringify(data)?.slice(0, 500);
    } catch {
      dataStr = String(data).slice(0, 500);
    }
    this.logger.error(`Documenso ${method} lỗi: status=${status} ${dataStr}`);
    throw new InternalServerErrorException(
      `Documenso ${method} thất bại${status ? ` (HTTP ${status})` : ''}`,
    );
  }
}
