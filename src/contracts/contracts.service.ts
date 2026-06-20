import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DocumensoClient } from './documenso.client';
import { PdfBurnService, BurnImageItem, BurnTextItem } from './pdf-burn.service';
import { LarkMailService } from './lark-mail.service';
import {
  CreateFromTemplateDto,
  UploadContractDto,
  ContractQueryDto,
  DocumensoWebhookDto,
} from './dto';
import * as crypto from 'crypto';
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
    private readonly larkMail: LarkMailService,
  ) {
    const tpl = this.configService.get<string>('DOCUMENSO_TEMPLATE_ID');
    this.defaultTemplateId = tpl ? Number(tpl) : undefined;
  }

  // ---------- Queries ----------

  /** Danh sách loại hợp đồng (template Documenso) cho FE chọn. */
  async listTemplates() {
    return this.documenso.listTemplates();
  }

  /** Field công ty điền (readOnly) — FE render form động. */
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

  // ===================================================================
  // PHASE 1 — Tạo & gửi bản XEM TRƯỚC (chưa có ô ký) qua Lark Mail.
  // ===================================================================

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

    const template = await this.documenso.getTemplate(templateId);
    const title = dto.title || `Hợp đồng - ${customer.name}`;
    const externalId = `contract-cus${customer.id}-${Date.now()}`;

    // Prefill {fieldId: value} từ FE.
    const prefillMap = new Map<number, string>();
    if (dto.prefillFields?.length) {
      for (const p of dto.prefillFields) {
        if (p.value !== undefined && p.value !== null && p.value !== '') {
          prefillMap.set(p.fieldId, String(p.value));
        }
      }
    }

    // Nung text công ty vào PDF gốc (KHÔNG có chữ ký/dấu — đây chỉ là bản xem).
    const { burnedPdf } = await this.buildReviewPdf(template, prefillMap);

    // Lưu PDF review về local để xem lại / đính kèm.
    const reviewFileUrl = this.storePdf(
      externalId,
      'review',
      burnedPdf,
    );

    // Sinh token bí mật cho khách xác nhận/từ chối bản dự thảo.
    const reviewToken = crypto.randomBytes(32).toString('base64url');
    const publicUrl =
      this.configService.get<string>('CONTRACT_PUBLIC_URL') ||
      this.configService.get<string>('API_URL') ||
      'http://localhost:3060';
    const reviewUrl = `${publicUrl}/api/contracts/review/${reviewToken}`;

    // Gửi Lark Mail bản xem trước.
    await this.larkMail.sendMailWithPdf({
      to: recipientEmail,
      subject: `[Diệp Trà] Bản dự thảo hợp đồng — Quý khách vui lòng rà soát và phản hồi`,
      html: this.larkMail.buildReviewHtml({
        customerName: customer.name,
        reviewUrl,
      }),
      pdfBuffer: burnedPdf,
      pdfFileName: `${title}.pdf`,
    });

    const contract = await this.prisma.contract.create({
      data: {
        customerId: customer.id,
        title,
        source: 'template',
        templateId,
        templateTitle: template.title || null,
        externalId,
        recipientEmail,
        status: 'REVIEW_SENT',
        reviewFileUrl,
        reviewToken,
        prefillData: dto.prefillFields?.length
          ? JSON.stringify(dto.prefillFields)
          : null,
        reviewSentAt: new Date(),
        createdBy: userId || null,
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });

    return contract;
  }

  /** Gửi lại bản xem trước (Phase 1) qua Lark Mail. */
  async resendReview(id: number) {
    const contract = await this.findOne(id);
    if (!['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      throw new BadRequestException(
        'Chỉ gửi lại bản xem khi hợp đồng đang ở bước xem trước.',
      );
    }
    if (!contract.recipientEmail) {
      throw new BadRequestException('Hợp đồng chưa có email người nhận');
    }

    const buffer = this.readStoredPdf(contract.reviewFileUrl);
    if (!buffer) {
      throw new BadRequestException(
        'Không tìm thấy file bản xem trước. Vui lòng tạo lại hợp đồng.',
      );
    }

    await this.larkMail.sendMailWithPdf({
      to: contract.recipientEmail,
      subject: `[Diệp Trà] Bản dự thảo hợp đồng (gửi lại) — Quý khách vui lòng rà soát và phản hồi`,
      html: this.larkMail.buildReviewHtml({
        customerName: contract.customer?.name || '',
        reviewUrl: `${this.configService.get<string>('CONTRACT_PUBLIC_URL') || this.configService.get<string>('API_URL') || 'http://localhost:3060'}/api/contracts/review/${contract.reviewToken}`,
      }),
      pdfBuffer: buffer,
      pdfFileName: `${contract.title}.pdf`,
    });

    return this.prisma.contract.update({
      where: { id },
      data: { reviewSentAt: new Date() },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
  }

  /** Đánh dấu khách đã đồng ý nội dung (Phase 1 → cho phép gửi bản ký). */
  async approveReview(id: number) {
    const contract = await this.findOne(id);
    if (!['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      throw new BadRequestException(
        'Chỉ duyệt được hợp đồng đang ở bước xem trước.',
      );
    }
    return this.prisma.contract.update({
      where: { id },
      data: { status: 'REVIEW_APPROVED' },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
  }

  /** Tìm hợp đồng theo reviewToken (cho trang xác nhận public). */
  async findByReviewToken(token: string) {
    if (!token) throw new NotFoundException('Liên kết không hợp lệ');
    const contract = await this.prisma.contract.findUnique({
      where: { reviewToken: token },
      include: { customer: { select: { name: true } } },
    });
    if (!contract) throw new NotFoundException('Liên kết không hợp lệ');
    return contract;
  }

  /**
   * Khách bấm "Đồng ý" từ email → xác nhận bản dự thảo → tự động gửi bản ký
   * (Phase 2). Idempotent: nếu đã gửi ký rồi thì không gửi lại.
   */
  async approveReviewByToken(
    token: string,
  ): Promise<{ status: string; alreadyProcessed: boolean }> {
    const contract = await this.findByReviewToken(token);

    // Đã chuyển sang bước ký (hoặc xa hơn) → không xử lý lại.
    if (
      ['SENT', 'SIGNED', 'REJECTED', 'CANCELLED'].includes(contract.status)
    ) {
      return { status: contract.status, alreadyProcessed: true };
    }
    if (!['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      throw new BadRequestException('Hợp đồng không ở bước xem trước.');
    }

    // Đánh dấu duyệt rồi gửi bản ký (Phase 2).
    await this.prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'REVIEW_APPROVED' },
    });
    await this.sendForSigning(contract.id);
    return { status: 'SENT', alreadyProcessed: false };
  }

  /** Khách bấm "Không đồng ý" từ email → đánh dấu từ chối bản dự thảo. */
  async rejectReviewByToken(
    token: string,
    reason?: string,
  ): Promise<{ status: string; alreadyProcessed: boolean }> {
    const contract = await this.findByReviewToken(token);
    if (['REJECTED', 'CANCELLED'].includes(contract.status)) {
      return { status: contract.status, alreadyProcessed: true };
    }
    if (!['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      throw new BadRequestException(
        'Hợp đồng đã chuyển bước, không thể từ chối tại đây.',
      );
    }
    await this.prisma.contract.update({
      where: { id: contract.id },
      data: {
        status: 'REJECTED',
        rejectReason: reason?.trim() || 'Khách từ chối bản dự thảo',
      },
    });
    return { status: 'REJECTED', alreadyProcessed: false };
  }

  // ===================================================================
  // PHASE 2 — Gửi bản KÝ (Documenso): PDF nung text + dấu/chữ ký công ty,
  // chỉ field chữ ký khách. Distribute → khách nhận email link ký.
  // ===================================================================

  async sendForSigning(id: number) {
    const contract = await this.findOne(id);
    if (!['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      throw new BadRequestException(
        'Hợp đồng phải ở bước xem trước (đã duyệt) mới gửi bản ký được.',
      );
    }
    if (!contract.templateId) {
      throw new BadRequestException('Hợp đồng không gắn template Documenso.');
    }
    if (!contract.recipientEmail) {
      throw new BadRequestException('Hợp đồng chưa có email người nhận.');
    }

    const customer = contract.customer;
    const template = await this.documenso.getTemplate(contract.templateId);

    // Khôi phục prefill đã lưu ở Phase 1.
    const prefillMap = new Map<number, string>();
    if (contract.prefillData) {
      try {
        const arr: { fieldId: number; value: string }[] = JSON.parse(
          contract.prefillData,
        );
        for (const p of arr) {
          if (p.value) prefillMap.set(p.fieldId, String(p.value));
        }
      } catch {
        /* ignore */
      }
    }

    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    const allFields = template.fields || [];

    // (1) Text công ty (readOnly, không phải chữ ký) → nung vào PDF.
    const burnTextItems: BurnTextItem[] = allFields
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

    // (2) Chữ ký/dấu công ty: field readOnly + là SIGNATURE → nung ẢNH dấu công ty.
    const stampBuffer = this.loadCompanyStamp();
    const burnImageItems: BurnImageItem[] = [];
    if (stampBuffer) {
      for (const f of allFields) {
        const isSig = SIGNATURE_TYPES.includes((f.type || '').toUpperCase());
        if (isSig && f.fieldMeta?.readOnly === true) {
          burnImageItems.push({
            page: Number(f.page) || 1,
            xPercent: Number(f.positionX),
            yPercent: Number(f.positionY),
            widthPercent: Number(f.width),
            heightPercent: Number(f.height),
            imageBuffer: stampBuffer,
          });
        }
      }
    }

    // (3) Field khách = KHÔNG readOnly (chữ ký khách, ngày, ô khách điền).
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

    if (customerFields.length === 0) {
      throw new BadRequestException(
        'Template không có ô nào cho khách ký. Vui lòng thêm ô chữ ký khách vào template.',
      );
    }

    // Tải PDF gốc → nung text + dấu công ty.
    const originalPdf = await this.documenso.downloadTemplateRawPdf(
      contract.templateId,
    );
    const burnedPdf = await this.pdfBurn.burnTextAndImages(
      originalPdf,
      burnTextItems,
      burnImageItems,
    );

    // Tạo document Documenso từ PDF đã nung, chỉ kèm field khách.
    const externalId =
      contract.externalId || `contract-cus${contract.customerId}-${Date.now()}`;
    const envelope = await this.documenso.createEnvelopeWithFields({
      title: contract.title,
      recipientEmail: contract.recipientEmail,
      recipientName: customer?.name || contract.recipientEmail,
      externalId,
      fileBuffer: burnedPdf,
      fileName: `${contract.title}.pdf`,
      fields: customerFields,
    });

    let result = envelope;
    if (envelope.envelopeId) {
      try {
        result = await this.documenso.distribute(envelope.envelopeId, {
          // Tắt email hoàn tất của Documenso — mình tự gửi Lark Mail Phase 4 kèm PDF.
          documentCompleted: false,
          ownerDocumentCompleted: false,
        });
      } catch (e) {
        this.logger.warn(`distribute sau createEnvelope lỗi: ${e}`);
      }
    }

    const signingUrl = result.recipients?.find(
      (r) => r.email === contract.recipientEmail,
    )?.signingUrl;

    return this.prisma.contract.update({
      where: { id },
      data: {
        documensoId: result.envelopeId || envelope.envelopeId || null,
        externalId,
        status: 'SENT',
        signingUrl: signingUrl || null,
        sentAt: new Date(),
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
  }

  /** Build PDF bản xem (chỉ nung text công ty, không dấu/chữ ký). */
  private async buildReviewPdf(
    template: any,
    prefillMap: Map<number, string>,
  ): Promise<{ burnedPdf: Buffer }> {
    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    const allFields = template.fields || [];

    const burnItems: BurnTextItem[] = allFields
      .filter((f: any) => f.fieldMeta?.readOnly === true)
      .filter(
        (f: any) => !SIGNATURE_TYPES.includes((f.type || '').toUpperCase()),
      )
      .map((f: any) => {
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
      .filter((it: BurnTextItem) => it.value !== '');

    const originalPdf = await this.documenso.downloadTemplateRawPdf(
      template.id,
    );
    const burnedPdf = await this.pdfBurn.burnText(originalPdf, burnItems);
    return { burnedPdf };
  }

  /**
   * Nạp ảnh dấu/chữ ký công ty (PNG nền trong suốt). Tìm ở nhiều vị trí; có thể
   * override bằng ENV CONTRACT_COMPANY_STAMP_PATH. Trả null nếu không có (khi đó
   * Phase 2 vẫn chạy nhưng không nung dấu — log cảnh báo).
   */
  private loadCompanyStamp(): Buffer | null {
    const envPath = this.configService.get<string>(
      'CONTRACT_COMPANY_STAMP_PATH',
    );
    const candidates = [
      envPath,
      path.join(__dirname, 'assets', 'signatures', 'company-stamp.png'),
      path.join(
        process.cwd(),
        'src',
        'contracts',
        'assets',
        'signatures',
        'company-stamp.png',
      ),
      path.join(
        process.cwd(),
        'dist',
        'src',
        'contracts',
        'assets',
        'signatures',
        'company-stamp.png',
      ),
    ].filter(Boolean) as string[];

    const found = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!found) {
      this.logger.warn(
        `Không tìm thấy dấu công ty (company-stamp.png). Đã thử: ${candidates.join(', ')}`,
      );
      return null;
    }
    return fs.readFileSync(found);
  }

  /**
   * Lọc fieldMeta giữ thuộc tính hợp lệ khi tạo field mới.
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

  // ---------- Upload PDF (giữ nguyên, ít dùng) ----------

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

    const distributed = await this.documenso.distribute(envelope.envelopeId, {
      documentCompleted: false,
      ownerDocumentCompleted: false,
    });
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

  // ---------- Resend (Phase 2 — bản ký Documenso) ----------

  async resend(id: number) {
    const contract = await this.findOne(id);

    // Đang ở bước xem trước → gửi lại bản xem (Lark Mail).
    if (['REVIEW_SENT', 'REVIEW_APPROVED'].includes(contract.status)) {
      return this.resendReview(id);
    }

    if (!contract.documensoId) {
      throw new BadRequestException('Hợp đồng chưa liên kết Documenso');
    }
    if (contract.status === 'SIGNED') {
      throw new BadRequestException('Hợp đồng đã ký, không thể gửi lại');
    }

    const current = await this.documenso.getEnvelope(contract.documensoId);
    const docStatus = (current.status || '').toUpperCase();

    if (docStatus === 'COMPLETED') {
      await this.finalizeSignedContract(contract.id, contract.documensoId);
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

    const result = await this.documenso.distribute(contract.documensoId, {
      documentCompleted: false,
      ownerDocumentCompleted: false,
    });
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
    const externalId: string | undefined = payload.externalId || undefined;
    const rawId = payload.id;
    const idStr =
      typeof rawId === 'string'
        ? rawId
        : rawId !== undefined && rawId !== null
          ? String(rawId)
          : undefined;

    let contract: {
      id: number;
      documensoId: string | null;
      signedFileUrl: string | null;
    } | null = null;
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
      await this.finalizeSignedContract(contract.id, contract.documensoId);
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

  // ===================================================================
  // PHASE 3 + 4 — Khách ký xong: tải PDF hoàn tất, cập nhật trạng thái,
  // gửi Lark Mail bản cuối cho khách.
  // ===================================================================

  /** Hoàn tất hợp đồng đã ký: tải PDF, lưu local, set SIGNED, gửi Lark Mail. */
  private async finalizeSignedContract(
    contractId: number,
    documensoId: string | null,
  ): Promise<void> {
    let signedFileUrl: string | null = null;
    let signedBuffer: Buffer | null = null;

    try {
      if (documensoId) {
        const numericId = await this.resolveDocumentNumericId(documensoId);
        signedBuffer = await this.documenso.downloadSignedPdf(numericId);
        signedFileUrl = this.storePdf(
          `contract-${contractId}`,
          'signed',
          signedBuffer,
        );
      }
    } catch (err) {
      this.logger.error(
        `Không tải được PDF đã ký cho contract #${contractId}: ${err}`,
      );
    }

    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: {
        status: 'SIGNED',
        signedAt: new Date(),
        ...(signedFileUrl ? { signedFileUrl } : {}),
      },
      include: {
        customer: { select: { id: true, name: true, email: true } },
      },
    });

    // Phase 4 — Gửi Lark Mail bản cuối (kèm PDF đã ký) cho khách.
    if (signedBuffer && updated.recipientEmail) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: updated.recipientEmail,
          subject: `[Diệp Trà] Hợp đồng đã ký hoàn tất: ${updated.title}`,
          html: this.larkMail.buildCompletedHtml({
            customerName: updated.customer?.name || '',
            contractTitle: updated.title,
          }),
          pdfBuffer: signedBuffer,
          pdfFileName: `${updated.title} - da ky.pdf`,
        });
      } catch (e) {
        this.logger.error(
          `Gửi Lark Mail bản cuối cho contract #${contractId} lỗi: ${e}`,
        );
      }
    }
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

  /** Lưu PDF vào uploads/contracts, trả relative URL. */
  private storePdf(prefix: string, kind: string, buffer: Buffer): string {
    const dir = path.join(process.cwd(), 'uploads', 'contracts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `${safePrefix}-${kind}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    return `/uploads/contracts/${filename}`;
  }

  /** Đọc PDF đã lưu local từ relative URL. Trả null nếu không có. */
  private readStoredPdf(relativeUrl?: string | null): Buffer | null {
    if (!relativeUrl) return null;
    const localPath = path.join(
      process.cwd(),
      relativeUrl.replace(/^\//, ''),
    );
    if (!fs.existsSync(localPath)) return null;
    return fs.readFileSync(localPath);
  }
}
