import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FinanceAccessService,
  type FinanceActor,
} from '../auth/finance-access.service';
import { LarkExpenseReviewNotificationService } from '../lark-sync/services/lark-expense-review-notification.service';
import {
  INTERNAL_FINANCE_DIRECTION,
  localizeFeeCodes,
} from './internal-finance.constants';
import type { CreateWarehouseExpenseNoteDto } from './dto';

/** Chi nhánh có phiếu chi kho (Kho HN, Kho SG, VP HN, VP SG). */
const WAREHOUSE_EXPENSE_BRANCH_IDS = [6, 1, 4, 7];

export const NOTE_LARK_STATUS = {
  SENT: 'SENT',
  NO_LARK: 'NO_LARK',
  ERROR: 'ERROR',
} as const;

/**
 * Ghi chú yêu cầu xem lại phiếu chi kho: lưu ghi chú, tag người xem lại và
 * gửi tin Lark riêng cho từng người kèm link mở thẳng phiếu.
 */
@Injectable()
export class WarehouseExpenseNotesService {
  private readonly logger = new Logger(WarehouseExpenseNotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
    private readonly lark: LarkExpenseReviewNotificationService,
  ) {}

  async list(entryId: number, user: FinanceActor) {
    await this.requireEntry(entryId, user, 'view');
    return this.prisma.internalFinanceEntryNote.findMany({
      where: { entryId },
      orderBy: { createdAt: 'desc' },
      include: this.noteInclude(),
    });
  }

  /** Người tag được: đang hoạt động, đã gắn Lark, xem được phiếu chi của kho. */
  async mentionCandidates(entryId: number, user: FinanceActor) {
    const entry = await this.requireEntry(entryId, user, 'request_review');
    return this.candidatesFor(entry.branchId);
  }

  async create(
    entryId: number,
    dto: CreateWarehouseExpenseNoteDto,
    user: { id: number } & Exclude<FinanceActor, number>,
  ) {
    const entry = await this.requireEntry(entryId, user, 'request_review');
    const content = dto.content?.trim();
    if (!content) throw new BadRequestException('Cần nhập nội dung ghi chú');
    const mentionIds = [...new Set(dto.mentionUserIds || [])];
    if (mentionIds.length > 10) {
      throw new BadRequestException('Chỉ tag tối đa 10 người mỗi lần');
    }
    if (mentionIds.length) {
      const allowed = new Set(
        (await this.candidatesFor(entry.branchId)).map((row) => row.id),
      );
      if (mentionIds.some((id) => !allowed.has(id))) {
        throw new BadRequestException(
          'Có người được tag chưa gắn Lark hoặc không xem được phiếu chi của kho này',
        );
      }
    }

    const note = await this.prisma.internalFinanceEntryNote.create({
      data: {
        entryId,
        content,
        createdBy: user.id,
        mentions: {
          create: mentionIds.map((userId) => ({ userId })),
        },
      },
      include: {
        creator: { select: { id: true, name: true } },
        mentions: {
          include: {
            user: { select: { id: true, name: true, larkUserId: true } },
          },
        },
      },
    });

    // Lỗi gửi Lark không làm mất ghi chú: ghi lại trạng thái từng người.
    let sent = 0;
    for (const mention of note.mentions) {
      const larkUserId = mention.user.larkUserId;
      let larkStatus: string = NOTE_LARK_STATUS.NO_LARK;
      let larkError: string | null = null;
      if (larkUserId) {
        try {
          await this.lark.send({
            larkUserId,
            entry: {
              code: entry.code,
              branchName: entry.branch?.name || '',
              occurredAt: entry.occurredAt,
              sourceType: entry.sourceType,
              category: entry.category,
              description: localizeFeeCodes(entry.description),
              expenseItem: entry.expenseItem,
              amount: Number(entry.amount),
              payerName: entry.payer?.name || null,
              managerChecked: Boolean(entry.managerReviewedAt),
              accountantChecked: Boolean(entry.accountantReviewedAt),
              cashIssued: entry.cashIssued,
              packingSlipCode: entry.packingSlip?.code || null,
            },
            note: content,
            authorName: note.creator.name,
          });
          larkStatus = NOTE_LARK_STATUS.SENT;
          sent += 1;
        } catch (error: any) {
          larkStatus = NOTE_LARK_STATUS.ERROR;
          larkError = String(error?.message || error).slice(0, 500);
          this.logger.warn(
            `Gửi tin Lark xem lại phiếu ${entry.code} cho user #${mention.userId} thất bại: ${larkError}`,
          );
        }
      }
      await this.prisma.internalFinanceEntryNoteMention.update({
        where: { id: mention.id },
        data: {
          larkStatus,
          larkError,
          sentAt: larkStatus === NOTE_LARK_STATUS.SENT ? new Date() : null,
        },
      });
    }

    const saved = await this.prisma.internalFinanceEntryNote.findUnique({
      where: { id: note.id },
      include: this.noteInclude(),
    });
    return { note: saved, sent, failed: note.mentions.length - sent };
  }

  private async candidatesFor(branchId: number) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, larkUserId: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const allowed: Array<{ id: number; name: string }> = [];
    for (const candidate of users) {
      if (
        await this.access.can(candidate.id, branchId, 'warehouse_expense:view')
      ) {
        allowed.push(candidate);
      }
    }
    return allowed;
  }

  private async requireEntry(
    entryId: number,
    user: FinanceActor,
    action: 'view' | 'request_review',
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      include: {
        branch: { select: { name: true } },
        payer: { select: { name: true } },
        packingSlip: { select: { code: true } },
      },
    });
    if (
      !entry ||
      entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE ||
      !WAREHOUSE_EXPENSE_BRANCH_IDS.includes(entry.branchId)
    ) {
      throw new NotFoundException('Không tìm thấy phiếu chi kho');
    }
    if (
      !(await this.access.can(
        user,
        entry.branchId,
        `warehouse_expense:${action}`,
      ))
    ) {
      throw new ForbiddenException(
        action === 'view'
          ? 'Không có quyền xem phiếu chi của chi nhánh này'
          : 'Không có quyền ghi chú và yêu cầu xem lại phiếu chi',
      );
    }
    return entry;
  }

  private noteInclude() {
    return {
      creator: { select: { id: true, name: true } },
      mentions: {
        orderBy: { id: 'asc' as const },
        select: {
          id: true,
          larkStatus: true,
          sentAt: true,
          user: { select: { id: true, name: true } },
        },
      },
    };
  }
}
