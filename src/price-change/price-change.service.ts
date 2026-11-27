import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PriceChangeItem, PriceChangeTicket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  BASE_PRICE_BOOK_ID,
  BASE_PRICE_BOOK_NAME,
  CODE_PREFIX,
  CostLine,
  PC_ACTION,
  PC_DECISION,
  PC_EVENT,
  PC_GROUPS,
  PC_STAGE,
  PcAction,
  PriceLine,
  STAGE_GROUP,
  STAGE_LABELS,
} from './price-change.constants';
import {
  RuleActor,
  checkItems,
  computeStatus,
  nextStage,
  resolveAccess,
  stagePath,
  submitBlockReason,
} from './price-change.rules';
import { summarizeItems } from './price-change.calc';
import {
  PcConfig,
  PriceChangeConfigService,
} from './price-change-config.service';
import {
  BuiltItem,
  PriceChangeReferenceService,
} from './price-change-reference.service';
import { PriceChangeNotifyService } from './price-change-notify.service';
import {
  CreatePcDto,
  PcCommentDto,
  PcDecisionDto,
  PcItemDto,
  PcQueryDto,
  UpdatePcDto,
} from './dto';

export interface PcUser {
  id: number;
  name?: string;
  roles?: string[];
  permissions?: string[];
}

type TicketData = Prisma.PriceChangeTicketUncheckedUpdateInput;
type Db = Prisma.TransactionClient | PrismaService;

const SUPER_ADMIN_ROLE = 'Super Admin';

/** Dòng phiếu đọc từ DB → kiểu có costs/prices rõ ràng. */
export function parseItem(row: PriceChangeItem) {
  return {
    ...row,
    costs: (row.costs as unknown as CostLine[]) ?? [],
    prices: (row.prices as unknown as PriceLine[]) ?? [],
  };
}

function idList(value: Prisma.JsonValue | null | undefined): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
    : [];
}

function uniqueIds(ids: number[] | undefined): number[] {
  return [...new Set((ids ?? []).filter((n) => Number.isInteger(n) && n >= 0))];
}

@Injectable()
export class PriceChangeService {
  private readonly logger = new Logger(PriceChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly pcConfig: PriceChangeConfigService,
    private readonly reference: PriceChangeReferenceService,
    private readonly notify: PriceChangeNotifyService,
  ) {}

  actorOf(user: PcUser): RuleActor {
    return {
      id: user.id,
      isSuperAdmin: !!user.roles?.includes(SUPER_ADMIN_ROLE),
      permissions: user.permissions ?? [],
    };
  }

  // ───────────────────────── Danh sách ─────────────────────────

  private async mineCondition(
    user: PcUser,
  ): Promise<Prisma.PriceChangeTicketWhereInput> {
    const cfg = await this.pcConfig.get();
    const or: Prisma.PriceChangeTicketWhereInput[] = [
      { createdById: user.id, stage: PC_STAGE.PROPOSAL },
    ];
    for (const [stage, group] of Object.entries(STAGE_GROUP)) {
      if (group && cfg.approvers[group]?.includes(user.id)) or.push({ stage });
    }
    return { OR: or };
  }

  private async buildWhere(
    query: PcQueryDto,
    user: PcUser,
    opts: { ignoreStages?: boolean; ignoreMine?: boolean } = {},
  ): Promise<Prisma.PriceChangeTicketWhereInput> {
    const and: Prisma.PriceChangeTicketWhereInput[] = [];
    const search = query.search?.trim();
    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { note: { contains: search, mode: 'insensitive' } },
          {
            items: {
              some: {
                OR: [
                  { productCode: { contains: search, mode: 'insensitive' } },
                  { productName: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }
    if (!opts.ignoreStages && query.stages?.length)
      and.push({ stage: { in: query.stages } });
    if (query.statuses?.length) and.push({ status: { in: query.statuses } });
    if (query.types?.length) {
      const or: Prisma.PriceChangeTicketWhereInput[] = [];
      if (query.types.includes('COST')) or.push({ hasCost: true });
      if (query.types.includes('SALE')) or.push({ hasSale: true });
      if (or.length) and.push({ OR: or });
    }
    if (query.createdByIds?.length)
      and.push({ createdById: { in: query.createdByIds } });
    if (query.productIds?.length)
      and.push({ items: { some: { productId: { in: query.productIds } } } });
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    if (createdAt.gte || createdAt.lte) and.push({ createdAt });
    if (!opts.ignoreMine && query.mine)
      and.push(await this.mineCondition(user));
    return and.length ? { AND: and } : {};
  }

  /** Tên các cột (chi nhánh / bảng giá) để hiển thị tóm tắt trong danh sách. */
  private async columnNames(tickets: PriceChangeTicket[]) {
    const branchIds = new Set<number>();
    const bookIds = new Set<number>();
    for (const t of tickets) {
      idList(t.costBranchIds).forEach((id) => branchIds.add(id));
      idList(t.priceBookIds).forEach((id) => bookIds.add(id));
    }
    bookIds.delete(BASE_PRICE_BOOK_ID);
    const [branches, books] = await Promise.all([
      this.prisma.branch.findMany({
        where: { id: { in: [...branchIds] } },
        select: { id: true, name: true },
      }),
      this.prisma.priceBook.findMany({
        where: { id: { in: [...bookIds] } },
        select: { id: true, name: true },
      }),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const bookName = new Map<number, string>([
      [BASE_PRICE_BOOK_ID, BASE_PRICE_BOOK_NAME],
      ...books.map((b) => [b.id, b.name] as [number, string]),
    ]);
    return (t: PriceChangeTicket) => ({
      costBranches: idList(t.costBranchIds).map((id) => ({
        id,
        name: branchName.get(id) ?? `#${id}`,
      })),
      priceBooks: idList(t.priceBookIds).map((id) => ({
        id,
        name: bookName.get(id) ?? `#${id}`,
      })),
    });
  }

  async findAll(query: PcQueryDto, user: PcUser) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const where = await this.buildWhere(query, user);
    const [rows, total] = await Promise.all([
      this.prisma.priceChangeTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { items: true } },
          items: {
            orderBy: { sort: 'asc' },
            take: 3,
            select: { productId: true, productCode: true, productName: true },
          },
        },
      }),
      this.prisma.priceChangeTicket.count({ where }),
    ]);
    const columns = await this.columnNames(rows);
    return {
      data: rows.map(({ _count, items, ...t }) => ({
        ...t,
        ...columns(t),
        itemCount: _count.items,
        previewItems: items,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getSummary(query: PcQueryDto, user: PcUser) {
    const where = await this.buildWhere(query, user, {
      ignoreStages: true,
      ignoreMine: true,
    });
    const [byStage, mine] = await Promise.all([
      this.prisma.priceChangeTicket.groupBy({
        by: ['stage'],
        where,
        _count: { _all: true },
      }),
      this.prisma.priceChangeTicket.count({
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

  // ───────────────────────── Chi tiết ─────────────────────────

  async getTicketOrThrow(id: number, db: Db = this.prisma) {
    const ticket = await db.priceChangeTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu');
    return ticket;
  }

  async getItems(ticketId: number, db: Db = this.prisma) {
    const rows = await db.priceChangeItem.findMany({
      where: { ticketId },
      orderBy: { sort: 'asc' },
    });
    return rows.map(parseItem);
  }

  async findOne(id: number, user: PcUser) {
    const [ticket, cfg, items, events] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
      this.getItems(id),
      this.prisma.priceChangeEvent.findMany({
        where: { ticketId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const columns = await this.columnNames([ticket]);
    const access = resolveAccess(ticket, this.actorOf(user), cfg.approvers);
    return {
      ...ticket,
      ...columns(ticket),
      items,
      summary: summarizeItems(items),
      path: stagePath(ticket.hasCost),
      access: {
        ...access,
        submitBlockReason: access.actions.includes(PC_ACTION.SUBMIT)
          ? submitBlockReason(items)
          : null,
      },
      events,
    };
  }

  async findIdByCode(code: string): Promise<number | null> {
    const t = await this.prisma.priceChangeTicket.findUnique({
      where: { code },
      select: { id: true },
    });
    return t?.id ?? null;
  }

  // ───────────────────────── Tạo / sửa ─────────────────────────

  private async generateCode(db: Db = this.prisma) {
    const last = await db.priceChangeTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const n = last ? parseInt(last.code.slice(CODE_PREFIX.length), 10) : 0;
    return `${CODE_PREFIX}${String((Number.isNaN(n) ? 0 : n) + 1).padStart(6, '0')}`;
  }

  /** Dựng + kiểm tra dòng phiếu; trả về dòng đã chụp giá cũ và hasCost/hasSale. */
  private async prepareItems(
    items: PcItemDto[],
    costBranchIds: number[],
    priceBookIds: number[],
    db: Db = this.prisma,
  ) {
    const built = await this.reference.buildItems(
      items,
      costBranchIds,
      priceBookIds,
      db,
    );
    const check = checkItems(built, costBranchIds, priceBookIds);
    if (check.errors.length)
      throw new BadRequestException(check.errors.slice(0, 5).join('; '));
    return { built, hasCost: check.hasCost, hasSale: check.hasSale };
  }

  private itemRows(ticketId: number, built: BuiltItem[]) {
    return built.map((b) => ({
      ticketId,
      sort: b.sort,
      productId: b.productId,
      productCode: b.productCode,
      productName: b.productName,
      costs: b.costs as unknown as Prisma.InputJsonValue,
      prices: b.prices as unknown as Prisma.InputJsonValue,
    }));
  }

  async create(dto: CreatePcDto, user: PcUser) {
    const costBranchIds = uniqueIds(dto.costBranchIds);
    const priceBookIds = uniqueIds(dto.priceBookIds);
    const { built, hasCost, hasSale } = await this.prepareItems(
      dto.items ?? [],
      costBranchIds,
      priceBookIds,
    );
    if (dto.submit) {
      const reason = submitBlockReason(built);
      if (reason) throw new BadRequestException(reason);
    }
    const stage = dto.submit ? PC_STAGE.CHIEF_ACCOUNTANT : PC_STAGE.PROPOSAL;
    const actorName = user.name ?? null;

    let ticket: PriceChangeTicket | null = null;
    for (let attempt = 0; attempt < 3 && !ticket; attempt++) {
      try {
        ticket = await this.prisma.$transaction(async (tx) => {
          const created = await tx.priceChangeTicket.create({
            data: {
              code: await this.generateCode(tx),
              stage,
              status: computeStatus({ stage }),
              hasCost,
              hasSale,
              costBranchIds,
              priceBookIds,
              note: dto.note?.trim() || null,
              documents: (dto.documents as any) ?? undefined,
              createdById: user.id,
              createdByName: actorName,
              updatedById: user.id,
              updatedByName: actorName,
            },
          });
          if (built.length) {
            await tx.priceChangeItem.createMany({
              data: this.itemRows(created.id, built),
            });
          }
          await tx.priceChangeEvent.create({
            data: {
              ticketId: created.id,
              type: PC_EVENT.CREATED,
              toStage: PC_STAGE.PROPOSAL,
              actorId: user.id,
              actorName,
            },
          });
          if (dto.submit) {
            await tx.priceChangeEvent.create({
              data: {
                ticketId: created.id,
                type: PC_EVENT.SUBMITTED,
                fromStage: PC_STAGE.PROPOSAL,
                toStage: stage,
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
      'price_change.create',
      `Tạo phiếu thay đổi giá ${ticket!.code} (${built.length} sản phẩm)`,
    );
    if (dto.submit)
      this.notify.send('TO_KTT', ticket!.id, {
        actorId: user.id,
        decidedByName: user.name,
        decidedByRole: 'Người đề xuất',
      });
    return this.findOne(ticket!.id, user);
  }

  async update(id: number, dto: UpdatePcDto, user: PcUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg, PC_ACTION.EDIT);

    const data: TicketData = {};
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.documents !== undefined)
      data.documents = (dto.documents as any) ?? Prisma.DbNull;

    const columnsChanged =
      dto.costBranchIds !== undefined || dto.priceBookIds !== undefined;
    let built: BuiltItem[] | null = null;
    if (dto.items !== undefined || columnsChanged) {
      const costBranchIds =
        dto.costBranchIds !== undefined
          ? uniqueIds(dto.costBranchIds)
          : idList(ticket.costBranchIds);
      const priceBookIds =
        dto.priceBookIds !== undefined
          ? uniqueIds(dto.priceBookIds)
          : idList(ticket.priceBookIds);
      // Không gửi items mà đổi cột → giữ giá mới đã nhập ở các cột còn lại.
      const items: PcItemDto[] =
        dto.items ??
        (await this.getItems(id))
          .filter((i) => i.productId !== null)
          .map((i) => ({
            productId: i.productId!,
            costs: i.costs
              .filter((c) => costBranchIds.includes(c.branchId))
              .map((c) => ({ branchId: c.branchId, newCost: c.newCost })),
            prices: i.prices
              .filter((p) => priceBookIds.includes(p.priceBookId))
              .map((p) => ({
                priceBookId: p.priceBookId,
                newPrice: p.newPrice,
              })),
          }));
      const prepared = await this.prepareItems(
        items,
        costBranchIds,
        priceBookIds,
      );
      built = prepared.built;
      Object.assign(data, {
        costBranchIds,
        priceBookIds,
        hasCost: prepared.hasCost,
        hasSale: prepared.hasSale,
      });
    }
    if (!Object.keys(data).length) return this.findOne(id, user);

    await this.transition(
      ticket,
      user,
      data,
      {
        type: PC_EVENT.UPDATED,
        data: built
          ? { items: built.length, ...summarizeItems(built) }
          : undefined,
      },
      built
        ? async (tx) => {
            await tx.priceChangeItem.deleteMany({ where: { ticketId: id } });
            if (built.length) {
              await tx.priceChangeItem.createMany({
                data: this.itemRows(id, built),
              });
            }
          }
        : undefined,
    );
    return this.findOne(id, user);
  }

  // ───────────────────────── Chuyển bước ─────────────────────────

  private requireAction(
    ticket: PriceChangeTicket,
    user: PcUser,
    cfg: PcConfig,
    action: PcAction,
  ) {
    const access = resolveAccess(ticket, this.actorOf(user), cfg.approvers);
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
    ticket: PriceChangeTicket,
    user: PcUser,
    data: TicketData,
    event: {
      type: string;
      toStage?: string;
      content?: string | null;
      data?: any;
    },
    extra?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const merged = { ...ticket, ...data } as any;
    const status = computeStatus(merged);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.priceChangeTicket.updateMany({
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
      if (extra) await extra(tx);
      await tx.priceChangeEvent.create({
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

  private resetDecisions(): TicketData {
    return {
      kttDecision: null,
      kttById: null,
      kttByName: null,
      kttAt: null,
      kttNote: null,
      ceoDecision: null,
      ceoById: null,
      ceoByName: null,
      ceoAt: null,
      ceoNote: null,
    };
  }

  /** Gửi duyệt: chụp lại giá cũ từ POS, xóa quyết định cũ, chuyển sang Kế toán trưởng. */
  async submit(id: number, user: PcUser) {
    const [ticket, cfg, items] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
      this.getItems(id),
    ]);
    this.requireAction(ticket, user, cfg, PC_ACTION.SUBMIT);
    const reason = submitBlockReason(items);
    if (reason) throw new BadRequestException(reason);

    const { built, hasCost, hasSale } = await this.prepareItems(
      items.map((i) => ({
        productId: i.productId!,
        costs: i.costs.map((c) => ({
          branchId: c.branchId,
          newCost: c.newCost,
        })),
        prices: i.prices.map((p) => ({
          priceBookId: p.priceBookId,
          newPrice: p.newPrice,
        })),
      })),
      idList(ticket.costBranchIds),
      idList(ticket.priceBookIds),
    );
    const toStage = PC_STAGE.CHIEF_ACCOUNTANT;
    await this.transition(
      ticket,
      user,
      {
        ...this.resetDecisions(),
        hasCost,
        hasSale,
        stage: toStage,
        stageEnteredAt: new Date(),
      },
      { type: PC_EVENT.SUBMITTED, toStage },
      async (tx) => {
        await tx.priceChangeItem.deleteMany({ where: { ticketId: id } });
        await tx.priceChangeItem.createMany({ data: this.itemRows(id, built) });
      },
    );
    this.audit(
      ticket,
      user,
      'price_change.submit',
      `Gửi duyệt phiếu thay đổi giá ${ticket.code}`,
    );
    this.notify.send('TO_KTT', id, {
      actorId: user.id,
      decidedByName: user.name,
      decidedByRole: 'Người đề xuất',
    });
    return this.findOne(id, user);
  }

  /** Kế toán trưởng / CEO duyệt hoặc từ chối. */
  private async decide(
    id: number,
    dto: PcDecisionDto,
    user: PcUser,
    role: 'KTT' | 'CEO',
  ) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
    ]);
    this.requireAction(
      ticket,
      user,
      cfg,
      role === 'KTT' ? PC_ACTION.KTT_DECIDE : PC_ACTION.CEO_DECIDE,
    );
    const note = dto.note?.trim() || null;
    const now = new Date();
    const prefix = role === 'KTT' ? 'ktt' : 'ceo';
    const decided: TicketData = {
      [`${prefix}Decision`]: dto.decision,
      [`${prefix}ById`]: user.id,
      [`${prefix}ByName`]: user.name ?? null,
      [`${prefix}At`]: now,
      [`${prefix}Note`]: note,
    };
    const roleLabel = role === 'KTT' ? 'Kế toán trưởng' : 'CEO';
    const eventType =
      role === 'KTT' ? PC_EVENT.KTT_DECIDED : PC_EVENT.CEO_DECIDED;

    if (dto.decision === PC_DECISION.APPROVED) {
      const toStage = nextStage(ticket.stage, ticket.hasCost)!;
      await this.transition(
        ticket,
        user,
        { ...decided, stage: toStage, stageEnteredAt: now },
        {
          type: eventType,
          toStage,
          content: note,
          data: { decision: dto.decision },
        },
      );
      this.audit(
        ticket,
        user,
        `price_change.${prefix}_decision`,
        `${roleLabel} duyệt phiếu thay đổi giá ${ticket.code}`,
      );
      this.notify.send(toStage === PC_STAGE.CEO ? 'TO_CEO' : 'TO_DATA', id, {
        actorId: user.id,
        decidedByName: user.name,
        decidedByRole: roleLabel,
      });
      return this.findOne(id, user);
    }

    if (!note) throw new BadRequestException('Vui lòng nhập lý do từ chối');
    const toStage = dto.end ? PC_STAGE.ENDED : PC_STAGE.PROPOSAL;
    await this.transition(
      ticket,
      user,
      {
        ...decided,
        stage: toStage,
        stageEnteredAt: now,
        ...(dto.end ? { endedAt: now, endReason: note } : {}),
      },
      {
        type: eventType,
        toStage,
        content: note,
        data: { decision: dto.decision, end: !!dto.end },
      },
    );
    this.audit(
      ticket,
      user,
      `price_change.${prefix}_decision`,
      `${roleLabel} từ chối phiếu thay đổi giá ${ticket.code}: ${note}`,
    );
    this.notify.send('REJECTED', id, {
      actorId: user.id,
      reason: note,
      decidedByName: user.name,
      decidedByRole: roleLabel,
      ended: !!dto.end,
    });
    return this.findOne(id, user);
  }

  kttDecision(id: number, dto: PcDecisionDto, user: PcUser) {
    return this.decide(id, dto, user, 'KTT');
  }

  ceoDecision(id: number, dto: PcDecisionDto, user: PcUser) {
    return this.decide(id, dto, user, 'CEO');
  }

  /** Phòng Dữ Liệu trả về người đề xuất (vd sản phẩm đã ngừng bán). */
  async sendBack(id: number, reason: string, user: PcUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg, PC_ACTION.SEND_BACK);
    const note = reason.trim();
    await this.transition(
      ticket,
      user,
      {
        ...this.resetDecisions(),
        stage: PC_STAGE.PROPOSAL,
        stageEnteredAt: new Date(),
        applyStartedAt: null,
      },
      { type: PC_EVENT.SENT_BACK, toStage: PC_STAGE.PROPOSAL, content: note },
    );
    this.audit(
      ticket,
      user,
      'price_change.send_back',
      `Trả về phiếu thay đổi giá ${ticket.code}: ${note}`,
    );
    this.notify.send('SENT_BACK', id, {
      actorId: user.id,
      reason: note,
      decidedByName: user.name,
      decidedByRole: 'Phòng Dữ Liệu',
    });
    return this.findOne(id, user);
  }

  async end(id: number, reason: string, user: PcUser) {
    const [ticket, cfg] = await Promise.all([
      this.getTicketOrThrow(id),
      this.pcConfig.get(),
    ]);
    this.requireAction(ticket, user, cfg, PC_ACTION.END);
    const now = new Date();
    const note = reason.trim();
    await this.transition(
      ticket,
      user,
      {
        stage: PC_STAGE.ENDED,
        stageEnteredAt: now,
        endedAt: now,
        endReason: note,
      },
      { type: PC_EVENT.ENDED, toStage: PC_STAGE.ENDED, content: note },
    );
    this.audit(
      ticket,
      user,
      'price_change.end',
      `Kết thúc phiếu thay đổi giá ${ticket.code}: ${note}`,
    );
    return this.findOne(id, user);
  }

  async addComment(id: number, dto: PcCommentDto, user: PcUser) {
    await this.getTicketOrThrow(id);
    await this.prisma.priceChangeEvent.create({
      data: {
        ticketId: id,
        type: PC_EVENT.COMMENT,
        content: dto.content.trim(),
        data: dto.attachments?.length
          ? ({ attachments: dto.attachments } as any)
          : undefined,
        actorId: user.id,
        actorName: user.name ?? null,
      },
    });
    return this.prisma.priceChangeEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ───────────────────────── Cấu hình ─────────────────────────

  async getConfigView() {
    const cfg = await this.pcConfig.get();
    const ids = [...new Set(PC_GROUPS.flatMap((g) => cfg.approvers[g]))];
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
    user: PcUser,
    actionCode: string,
    message: string,
    extra: { changes?: unknown; snapshot?: unknown } = {},
  ) {
    void this.auditLogs
      .create({
        actionType: 'POST',
        actionCode,
        message,
        entityType: 'price_change',
        entityId: String(ticket.id),
        entityCode: ticket.code,
        userId: user.id,
        userName: user.name || 'Nhân viên',
        category: 'Sản phẩm',
        severity: 'info',
        ...extra,
      })
      .catch((err) => this.logger.warn(`Ghi audit lỗi: ${err?.message}`));
  }
}
