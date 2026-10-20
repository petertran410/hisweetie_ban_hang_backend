import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceAccessService } from '../auth/finance-access.service';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import { InternalFinanceCodeService } from '../internal-finance/internal-finance-code.service';
import {
  CASH_ADVANCE_ALLOCATION_STATUS,
  CASH_ADVANCE_ATTACHMENT_KIND,
  CASH_ADVANCE_BRANCH_IDS,
  CASH_ADVANCE_CODE_CATEGORY,
  CASH_ADVANCE_FUND_SOURCE,
  CASH_ADVANCE_POSTED_STATUSES,
  CASH_ADVANCE_STATUS,
  cashAdvanceRefundFundKey,
} from './cash-advance.constants';
import { fromCents, toCents } from './cash-advance-coverage';
import {
  dateKeyToDb,
  dbDateKey,
  periodLabel,
  vnDateKey,
  vnDayStart,
} from './cash-advance-period';
import {
  CashAdvanceAttachmentDto,
  CashAdvanceReasonDto,
  CashAdvanceRefundQueryDto,
  CreateCashAdvanceRefundDto,
  SignedVoucherDto,
  UpdateCashAdvanceRefundDto,
} from './dto/cash-advance.dto';
import {
  CashAdvancesService,
  type CashAdvanceActor,
} from './cash-advances.service';

type RefundAction = 'view' | 'create' | 'update' | 'confirm' | 'cancel';

const userSelect = { select: { id: true, name: true } } as const;

const refundInclude = {
  branch: userSelect,
  refunder: userSelect,
  creator: userSelect,
  confirmer: userSelect,
  completer: userSelect,
  canceller: userSelect,
  attachments: { orderBy: { id: 'asc' as const } },
  advance: {
    select: {
      id: true,
      code: true,
      amount: true,
      status: true,
      advanceDate: true,
      periodMode: true,
      periodYear: true,
      periodWeek: true,
      periodFrom: true,
      periodTo: true,
      refundDueDate: true,
      recipient: userSelect,
    },
  },
} satisfies Prisma.CashAdvanceRefundInclude;

type RefundRow = Prisma.CashAdvanceRefundGetPayload<{
  include: typeof refundInclude;
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

const formatMoney = (value: number) =>
  new Intl.NumberFormat('vi-VN').format(value);

@Injectable()
export class CashAdvanceRefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
    private readonly ledger: InternalFundLedgerService,
    private readonly codes: InternalFinanceCodeService,
    private readonly advances: CashAdvancesService,
  ) {}

  private can(user: CashAdvanceActor, branchId: number, action: RefundAction) {
    return this.access.can(user, branchId, `cash_advance_refund:${action}`);
  }

  private async assert(
    user: CashAdvanceActor,
    branchId: number,
    action: RefundAction,
  ) {
    await this.access.assert(user, branchId, `cash_advance_refund:${action}`);
  }

  private async findRow(id: number) {
    const row = await this.prisma.cashAdvanceRefund.findUnique({
      where: { id },
      include: refundInclude,
    });
    if (!row) throw new NotFoundException('Không tìm thấy phiếu hoàn ứng');
    return row;
  }

  private async decorate(rows: RefundRow[]) {
    if (!rows.length) return [];
    const funds = await this.prisma.internalFundTransaction.findMany({
      where: {
        sourceType: CASH_ADVANCE_FUND_SOURCE.REFUND,
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
    });
    return rows.map((row) => ({
      ...row,
      amount: Number(row.amount),
      refundDate: dbDateKey(row.refundDate),
      advance: {
        ...row.advance,
        amount: Number(row.advance.amount),
        advanceDate: dbDateKey(row.advance.advanceDate),
        periodFrom: dbDateKey(row.advance.periodFrom),
        periodTo: dbDateKey(row.advance.periodTo),
        refundDueDate: dbDateKey(row.advance.refundDueDate),
        periodLabel: periodLabel(row.advance),
      },
      fundTransaction:
        funds.find((fund) => fund.sourceId === String(row.id)) || null,
    }));
  }

  async detailOf(id: number) {
    const [row] = await this.decorate([await this.findRow(id)]);
    return row;
  }

  async list(query: CashAdvanceRefundQueryDto, user: CashAdvanceActor) {
    const allowed = await this.access.branchesFor(
      user,
      'cash_advance_refund:view',
      CASH_ADVANCE_BRANCH_IDS,
    );
    if (!allowed.length)
      throw new ForbiddenException('Không có quyền xem phiếu hoàn ứng');
    if (query.branchId && !allowed.includes(Number(query.branchId)))
      throw new ForbiddenException('Không có quyền xem hoàn ứng của kho này');
    const conditions: Prisma.CashAdvanceRefundWhereInput[] = [
      { branchId: { in: query.branchId ? [Number(query.branchId)] : allowed } },
    ];
    const statuses = (query.status || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (statuses.length) conditions.push({ status: { in: statuses } });
    if (query.refunderId) conditions.push({ refunderId: query.refunderId });
    if (query.advanceId) conditions.push({ advanceId: query.advanceId });
    if (query.fromDate)
      conditions.push({
        refundDate: { gte: dateKeyToDb(vnDateKey(query.fromDate)) },
      });
    if (query.toDate)
      conditions.push({
        refundDate: { lte: dateKeyToDb(vnDateKey(query.toDate)) },
      });
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { advance: { code: { contains: search, mode: 'insensitive' } } },
          { refunder: { name: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.CashAdvanceRefundWhereInput = { AND: conditions };
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    const [rows, total, sum] = await Promise.all([
      this.prisma.cashAdvanceRefund.findMany({
        where,
        orderBy: [{ refundDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: refundInclude,
      }),
      this.prisma.cashAdvanceRefund.count({ where }),
      this.prisma.cashAdvanceRefund.aggregate({
        where: {
          AND: [
            ...conditions,
            { status: { not: CASH_ADVANCE_STATUS.CANCELLED } },
          ],
        },
        _sum: { amount: true },
      }),
    ]);
    return {
      data: await this.decorate(rows),
      total,
      page,
      limit,
      totals: { amount: Number(sum._sum.amount || 0) },
    };
  }

  async get(id: number, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    await this.assert(user, row.branchId, 'view');
    return this.detailOf(id);
  }

  /** Hoàn ứng tối đa: số ứng − hoàn ứng khác chưa hủy − phần đã chi (đã chốt). */
  private async maxRefundCents(
    tx: Prisma.TransactionClient,
    advanceId: number,
    excludeRefundId?: number,
  ) {
    const advance = await tx.cashAdvance.findUnique({
      where: { id: advanceId },
      select: { amount: true, status: true, code: true },
    });
    if (!advance) throw new NotFoundException('Không tìm thấy phiếu tạm ứng');
    if (!CASH_ADVANCE_POSTED_STATUSES.includes(advance.status))
      throw new BadRequestException(
        'Chỉ hoàn ứng cho tạm ứng đã giao tiền (Đang xác nhận / Hoàn thành)',
      );
    const [refunds, locked] = await Promise.all([
      tx.cashAdvanceRefund.aggregate({
        where: {
          advanceId,
          status: { not: CASH_ADVANCE_STATUS.CANCELLED },
          ...(excludeRefundId ? { id: { not: excludeRefundId } } : {}),
        },
        _sum: { amount: true },
      }),
      tx.cashAdvanceAllocation.aggregate({
        where: { advanceId, status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE },
        _sum: { amount: true },
      }),
    ]);
    return Math.max(
      0,
      toCents(advance.amount) -
        toCents(refunds._sum.amount) -
        toCents(locked._sum.amount),
    );
  }

  private assertWithinMax(amount: number, maxCents: number) {
    if (toCents(amount) > maxCents)
      throw new BadRequestException(
        `Số tiền hoàn ứng vượt số còn lại có thể hoàn (${formatMoney(fromCents(maxCents))}đ)`,
      );
  }

  async create(dto: CreateCashAdvanceRefundDto, user: CashAdvanceActor) {
    const advance = await this.prisma.cashAdvance.findUnique({
      where: { id: dto.advanceId },
      select: { id: true, branchId: true, recipientId: true },
    });
    if (!advance) throw new NotFoundException('Không tìm thấy phiếu tạm ứng');
    await this.assert(user, advance.branchId, 'create');
    if (dto.clientUuid) {
      const existing = await this.prisma.cashAdvanceRefund.findUnique({
        where: { clientUuid: dto.clientUuid },
        select: { id: true },
      });
      if (existing) return this.detailOf(existing.id);
    }
    const refundDate = vnDateKey(dto.refundDate);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [advance.branchId]);
      this.assertWithinMax(
        dto.amount,
        await this.maxRefundCents(tx, advance.id),
      );
      const code = await this.codes.nextCode(tx, {
        direction: 'RECEIPT',
        category: CASH_ADVANCE_CODE_CATEGORY.REFUND,
        branchId: advance.branchId,
        occurredAt: vnDayStart(refundDate),
      });
      return tx.cashAdvanceRefund.create({
        data: {
          code,
          clientUuid: dto.clientUuid,
          advanceId: advance.id,
          branchId: advance.branchId,
          refunderId: advance.recipientId,
          amount: dto.amount,
          refundDate: dateKeyToDb(refundDate),
          description: dto.description?.trim() || null,
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

  async update(
    id: number,
    dto: UpdateCashAdvanceRefundDto,
    user: CashAdvanceActor,
  ) {
    const row = await this.findRow(id);
    if (row.status !== CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Chỉ sửa được phiếu tạm (chưa nhận tiền)');
    const permitted =
      (await this.can(user, row.branchId, 'update')) ||
      (row.createdBy === user.id &&
        (await this.can(user, row.branchId, 'create')));
    if (!permitted)
      throw new ForbiddenException('Không có quyền sửa phiếu hoàn ứng');
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.cashAdvanceRefund.findUnique({ where: { id } });
      if (current?.status !== CASH_ADVANCE_STATUS.DRAFT)
        throw new BadRequestException('Phiếu đã nhận tiền, không sửa được');
      if (dto.amount !== undefined)
        this.assertWithinMax(
          dto.amount,
          await this.maxRefundCents(tx, row.advanceId, id),
        );
      if (dto.attachments) {
        await tx.cashAdvanceAttachment.deleteMany({
          where: { refundId: id, kind: CASH_ADVANCE_ATTACHMENT_KIND.INITIAL },
        });
        await tx.cashAdvanceAttachment.createMany({
          data: attachmentData(
            dto.attachments,
            CASH_ADVANCE_ATTACHMENT_KIND.INITIAL,
            user.id,
          ).map((file) => ({ ...file, refundId: id })),
        });
      }
      await tx.cashAdvanceRefund.update({
        where: { id },
        data: {
          amount: dto.amount,
          refundDate: dto.refundDate
            ? dateKeyToDb(vnDateKey(dto.refundDate))
            : undefined,
          description:
            dto.description === undefined
              ? undefined
              : dto.description.trim() || null,
        },
      });
    });
    return this.detailOf(id);
  }

  /** Xác nhận nhận tiền: tiền hoàn ứng vào quỹ kho. */
  async confirm(id: number, user: CashAdvanceActor) {
    const row = await this.findRow(id);
    await this.assert(user, row.branchId, 'confirm');
    if (row.status !== CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Phiếu đã nhận tiền hoặc đã hủy');
    const adjust = await this.access.can(
      user,
      row.branchId,
      'internal_fund:adjust',
    );
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.cashAdvanceRefund.findUnique({ where: { id } });
      if (current?.status !== CASH_ADVANCE_STATUS.DRAFT)
        throw new BadRequestException('Phiếu đã nhận tiền hoặc đã hủy');
      this.assertWithinMax(
        Number(current.amount),
        await this.maxRefundCents(tx, current.advanceId, id),
      );
      const now = new Date();
      await this.ledger.postSystemTransaction(tx, {
        branchId: current.branchId,
        transactionType: 'RECEIPT',
        codeKind: 'THU',
        amount: current.amount,
        occurredAt: now,
        description: `Hoàn ứng ${current.code} (tạm ứng ${row.advance.code}) – ${row.refunder.name}${current.description ? `: ${current.description}` : ''}`,
        sourceType: CASH_ADVANCE_FUND_SOURCE.REFUND,
        sourceKey: cashAdvanceRefundFundKey(id),
        sourceId: String(id),
        userId: user.id,
        assertOpen: true,
        adjust,
      });
      await tx.cashAdvanceRefund.update({
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

  /** Upload phiếu hoàn ứng đã ký: người hoàn ứng hoặc người tạo phiếu. */
  async uploadSigned(
    id: number,
    dto: SignedVoucherDto,
    user: CashAdvanceActor,
  ) {
    const row = await this.findRow(id);
    const superAdmin = await this.access.isSuperAdmin(user);
    if (
      !superAdmin &&
      (![row.refunderId, row.createdBy].includes(user.id) ||
        !(await this.can(user, row.branchId, 'view')))
    )
      throw new ForbiddenException(
        'Chỉ người hoàn ứng hoặc người tạo phiếu được upload phiếu đã ký',
      );
    if (row.status === CASH_ADVANCE_STATUS.DRAFT)
      throw new BadRequestException('Cần xác nhận nhận tiền trước');
    if (row.status === CASH_ADVANCE_STATUS.CANCELLED)
      throw new BadRequestException('Phiếu đã hủy');
    await this.prisma.$transaction(async (tx) => {
      await tx.cashAdvanceAttachment.createMany({
        data: attachmentData(
          dto.attachments,
          CASH_ADVANCE_ATTACHMENT_KIND.SIGNED,
          user.id,
        ).map((file) => ({ ...file, refundId: id })),
      });
      if (row.status === CASH_ADVANCE_STATUS.CONFIRMING)
        await tx.cashAdvanceRefund.update({
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
      throw new ForbiddenException('Không có quyền hủy phiếu hoàn ứng');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Cần lý do hủy');
    const adjust = await this.access.can(
      user,
      row.branchId,
      'internal_fund:adjust',
    );
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.cashAdvanceRefund.findUnique({ where: { id } });
      if (!current || current.status === CASH_ADVANCE_STATUS.CANCELLED)
        throw new BadRequestException('Phiếu đã hủy');
      const fund = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: cashAdvanceRefundFundKey(id) },
      });
      if (fund?.status === 'POSTED') {
        await this.ledger.assertOpen(tx, row.branchId, fund.occurredAt, adjust);
        await this.ledger.cancelBySource(
          tx,
          cashAdvanceRefundFundKey(id),
          user.id,
          `Hủy hoàn ứng ${row.code}: ${reason}`,
        );
      }
      await tx.cashAdvanceRefund.update({
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

  /** Tạm ứng còn tiền để hoàn (cho ô chọn tạm ứng khi tạo hoàn ứng). */
  async refundableAdvances(
    query: { branchId?: number; search?: string },
    user: CashAdvanceActor,
  ) {
    const allowed = await this.access.branchesFor(
      user,
      'cash_advance_refund:create',
      CASH_ADVANCE_BRANCH_IDS,
    );
    const branchIds = query.branchId
      ? allowed.filter((id) => id === Number(query.branchId))
      : allowed;
    if (!branchIds.length) return [];
    const search = query.search?.trim();
    const rows = await this.prisma.cashAdvance.findMany({
      where: {
        branchId: { in: branchIds },
        status: { in: CASH_ADVANCE_POSTED_STATUSES },
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                {
                  recipient: {
                    name: { contains: search, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ periodTo: 'asc' }, { id: 'asc' }],
      take: 200,
      include: {
        branch: userSelect,
        recipient: userSelect,
        creator: userSelect,
        confirmer: userSelect,
        completer: userSelect,
        canceller: userSelect,
        attachments: { orderBy: { id: 'asc' } },
        refunds: {
          select: {
            id: true,
            code: true,
            amount: true,
            status: true,
            refundDate: true,
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    const decorated = await this.advances.decorate(rows);
    return decorated
      .filter((row) => row.usage.maxRefund > 0)
      .map((row) => ({
        id: row.id,
        code: row.code,
        branchId: row.branchId,
        branch: row.branch,
        recipient: row.recipient,
        amount: row.amount,
        periodLabel: row.periodLabel,
        periodTo: row.periodTo,
        refundDueDate: row.refundDueDate,
        overdue: row.overdue,
        needsRefund: row.needsRefund,
        usage: row.usage,
      }));
  }
}
