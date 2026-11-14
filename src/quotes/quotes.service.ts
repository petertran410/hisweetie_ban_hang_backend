import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { QuoteListQueryDto, QuotePayloadDto } from './dto/quote.dto';
import { validateTiers } from './quote-pricing';
import {
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_NEXT,
  QuoteStatus,
} from './quotes.constants';

export interface QuoteActor {
  id: number;
  name: string;
  /** Không có quotes:view_all → chỉ báo giá mình tạo (thư viện thì ai cũng xem). */
  ownOnly: boolean;
}

const ITEMS_INCLUDE = {
  items: {
    orderBy: { sortOrder: 'asc' },
    include: {
      tiers: { orderBy: { sortOrder: 'asc' } },
      // Tên POS hiện tại — cho dòng chưa lưu tên đầy đủ (dòng cũ, dòng lấy từ Thư viện)
      // + loại hàng (Hàng lạnh → bông tuyết ở cột Hình ảnh khi in)
      product: { select: { name: true, cargoType: true } },
    },
  },
} satisfies Prisma.QuoteInclude;

const CREATOR = {
  creator: { select: { id: true, name: true } },
} satisfies Prisma.QuoteInclude;

type QuoteRow = Prisma.QuoteGetPayload<{
  include: typeof ITEMS_INCLUDE & typeof CREATOR;
}>;
const LIST_INCLUDE = {
  ...CREATOR,
  template: { select: { name: true } },
  _count: { select: { items: true } },
} satisfies Prisma.QuoteInclude;

type QuoteListRow = Prisma.QuoteGetPayload<{ include: typeof LIST_INCLUDE }>;

/** Trạng thái đã chốt: không sửa nội dung, chỉ nhân bản. */
/** Ghi báo giá trong transaction: DB ở xa, để dư so với mặc định 5 giây của Prisma. */
const TX_TIMEOUT = 60_000;
const FINAL: string[] = ['accepted', 'rejected', 'expired'];

const num = (v: Prisma.Decimal | null) => (v == null ? null : Number(v));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ── Đọc ────────────────────────────────────────────────────────────
  async list(q: QuoteListQueryDto, actor: QuoteActor) {
    const library = q.tab === 'library';
    const where: Prisma.QuoteWhereInput = {
      isLibrary: library,
      ...(!library && actor.ownOnly ? { createdById: actor.id } : {}),
      ...(q.status?.length ? { status: { in: q.status } } : {}),
      ...(q.templateId?.length ? { templateId: { in: q.templateId } } : {}),
      ...(q.createdById?.length
        ? {
            createdById:
              actor.ownOnly && !library ? actor.id : { in: q.createdById },
          }
        : {}),
      ...(q.region?.length ? { region: { in: q.region } } : {}),
      ...(q.category?.length ? { category: { in: q.category } } : {}),
      ...(q.fromDate || q.toDate
        ? {
            createdAt: {
              ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
              ...(q.toDate ? { lte: new Date(q.toDate) } : {}),
            },
          }
        : {}),
      ...(q.search?.trim()
        ? {
            OR: ['code', 'title', 'customerName', 'customerCode'].map((f) => ({
              [f]: { contains: q.search!.trim(), mode: 'insensitive' },
            })),
          }
        : {}),
    };
    const page = q.page ?? 1;
    const size = Math.min(q.pageSize ?? 20, 100);
    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: library ? [{ id: 'asc' }] : [{ createdAt: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.quote.count({ where }),
    ]);
    return { data: rows.map((r) => this.toListItem(r)), total };
  }

  async get(id: number, actor: QuoteActor) {
    return this.toQuote(await this.load(id, actor));
  }

  private async load(id: number, actor: QuoteActor): Promise<QuoteRow> {
    const row = await this.prisma.quote.findUnique({
      where: { id },
      include: { ...ITEMS_INCLUDE, ...CREATOR },
    });
    if (!row) throw new NotFoundException('Không tìm thấy báo giá');
    if (!row.isLibrary && actor.ownOnly && row.createdById !== actor.id)
      throw new ForbiddenException('Bạn chỉ xem được báo giá của mình');
    return row;
  }

  // ── Ghi ────────────────────────────────────────────────────────────
  async create(dto: QuotePayloadDto, actor: QuoteActor) {
    await this.validate(dto);
    const created = await this.prisma.$transaction(
      async (tx) => {
        const q = await tx.quote.create({
          data: {
            ...this.header(dto),
            // Tạo mới luôn là báo giá Nháp; thư viện chỉ nạp bằng script import.
            isLibrary: false,
            status: 'draft',
            code: `TMP-${Date.now()}-${actor.id}`,
            createdById: actor.id,
          },
        });
        await this.writeItems(tx, q.id, dto);
        return tx.quote.update({
          where: { id: q.id },
          data: { code: `BG${String(q.id).padStart(6, '0')}` },
        });
      },
      { timeout: TX_TIMEOUT },
    );
    await this.log(
      actor,
      'QUOTE_CREATE',
      created.id,
      `Tạo báo giá ${created.code}`,
    );
    return this.get(created.id, actor);
  }

  async update(id: number, dto: QuotePayloadDto, actor: QuoteActor) {
    const current = await this.editable(id, actor);
    if (FINAL.includes(current.status))
      throw new BadRequestException(
        `Báo giá đã ở trạng thái "${QUOTE_STATUS_LABEL[current.status as QuoteStatus]}", không sửa được — hãy nhân bản để tạo bản mới`,
      );
    await this.validate(dto);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.quoteItem.deleteMany({ where: { quoteId: id } });
        // Trạng thái đổi qua PATCH /status, không qua sửa nội dung.
        await tx.quote.update({ where: { id }, data: this.header(dto) });
        await this.writeItems(tx, id, dto);
      },
      { timeout: TX_TIMEOUT },
    );
    await this.log(actor, 'QUOTE_UPDATE', id, `Sửa báo giá ${current.code}`);
    return this.get(id, actor);
  }

  async setStatus(id: number, status: QuoteStatus, actor: QuoteActor) {
    const current = await this.editable(id, actor);
    const from = current.status as QuoteStatus;
    if (!QUOTE_STATUS_NEXT[from].includes(status))
      throw new BadRequestException(
        `Không chuyển được từ "${QUOTE_STATUS_LABEL[from]}" sang "${QUOTE_STATUS_LABEL[status]}"`,
      );
    await this.prisma.quote.update({
      where: { id },
      data: { status, ...(status === 'sent' ? { sentAt: new Date() } : {}) },
    });
    await this.log(
      actor,
      'QUOTE_STATUS',
      id,
      `Báo giá ${current.code}: ${QUOTE_STATUS_LABEL[from]} → ${QUOTE_STATUS_LABEL[status]}`,
    );
    return this.get(id, actor);
  }

  /** Chỉ xoá được báo giá Nháp. */
  async remove(id: number, actor: QuoteActor) {
    const current = await this.editable(id, actor);
    if (current.status !== 'draft')
      throw new BadRequestException('Chỉ xoá được báo giá Nháp');
    await this.prisma.quote.delete({ where: { id } });
    await this.log(
      actor,
      'QUOTE_DELETE',
      id,
      `Xoá báo giá Nháp ${current.code}`,
    );
    return { ok: true };
  }

  /** Nhân bản — cũng là "Dùng mẫu này" từ Thư viện: bản mới là Nháp của người bấm. */
  async duplicate(id: number, actor: QuoteActor) {
    const src = await this.load(id, actor);
    const today = new Date().toISOString().slice(0, 10);
    const payload: QuotePayloadDto = {
      ...this.toQuote(src),
      isLibrary: false,
      status: 'draft',
      appliedFrom: today,
      sourceLibraryId: src.isLibrary ? src.id : src.sourceLibraryId,
    } as unknown as QuotePayloadDto;
    return this.create(payload, actor);
  }

  // ── Hỗ trợ ─────────────────────────────────────────────────────────
  /** Báo giá sửa được bởi actor: không phải thư viện; Sale chỉ sửa của mình. */
  private async editable(id: number, actor: QuoteActor) {
    const row = await this.prisma.quote.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        isLibrary: true,
        createdById: true,
      },
    });
    if (!row) throw new NotFoundException('Không tìm thấy báo giá');
    if (row.isLibrary)
      throw new ForbiddenException(
        'Mẫu thư viện chỉ cập nhật bằng file báo giá tổng hợp',
      );
    if (actor.ownOnly && row.createdById !== actor.id)
      throw new ForbiddenException('Bạn chỉ sửa được báo giá của mình');
    return row;
  }

  private async validate(dto: QuotePayloadDto) {
    if (!dto.items.length)
      throw new BadRequestException('Báo giá chưa có sản phẩm');
    if (dto.validUntil && dto.validUntil < dto.appliedFrom)
      throw new BadRequestException('Ngày hiệu lực phải sau ngày áp dụng');
    if (dto.customer && dto.customer.id == null && !dto.customer.name.trim())
      throw new BadRequestException(
        'Nhập tên khách hàng (khách chưa có trong POS)',
      );
    for (const it of dto.items) {
      const err = validateTiers(it.tiers);
      if (err) throw new BadRequestException(`${it.productName}: ${err}`);
    }
    if (dto.customer?.id != null) {
      const ok = await this.prisma.customer.count({
        where: { id: dto.customer.id },
      });
      if (!ok) throw new BadRequestException('Khách hàng không tồn tại');
    }
    const productIds = [
      ...new Set(
        dto.items.map((i) => i.productId).filter((x): x is number => x != null),
      ),
    ];
    if (productIds.length) {
      const found = await this.prisma.product.count({
        where: { id: { in: productIds } },
      });
      if (found !== productIds.length)
        throw new BadRequestException('Có sản phẩm không tồn tại');
    }
    if (dto.templateId != null) {
      const ok = await this.prisma.quoteTemplate.count({
        where: { id: dto.templateId },
      });
      if (!ok) throw new BadRequestException('Mẫu báo giá không tồn tại');
    }
  }

  private header(dto: QuotePayloadDto) {
    const c = dto.customer;
    return {
      templateId: dto.templateId ?? null,
      layout: dto.layout,
      region: dto.region,
      category: dto.category ?? null,
      customerId: c?.id ?? null,
      customerCode: c?.code ?? null,
      customerName: c?.name?.trim() || null,
      customerPhone: c?.contactNumber?.trim() || null,
      customerAddress: c?.address?.trim() || null,
      priceBookId: dto.priceBook?.id ?? null,
      priceBookName: dto.priceBook?.name ?? null,
      logoUrl: dto.logoUrl ?? null,
      companyName: dto.companyName.trim(),
      department: dto.department.trim(),
      title: dto.title.trim(),
      greeting: dto.greeting,
      intro: dto.intro,
      note: dto.note,
      closing: dto.closing,
      showMargin: dto.showMargin,
      appliedFrom: new Date(dto.appliedFrom),
      validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      sourceLibraryId: dto.sourceLibraryId ?? null,
    };
  }

  /**
   * Ghi dòng + khung giá theo lô (createMany): ~4 lần gọi DB thay vì 1 lần / dòng / khung
   * như nested create — báo giá 39 dòng từ ~23 giây xuống còn vài trăm ms.
   */
  private async writeItems(
    tx: Prisma.TransactionClient,
    quoteId: number,
    dto: QuotePayloadDto,
  ) {
    await tx.quoteItem.createMany({
      data: dto.items.map((it, i) => ({
        quoteId,
        sortOrder: i,
        productId: it.productId ?? null,
        productCode: it.productCode ?? null,
        fullName: it.fullName?.trim() || null,
        productName: it.productName.trim(),
        weight: it.weight?.trim() ?? '',
        spec: it.spec ?? '',
        unit: it.unit,
        imageUrl: it.imageUrl ?? null,
        basePrice: it.basePrice ?? null,
        priceBookPrice: it.priceBookPrice ?? null,
        comingSoon: !!it.comingSoon,
        note: it.note ?? null,
      })),
    });
    const rows = await tx.quoteItem.findMany({
      where: { quoteId },
      select: { id: true, sortOrder: true },
    });
    const idAt = new Map(rows.map((r) => [r.sortOrder, r.id]));
    const tiers = dto.items.flatMap((it, i) =>
      it.tiers.map((t, k) => ({
        quoteItemId: idAt.get(i) as number,
        sortOrder: k,
        key: t.key,
        label: t.label.trim(),
        minQty: t.minQty ?? null,
        maxQty: t.maxQty ?? null,
        unit: t.unit,
        price: t.price ?? null,
        manual: t.manual,
      })),
    );
    if (tiers.length) await tx.quoteItemTier.createMany({ data: tiers });
  }

  private customerRef(
    r: Pick<
      QuoteRow,
      | 'customerId'
      | 'customerCode'
      | 'customerName'
      | 'customerPhone'
      | 'customerAddress'
    >,
  ) {
    if (r.customerId == null && !r.customerName) return null;
    return {
      id: r.customerId,
      code: r.customerCode,
      name: r.customerName ?? '',
      contactNumber: r.customerPhone,
      address: r.customerAddress,
    };
  }

  /** Hàng DB → kiểu Quote của frontend (lib/types/quote.ts). */
  toQuote(r: QuoteRow) {
    return {
      id: r.id,
      code: r.code,
      isLibrary: r.isLibrary,
      status: r.status,
      templateId: r.templateId,
      layout: r.layout,
      region: r.region,
      category: r.category,
      customer: this.customerRef(r),
      priceBook: r.priceBookId
        ? { id: r.priceBookId, name: r.priceBookName ?? '' }
        : null,
      logoUrl: r.logoUrl,
      companyName: r.companyName,
      department: r.department,
      title: r.title,
      greeting: r.greeting,
      intro: r.intro,
      closing: r.closing,
      note: r.note,
      showMargin: r.showMargin,
      appliedFrom: day(r.appliedFrom)!,
      validUntil: day(r.validUntil),
      items: r.items.map((it) => ({
        id: String(it.id),
        productId: it.productId,
        productCode: it.productCode,
        fullName: it.fullName ?? it.product?.name ?? null,
        cold: it.product?.cargoType === 'COLD',
        productName: it.productName,
        weight: it.weight,
        spec: it.spec,
        unit: it.unit,
        imageUrl: it.imageUrl,
        basePrice: num(it.basePrice),
        priceBookPrice: num(it.priceBookPrice),
        comingSoon: it.comingSoon,
        note: it.note ?? undefined,
        tiers: it.tiers.map((t) => ({
          key: t.key,
          label: t.label,
          minQty: t.minQty,
          maxQty: t.maxQty,
          unit: t.unit,
          price: num(t.price),
          manual: t.manual,
        })),
      })),
      createdBy: r.creator,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      sourceLibraryId: r.sourceLibraryId,
    };
  }

  private toListItem(r: QuoteListRow) {
    return {
      id: r.id,
      code: r.code,
      isLibrary: r.isLibrary,
      status: r.status,
      templateId: r.templateId,
      templateName: r.template?.name ?? null,
      layout: r.layout,
      region: r.region,
      category: r.category,
      customer: this.customerRef(r),
      priceBook: r.priceBookId
        ? { id: r.priceBookId, name: r.priceBookName ?? '' }
        : null,
      title: r.title,
      greeting: r.greeting,
      showMargin: r.showMargin,
      appliedFrom: day(r.appliedFrom)!,
      validUntil: day(r.validUntil),
      createdBy: r.creator,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      sourceLibraryId: r.sourceLibraryId,
      itemCount: r._count.items,
    };
  }

  private log(
    actor: QuoteActor,
    actionCode: string,
    id: number,
    message: string,
  ) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'quotes',
      entityId: String(id),
      message,
      userId: actor.id,
      userName: actor.name,
    });
  }
}
