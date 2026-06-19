import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DocumensoClient, PrefillField } from './documenso.client';
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
  ) {
    const tpl = this.configService.get<string>('DOCUMENSO_TEMPLATE_ID');
    this.defaultTemplateId = tpl ? Number(tpl) : undefined;
  }

  // ---------- Queries ----------

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

    // Lấy template để map label → fieldId + tìm recipient slot.
    const template = await this.documenso.getTemplate(templateId);

    const signerRecipient =
      template.recipients?.find((r) => r.role === 'SIGNER') ||
      template.recipients?.[0];
    if (!signerRecipient) {
      throw new BadRequestException(
        'Template không có recipient để gán khách hàng.',
      );
    }

    const prefillFields = this.buildPrefillFields(
      template,
      dto.prefill as Record<string, string | undefined> | undefined,
    );
    const title = dto.title || `Hợp đồng - ${customer.name}`;
    const externalId = `contract-cus${customer.id}-${Date.now()}`;

    const envelope = await this.documenso.useTemplate({
      templateId,
      recipients: [
        {
          id: signerRecipient.id,
          email: recipientEmail,
          name: customer.name,
        },
      ],
      prefillFields,
      override: { title },
      distributeDocument: true,
      externalId,
    });

    // template/use trả draft (chưa có signingUrl). distribute để gửi + lấy signingUrl.
    let result = envelope;
    if (envelope.envelopeId) {
      try {
        result = await this.documenso.distribute(envelope.envelopeId);
      } catch (e) {
        this.logger.warn(`distribute sau useTemplate lỗi: ${e}`);
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
