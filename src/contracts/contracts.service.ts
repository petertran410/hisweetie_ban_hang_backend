import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DocumensoClient, PrefillField } from './documenso.client';
import { PdfBurnService } from './pdf-burn.service';
import {
  CreateFromTemplateDto,
  UploadContractDto,
  ContractQueryDto,
  DocumensoWebhookDto,
} from './dto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  private readonly defaultTemplateId?: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documenso: DocumensoClient,
    private readonly configService: ConfigService,
    private readonly pdfBurn: PdfBurnService,
  ) {
    const tpl = this.configService.get<string>('DOCUMENSO_TEMPLATE_ID');
    this.defaultTemplateId = tpl ? Number(tpl) : undefined;
  }

  // ---------- Queries ----------

  /** Danh sách loại hợp đồng (template Documenso) cho FE chọn. */
  async listTemplates() {
    return this.documenso.listTemplates();
  }

  /** Field do recipient "công ty" (ASSISTANT) điền — FE render form động. */
  async getTemplateFields(templateId: number) {
    return this.documenso.getAssistantFields(templateId);
  }

  async findAll(query: ContractQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 20;

    const where: any = {};
    if (query.customerId) where.customerId = query.customerId;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { recipientEmail: { contains: query.search, mode: 'insensitive' } },
        { customer: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        include: {
          customer: { select: { id: true, code: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contract.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  async findOne(id: number) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
    if (!contract) throw new NotFoundException('Không tìm thấy hợp đồng');
    return contract;
  }

  // ---------- Create từ template ----------

  async createFromTemplate(dto: CreateFromTemplateDto, userId?: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const recipientEmail = dto.recipientEmail || customer.email || '';
    if (!recipientEmail) {
      throw new BadRequestException(
        'Khách hàng chưa có email. Vui lòng cập nhật email trước khi gửi hợp đồng.',
      );
    }

    const templateId = dto.templateId || this.defaultTemplateId;
    if (!templateId) {
      throw new BadRequestException(
        'Chưa cấu hình template hợp đồng (DOCUMENSO_TEMPLATE_ID).',
      );
    }

    // Lấy template để biết recipient slot + toạ độ field công ty (readOnly) +
    // field khách (chữ ký, ô khách điền).
    const template = await this.documenso.getTemplate(templateId);

    const customerRecipient = this.documenso.findCustomerRecipient(template);
    if (!customerRecipient) {
      throw new BadRequestException(
        'Template không có recipient để gán khách hàng.',
      );
    }

    const title = dto.title || `Hợp đồng - ${customer.name}`;
    const externalId = `contract-cus${customer.id}-${Date.now()}`;

    // Map prefill {fieldId: value} từ FE.
    const prefillMap = new Map<number, string>();
    if (dto.prefillFields?.length) {
      for (const p of dto.prefillFields) {
        if (p.value !== undefined && p.value !== null && p.value !== '') {
          prefillMap.set(p.fieldId, String(p.value));
        }
      }
    }

    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    const allFields = template.fields || [];

    // (1) Field công ty = readOnly → "nung" text thẳng vào PDF (không viền).
    const burnItems = allFields
      .filter((f) => f.fieldMeta?.readOnly === true)
      .filter((f) => !SIGNATURE_TYPES.includes((f.type || '').toUpperCase()))
      .map((f) => {
        const value =
          prefillMap.get(f.id) ??
          (f.fieldMeta?.text ? String(f.fieldMeta.text) : '');
        return {
          page: Number(f.page) || 1,
          xPercent: Number(f.positionX),
          yPercent: Number(f.positionY),
          widthPercent: Number(f.width),
          heightPercent: Number(f.height),
          value,
          fontSize: f.fieldMeta?.fontSize
            ? Number(f.fieldMeta.fontSize)
            : undefined,
          align:
            (f.fieldMeta?.textAlign as 'left' | 'center' | 'right') || 'left',
        };
      })
      .filter((it) => it.value !== '');

    // (2) Field khách = KHÔNG readOnly (chữ ký, ngày, ô khách điền) → giữ làm
    // field Documenso cho khách thao tác khi ký.
    const customerFields = allFields
      .filter((f) => f.fieldMeta?.readOnly !== true)
      .map((f) => ({
        type: (f.type || 'TEXT').toUpperCase(),
        page: Number(f.page) || 1,
        positionX: Number(f.positionX),
        positionY: Number(f.positionY),
        width: Number(f.width),
        height: Number(f.height),
        fieldMeta: this.sanitizeFieldMeta(f.fieldMeta),
      }));

    // Tải PDF gốc của template (chưa có field) → vẽ text công ty lên.
    const envelopeItemId =
      (template as any).envelopeItems?.[0]?.id ||
      allFields[0]?.envelopeItemId;
    if (!envelopeItemId) {
      throw new BadRequestException(
        'Không xác định được file PDF gốc của template.',
      );
    }
    const originalPdf =
      await this.documenso.downloadEnvelopeItemPdf(envelopeItemId);
    const burnedPdf = await this.pdfBurn.burnText(originalPdf, burnItems);

    // Tạo document MỚI từ PDF đã nung text, chỉ kèm field khách.
    const envelope = await this.documenso.createEnvelopeWithFields({
      title,
      recipientEmail,
      recipientName: customer.name,
      externalId,
      fileBuffer: burnedPdf,
      fileName: `${title}.pdf`,
      fields: customerFields,
    });

    // distribute để gửi + lấy signingUrl.
    let result = envelope;
    if (envelope.envelopeId) {
      try {
        result = await this.documenso.distribute(envelope.envelopeId);
      } catch (e) {
        this.logger.warn(`distribute sau createEnvelope lỗi: ${e}`);
      }
    }

    const signingUrl = result.recipients?.find(
      (r) => r.email === recipientEmail,
    )?.signingUrl;

    const contract = await this.prisma.contract.create({
      data: {
        customerId: customer.id,
        title,
        source: 'template',
        templateId,
        templateTitle: template.title || null,
        documensoId: result.envelopeId || envelope.envelopeId || null,
        externalId,
        recipientEmail,
        status: 'SENT',
        signingUrl: signingUrl || null,
        sentAt: new Date(),
        createdBy: userId || null,
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });

    return contract;
  }

  /**
   * Lọc fieldMeta giữ các thuộc tính hợp lệ khi tạo field mới (bỏ text/readOnly
   * thừa). Documenso validate fieldMeta theo type nên chỉ giữ key an toàn.
   */
  private sanitizeFieldMeta(
    fieldMeta?: Record<string, any>,
  ): Record<string, any> | undefined {
    if (!fieldMeta) return undefined;
    const out: Record<string, any> = {};
    const keep = [
      'label',
      'placeholder',
      'required',
      'fontSize',
      'textAlign',
      'type',
    ];
    for (const k of keep) {
      if (fieldMeta[k] !== undefined) out[k] = fieldMeta[k];
    }
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Map prefill (label-based từ FE) → prefillFields (id-based cho Documenso).
   * Bỏ qua field không tìm thấy label tương ứng trong template.
   */
  private buildPrefillFields(
    template: { fields: any[] },
    prefill?: Record<string, string | undefined>,
  ): PrefillField[] {
    if (!prefill) return [];
    const result: PrefillField[] = [];

    for (const [label, value] of Object.entries(prefill)) {
      if (value === undefined || value === null || value === '') continue;
      const field = template.fields?.find(
        (f) =>
          (f.fieldMeta?.label || '').toLowerCase() === label.toLowerCase(),
      );
      if (!field) {
        this.logger.warn(
          `Prefill: không tìm thấy field label="${label}" trong template`,
        );
        continue;
      }
      result.push({
        id: field.id,
        type: (field.type || 'TEXT').toLowerCase() === 'text' ? 'text' : 'text',
        value: String(value),
      });
    }
    return result;
  }

  /**
   * Prefill id-based (động): FE gửi {fieldId, value}. Khớp field trong template
   * để lấy type chuẩn rồi build PrefillField. Bỏ field không thuộc template.
   * value giữ dạng string (Documenso v2.13 nhận string cho mọi loại text-like;
   * CHECKBOX/RADIO/DROPDOWN cũng nhận chuỗi giá trị đã chọn).
   */
  private buildPrefillFieldsById(
    template: { fields: any[] },
    items: { fieldId: number; value: string }[],
  ): PrefillField[] {
    const result: PrefillField[] = [];
    for (const item of items) {
      if (item.value === undefined || item.value === null || item.value === '')
        continue;
      const field = template.fields?.find((f) => f.id === item.fieldId);
      if (!field) {
        this.logger.warn(
          `Prefill: fieldId=${item.fieldId} không thuộc template — bỏ qua`,
        );
        continue;
      }
      result.push({
        id: field.id,
        type: (field.type || 'TEXT').toLowerCase(),
        value: String(item.value),
      });
    }
    return result;
  }

  /**
   * Khóa (readOnly) các field thuộc recipient CÔNG TY trong envelope vừa tạo.
   * (Không còn dùng trong flow chính — field công ty đã đặt readOnly sẵn ở
   * template. Giữ lại cho trường hợp cần khóa động.)
   */
  private async lockCompanyFields(
    envelopeId: string,
    customerEmail: string,
  ): Promise<void> {
    const raw = await this.documenso.getEnvelopeRaw(envelopeId);
    const recipients: any[] = raw?.recipients || [];
    const fields: any[] = raw?.fields || [];

    // Recipient khách trong envelope mới (email đã được thay bằng khách thật).
    const customer = recipients.find(
      (r) =>
        (r.email || '').trim().toLowerCase() ===
        customerEmail.trim().toLowerCase(),
    );
    const customerId = customer?.id;

    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    // Field công ty = không thuộc recipient khách + không phải chữ ký + đã có giá trị.
    const companyFields = fields
      .filter((f) => f.recipientId !== customerId)
      .filter((f) => !SIGNATURE_TYPES.includes((f.type || '').toUpperCase()))
      .filter((f) => f.inserted === true || f.customText || f.fieldMeta?.text)
      .map((f) => ({
        id: f.id,
        type: f.type,
        fieldMeta: f.fieldMeta || {},
      }));

    if (companyFields.length === 0) return;
    await this.documenso.setFieldsReadOnly(envelopeId, companyFields);
  }

  // ---------- Upload PDF ----------

  async createFromUpload(
    dto: UploadContractDto,
    file: Express.Multer.File,
    userId?: number,
  ) {
    if (!file) throw new BadRequestException('Thiếu file PDF');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Chỉ chấp nhận file PDF');
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const recipientEmail = dto.recipientEmail || customer.email || '';
    if (!recipientEmail) {
      throw new BadRequestException(
        'Khách hàng chưa có email. Vui lòng cập nhật email trước khi gửi hợp đồng.',
      );
    }

    const title = dto.title || `Hợp đồng - ${customer.name}`;
    const externalId = `contract-cus${customer.id}-${Date.now()}`;

    const envelope = await this.documenso.createEnvelope({
      title,
      recipientEmail,
      recipientName: customer.name,
      externalId,
      fileBuffer: file.buffer,
      fileName: file.originalname || 'contract.pdf',
    });

    const distributed = await this.documenso.distribute(envelope.envelopeId);
    const signingUrl = distributed.recipients?.find(
      (r) => r.email === recipientEmail,
    )?.signingUrl;

    const contract = await this.prisma.contract.create({
      data: {
        customerId: customer.id,
        title,
        source: 'upload',
        documensoId: envelope.envelopeId || null,
        externalId,
        recipientEmail,
        status: 'SENT',
        signingUrl: signingUrl || null,
        sentAt: new Date(),
        createdBy: userId || null,
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });

    return contract;
  }

  // ---------- Resend ----------

  async resend(id: number) {
    const contract = await this.findOne(id);
    if (!contract.documensoId) {
      throw new BadRequestException('Hợp đồng chưa liên kết Documenso');
    }
    if (contract.status === 'SIGNED') {
      throw new BadRequestException('Hợp đồng đã ký, không thể gửi lại');
    }

    // Đồng bộ trạng thái thực tế bên Documenso trước khi gửi lại. Documenso chỉ
    // cho distribute khi document còn DRAFT/PENDING; các trạng thái cuối
    // (COMPLETED/REJECTED/CANCELLED) sẽ báo lỗi 500 "Can not send...".
    const current = await this.documenso.getEnvelope(contract.documensoId);
    const docStatus = (current.status || '').toUpperCase();

    if (docStatus === 'COMPLETED') {
      let signedFileUrl = contract.signedFileUrl;
      try {
        if (current.documentNumericId != null) {
          signedFileUrl = await this.downloadAndStoreSignedPdf(
            contract.id,
            current.documentNumericId,
          );
        }
      } catch (e) {
        this.logger.warn(`resend: tải PDF đã ký lỗi: ${e}`);
      }
      await this.prisma.contract.update({
        where: { id },
        data: { status: 'SIGNED', signedAt: new Date(), signedFileUrl },
      });
      throw new BadRequestException(
        'Hợp đồng đã được ký xong — đã cập nhật lại trạng thái. Vui lòng tải PDF.',
      );
    }

    if (docStatus === 'REJECTED') {
      await this.prisma.contract.update({
        where: { id },
        data: { status: 'REJECTED' },
      });
      throw new BadRequestException(
        'Khách hàng đã từ chối ký hợp đồng này — không thể gửi lại. Vui lòng tạo hợp đồng mới.',
      );
    }

    if (docStatus === 'CANCELLED') {
      await this.prisma.contract.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      throw new BadRequestException(
        'Hợp đồng đã bị hủy bên Documenso — không thể gửi lại.',
      );
    }

    const result = await this.documenso.distribute(contract.documensoId);
    const signingUrl = result.recipients?.find(
      (r) => r.email === contract.recipientEmail,
    )?.signingUrl;

    return this.prisma.contract.update({
      where: { id },
      data: {
        status: 'SENT',
        signingUrl: signingUrl || contract.signingUrl,
        sentAt: new Date(),
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
  }

  // ---------- Download signed PDF ----------

  async getSignedPdf(
    id: number,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.findOne(id);
    if (contract.status !== 'SIGNED') {
      throw new BadRequestException('Hợp đồng chưa được ký xong');
    }

    // Ưu tiên file đã tải về local (qua webhook).
    if (contract.signedFileUrl) {
      const localPath = path.join(
        process.cwd(),
        contract.signedFileUrl.replace(/^\//, ''),
      );
      if (fs.existsSync(localPath)) {
        return {
          buffer: fs.readFileSync(localPath),
          filename: `hop-dong-${contract.id}.pdf`,
        };
      }
    }

    // Fallback: tải trực tiếp từ Documenso (cần numeric document id).
    if (!contract.documensoId) {
      throw new BadRequestException('Hợp đồng chưa liên kết Documenso');
    }
    const numericId = await this.resolveDocumentNumericId(contract.documensoId);
    const buffer = await this.documenso.downloadSignedPdf(numericId);
    return { buffer, filename: `hop-dong-${contract.id}.pdf` };
  }

  // ---------- Webhook ----------

  async handleWebhook(dto: DocumensoWebhookDto) {
    const payload: any = dto.payload || {};
    // Map ưu tiên theo externalId (ổn định), fallback envelopeId/id.
    const externalId: string | undefined = payload.externalId || undefined;
    const rawId = payload.id;
    const idStr =
      typeof rawId === 'string'
        ? rawId
        : rawId !== undefined && rawId !== null
          ? String(rawId)
          : undefined;

    let contract: { id: number; documensoId: string | null; signedFileUrl: string | null } | null =
      null;
    if (externalId) {
      contract = await this.prisma.contract.findUnique({
        where: { externalId },
      });
    }
    if (!contract && idStr) {
      contract = await this.prisma.contract.findUnique({
        where: { documensoId: idStr },
      });
    }
    if (!contract) {
      this.logger.warn(
        `Webhook: không map được contract (externalId=${externalId}, id=${idStr})`,
      );
      return { received: true };
    }

    const event = dto.event?.toUpperCase();
    this.logger.log(`Webhook ${event} cho contract #${contract.id}`);

    if (event === 'DOCUMENT_COMPLETED') {
      let signedFileUrl = contract.signedFileUrl;
      try {
        if (contract.documensoId) {
          const numericId = await this.resolveDocumentNumericId(
            contract.documensoId,
          );
          signedFileUrl = await this.downloadAndStoreSignedPdf(
            contract.id,
            numericId,
          );
        }
      } catch (err) {
        this.logger.error(
          `Không tải được PDF đã ký cho contract #${contract.id}: ${err}`,
        );
      }
      await this.prisma.contract.update({
        where: { id: contract.id },
        data: {
          status: 'SIGNED',
          signedAt: new Date(),
          signedFileUrl,
        },
      });
    } else if (event === 'DOCUMENT_REJECTED') {
      await this.prisma.contract.update({
        where: { id: contract.id },
        data: { status: 'REJECTED' },
      });
    } else if (event === 'DOCUMENT_CANCELLED') {
      await this.prisma.contract.update({
        where: { id: contract.id },
        data: { status: 'CANCELLED' },
      });
    }

    return { received: true };
  }

  /** envelope_xxx → numeric document id (qua GET /envelope). */
  private async resolveDocumentNumericId(
    documensoId: string,
  ): Promise<number> {
    const env = await this.documenso.getEnvelope(documensoId);
    if (env.documentNumericId == null) {
      throw new BadRequestException(
        'Không xác định được document id để tải PDF',
      );
    }
    return env.documentNumericId;
  }

  private async downloadAndStoreSignedPdf(
    contractId: number,
    documentNumericId: number,
  ): Promise<string> {
    const buffer = await this.documenso.downloadSignedPdf(documentNumericId);
    const dir = path.join(process.cwd(), 'uploads', 'contracts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `contract-${contractId}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    return `/uploads/contracts/${filename}`;
  }
}
