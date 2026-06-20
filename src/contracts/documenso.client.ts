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

/** Field do recipient "công ty" (ASSISTANT) điền — FE render input động. */
export interface AssistantField {
  fieldId: number;
  type: string;
  label: string;
}

@Injectable()
export class DocumensoClient {
  private readonly logger = new Logger(DocumensoClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly publicUrl: string;
  /** Email placeholder đánh dấu slot "khách hàng" trong template. */
  private readonly customerPlaceholderEmail: string;

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
    this.customerPlaceholderEmail = (
      this.configService.get<string>('DOCUMENSO_CUSTOMER_RECIPIENT_EMAIL') ||
      'khachhang@placeholder.com'
    )
      .trim()
      .toLowerCase();
  }

  /** Recipient này có phải slot khách hàng (theo email placeholder)? */
  isCustomerRecipient(r: { email?: string }): boolean {
    return (r.email || '').trim().toLowerCase() === this.customerPlaceholderEmail;
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

  /**
   * Liệt kê template (loại hợp đồng) để FE chọn. Trả rút gọn — không kèm PDF.
   * GET /template?perPage=100
   */
  async listTemplates(): Promise<
    { id: number; title: string; fieldLabels: string[] }[]
  > {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get<any>(`${this.baseUrl}/template?perPage=100`, {
          headers: this.authHeaders,
        }),
      );
      const list = res.data?.data || [];
      return list.map((t: any) => ({
        id: t.id,
        title: t.title,
        fieldLabels: (t.fields || [])
          .map((f: any) => f?.fieldMeta?.label)
          .filter((l: any) => typeof l === 'string' && l.length > 0),
      }));
    } catch (err) {
      this.handleError('listTemplates', err);
    }
  }

  /**
   * Tìm recipient "công ty điền" trong template.
   * Documenso 2.13 thường để mọi recipient role=SIGNER, nên KHÔNG dựa vào role.
   * Quy ước: recipient có email == placeholder khách (DOCUMENSO_CUSTOMER_RECIPIENT_EMAIL)
   * là slot KHÁCH; recipient còn lại (email công ty thật) là slot CÔNG TY.
   * Fallback (chỉ 1 recipient hoặc không khớp): role ASSISTANT → non-customer đầu tiên.
   */
  private findAssistantRecipient(
    template: DocumensoTemplate,
  ): DocumensoTemplateRecipient | null {
    const recipients = template.recipients || [];
    if (recipients.length === 0) return null;

    // Ưu tiên: recipient KHÔNG phải slot khách hàng.
    const nonCustomer = recipients.filter((r) => !this.isCustomerRecipient(r));
    if (nonCustomer.length > 0) {
      // Nếu có nhiều, ưu tiên role ASSISTANT, rồi recipient đầu tiên.
      return (
        nonCustomer.find(
          (r) => (r.role || '').toUpperCase() === 'ASSISTANT',
        ) || nonCustomer[0]
      );
    }
    // Tất cả recipient đều là placeholder khách (cấu hình lạ) → không có slot công ty.
    return null;
  }

  /** Tìm recipient "khách hàng" (slot sẽ thay bằng khách thật khi gửi). */
  findCustomerRecipient(
    template: DocumensoTemplate,
  ): DocumensoTemplateRecipient | null {
    const recipients = template.recipients || [];
    if (recipients.length === 0) return null;
    // Ưu tiên slot có email placeholder.
    const byPlaceholder = recipients.find((r) => this.isCustomerRecipient(r));
    if (byPlaceholder) return byPlaceholder;
    // Fallback: nếu chỉ 1 recipient → chính nó là khách.
    if (recipients.length === 1) return recipients[0];
    // Nhiều recipient, không có placeholder → lấy SIGNER cuối (khác công ty).
    const company = this.findAssistantRecipient(template);
    const others = recipients.filter((r) => r.id !== company?.id);
    return others[0] || recipients[0];
  }

  /**
   * Lấy danh sách field "công ty điền sẵn" của template — để FE render form động.
   * Quy ước: field có fieldMeta.readOnly === true là field công ty prefill
   * (Documenso "in cứng" giá trị vào PDF ngay, khách thấy nhưng không sửa được).
   * Field readOnly=false (hoặc chữ ký) là phần khách tự điền khi ký → bỏ qua.
   */
  async getAssistantFields(templateId: number): Promise<AssistantField[]> {
    this.ensureConfigured();
    const template = await this.getTemplate(templateId);
    // Field chữ ký không prefill qua API được → bỏ khỏi form POS.
    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    return (template.fields || [])
      .filter((f) => f.fieldMeta?.readOnly === true)
      .filter((f) => !SIGNATURE_TYPES.includes((f.type || '').toUpperCase()))
      .map((f) => ({
        fieldId: f.id,
        type: (f.type || 'TEXT').toUpperCase(),
        label:
          (f.fieldMeta?.label && String(f.fieldMeta.label)) ||
          (f.type ? String(f.type) : `Field ${f.id}`),
      }));
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
   * Tải PDF gốc của 1 envelope item (PDF chưa có chữ ký, dùng làm nền để vẽ
   * text công ty rồi tạo document mới). GET /envelope/item/{id}/download
   */
  async downloadEnvelopeItemPdf(envelopeItemId: string): Promise<Buffer> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/envelope/item/${envelopeItemId}/download`,
          { headers: this.authHeaders, responseType: 'arraybuffer' },
        ),
      );
      return Buffer.from(res.data);
    } catch (err) {
      this.handleError('downloadEnvelopeItemPdf', err);
    }
  }

  /**
   * Tạo envelope (document) từ PDF upload + danh sách field tuỳ ý cho 1 recipient.
   * Dùng cho flow "burn text": PDF đã được vẽ sẵn text công ty, chỉ còn field
   * khách (chữ ký, ngày, ô khách điền). POST /envelope/create
   */
  async createEnvelopeWithFields(params: {
    title: string;
    recipientEmail: string;
    recipientName?: string;
    externalId?: string;
    fileBuffer: Buffer;
    fileName: string;
    fields: {
      type: string;
      page: number;
      positionX: number;
      positionY: number;
      width: number;
      height: number;
      fieldMeta?: Record<string, any>;
    }[];
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
          fields: params.fields.map((f) => ({
            identifier: 0,
            type: f.type,
            page: f.page,
            positionX: f.positionX,
            positionY: f.positionY,
            width: f.width,
            height: f.height,
            ...(f.fieldMeta ? { fieldMeta: f.fieldMeta } : {}),
          })),
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
      this.handleError('createEnvelopeWithFields', err);
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

  /** Lấy envelope dạng RAW (kèm recipients + fields đầy đủ). */
  async getEnvelopeRaw(envelopeId: string): Promise<any> {
    this.ensureConfigured();
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/envelope/${envelopeId}`, {
          headers: this.authHeaders,
        }),
      );
      return res.data;
    } catch (err) {
      this.handleError('getEnvelopeRaw', err);
    }
  }

  /**
   * Đặt readOnly=true cho danh sách field (sau khi prefill, TRƯỚC distribute).
   * Field readOnly + có text → Documenso "in cứng" giá trị vào PDF, hiện ngay
   * với mọi recipient mà không cần ai ký, và không ai sửa được.
   * ⚠️ Phải gọi TRƯỚC distribute — nếu recipient đã tương tác sẽ báo lỗi
   * "Cannot modify a field where the recipient has already interacted".
   * POST /envelope/field/update-many
   */
  async setFieldsReadOnly(
    envelopeId: string,
    fields: { id: number; type: string; fieldMeta?: Record<string, any> }[],
  ): Promise<void> {
    this.ensureConfigured();
    if (!fields.length) return;
    const data = fields.map((f) => {
      const meta = f.fieldMeta || {};
      // Giữ nguyên meta cũ, chỉ bật readOnly + bỏ required (readonly không cần nhập).
      return {
        id: f.id,
        type: (f.type || 'TEXT').toUpperCase(),
        fieldMeta: {
          ...meta,
          type: (meta.type as string) || (f.type || 'text').toLowerCase(),
          readOnly: true,
          required: false,
        },
      };
    });
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/envelope/field/update-many`,
          { envelopeId, data },
          {
            headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
          },
        ),
      );
    } catch (err) {
      this.handleError('setFieldsReadOnly', err);
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
