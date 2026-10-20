import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FinanceAccessService,
  type FinanceActor,
} from '../auth/finance-access.service';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import { InternalFinanceCodeService } from '../internal-finance/internal-finance-code.service';
import { INTERNAL_FINANCE_REVIEW_ROLE } from '../internal-finance/internal-finance.constants';
import {
  CASH_ADVANCE_ALLOCATION_STATUS,
  CASH_ADVANCE_ATTACHMENT_KIND,
  CASH_ADVANCE_BRANCH_IDS,
  CASH_ADVANCE_CODE_CATEGORY,
  CASH_ADVANCE_FUND_SOURCE,
  CASH_ADVANCE_POSTED_STATUSES,
  CASH_ADVANCE_STATUS,
  cashAdvanceFundKey,
} from './cash-advance.constants';
import {
  advanceUsage,
  blockingAdvancesFor,
  fromCents,
  isCoverableExpense,
  loadBranchCoverage,
  previewEntryCoverage,
  releaseEntryAllocations,
  toCents,
  warehouseExpenseWhere,
  type BranchCoverage,
} from './cash-advance-coverage';
import {
  dateKeyToDb,
  dbDateKey,
  derivePeriod,
  formatDateKey,
  periodLabel,
  refundDueKey,
  vnDateKey,
  vnDayStart,
  vnTodayKey,
} from './cash-advance-period';
import {
  CashAdvanceAttachmentDto,
  CashAdvanceQueryDto,
  CashAdvanceReasonDto,
  CreateCashAdvanceDto,
  FundBalanceQueryDto,
  RecipientStatusQueryDto,
  SignedVoucherDto,
  UpdateCashAdvanceDto,
} from './dto/cash-advance.dto';

export type CashAdvanceActor = Exclude<FinanceActor, number>;

type CashAdvanceAction = 'view' | 'create' | 'update' | 'confirm' | 'cancel';

const userSelect = { select: { id: true, name: true } } as const;

const advanceInclude = {
  branch: userSelect,
  recipient: userSelect,
  creator: userSelect,
  confirmer: userSelect,
  completer: userSelect,
  canceller: userSelect,
  attachments: { orderBy: { id: 'asc' as const } },
  refunds: {
    select: {
      id: true,
      code: true,
      amount: true,
      status: true,
      refundDate: true,
    },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.CashAdvanceInclude;

type AdvanceRow = Prisma.CashAdvanceGetPayload<{
  include: typeof advanceInclude;
}>;

const attachmentData = (
  files: CashAdvanceAttachmentDto[] | undefined,
  kind: string,
  userId: number,
) =>
  (files || []).map((file) => ({
    kind,
    fileUrl: file.fileUrl,
    fileName: file.fileName,
    fileType: file.fileType,
    fileSize: file.fileSize,
    createdBy: userId,
  }));

@Injectable()
export class CashAdvancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
    private readonly ledger: InternalFundLedgerService,
    private readonly codes: InternalFinanceCodeService,
  ) {}

  private can(
    user: CashAdvanceActor,
    branchId: number,
    action: CashAdvanceAction,
  ) {
    return this.access.can(user, branchId, `cash_advance:${action}`);
  }

  private async assert(
    user: CashAdvanceActor,
    branchId: number,
    action: CashAdvanceAction,
  ) {
    await this.access.assert(user, branchId, `cash_advance:${action}`);
  }

  private async findRow(id: number) {
    const row = await this.prisma.cashAdvance.findUnique({
      where: { id },
      include: advanceInclude,
    });
    if (!row) throw new NotFoundException('Không tìm thấy phiếu tạm ứng');
    return row;
  }

  /** Số liệu đối chiếu + hạn hoàn ứng cho danh sách phiếu. */
  async decorate(rows: AdvanceRow[]) {
    if (!rows.length) return [];
    const today = vnTodayKey();
    const coverages = new Map<number, BranchCoverage>();
    for (const branchId of [...new Set(rows.map((row) => row.branchId))])
      coverages.set(branchId, await loadBranchCoverage(this.prisma, branchId));
    const [periodTotals, funds] = await Promise.all([
      Promise.all(
        rows.map((row) =>
          this.prisma.internalFinanceEntry.aggregate({
            where: warehouseExpenseWhere(
              row.branchId,
              dbDateKey(row.periodFrom),
              dbDateKey(row.periodTo),
            ),
            _sum: { amount: true },
            _count: { _all: true },
          }),
        ),
      ),
      this.prisma.internalFundTransaction.findMany({
        where: {
          sourceType: CASH_ADVANCE_FUND_SOURCE.ADVANCE,
          sourceId: { in: rows.map((row) => String(row.id)) },
        },
        select: {
          id: true,
          code: true,
          status: true,
          amount: true,
          occurredAt: true,
          sourceId: true,
        },
        orderBy: { id: 'desc' },
      }),
    ]);
    return rows.map((row, index) => {
      const activeRefunds = row.refunds.filter(
        (refund) => refund.status !== CASH_ADVANCE_STATUS.CANCELLED,
      );
      const usage = advanceUsage(
        row,
        coverages.get(row.branchId) || null,
        activeRefunds.reduce((sum, refund) => sum + toCents(refund.amount), 0),
      );
      const periodTo = dbDateKey(row.periodTo);
      const due = dbDateKey(row.refundDueDate);
      const posted = CASH_ADVANCE_POSTED_STATUSES.includes(row.status);
      const needsRefund =
        posted &&
        today > periodTo &&
        usage.remaining > 0 &&
        !activeRefunds.length;
      return {
        ...row,
        amount: Number(row.amount),
        advanceDate: dbDateKey(row.advanceDate),
        periodFrom: dbDateKey(row.periodFrom),
        periodTo,
        refundDueDate: due,
        periodLabel: periodLabel(row),
        refunds: row.refunds.map((refund) => ({
          ...refund,
          amount: Number(refund.amount),
          refundDate: dbDateKey(refund.refundDate),
        })),
        usage,
        totalInPeriod: Number(periodTotals[index]._sum.amount || 0),
        expenseCountInPeriod: periodTotals[index]._count._all,
        needsRefund,
        // Quá hạn hoàn ứng: chặn tạo tạm ứng mới cho người nhận.
        overdue: needsRefund && today > due,
        fundTransaction:
          funds.find((fund) => fund.sourceId === String(row.id)) || null,
      };
    });
  }

  async list(query: CashAdvanceQueryDto, user: CashAdvanceActor) {
    const allowed = await this.access.branchesFor(
      user,
      'cash_advance:view',
      CASH_ADVANCE_BRANCH_IDS,
    );
    if (!allowed.length)
      throw new ForbiddenException('Không có quyền xem phiếu tạm ứng');
    if (query.branchId && !allowed.includes(Number(query.branchId)))
      throw new ForbiddenException('Không có quyền xem tạm ứng của kho này');
    const branchIds = query.branchId ? [Number(query.branchId)] : allowed;
    const today = vnTodayKey();
    const conditions: Prisma.CashAdvanceWhereInput[] = [
      { branchId: { in: branchIds } },
    ];
    const statuses = (query.status || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (statuses.length) conditions.push({ status: { in: statuses } });
    if (query.recipientId) conditions.push({ recipientId: query.recipientId });
    if (query.createdBy) conditions.push({ createdBy: query.createdBy });
    if (query.fromDate)
      conditions.push({
        periodTo: { gte: dateKeyToDb(vnDateKey(query.fromDate)) },
      });
    if (query.toDate)
      conditions.push({
        periodFrom: { lte: dateKeyToDb(vnDateKey(query.toDate)) },
      });
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { recipient: { name: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }
    if (query.refundState) {
      conditions.push({
        status: { in: CASH_ADVANCE_POSTED_STATUSES },
        periodTo: { lt: dateKeyToDb(today) },
        refunds: { none: { status: { not: CASH_ADVANCE_STATUS.CANCELLED } } },
        ...(query.refundState === 'OVERDUE'
          ? { refundDueDate: { lt: dateKeyToDb(today) } }
          : {}),
      });
    }
    const where: Prisma.CashAdvanceWhereInput = { AND: conditions };
    const direction = query.orderDirection === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.CashAdvanceOrderByWithRelationInput[] =
      query.orderBy === 'amount'
        ? [{ amount: direction }, { id: 'desc' }]
        : query.orderBy === 'createdAt'
          ? [{ createdAt: direction }, { id: direction }]
          : [{ advanceDate: direction }, { id: direction }];
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    // Lọc theo tiền còn lại phải tính đối chiếu trước rồi mới phân trang.
    const all = await this.prisma.cashAdvance.findMany({
      where,
      orderBy,
      include: advanceInclude,
    });
    const decoratedAll = query.refundState
      ? (await this.decorate(all)).filter((row) => row.needsRefund)
      : null;
    const pageRows = decoratedAll
      ? decoratedAll.slice((page - 1) * limit, page * limit)
      : await this.decorate(all.slice((page - 1) * limit, page * limit));
    const summaryRows = decoratedAll ?? (await this.summaryUsage(all));
    const live = summaryRows.filter(
      (row) => row.status !== CASH_ADVANCE_STATUS.CANCELLED,
    );
    const sum = (pick: (row: (typeof live)[number]) => number) =>
      live.reduce((total, row) => total + pick(row), 0);
    return {
      data: pageRows,
      total: decoratedAll ? decoratedAll.length : all.length,
      page,
      limit,
      totals: {
        amount: sum((row) => Number(row.amount)),
        used: sum((row) => row.usage.used),
        refunded: sum((row) => row.usage.refunded),
        remaining: sum((row) => row.usage.remaining),
      },
    };
  }

  // Tổng của toàn bộ phiếu khớp lọc: chỉ cần số đối chiếu, không cần chi tiết.
  private async summaryUsage(rows: AdvanceRow[]) {
    const coverages = new Map<number, BranchCoverage>();
    for (const branchId of [...new Set(rows.map((row) => row.branchId))])
      coverages.set(branchId, await loadBranchCoverage(this.prisma, branchId));
    return rows.map((row) => ({
      status: row.status,
      amount: Number(row.amount),
      usage: advanceUsage(
        row,
        coverages.get(row.branchId) || null,
        row.refunds
          .filter((refund) => refund.status !== CASH_ADVANCE_STATUS.CANCELLED)
          .reduce((sum, refund) => sum + toCents(refund.amount), 0),
      ),
    }));
  }

  async detailOf(id: number) {
    const row = await this.findRow(id);
    const [decorated] = await this.decorate([row]);
    return decorated;
  }

  async get(id: number, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    await this.assert(user, row.branchId, 'view');
    const [decorated] = await this.decorate([row]);
    return { ...decorated, expenses: await this.breakdown(row) };
  }

  /**
   * Phiếu chi kho trong kỳ chia 3 nhóm: đã chi từ tạm ứng này (đã chốt), dự
   * kiến trừ vào tạm ứng này (chưa Đã chi), và phần không thuộc tạm ứng này.
   */
  private async breakdown(row: AdvanceRow) {
    const coverage = await loadBranchCoverage(this.prisma, row.branchId);
    const posted = CASH_ADVANCE_POSTED_STATUSES.includes(row.status);
    const expenses = await this.prisma.internalFinanceEntry.findMany({
      where: warehouseExpenseWhere(
        row.branchId,
        dbDateKey(row.periodFrom),
        dbDateKey(row.periodTo),
      ),
      select: {
        id: true,
        code: true,
        direction: true,
        branchId: true,
        category: true,
        status: true,
        occurredAt: true,
        description: true,
        amount: true,
        cashIssued: true,
        cashIssuedAt: true,
        cashFlowId: true,
        sourceSnapshot: true,
        payer: userSelect,
        advanceAllocations: {
          where: { status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE },
          select: {
            advanceId: true,
            amount: true,
            advance: { select: { code: true } },
          },
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    const codeOf = new Map(
      coverage.advances.map((item) => [item.id, item.code]),
    );
    const view = (entry: (typeof expenses)[number], cents: number) => ({
      id: entry.id,
      code: entry.code,
      occurredAt: entry.occurredAt,
      description: entry.description,
      amount: Number(entry.amount),
      allocated: fromCents(cents),
      status: entry.status,
      cashIssued: entry.cashIssued,
      cashIssuedAt: entry.cashIssuedAt,
      payer: entry.payer,
    });
    const locked: ReturnType<typeof view>[] = [];
    const projected: ReturnType<typeof view>[] = [];
    const outside: Array<
      ReturnType<typeof view> & { reason: string; advanceCodes: string[] }
    > = [];
    for (const entry of expenses) {
      const parts = coverage.plan.parts.filter(
        (part) => part.entryId === entry.id,
      );
      const lockedHere = entry.advanceAllocations
        .filter((item) => item.advanceId === row.id)
        .reduce((sum, item) => sum + toCents(item.amount), 0);
      const projectedHere = parts
        .filter((part) => part.advanceId === row.id)
        .reduce((sum, part) => sum + part.cents, 0);
      if (lockedHere > 0) locked.push(view(entry, lockedHere));
      if (projectedHere > 0) projected.push(view(entry, projectedHere));
      const rest = toCents(entry.amount) - lockedHere - projectedHere;
      if (rest <= 0) continue;
      const elsewhere = [
        ...entry.advanceAllocations
          .filter((item) => item.advanceId !== row.id)
          .map((item) => item.advance.code),
        ...parts
          .filter((part) => part.advanceId !== row.id)
          .map((part) => codeOf.get(part.advanceId) || ''),
      ].filter(Boolean);
      const snapshot = entry.sourceSnapshot as {
        larkLedgerRecorded?: unknown;
      } | null;
      const reason = !isCoverableExpense(entry)
        ? snapshot?.larkLedgerRecorded === true
          ? 'LARK_LEDGER'
          : 'CASH_FLOW'
        : elsewhere.length
          ? 'OTHER_ADVANCE'
          : entry.cashIssued
            ? 'FUND'
            : posted
              ? 'OVER_LIMIT'
              : 'NOT_CONFIRMED';
      outside.push({
        ...view(entry, rest),
        reason,
        advanceCodes: [...new Set(elsewhere)],
      });
    }
    return { locked, projected, outside };
  }

  /** Người nhận đang bị chặn tạo tạm ứng mới (quá hạn hoàn ứng). */
  async recipientStatus(
    query: RecipientStatusQueryDto,
    user: CashAdvanceActor,
  ) {
    const allowed = await this.access.branchesFor(
      user,
      ['cash_advance:create', 'cash_advance:update', 'cash_advance:view'],
      CASH_ADVANCE_BRANCH_IDS,
    );
    if (!allowed.length)
      throw new ForbiddenException('Không có quyền tạo phiếu tạm ứng');
    const advances = await blockingAdvancesFor(
      this.prisma,
      query.recipientId,
      vnTodayKey(),
    );
    return { blocked: advances.length > 0, advances };
  }

  private async assertRecipientOpen(recipientId: number, excludeId?: number) {
    const blocking = await blockingAdvancesFor(
      this.prisma,
      recipientId,
      vnTodayKey(),
      excludeId,
    );
    if (!blocking.length) return;
    const list = blocking
      .map(
        (row) =>
          `${row.code} (hạn ${formatDateKey(row.refundDueDate)}, còn ${new Intl.NumberFormat('vi-VN').format(row.remaining)}đ)`,
      )
      .join(', ');
    throw new BadRequestException(
      `Người nhận còn tạm ứng quá hạn chưa làm hoàn ứng: ${list}. Cần làm phiếu hoàn ứng trước khi tạm ứng mới`,
    );
  }

  /** Số dư quỹ kho hôm nay (cảnh báo trước khi giao tiền). */
  async fundBalance(query: FundBalanceQueryDto, user: CashAdvanceActor) {
    const permitted =
      (await this.can(user, query.branchId, 'create')) ||
      (await this.can(user, query.branchId, 'confirm'));
    if (!permitted)
      throw new ForbiddenException('Không có quyền xem số dư quỹ kho này');
    const balance = await this.prisma.$transaction((tx) =>
      this.ledger.balance(tx, query.branchId, vnTodayKey()),
    );
    return { branchId: query.branchId, closing: Number(balance.closing) };
  }

  private async assertRecipient(recipientId: number) {
    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true, isActive: true },
    });
    if (!recipient || !recipient.isActive)
      throw new BadRequestException(
        'Người nhận tạm ứng không tồn tại hoặc đã nghỉ',
      );
    return recipient;
  }

  async create(dto: CreateCashAdvanceDto, user: CashAdvanceActor) {
    await this.assert(user, dto.branchId, 'create');
    if (dto.clientUuid) {
      const existing = await this.prisma.cashAdvance.findUnique({
        where: { clientUuid: dto.clientUuid },
        select: { id: true },
      });
      if (existing) return this.detailOf(existing.id);
    }
    await this.assertRecipient(dto.recipientId);
    const period = derivePeriod(dto);
    const advanceDate = vnDateKey(dto.advanceDate);
    await this.assertRecipientOpen(dto.recipientId);
    const created = await this.prisma.$transaction(async (tx) => {
      const code = await this.codes.nextCode(tx, {
        direction: 'EXPENSE',
        category: CASH_ADVANCE_CODE_CATEGORY.ADVANCE,
        branchId: dto.branchId,
        occurredAt: vnDayStart(advanceDate),
      });
      return tx.cashAdvance.create({
        data: {
          code,
          clientUuid: dto.clientUuid,
          branchId: dto.branchId,
          recipientId: dto.recipientId,
          amount: dto.amount,
          advanceDate: dateKeyToDb(advanceDate),
          periodMode: period.mode,
          periodYear: period.year,
          periodWeek: period.week,
          periodFrom: dateKeyToDb(period.from),
          periodTo: dateKeyToDb(period.to),
          refundDueDate: dateKeyToDb(refundDueKey(period.to)),
          description: dto.description.trim(),
          status: CASH_ADVANCE_STATUS.DRAFT,
          createdBy: user.id,
          attachments: {
            create: attachmentData(
              dto.attachments,
              CASH_ADVANCE_ATTACHMENT_KIND.INITIAL,
              user.id,
            ),
          },
        },
      });
    });
    return this.detailOf(created.id);
  }

  async update(id: number, dto: UpdateCashAdvanceDto, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    if (row.status !== CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Chỉ sửa được phiếu tạm (chưa giao tiền)');
    const permitted =
      (await this.can(user, row.branchId, 'update')) ||
      (row.createdBy === user.id &&
        (await this.can(user, row.branchId, 'create')));
    if (!permitted)
      throw new ForbiddenException('Không có quyền sửa phiếu tạm ứng');
    const recipientId = dto.recipientId ?? row.recipientId;
    if (dto.recipientId && dto.recipientId !== row.recipientId) {
      await this.assertRecipient(dto.recipientId);
      await this.assertRecipientOpen(dto.recipientId, row.id);
    }
    const periodChanged = [
      dto.periodMode,
      dto.periodYear,
      dto.periodWeek,
      dto.periodFrom,
      dto.periodTo,
    ].some((value) => value !== undefined);
    const period = periodChanged
      ? derivePeriod({
          periodMode: dto.periodMode ?? row.periodMode,
          periodYear: dto.periodYear ?? row.periodYear,
          periodWeek: dto.periodWeek ?? row.periodWeek,
          periodFrom: dto.periodFrom ?? dbDateKey(row.periodFrom),
          periodTo: dto.periodTo ?? dbDateKey(row.periodTo),
        })
      : null;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.cashAdvance.findUnique({ where: { id } });
      if (current?.status !== CASH_ADVANCE_STATUS.DRAFT)
        throw new BadRequestException('Phiếu đã giao tiền, không sửa được');
      if (dto.attachments) {
        await tx.cashAdvanceAttachment.deleteMany({
          where: { advanceId: id, kind: CASH_ADVANCE_ATTACHMENT_KIND.INITIAL },
        });
        await tx.cashAdvanceAttachment.createMany({
          data: attachmentData(
            dto.attachments,
            CASH_ADVANCE_ATTACHMENT_KIND.INITIAL,
            user.id,
          ).map((file) => ({ ...file, advanceId: id })),
        });
      }
      await tx.cashAdvance.update({
        where: { id },
        data: {
          recipientId,
          amount: dto.amount,
          advanceDate: dto.advanceDate
            ? dateKeyToDb(vnDateKey(dto.advanceDate))
            : undefined,
          description: dto.description?.trim(),
          ...(period
            ? {
                periodMode: period.mode,
                periodYear: period.year,
                periodWeek: period.week,
                periodFrom: dateKeyToDb(period.from),
                periodTo: dateKeyToDb(period.to),
                refundDueDate: dateKeyToDb(refundDueKey(period.to)),
              }
            : {}),
        },
      });
    });
    return this.detailOf(id);
  }

  /** Xác nhận giao tiền: tiền ra khỏi quỹ kho, phiếu chờ upload phiếu đã ký. */
  async confirm(id: number, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    await this.assert(user, row.branchId, 'confirm');
    if (row.status !== CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Phiếu đã giao tiền hoặc đã hủy');
    await this.assertRecipientOpen(row.recipientId, row.id);
    const adjust = await this.access.can(
      user,
      row.branchId,
      'internal_fund:adjust',
    );
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.cashAdvance.findUnique({ where: { id } });
      if (current?.status !== CASH_ADVANCE_STATUS.DRAFT)
        throw new BadRequestException('Phiếu đã giao tiền hoặc đã hủy');
      const now = new Date();
      await this.ledger.postSystemTransaction(tx, {
        branchId: current.branchId,
        transactionType: 'EXPENSE',
        codeKind: 'CHI',
        amount: current.amount,
        occurredAt: now,
        description: `Tạm ứng ${current.code} – ${row.recipient.name}: ${current.description}`,
        sourceType: CASH_ADVANCE_FUND_SOURCE.ADVANCE,
        sourceKey: cashAdvanceFundKey(id),
        sourceId: String(id),
        userId: user.id,
        assertOpen: true,
        adjust,
      });
      await tx.cashAdvance.update({
        where: { id },
        data: {
          status: CASH_ADVANCE_STATUS.CONFIRMING,
          confirmedAt: now,
          confirmedBy: user.id,
        },
      });
    });
    return this.detailOf(id);
  }

  /** Upload phiếu tạm ứng đã ký: người nhận hoặc người tạo phiếu. */
  async uploadSigned(
    id: number,
    dto: SignedVoucherDto,
    user: CashAdvanceActor,
  ) {
    const row = await this.findRow(id);
    const superAdmin = await this.access.isSuperAdmin(user);
    if (
      !superAdmin &&
      (![row.recipientId, row.createdBy].includes(user.id) ||
        !(await this.can(user, row.branchId, 'view')))
    )
      throw new ForbiddenException(
        'Chỉ người nhận tạm ứng hoặc người tạo phiếu được upload phiếu đã ký',
      );
    if (row.status === CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Cần xác nhận giao tiền trước');
    if (row.status === CASH_ADVANCE_STATUS.CANCELLED)
      throw new BadRequestException('Phiếu đã hủy');
    await this.prisma.$transaction(async (tx) => {
      await tx.cashAdvanceAttachment.createMany({
        data: attachmentData(
          dto.attachments,
          CASH_ADVANCE_ATTACHMENT_KIND.SIGNED,
          user.id,
        ).map((file) => ({ ...file, advanceId: id })),
      });
      if (row.status === CASH_ADVANCE_STATUS.CONFIRMING)
        await tx.cashAdvance.update({
          where: { id },
          data: {
            status: CASH_ADVANCE_STATUS.COMPLETED,
            completedAt: new Date(),
            completedBy: user.id,
          },
        });
    });
    return this.detailOf(id);
  }

  /** Hủy phiếu (không xóa); đã giao tiền thì trả tiền về quỹ. */
  async cancel(id: number, dto: CashAdvanceReasonDto, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    if (row.status === CASH_ADVANCE_STATUS.CANCELLED)
      throw new BadRequestException('Phiếu đã hủy');
    const permitted =
      (await this.can(user, row.branchId, 'cancel')) ||
      (row.status === CASH_ADVANCE_STATUS.DRAFT &&
        row.createdBy === user.id &&
        (await this.can(user, row.branchId, 'create')));
    if (!permitted)
      throw new ForbiddenException('Không có quyền hủy phiếu tạm ứng');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Cần lý do hủy');
    const adjust = await this.access.can(
      user,
      row.branchId,
      'internal_fund:adjust',
    );
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.cashAdvance.findUnique({ where: { id } });
      if (!current || current.status === CASH_ADVANCE_STATUS.CANCELLED)
        throw new BadRequestException('Phiếu đã hủy');
      const allocated = await tx.cashAdvanceAllocation.count({
        where: { advanceId: id, status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE },
      });
      if (allocated)
        throw new BadRequestException(
          'Đã có phiếu chi kho Đã chi từ tạm ứng này: bỏ Đã chi các phiếu đó trước',
        );
      const refunds = await tx.cashAdvanceRefund.count({
        where: {
          advanceId: id,
          status: { not: CASH_ADVANCE_STATUS.CANCELLED },
        },
      });
      if (refunds)
        throw new BadRequestException(
          'Tạm ứng đã có phiếu hoàn ứng: hủy hoàn ứng trước',
        );
      const fund = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: cashAdvanceFundKey(id) },
      });
      if (fund?.status === 'POSTED') {
        await this.ledger.assertOpen(tx, row.branchId, fund.occurredAt, adjust);
        await this.ledger.cancelBySource(
          tx,
          cashAdvanceFundKey(id),
          user.id,
          `Hủy tạm ứng ${row.code}: ${reason}`,
        );
      }
      await tx.cashAdvance.update({
        where: { id },
        data: {
          status: CASH_ADVANCE_STATUS.CANCELLED,
          cancelledAt: new Date(),
          cancelledBy: user.id,
          cancelReason: reason,
        },
      });
    });
    return this.detailOf(id);
  }

  /** Số tiền hoàn ứng đề xuất / tối đa của tạm ứng. */
  async refundable(id: number, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    const permitted =
      (await this.access.can(
        user,
        row.branchId,
        'cash_advance_refund:create',
      )) || (await this.can(user, row.branchId, 'view'));
    if (!permitted)
      throw new ForbiddenException('Không có quyền xem tạm ứng này');
    const [decorated] = await this.decorate([row]);
    return {
      advanceId: id,
      suggested: decorated.usage.suggestedRefund,
      max: decorated.usage.maxRefund,
      usage: decorated.usage,
    };
  }

  /** Xem trước khi tick Đã chi: bao nhiêu chi từ tạm ứng, bao nhiêu trừ quỹ. */
  async coveragePreview(entryId: number, user: CashAdvanceActor) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        direction: true,
        branchId: true,
        category: true,
        status: true,
        amount: true,
        cashFlowId: true,
        cashIssued: true,
        sourceSnapshot: true,
      },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy phiếu chi');
    const permitted =
      (await this.access.can(user, entry.branchId, 'warehouse_expense:view')) ||
      (await this.access.can(user, entry.branchId, 'internal_fund:view'));
    if (!permitted)
      throw new ForbiddenException('Không có quyền xem phiếu chi này');
    const preview = await previewEntryCoverage(this.prisma, entry);
    const amountCents = toCents(entry.amount);
    return {
      entryId,
      amount: fromCents(amountCents),
      covered: fromCents(preview.coveredCents),
      uncovered: fromCents(Math.max(0, amountCents - preview.coveredCents)),
      parts: preview.parts.map((part) => ({
        advanceId: part.advanceId,
        code: part.code,
        amount: fromCents(part.cents),
      })),
    };
  }

  /**
   * Bỏ Đã chi của phiếu chi kho đã chi từ tạm ứng: nhả phần đã chốt, hủy
   * dòng quỹ phần vượt (nếu có) để tick Đã chi lại được.
   */
  async releaseEntry(
    entryId: number,
    dto: CashAdvanceReasonDto,
    user: CashAdvanceActor,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: { id: true, branchId: true, code: true },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy phiếu chi');
    await this.access.assert(user, entry.branchId, 'internal_fund:cancel');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Cần lý do bỏ Đã chi');
    const adjust = await this.access.can(
      user,
      entry.branchId,
      'internal_fund:adjust',
    );
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [entry.branchId]);
      const allocations = await tx.cashAdvanceAllocation.count({
        where: { entryId, status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE },
      });
      if (!allocations)
        throw new BadRequestException('Phiếu chi này không chi từ tạm ứng');
      const fund = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: `EXPENSE:${entryId}` },
      });
      if (fund?.status === 'POSTED') {
        await this.ledger.assertOpen(
          tx,
          entry.branchId,
          fund.occurredAt,
          adjust,
        );
        await this.ledger.releaseCancelled(tx, fund, user.id, reason);
      }
      await releaseEntryAllocations(tx, [entryId], user.id, reason);
      await tx.internalFinanceEntry.update({
        where: { id: entryId },
        data: {
          cashIssued: false,
          cashIssuedAt: null,
          cashIssuedBy: null,
          cashIssuedReason: null,
        },
      });
      await tx.internalFinanceReview.create({
        data: {
          entryId,
          role: INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
          decision: 'UNISSUE_ADVANCE',
          reason,
          reviewerId: user.id,
        },
      });
    });
    return { entryId, released: true };
  }
}
