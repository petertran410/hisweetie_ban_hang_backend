import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DocumensoClient } from './documenso.client';
import {
  PdfBurnService,
  BurnTextItem,
} from './pdf-burn.service';
import { LarkMailService } from './lark-mail.service';
import {
  CreateFromTemplateDto,
  UploadContractDto,
  ContractQueryDto,
  DocumensoWebhookDto,
  CreateContractSignerDto,
  UpdateContractSignerDto,
} from './dto';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  private readonly defaultTemplateId?: number;
  private readonly defaultCompanySignerEmail?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documenso: DocumensoClient,
    private readonly configService: ConfigService,
    private readonly pdfBurn: PdfBurnService,
    private readonly larkMail: LarkMailService,
  ) {
    const tpl = this.configService.get<string>('DOCUMENSO_TEMPLATE_ID');
    this.defaultTemplateId = tpl ? Number(tpl) : undefined;
    this.defaultCompanySignerEmail = (
      this.configService.get<string>('CONTRACT_SIGNER_EMAIL') || ''
    ).trim();
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

  /**
   * Liệt kê người ký BÊN A (lưu trong bảng `ContractSigner`) để NV chọn khi
   * tạo HĐ 2 bên.
   *
   * KHÔNG đồng bộ từ Documenso nữa: API `GET /api/v2/user` đã bị gỡ ở v2.14.0
   * (chỉ admin key mới list được). Thay vào đó, admin dùng trang
   * `/cai-dat/nguoi-ky-hop-dong` để nhập / sửa / ẩn tay.
   *
   * Param `force` được giữ để tương thích ngược với FE — hiện không còn ý nghĩa.
   */
  async listSigners(_force = false) {
    return this.prisma.contractSigner.findMany({
      where: { isActive: true },
      orderBy: [{ department: 'asc' }, { name: 'asc' }],
    });
  }

  // ---------- CRUD người ký (admin) ----------

  async createSigner(dto: CreateContractSignerDto) {
    try {
      return await this.prisma.contractSigner.create({
        data: {
          documensoEmail: dto.documensoEmail.toLowerCase().trim(),
          name: dto.name?.trim() || null,
          department: dto.department?.trim() || null,
          code: dto.code?.trim() || null,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (e: any) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = (e.meta?.target as string[]) || [];
        throw new BadRequestException(
          target.includes('documensoEmail')
            ? `Email Documenso "${dto.documensoEmail}" đã tồn tại.`
            : `Mã "${dto.code}" đã tồn tại.`,
        );
      }
      throw e;
    }
  }

  async updateSigner(id: number, dto: UpdateContractSignerDto) {
    const existing = await this.prisma.contractSigner.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy người ký');

    const data: Prisma.ContractSignerUpdateInput = {};
    if (dto.documensoEmail !== undefined) {
      data.documensoEmail = dto.documensoEmail.toLowerCase().trim();
    }
    if (dto.name !== undefined) data.name = dto.name.trim() || null;
    if (dto.department !== undefined) {
      data.department = dto.department.trim() || null;
    }
    if (dto.code !== undefined) data.code = dto.code.trim() || null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.contractSigner.update({
        where: { id },
        data,
      });
    } catch (e: any) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = (e.meta?.target as string[]) || [];
        throw new BadRequestException(
          target.includes('documensoEmail')
            ? `Email Documenso "${dto.documensoEmail}" đã tồn tại.`
            : `Mã "${dto.code}" đã tồn tại.`,
        );
      }
      throw e;
    }
  }

  /**
   * Soft-delete: set `isActive = false`. KHÔNG xóa row để giữ liên kết lịch sử
   * với hợp đồng đã tạo (tránh FK / audit gap).
   */
  async deleteSigner(id: number) {
    const existing = await this.prisma.contractSigner.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy người ký');

    return this.prisma.contractSigner.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Lấy các HĐ đang chờ ký (SENT / PARTIALLY_SIGNED) để cron sync Documenso kiểm
   * tra lại trạng thái. Lọc theo sentAt trong khoảng 7 ngày gần nhất — quá cũ
   * thì webhook chắc chắn đã miss hẳn và cần xử lý tay, không nên spam Documenso.
   */
  async findStaleForSync() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    return this.prisma.contract.findMany({
      where: {
        status: { in: ['SENT', 'PARTIALLY_SIGNED'] },
        documensoId: { not: null },
        sentAt: { gte: sevenDaysAgo },
      },
      select: {
        id: true,
        status: true,
        documensoId: true,
      },
      orderBy: { sentAt: 'asc' },
    });
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
          customer: {
            select: { id: true, code: true, name: true, email: true },
          },
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
  // FLOW MỚI — 2 phase gộp:
  //  (1) NV tạo HĐ từ template → burn text + tạo Documenso envelope → distribute.
  //      - Loại 1 (1 bên ký): 1 recipient = khách.
  //      - Loại 2 (2 bên ký tuần tự): 2 recipient (khách order=1, NV order=2).
  //      Mail #1 gửi cho khách (link Documenso ký).
  //  (2) Webhook Documenso:
  //      - Loại 1: recipientSigned khách → tải PDF → mail hoàn tất cả bên → SIGNED.
  //      - Loại 2: recipientSigned khách (order=1) → mail "đến lượt NV" → PARTIALLY_SIGNED.
  //                recipientSigned NV (order=2) → tải PDF → mail hoàn tất → SIGNED.
  // ===================================================================

  /**
   * Tạo HĐ từ template + gửi mail #1 cho khách ngay.
   * Phát hiện Loại 1 vs Loại 2 theo số recipient SIGNER trong template.
   */
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

    // Phát hiện Loại: đếm recipient SIGNER còn lại sau khi loại trừ recipient công ty.
    const totalSigners = (template.recipients || []).filter(
      (r) => (r.role || '').toUpperCase() !== 'ASSISTANT',
    ).length;
    const isTwoParty = totalSigners >= 2;
    const contractType: 'SINGLE' | 'DOUBLE' = isTwoParty ? 'DOUBLE' : 'SINGLE';

    // Email NV ký BÊN A — ưu tiên:
    //   1) FIELD `companySignerEmail` do FE truyền (NV chọn dropdown)
    //   2) `ContractSigner` đầu tiên trong DB (cache đồng bộ Documenso)
    //   3) ENV `CONTRACT_SIGNER_EMAIL`
    const companySignerEmail =
      (dto.companySignerEmail || '').trim() ||
      (await this.firstActiveSignerEmail()) ||
      this.defaultCompanySignerEmail ||
      '';

    if (isTwoParty && !companySignerEmail) {
      throw new BadRequestException(
        'Hợp đồng 2 bên ký yêu cầu email Documenso user của NV ký BÊN A. Vui lòng cấu hình CONTRACT_SIGNER_EMAIL hoặc đồng bộ danh sách signer.',
      );
    }

    // Burn text công ty vào PDF gốc (giữ nguyên field chữ ký để Documenso xử lý).
    const { burnedPdf } = await this.buildSignedPdf(template, prefillMap);

    // Lấy danh sách field khách ký (readOnly=false) theo từng recipient.
    const SIGNATURE_TYPES = ['SIGNATURE', 'INITIALS', 'FREE_SIGNATURE'];
    const allFields = template.fields || [];

    // Phân field theo recipient: customer vs company.
    const customerRecipient =
      this.documenso.findCustomerRecipient(template) ||
      (template.recipients || [])[0];
    const companyRecipient = (template.recipients || []).find(
      (r) => r.id !== customerRecipient?.id,
    );

    const buildFieldsFor = (recipientId?: number) =>
      allFields
        .filter((f) => f.fieldMeta?.readOnly !== true)
        .filter((f) => !recipientId || Number(f.recipientId) === recipientId)
        .map((f) => ({
          type: (f.type || 'TEXT').toUpperCase(),
          page: Number(f.page) || 1,
          positionX: Number(f.positionX),
          positionY: Number(f.positionY),
          width: Number(f.width),
          height: Number(f.height),
          fieldMeta: this.sanitizeFieldMeta(f.fieldMeta),
        }));

    const customerFields = buildFieldsFor(customerRecipient?.id);
    const companyFields = buildFieldsFor(companyRecipient?.id);

    if (customerFields.length === 0) {
      throw new BadRequestException(
        'Template không có ô nào cho khách ký. Vui lòng thêm ô chữ ký khách vào template.',
      );
    }
    if (isTwoParty && companyFields.length === 0) {
      throw new BadRequestException(
        'Template 2 bên không có ô ký cho công ty. Vui lòng thêm ô SIGNATURE cho BÊN A.',
      );
    }

    // Tạo envelope Documenso.
    const recipients: {
      email: string;
      name: string;
      role: string;
      signingOrder: number;
      fields: any[];
    }[] = [
      {
        email: recipientEmail,
        name: customer?.name || recipientEmail,
        role: 'SIGNER',
        signingOrder: 1, // Khách ký trước.
        fields: customerFields,
      },
    ];

    if (isTwoParty && companyRecipient && companySignerEmail) {
      recipients.push({
        email: companySignerEmail,
        name: companySignerEmail,
        role: 'SIGNER',
        signingOrder: 2, // NV ký sau.
        fields: companyFields,
      });
    }

    const envelope = await this.documenso.createEnvelopeWithFields({
      title,
      externalId,
      fileBuffer: burnedPdf,
      fileName: `${title}.pdf`,
      recipients,
    });

    if (!envelope.envelopeId) {
      throw new BadRequestException(
        'Documenso không trả envelopeId — không thể gửi ký.',
      );
    }

    // Distribute (tắt hết email Documenso).
    const result = await this.documenso.distribute(envelope.envelopeId, true);

    const customerRecipientResult = result.recipients?.find(
      (r) => r.email === recipientEmail,
    );

    const contract = await this.prisma.contract.create({
      data: {
        customerId: customer.id,
        title,
        source: 'template',
        templateId,
        templateTitle: template.title || null,
        documensoId: result.envelopeId || envelope.envelopeId,
        externalId,
        recipientEmail,
        status: 'SENT',
        signingUrl: customerRecipientResult?.signingUrl || null,
        contractType,
        companySignerEmail: isTwoParty ? companySignerEmail : null,
        sentAt: new Date(),
        createdBy: userId || null,
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });

    // Gửi mail #1 cho khách (không đính kèm file — link Documenso đã có PDF).
    if (customerRecipientResult?.signingUrl) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: recipientEmail,
          subject: this.larkMail.subjectSentToCustomer(contract.title),
          html: this.larkMail.buildSentToCustomerHtml({
            customerName: customer.name,
            contractTitle: contract.title,
            signingUrl: customerRecipientResult.signingUrl,
          }),
        });
      } catch (e) {
        this.logger.error(
          `Gửi mail #1 cho khách contract #${contract.id} lỗi: ${e}`,
        );
      }
    }

    return contract;
  }

  /** Gửi lại — chỉ dùng khi SENT/PARTIALLY_SIGNED (Documenso re-distribute). */
  async resend(id: number) {
    const contract = await this.findOne(id);
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

    // HĐ 2 bên, khách đã ký → gửi lại mail + link ký cho NV BÊN A (không gửi lại khách).
    if (
      contract.status === 'PARTIALLY_SIGNED' &&
      contract.contractType === 'DOUBLE'
    ) {
      const staffSigningUrl = await this.resolveStaffSigningUrl(contract);
      await this.notifyStaffToSign(contract, staffSigningUrl);
      return this.prisma.contract.update({
        where: { id },
        data: {
          ...(staffSigningUrl ? { signingUrl: staffSigningUrl } : {}),
        },
        include: {
          customer: {
            select: { id: true, code: true, name: true, email: true },
          },
        },
      });
    }

    const result = await this.documenso.distribute(contract.documensoId, true);
    const customerRecipientResult = result.recipients?.find(
      (r) => r.email === contract.recipientEmail,
    );

    // Mail #1 lại cho khách.
    if (customerRecipientResult?.signingUrl) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: contract.recipientEmail!,
          subject: this.larkMail.subjectSentToCustomer(
            `[Gửi lại] ${contract.title}`,
          ),
          html: this.larkMail.buildSentToCustomerHtml({
            customerName: contract.customer?.name || '',
            contractTitle: contract.title,
            signingUrl: customerRecipientResult.signingUrl,
          }),
        });
      } catch (e) {
        this.logger.error(`Gửi lại mail #1 lỗi: ${e}`);
        throw new BadRequestException(
          `Gửi lại email cho khách thất bại: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return this.prisma.contract.update({
      where: { id },
      data: {
        status: 'SENT',
        signingUrl:
          customerRecipientResult?.signingUrl || contract.signingUrl,
        sentAt: new Date(),
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });
  }

  // ---------- Download / preview ----------

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
    // Documenso v2 payload: envelopeId (string) + id (numeric document id)
    const envelopeId: string | undefined =
      typeof payload.envelopeId === 'string' ? payload.envelopeId : undefined;
    const rawId = payload.id;
    const idStr =
      typeof rawId === 'string'
        ? rawId
        : rawId !== undefined && rawId !== null
          ? String(rawId)
          : undefined;

    let contract: any = null;
    if (externalId) {
      contract = await this.prisma.contract.findUnique({
        where: { externalId },
        include: { customer: { select: { name: true, email: true } } },
      });
    }
    // HĐ lưu documensoId = envelope_xxx
    if (!contract && envelopeId) {
      contract = await this.prisma.contract.findUnique({
        where: { documensoId: envelopeId },
        include: { customer: { select: { name: true, email: true } } },
      });
    }
    if (!contract && idStr) {
      contract = await this.prisma.contract.findUnique({
        where: { documensoId: idStr },
        include: { customer: { select: { name: true, email: true } } },
      });
    }
    if (!contract) {
      this.logger.warn(
        `Webhook: không map được contract (externalId=${externalId}, envelopeId=${envelopeId}, id=${idStr})`,
      );
      return { received: true };
    }

    const event = (dto.event || '').toUpperCase();
    this.logger.log(
      `Webhook ${event} cho contract #${contract.id} (status=${contract.status})`,
    );

    // Documenso v2.14 enum (KHÔNG có RECIPIENT_SIGNED):
    //   DOCUMENT_RECIPIENT_COMPLETED — 1 recipient vừa ký xong
    //   DOCUMENT_SIGNED              — cũng fire sau mỗi lần 1 recipient ký
    //   DOCUMENT_COMPLETED           — toàn bộ đã seal
    if (event === 'DOCUMENT_COMPLETED') {
      await this.finalizeSignedContract(contract.id, contract.documensoId);
    } else if (
      event === 'DOCUMENT_RECIPIENT_COMPLETED' ||
      event === 'DOCUMENT_SIGNED' ||
      event === 'RECIPIENT_SIGNED' // legacy / docs cũ
    ) {
      await this.handleRecipientSigned(contract, payload);
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
    } else {
      this.logger.log(`Webhook event bỏ qua: ${event}`);
    }

    return { received: true };
  }

  /**
   * Đồng bộ trạng thái HĐ từ Documenso (khi webhook miss / status kẹt SENT).
   * Dùng nút "Làm mới" / đồng bộ trên POS.
   */
  async syncFromDocumenso(id: number) {
    const contract = await this.findOne(id);
    if (!contract.documensoId) {
      throw new BadRequestException('Hợp đồng chưa liên kết Documenso');
    }
    if (contract.status === 'SIGNED' || contract.status === 'CANCELLED') {
      return contract;
    }

    const env = await this.documenso.getEnvelope(contract.documensoId);
    const docStatus = (env.status || '').toUpperCase();
    this.logger.log(
      `syncFromDocumenso #${id}: Documenso status=${docStatus}, recipients=${JSON.stringify(
        env.recipients?.map((r) => ({
          email: r.email,
          signingStatus: r.signingStatus,
        })),
      )}`,
    );

    if (docStatus === 'COMPLETED') {
      await this.finalizeSignedContract(contract.id, contract.documensoId);
      return this.findOne(id);
    }
    if (docStatus === 'REJECTED') {
      return this.prisma.contract.update({
        where: { id },
        data: { status: 'REJECTED' },
        include: {
          customer: {
            select: { id: true, code: true, name: true, email: true },
          },
        },
      });
    }

    // Build fake payload từ envelope để tái dùng handleRecipientSigned
    await this.handleRecipientSigned(contract, {
      recipients: env.recipients || [],
      Recipient: env.recipients || [],
      status: env.status,
      externalId: env.externalId,
      envelopeId: env.envelopeId,
    });

    return this.findOne(id);
  }

  /**
   * Xử lý khi 1 recipient vừa ký (Documenso: DOCUMENT_RECIPIENT_COMPLETED /
   * DOCUMENT_SIGNED). Payload là document/envelope kèm mảng recipients.
   */
  private async handleRecipientSigned(contract: any, payload: any) {
    if (contract.status === 'SIGNED' || contract.status === 'CANCELLED') {
      return;
    }

    const recipients: any[] =
      payload?.recipients || payload?.Recipient || [];
    const customerEmail = (contract.recipientEmail || '').toLowerCase();
    const staffEmail = (contract.companySignerEmail || '').toLowerCase();

    const isSigned = (r: any) =>
      (r.signingStatus || '').toUpperCase() === 'SIGNED';

    const customerRec = recipients.find(
      (r) => (r.email || '').toLowerCase() === customerEmail,
    );
    const staffRec = recipients.find(
      (r) => (r.email || '').toLowerCase() === staffEmail,
    );

    // Fallback: payload.recipient (nếu có) hoặc so khớp email lẻ
    const singleEmail = (
      payload?.recipient?.email ||
      payload?.email ||
      ''
    ).toLowerCase();
    const customerSigned =
      (customerRec && isSigned(customerRec)) ||
      singleEmail === customerEmail;
    const staffSigned = staffRec && isSigned(staffRec);
    const allSigned =
      recipients.length > 0 && recipients.every(isSigned);

    const isTwoParty = contract.contractType === 'DOUBLE';

    this.logger.log(
      `handleRecipientSigned #${contract.id}: customerSigned=${customerSigned} staffSigned=${!!staffSigned} allSigned=${allSigned} isTwoParty=${isTwoParty} status=${contract.status}`,
    );

    // Tất cả đã ký → hoàn tất
    if (allSigned || (staffSigned && isTwoParty)) {
      // Staff signed on double, or everyone signed — check COMPLETED via finalize
      // (PDF download may fail until seal finishes; finalize handles that)
      if (allSigned) {
        await this.finalizeSignedContract(contract.id, contract.documensoId);
        return;
      }
    }

    // Khách đã ký, HĐ 2 bên, còn chờ NV
    if (
      customerSigned &&
      isTwoParty &&
      (contract.status === 'SENT' || contract.status === 'PARTIALLY_SIGNED')
    ) {
      if (contract.status === 'PARTIALLY_SIGNED') {
        // Đã xử lý rồi — không gửi mail lặp khi sync
        return;
      }

      const staffSigningUrl = await this.resolveStaffSigningUrl(contract);

      await this.prisma.contract.update({
        where: { id: contract.id },
        data: {
          status: 'PARTIALLY_SIGNED',
          ...(staffSigningUrl ? { signingUrl: staffSigningUrl } : {}),
        },
      });

      try {
        await this.notifyStaffToSign(
          { ...contract, status: 'PARTIALLY_SIGNED' },
          staffSigningUrl,
        );
      } catch (e) {
        this.logger.error(
          `Gửi mail NV sau khi khách ký lỗi (contract #${contract.id}): ${e instanceof Error ? e.stack || e.message : e}`,
        );
      }
    }
  }

  /** Lấy signingUrl của recipient BÊN A từ envelope Documenso. */
  private async resolveStaffSigningUrl(
    contract: any,
  ): Promise<string | null> {
    if (!contract.documensoId) return contract.signingUrl || null;
    try {
      const env = await this.documenso.getEnvelope(contract.documensoId);
      const staffEmail = (contract.companySignerEmail || '').toLowerCase();
      const fromEnv =
        env.recipients?.find(
          (r) => (r.email || '').toLowerCase() === staffEmail,
        )?.signingUrl || null;
      return fromEnv || contract.signingUrl || null;
    } catch (e) {
      this.logger.warn(
        `Không lấy được staff signingUrl cho contract #${contract.id}: ${e}`,
      );
      return contract.signingUrl || null;
    }
  }

  /**
   * Gửi mail Lark cho NV BÊN A: khách đã ký + link ký phần công ty.
   * Throw nếu SMTP fail để caller (webhook/resend) log / báo lỗi.
   */
  private async notifyStaffToSign(
    contract: any,
    staffSigningUrl: string | null,
  ): Promise<void> {
    const staffEmail =
      (contract.companySignerEmail || '').trim() ||
      this.larkMail.getInternalMail();

    if (!staffEmail) {
      this.logger.warn(
        `Contract #${contract.id}: không có email NV để gửi link ký BÊN A (companySignerEmail + CONTRACT_INTERNAL_MAIL/LARK_SMTP_USER đều trống)`,
      );
      return;
    }

    // PDF giữa chừng (khách đã ký) — optional; Documenso có thể chưa cho tải.
    let signedBuffer: Buffer | null = null;
    try {
      if (contract.documensoId) {
        const env = await this.documenso.getEnvelope(contract.documensoId);
        if (env.documentNumericId != null) {
          signedBuffer = await this.documenso.downloadSignedPdf(
            env.documentNumericId,
          );
        }
      }
    } catch {
      /* bỏ qua */
    }

    this.logger.log(
      `Gửi mail NV BÊN A contract #${contract.id} → ${staffEmail}` +
        (staffSigningUrl ? ` (có signingUrl)` : ' (THIẾU signingUrl)'),
    );

    await this.larkMail.sendMailWithPdf({
      to: staffEmail,
      subject: this.larkMail.subjectCustomerSigned(
        contract.customer?.name || '',
        contract.title,
      ),
      html: this.larkMail.buildCustomerSignedToStaffHtml({
        customerName: contract.customer?.name || '',
        contractTitle: contract.title,
        isTwoParty: true,
        staffSigningUrl: staffSigningUrl || undefined,
      }),
      ...(signedBuffer
        ? {
            pdfBuffer: signedBuffer,
            pdfFileName: `${contract.title} - khach ky.pdf`,
          }
        : {}),
    });
  }

  /**
   * Hoàn tất HĐ đã ký: tải PDF, lưu local, set SIGNED, gửi Lark Mail hoàn tất
   * cho cả khách + NV.
   */
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
        customer: { select: { name: true, email: true } },
      },
    });

    // Mail hoàn tất: gửi cho khách.
    if (signedBuffer && updated.recipientEmail) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: updated.recipientEmail,
          subject: this.larkMail.subjectCompleted(updated.title),
          html: this.larkMail.buildCompletedHtml({
            customerName: updated.customer?.name || '',
            contractTitle: updated.title,
          }),
          pdfBuffer: signedBuffer,
          pdfFileName: `${updated.title} - da ky.pdf`,
        });
      } catch (e) {
        this.logger.error(
          `Gửi Lark Mail hoàn tất cho contract #${contractId} lỗi: ${e}`,
        );
      }
    }

    // Thông báo nội bộ NV (CC không đủ — gửi riêng cho dễ theo dõi).
    if (signedBuffer) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: this.larkMail.getInternalMail(),
          subject: this.larkMail.subjectCompleted(updated.title),
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
            <p>Thông báo nội bộ,</p>
            <p>Hợp đồng <strong>${escapeHtml(updated.title)}</strong> đã được
            <strong>ký kết hoàn tất</strong> bởi cả hai bên. File PDF có chữ ký
            đính kèm bên dưới.</p>
          </div>`,
          pdfBuffer: signedBuffer,
          pdfFileName: `${updated.title} - da ky.pdf`,
        });
      } catch (e) {
        this.logger.error(
          `Gửi Lark Mail nội bộ hoàn tất cho contract #${contractId} lỗi: ${e}`,
        );
      }
    }
  }

  /** Build PDF ký: burn text công ty vào PDF gốc. Field khách/ký được giữ. */
  private async buildSignedPdf(
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
    // Không burn ảnh — Documenso sẽ tự apply chữ ký cá nhân của user khi họ ký.
    const burnedPdf = await this.pdfBurn.burnText(originalPdf, burnItems);
    return { burnedPdf };
  }

  private async firstActiveSignerEmail(): Promise<string | null> {
    const first = await this.prisma.contractSigner.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    return first?.documensoEmail || null;
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

  /** envelope_xxx → numeric document id (qua GET /envelope). */
  private async resolveDocumentNumericId(documensoId: string): Promise<number> {
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

    const envelope = await this.documenso.createEnvelopeWithFields({
      title,
      externalId,
      fileBuffer: file.buffer,
      fileName: file.originalname || 'contract.pdf',
      recipients: [
        {
          email: recipientEmail,
          name: customer.name,
          role: 'SIGNER',
          signingOrder: 1,
          fields: [
            {
              type: 'SIGNATURE',
              page: 1,
              positionX: 10,
              positionY: 85,
              width: 30,
              height: 5,
            },
            {
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
    });

    const distributed = await this.documenso.distribute(envelope.envelopeId, true);
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
        contractType: 'SINGLE',
        sentAt: new Date(),
        createdBy: userId || null,
      },
      include: {
        customer: { select: { id: true, code: true, name: true, email: true } },
      },
    });

    if (signingUrl) {
      try {
        await this.larkMail.sendMailWithPdf({
          to: recipientEmail,
          subject: this.larkMail.subjectSentToCustomer(contract.title),
          html: this.larkMail.buildSentToCustomerHtml({
            customerName: customer.name,
            contractTitle: contract.title,
            signingUrl,
          }),
        });
      } catch (e) {
        this.logger.error(`Gửi mail #1 cho upload contract lỗi: ${e}`);
      }
    }

    return contract;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}