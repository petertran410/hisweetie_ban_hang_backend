import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NewProductPriceTicket, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { loadUnitNameMap, resolveUnitFromMap } from '../common/unit.util';
import {
  CODE_PREFIX,
  DOMESTIC_ORIGIN,
  NPP_ACTION,
  NPP_DECISION,
  NPP_EVENT,
  NPP_GROUP,
  NPP_GROUPS,
  NPP_STAGE,
  NppAction,
  NppStage,
  STAGE_GROUP,
  STAGE_LABELS,
  fieldLabel,
} from './new-product-price.constants';
import {
  FIELD_KINDS,
  PARALLEL_FIELDS,
  RuleActor,
  completeBlockReason,
  computeStatus,
  missingRequired,
  nextStage,
  normText,
  resolveAccess,
} from './new-product-price.rules';
import {
  goodsPriceVnd,
  leadtimeDays,
  priceAnalysis,
} from './new-product-price.calc';
import { NewProductPriceConfigService } from './new-product-price-config.service';
import { NewProductPriceNotifyService } from './new-product-price-notify.service';
import { NppNotifyKind } from './new-product-price-lark-cards';
import {
  CreateNppDto,
  NppCommentDto,
  NppDecisionDto,
  NppQueryDto,
  UpdateNppDto,
} from './dto';

export interface NppUser {
  id: number;
  name?: string;
  roles?: string[];
  permissions?: string[];
}

type TicketData = Prisma.NewProductPriceTicketUncheckedUpdateInput;

const SUPER_ADMIN_ROLE = 'Super Admin';
const COGS_FIELDS = ['cogsHn', 'cogsSg', 'cogsDt'];
/** Trường ID → cột tên đi kèm (lịch sử hiện tên thay cho số ID). */
const ID_NAME_FIELDS: Record<string, string> = {
  tradeMarkId: 'tradeMarkName',
  costApproverId: 'costApproverName',
  supplierId: 'supplierName',
  factoryId: 'factoryName',
  oemPriceBookId: 'oemPriceBookName',
};

/** Decimal → number để FE nhận số (không phải chuỗi). */
export function serializeTicket<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Prisma.Decimal ? v.toNumber() : v;
  }
  return out as T;
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    if (v instanceof Prisma.Decimal) return v.toNumber();
    if (v instanceof Date) return v.toISOString();
    if (v === undefined) return null;
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

@Injectable()
export class NewProductPriceService {
  private readonly logger = new Logger(NewProductPriceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly nppConfig: NewProductPriceConfigService,
    private readonly notify: NewProductPriceNotifyService,
  ) {}

  actorOf(user: NppUser): RuleActor {
    return {
      id: user.id,
      isSuperAdmin: !!user.roles?.includes(SUPER_ADMIN_ROLE),
      permissions: user.permissions ?? [],
    };
  }

  // ───────────────────────── Danh sách ─────────────────────────

  private async mineCondition(
    user: NppUser,
  ): Promise<Prisma.NewProductPriceTicketWhereInput> {
    const cfg = await this.nppConfig.get();
    const or: Prisma.NewProductPriceTicketWhereInput[] = [
      { createdById: user.id, stage: NPP_STAGE.PROPOSAL },
      { costApproverId: user.id, stage: NPP_STAGE.PURCHASING },
    ];
    for (const [stage, group] of Object.entries(STAGE_GROUP)) {
      if (cfg.approvers[group!]?.includes(user.id)) or.push({ stage });
    }
    if (cfg.approvers[NPP_GROUP.CHIEF_ACCOUNTANT]?.includes(user.id)) {
      or.push({
        stage: NPP_STAGE.ACCOUNTING,
        sendToChiefAccountant: true,
        chiefAccountantDecision: null,
      });
    }
    return { OR: or };
  }

  private async buildWhere(
    query: NppQueryDto,
    user: NppUser,
    opts: { ignoreStages?: boolean; ignoreMine?: boolean } = {},
  ): Promise<Prisma.NewProductPriceTicketWhereInput> {
    const and: Prisma.NewProductPriceTicketWhereInput[] = [];
    const search = query.search?.trim();
    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { productName: { contains: search, mode: 'insensitive' } },
          { productCode: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (!opts.ignoreStages && query.stages?.length)
      and.push({ stage: { in: query.stages } });
    if (query.statuses?.length) and.push({ status: { in: query.statuses } });
    if (query.parentNames?.length)
      and.push({ parentName: { in: query.parentNames } });
    if (query.tradeMarkIds?.length)
      and.push({ tradeMarkId: { in: query.tradeMarkIds } });
    if (query.createdByIds?.length)
      and.push({ createdById: { in: query.createdByIds } });
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    if (createdAt.gte || createdAt.lte) and.push({ createdAt });
    if (!opts.ignoreMine && query.mine)
      and.push(await this.mineCondition(user));
    return and.length ? { AND: and } : {};
  }

  async findAll(query: NppQueryDto, user: NppUser) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const where = await this.buildWhere(query, user);
    const [rows, total] = await Promise.all([
      this.prisma.newProductPriceTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.newProductPriceTicket.count({ where }),
    ]);
    const now = new Date();
    return {
      data: rows.map((r) => ({
        ...serializeTicket(r),
        leadtimeDays: leadtimeDays(r, now),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getSummary(query: NppQueryDto, user: NppUser) {
    const where = await this.buildWhere(query, user, {
      ignoreStages: true,
      ignoreMine: true,
    });
    const [byStage, mine] = await Promise.all([
      this.prisma.newProductPriceTicket.groupBy({
        by: ['stage'],
        where,
        _count: { _all: true },
      }),
      this.prisma.newProductPriceTicket.count({
        where: { AND: [where, await this.mineCondition(user)] },
      }),
    ]);
    const stages: Record<string, number> = {};
    for (const s of Object.keys(STAGE_LABELS)) stages[s] = 0;
    let total = 0;
    for (const row of byStage) {
      stages[row.stage] = row._count._all;
      total += row._count._all;
    }
    return { stages, total, mine };
  }

  // ───────────────────────── Dữ liệu gốc ─────────────────────────

  async getReference() {
    const cfg = await this.nppConfig.get();
    const [
      categories,
      trademarks,
      units,
      priceBooks,
      branches,
      approverUsers,
      suppliers,
      factories,
    ] = await Promise.all([
      this.prisma.category.findMany({
        select: { name: true, type: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.tradeMark.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.unit.findMany({
        where: { isActive: true },
        select: { name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.priceBook.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.user.findMany({
        where: {
          id: { in: cfg.approvers[NPP_GROUP.PURCHASING] },
          isActive: true,
        },
        select: { id: true, name: true },
      }),
      // NCC & nhà máy cho ô chọn ở bước Thu Mua (phòng ban có thể không có quyền xem NCC)
      this.prisma.supplier.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.factory.findMany({
        where: { isActive: true },
        select: {
          id: true,
          code: true,
          name: true,
          supplierId: true,
          currency: true,
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    const byType = (type: string) =>
      categories.filter((c) => c.type === type).map((c) => c.name);
    return {
      categories: {
        parent: byType('parent'),
        middle: byType('middle'),
        child: byType('child'),
      },
      trademarks,
      units: units.map((u) => u.name),
      priceBooks,
      branches,
      costApprovers: approverUsers,
      suppliers,
      factories,
    };
  }

  async searchCustomers(search?: string) {
    const q = search?.trim();
    return this.prisma.customer.findMany({
      where: {
        isActive: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { code: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
      take: 30,
    });
  }

  // ───────────────────────── Chi tiết ─────────────────────────

  async getTicketOrThrow(id: number): Promise<NewProductPriceTicket> {
    const ticket = await this.prisma.newProductPriceTicket.findUnique({
      where: { id },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu');
    return ticket;
  }

  async findOne(id: number, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    const events = await this.prisma.newProductPriceEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'desc' },
    });
    const access = resolveAccess(
      ticket as any,
      this.actorOf(user),
      cfg.approvers,
    );
    return {
      ...serializeTicket(ticket),
      goodsPriceVnd: goodsPriceVnd(ticket),
      leadtimeDays: leadtimeDays(ticket),
      analysis: priceAnalysis(ticket),
      access,
      events,
    };
  }

  async findIdByCode(code: string): Promise<number | null> {
    const t = await this.prisma.newProductPriceTicket.findUnique({
      where: { code },
      select: { id: true },
    });
    return t?.id ?? null;
  }

  // ───────────────────────── Chuẩn hóa dữ liệu nhập ─────────────────────────

  /**
   * Đổi DTO thành dữ liệu ghi DB: ép kiểu, kiểm tra danh mục/thương hiệu/đơn vị có
   * trong dữ liệu gốc, chụp tên (thương hiệu, người duyệt cost, bảng giá OEM, khách OEM).
   * Trả về dữ liệu ghi + danh sách thay đổi so với `current`.
   */
  /**
   * NCC & nhà máy phải có trên POS (đang hoạt động); lưu kèm tên.
   * Nhà máy thuộc NCC nào thì NCC phải khớp — để trống NCC thì tự lấy theo nhà máy.
   */
  private async normalizeSupplierFactory(
    data: Record<string, any>,
    current: Partial<NewProductPriceTicket>,
  ) {
    if ('supplierId' in data) {
      if (data.supplierId) {
        const s = await this.prisma.supplier.findUnique({
          where: { id: data.supplierId },
          select: { name: true, isActive: true },
        });
        if (!s?.isActive) {
          throw new BadRequestException(
            'Nhà cung cấp không tồn tại hoặc đã ngừng hoạt động',
          );
        }
        data.supplierName = s.name;
      } else {
        data.supplierName = null;
      }
    }
    const factoryId =
      'factoryId' in data ? data.factoryId : (current.factoryId ?? null);
    if ('factoryId' in data && !data.factoryId) data.factoryName = null;
    if (!factoryId || !('factoryId' in data || 'supplierId' in data)) return;

    const f = await this.prisma.factory.findUnique({
      where: { id: factoryId },
      select: {
        name: true,
        isActive: true,
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!f?.isActive) {
      throw new BadRequestException(
        'Nhà máy không tồn tại hoặc đã ngừng hoạt động',
      );
    }
    if ('factoryId' in data) data.factoryName = f.name;
    if (!f.supplier) return;
    const supplierId =
      'supplierId' in data ? data.supplierId : (current.supplierId ?? null);
    if (!supplierId) {
      data.supplierId = f.supplier.id;
      data.supplierName = f.supplier.name;
    } else if (supplierId !== f.supplier.id) {
      throw new BadRequestException(
        `Nhà máy "${f.name}" thuộc NCC "${f.supplier.name}", không thuộc NCC đã chọn`,
      );
    }
  }

  async normalizeInput(
    dto: UpdateNppDto,
    current: Partial<NewProductPriceTicket>,
  ): Promise<{
    data: Record<string, any>;
    changes: Record<string, { from: any; to: any }>;
  }> {
    const data: Record<string, any> = {};
    const input = dto as Record<string, any>;

    for (const [field, kind] of Object.entries(FIELD_KINDS)) {
      if (!(field in input) || input[field] === undefined) continue;
      const raw = input[field];
      if (raw === null || raw === '') {
        data[field] = null;
        continue;
      }
      switch (kind) {
        case 'string':
          data[field] = String(raw).trim() || null;
          break;
        case 'number': {
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            throw new BadRequestException(`${fieldLabel(field)} không hợp lệ`);
          }
          data[field] = n;
          break;
        }
        case 'int': {
          const n = Number(raw);
          if (!Number.isInteger(n)) {
            throw new BadRequestException(`${fieldLabel(field)} không hợp lệ`);
          }
          data[field] = n;
          break;
        }
        case 'date': {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) {
            throw new BadRequestException(`${fieldLabel(field)} không hợp lệ`);
          }
          data[field] = d;
          break;
        }
        case 'json':
          data[field] = raw;
          break;
      }
    }

    if ('productName' in data && !data.productName) {
      throw new BadRequestException('Vui lòng nhập tên hàng hóa');
    }

    // Danh mục 3 cấp: phải có trong bảng categories (lưu đúng tên chuẩn).
    for (const [field, type] of [
      ['parentName', 'parent'],
      ['middleName', 'middle'],
      ['childName', 'child'],
    ] as const) {
      if (!data[field]) continue;
      const found = await this.prisma.category.findFirst({
        where: { type, name: { equals: data[field], mode: 'insensitive' } },
        select: { name: true },
      });
      if (!found) {
        throw new BadRequestException(
          `${fieldLabel(field)} "${data[field]}" không có trong danh mục`,
        );
      }
      data[field] = found.name;
    }

    if ('tradeMarkId' in data) {
      if (data.tradeMarkId) {
        const tm = await this.prisma.tradeMark.findUnique({
          where: { id: data.tradeMarkId },
          select: { name: true },
        });
        if (!tm) throw new BadRequestException('Thương hiệu không tồn tại');
        data.tradeMarkName = tm.name;
      } else {
        data.tradeMarkName = null;
      }
    }

    if (data.unit) {
      const resolved = resolveUnitFromMap(
        await loadUnitNameMap(this.prisma),
        data.unit,
      );
      if (resolved.unknown) {
        throw new BadRequestException(
          `Đơn vị tính "${resolved.unknown}" không có trong danh mục`,
        );
      }
      data.unit = resolved.name;
    }

    if ('costApproverId' in data) {
      if (data.costApproverId) {
        const u = await this.prisma.user.findUnique({
          where: { id: data.costApproverId },
          select: { name: true },
        });
        if (!u)
          throw new BadRequestException('Người duyệt giá cost không tồn tại');
        data.costApproverName = u.name;
      } else {
        data.costApproverName = null;
      }
    }

    await this.normalizeSupplierFactory(data, current);

    if ('oemPriceBookId' in data) {
      if (data.oemPriceBookId) {
        const pb = await this.prisma.priceBook.findUnique({
          where: { id: data.oemPriceBookId },
          select: { name: true },
        });
        if (!pb) throw new BadRequestException('Bảng giá OEM không tồn tại');
        data.oemPriceBookName = pb.name;
      } else {
        data.oemPriceBookName = null;
      }
    }

    if ('oemCustomers' in data) {
      const ids = [
        ...new Set(
          ((data.oemCustomers as { customerId: number }[]) ?? []).map((c) =>
            Number(c.customerId),
          ),
        ),
      ].filter(Number.isInteger);
      if (ids.length) {
        const customers = await this.prisma.customer.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, name: true },
        });
        data.oemCustomers = customers.map((c) => ({
          customerId: c.id,
          code: c.code,
          name: c.name,
        }));
      } else {
        data.oemCustomers = null;
      }
    }

    for (const field of ['images', 'documents']) {
      if (!(field in data) || !data[field]) continue;
      const list = (data[field] as any[]).map((a) => ({
        url: a.url,
        originalName: a.originalName ?? null,
        mimetype: a.mimetype ?? null,
        size: a.size ?? null,
        ...(field === 'images' ? { isPrimary: !!a.isPrimary } : {}),
        ...(a.larkFileToken ? { larkFileToken: a.larkFileToken } : {}),
      }));
      if (field === 'images' && list.length && !list.some((a) => a.isPrimary)) {
        list[0].isPrimary = true;
      }
      data[field] = list.length ? list : null;
    }

    // Hàng nội địa: tỉ giá = 1 (mô tả trường Tỉ giá trên Lark).
    const origin = 'middleName' in data ? data.middleName : current.middleName;
    if (origin && normText(origin) === normText(DOMESTIC_ORIGIN)) {
      data.exchangeRate = 1;
    }

    const changes: Record<string, { from: any; to: any }> = {};
    for (const [field, value] of Object.entries(data)) {
      const before = (current as Record<string, any>)[field];
      if (sameValue(before, value)) {
        delete data[field];
        continue;
      }
      if (field in FIELD_KINDS) {
        changes[field] = {
          from:
            before instanceof Prisma.Decimal
              ? before.toNumber()
              : (before ?? null),
          to: value,
        };
      }
    }

    // Lịch sử: trường chọn từ danh sách ghi tên (thương hiệu, NCC, nhà máy…) thay cho ID.
    const cur = current as Record<string, any>;
    for (const [idField, nameField] of Object.entries(ID_NAME_FIELDS)) {
      const c = changes[idField];
      if (!c) continue;
      changes[idField] = {
        from: c.from === null ? null : (cur[nameField] ?? c.from),
        to:
          c.to === null
            ? null
            : nameField in data
              ? data[nameField]
              : (cur[nameField] ?? c.to),
      };
    }

    if (PARALLEL_FIELDS.some((f) => f in changes))
      data.rdUpdatedAt = new Date();
    return { data, changes };
  }

  // ───────────────────────── Tạo / sửa ─────────────────────────

  private async generateCode(
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const last = await tx.newProductPriceTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const n = last ? parseInt(last.code.slice(CODE_PREFIX.length), 10) : 0;
    return `${CODE_PREFIX}${String((Number.isNaN(n) ? 0 : n) + 1).padStart(6, '0')}`;
  }

  async create(dto: CreateNppDto, user: NppUser) {
    if (!dto.productName?.trim())
      throw new BadRequestException('Vui lòng nhập tên hàng hóa');
    const { submit, ...fields } = dto;
    const { data } = await this.normalizeInput(fields, {});
    const actorName = user.name ?? null;

    const draft = { ...data, stage: NPP_STAGE.PROPOSAL, createdById: user.id };
    if (submit) {
      const missing = missingRequired(draft as any, NPP_STAGE.PROPOSAL);
      if (missing.length) {
        throw new BadRequestException(
          `Còn thiếu: ${missing.map(fieldLabel).join(', ')}`,
        );
      }
    }
    const stage = submit ? NPP_STAGE.PURCHASING : NPP_STAGE.PROPOSAL;

    let ticket: NewProductPriceTicket | null = null;
    for (let attempt = 0; attempt < 3 && !ticket; attempt++) {
      try {
        ticket = await this.prisma.$transaction(async (tx) => {
          const created = await tx.newProductPriceTicket.create({
            data: {
              ...(data as any),
              code: await this.generateCode(tx),
              stage,
              status: computeStatus({ ...draft, stage } as any),
              createdById: user.id,
              createdByName: actorName,
              updatedById: user.id,
              updatedByName: actorName,
            },
          });
          await tx.newProductPriceEvent.create({
            data: {
              ticketId: created.id,
              type: NPP_EVENT.CREATED,
              toStage: NPP_STAGE.PROPOSAL,
              actorId: user.id,
              actorName,
            },
          });
          if (submit) {
            await tx.newProductPriceEvent.create({
              data: {
                ticketId: created.id,
                type: NPP_EVENT.STAGE_COMPLETED,
                fromStage: NPP_STAGE.PROPOSAL,
                toStage: NPP_STAGE.PURCHASING,
                actorId: user.id,
                actorName,
              },
            });
          }
          return created;
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          attempt < 2
        ) {
          continue;
        }
        throw err;
      }
    }

    this.audit(
      ticket!,
      user,
      'new_product_price.create',
      `Tạo đề xuất sản phẩm mới ${ticket!.code} — ${ticket!.productName}`,
    );
    if (submit)
      this.notify.send('ENTER_PURCHASING', ticket!.id, { actorId: user.id });
    return this.findOne(ticket!.id, user);
  }

  async update(id: number, dto: UpdateNppDto, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    const access = resolveAccess(
      ticket as any,
      this.actorOf(user),
      cfg.approvers,
    );
    const keys = Object.keys(dto).filter(
      (k) => (dto as any)[k] !== undefined && k in FIELD_KINDS,
    );
    const forbidden = keys.filter((k) => !access.editableFields.includes(k));
    if (forbidden.length) {
      throw new ForbiddenException(
        `Bạn không được sửa: ${forbidden.map(fieldLabel).join(', ')}`,
      );
    }

    const { data, changes } = await this.normalizeInput(dto, ticket);
    if (!Object.keys(changes).length) return this.findOne(id, user);

    // Kế toán sửa giá vốn sau khi KTT đã quyết định → phải gửi duyệt lại.
    if (
      COGS_FIELDS.some((f) => f in changes) &&
      ticket.sendToChiefAccountant &&
      ticket.chiefAccountantDecision
    ) {
      Object.assign(data, {
        sendToChiefAccountant: false,
        chiefAccountantDecision: null,
        chiefAccountantById: null,
        chiefAccountantByName: null,
        chiefAccountantAt: null,
        chiefAccountantNote: null,
      });
    }

    await this.transition(ticket, user, data, {
      type: NPP_EVENT.UPDATED,
      data: { changes },
    });
    return this.findOne(id, user);
  }

  // ───────────────────────── Chuyển bước ─────────────────────────

  private requireAction(
    ticket: NewProductPriceTicket,
    user: NppUser,
    approvers: Awaited<
      ReturnType<NewProductPriceConfigService['get']>
    >['approvers'],
    action: NppAction,
  ) {
    const access = resolveAccess(ticket as any, this.actorOf(user), approvers);
    if (!access.actions.includes(action)) {
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện thao tác này ở bước hiện tại',
      );
    }
    return access;
  }

  /**
   * Ghi thay đổi có điều kiện "phiếu vẫn ở bước cũ" (chống 2 người bấm cùng lúc),
   * tính lại trạng thái và ghi event trong cùng transaction.
   */
  private async transition(
    ticket: NewProductPriceTicket,
    user: NppUser,
    data: TicketData,
    event: {
      type: string;
      toStage?: string;
      content?: string | null;
      data?: any;
    },
  ) {
    const merged = { ...ticket, ...data } as any;
    const status = computeStatus(merged);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.newProductPriceTicket.updateMany({
        where: { id: ticket.id, stage: ticket.stage },
        data: {
          ...(data as any),
          status,
          updatedById: user.id,
          updatedByName: user.name ?? null,
        },
      });
      if (res.count !== 1) {
        throw new ConflictException('Phiếu đã được cập nhật, vui lòng tải lại');
      }
      await tx.newProductPriceEvent.create({
        data: {
          ticketId: ticket.id,
          type: event.type,
          fromStage: event.toStage ? ticket.stage : null,
          toStage: event.toStage ?? null,
          content: event.content ?? null,
          data: event.data ?? undefined,
          actorId: user.id,
          actorName: user.name ?? null,
        },
      });
    });
  }

  async complete(id: number, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.COMPLETE);
    const block = completeBlockReason(ticket as any);
    if (block) throw new BadRequestException(block);

    const next = nextStage(ticket as any)!;
    const now = new Date();
    const data: TicketData = { stage: next, stageEnteredAt: now };
    if (ticket.stage === NPP_STAGE.SALES) data.salesDecidedAt = now;
    if (next === NPP_STAGE.CEO) {
      // Vào lại bước CEO sau khi làm lại → CEO quyết định lần mới.
      Object.assign(data, {
        ceoDecision: null,
        ceoById: null,
        ceoByName: null,
        ceoAt: null,
        ceoNote: null,
      });
    }

    await this.transition(ticket, user, data, {
      type: NPP_EVENT.STAGE_COMPLETED,
      toStage: next,
    });
    this.audit(
      ticket,
      user,
      'new_product_price.complete',
      `Hoàn tất bước ${STAGE_LABELS[ticket.stage as NppStage]} phiếu ${ticket.code} → ${STAGE_LABELS[next]}`,
    );

    const kindByStage: Partial<Record<NppStage, NppNotifyKind>> = {
      PURCHASING: 'ENTER_PURCHASING',
      ACCOUNTING: 'ENTER_ACCOUNTING',
      CEO: 'ENTER_CEO',
      DATA: 'TO_DATA',
    };
    const kind = kindByStage[next];
    if (kind) this.notify.send(kind, id, { actorId: user.id });
    return this.findOne(id, user);
  }

  private resetReviewData(): TicketData {
    return {
      sendToChiefAccountant: false,
      chiefAccountantDecision: null,
      chiefAccountantById: null,
      chiefAccountantByName: null,
      chiefAccountantAt: null,
      chiefAccountantNote: null,
    };
  }

  async sendBack(id: number, reason: string, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.SEND_BACK);
    await this.transition(
      ticket,
      user,
      {
        stage: NPP_STAGE.PURCHASING,
        stageEnteredAt: new Date(),
        ...this.resetReviewData(),
        ceoDecision: null,
        ceoById: null,
        ceoByName: null,
        ceoAt: null,
        ceoNote: null,
      },
      {
        type: NPP_EVENT.SENT_BACK,
        toStage: NPP_STAGE.PURCHASING,
        content: reason.trim(),
      },
    );
    this.audit(
      ticket,
      user,
      'new_product_price.send_back',
      `Trả phiếu ${ticket.code} về Phòng Thu Mua: ${reason.trim()}`,
    );
    this.notify.send('SENT_BACK', id, {
      actorId: user.id,
      reason: reason.trim(),
    });
    return this.findOne(id, user);
  }

  async sendToChiefAccountant(id: number, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.SEND_KTT);
    const missing = missingRequired(ticket as any, NPP_STAGE.ACCOUNTING);
    if (missing.length) {
      throw new BadRequestException(
        `Nhập đủ trước khi gửi duyệt: ${missing.map(fieldLabel).join(', ')}`,
      );
    }
    if (!cfg.approvers[NPP_GROUP.CHIEF_ACCOUNTANT]?.length) {
      throw new BadRequestException(
        'Chưa cấu hình Kế toán trưởng trong "Cấu hình duyệt"',
      );
    }
    await this.transition(
      ticket,
      user,
      { ...this.resetReviewData(), sendToChiefAccountant: true },
      { type: NPP_EVENT.KTT_SENT },
    );
    this.notify.send('KTT_REQUEST', id, { actorId: user.id });
    return this.findOne(id, user);
  }

  async chiefAccountantDecision(
    id: number,
    dto: NppDecisionDto,
    user: NppUser,
  ) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.KTT_DECIDE);
    const note = dto.note?.trim() || null;
    if (dto.decision === NPP_DECISION.REJECTED && !note) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối');
    }
    await this.transition(
      ticket,
      user,
      {
        chiefAccountantDecision: dto.decision,
        chiefAccountantById: user.id,
        chiefAccountantByName: user.name ?? null,
        chiefAccountantAt: new Date(),
        chiefAccountantNote: note,
      },
      {
        type: NPP_EVENT.KTT_DECIDED,
        content: note,
        data: { decision: dto.decision },
      },
    );
    this.audit(
      ticket,
      user,
      'new_product_price.ktt_decision',
      `Kế toán trưởng ${dto.decision === 'APPROVED' ? 'duyệt' : 'từ chối'} giá vốn phiếu ${ticket.code}`,
    );
    this.notify.send('KTT_DECIDED', id, {
      actorId: user.id,
      decision: dto.decision,
      decidedByName: user.name,
      reason: note,
    });
    return this.findOne(id, user);
  }

  async ceoDecision(id: number, dto: NppDecisionDto, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.CEO_DECIDE);
    const note = dto.note?.trim() || null;
    const now = new Date();
    const decided: TicketData = {
      ceoDecision: dto.decision,
      ceoById: user.id,
      ceoByName: user.name ?? null,
      ceoAt: now,
      ceoNote: note,
    };

    if (dto.decision === NPP_DECISION.APPROVED) {
      await this.transition(
        ticket,
        user,
        { ...decided, stage: NPP_STAGE.DATA, stageEnteredAt: now },
        {
          type: NPP_EVENT.CEO_DECIDED,
          toStage: NPP_STAGE.DATA,
          content: note,
          data: { decision: dto.decision },
        },
      );
      this.audit(
        ticket,
        user,
        'new_product_price.ceo_decision',
        `CEO duyệt bảng giá phiếu ${ticket.code}`,
      );
      this.notify.send('TO_DATA', id, { actorId: user.id });
      return this.findOne(id, user);
    }

    if (!note) throw new BadRequestException('Vui lòng nhập lý do từ chối');
    const toStage = dto.end ? NPP_STAGE.ENDED : NPP_STAGE.PURCHASING;
    await this.transition(
      ticket,
      user,
      {
        ...decided,
        stage: toStage,
        stageEnteredAt: now,
        ...(dto.end
          ? { endedAt: now, endReason: note }
          : this.resetReviewData()),
      },
      {
        type: NPP_EVENT.CEO_DECIDED,
        toStage,
        content: note,
        data: { decision: dto.decision, end: !!dto.end },
      },
    );
    this.audit(
      ticket,
      user,
      'new_product_price.ceo_decision',
      `CEO từ chối bảng giá phiếu ${ticket.code}: ${note}`,
    );
    this.notify.send('CEO_REJECTED', id, {
      actorId: user.id,
      reason: note,
      ended: !!dto.end,
    });
    return this.findOne(id, user);
  }

  async end(id: number, reason: string, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg.approvers, NPP_ACTION.END);
    const now = new Date();
    await this.transition(
      ticket,
      user,
      {
        stage: NPP_STAGE.ENDED,
        stageEnteredAt: now,
        endedAt: now,
        endReason: reason.trim(),
      },
      {
        type: NPP_EVENT.ENDED,
        toStage: NPP_STAGE.ENDED,
        content: reason.trim(),
      },
    );
    this.audit(
      ticket,
      user,
      'new_product_price.end',
      `Kết thúc phiếu ${ticket.code}: ${reason.trim()}`,
    );
    return this.findOne(id, user);
  }

  async addComment(id: number, dto: NppCommentDto, user: NppUser) {
    await this.getTicketOrThrow(id);
    await this.prisma.newProductPriceEvent.create({
      data: {
        ticketId: id,
        type: NPP_EVENT.COMMENT,
        content: dto.content.trim(),
        data: dto.attachments?.length
          ? ({ attachments: dto.attachments } as any)
          : undefined,
        actorId: user.id,
        actorName: user.name ?? null,
      },
    });
    return this.prisma.newProductPriceEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ───────────────────────── Cấu hình ─────────────────────────

  async getConfigView() {
    const cfg = await this.nppConfig.get();
    const ids = [...new Set(NPP_GROUPS.flatMap((g) => cfg.approvers[g]))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, larkUserId: true, isActive: true },
        })
      : [];
    return {
      ...cfg,
      members: users.map((u) => ({
        id: u.id,
        name: u.name,
        hasLark: !!u.larkUserId,
        isActive: u.isActive,
      })),
    };
  }

  // ───────────────────────── Audit ─────────────────────────

  audit(
    ticket: { id: number; code: string },
    user: NppUser,
    actionCode: string,
    message: string,
  ) {
    void this.auditLogs
      .create({
        actionType: 'POST',
        actionCode,
        message,
        entityType: 'new_product_price',
        entityId: String(ticket.id),
        entityCode: ticket.code,
        userId: user.id,
        userName: user.name || 'Nhân viên',
        category: 'Sản phẩm',
        severity: 'info',
      })
      .catch((err) => this.logger.warn(`Ghi audit lỗi: ${err?.message}`));
  }
}
