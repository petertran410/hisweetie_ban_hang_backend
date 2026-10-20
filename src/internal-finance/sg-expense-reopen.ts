import { Prisma, PrismaClient } from '@prisma/client';
import { LARK_LEDGER_CUTOFF } from '../approval-lifecycle/approval-lifecycle.constants';
import {
  InternalFundLedgerService,
  isLarkLedgerRecorded,
} from '../internal-fund/internal-fund-ledger.service';
import { REASON } from './legacy-fund-reconcile';
import { releaseEntryAllocations } from '../cash-advances/cash-advance-coverage';

/**
 * Kho SG: phiếu chi đồng bộ từ LarkBase mang sẵn "Đã chi" (Lark SG ghi chi
 * ngay) và bước đối soát cũ đã tick đủ hai đồng kiểm, dù tuần chưa được duyệt.
 * Mở lại: bỏ hai tick và "Đã chi", gỡ khỏi batch chưa gửi, hủy dòng quỹ POS.
 * Phiếu tới hết 13/10 mà sổ quỹ Lark đã trừ tiền thì gắn dấu để Approval tuần
 * duyệt sau này không trừ quỹ lần hai.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const SG_BRANCH_ID = 1;
export const REOPEN_FROM = '2026-10-12';
const SENT_WEEK_STATUSES = ['IN_APPROVAL', 'APPROVED'];
const LARK_PAID_REASONS = [
  REASON.larkPaid,
  REASON.paidOnLark,
  REASON.ledgerRecorded,
];
export const REOPEN_NOTE = 'Mở lại: phiếu SG đồng bộ từ Lark chưa được duyệt';

const entrySelect = {
  id: true,
  code: true,
  occurredAt: true,
  description: true,
  amount: true,
  status: true,
  managerReviewedAt: true,
  accountantReviewedAt: true,
  cashIssued: true,
  cashIssuedReason: true,
  sourceSnapshot: true,
  weeklyBatchId: true,
  weeklyBatch: { select: { code: true, status: true } },
} satisfies Prisma.InternalFinanceEntrySelect;

export type ReopenEntry = Prisma.InternalFinanceEntryGetPayload<{
  select: typeof entrySelect;
}>;

export interface ReopenItem {
  entry: ReopenEntry;
  fundRows: Array<{
    id: number;
    code: string;
    amount: Prisma.Decimal;
    occurredAt: Date;
    branchId: number;
    sourceKey: string;
  }>;
  /** Gắn dấu "đã trừ trên sổ quỹ Lark" (không trừ quỹ lần hai khi duyệt). */
  markLedger: boolean;
}

/** Sổ quỹ Lark đã trừ tiền phiếu này (tới hết 13/10, Lark báo đã chi). */
export function shouldMarkLedger(entry: {
  occurredAt: Date;
  cashIssuedReason: string | null;
  sourceSnapshot: unknown;
}) {
  if (isLarkLedgerRecorded(entry)) return false;
  return (
    entry.occurredAt < LARK_LEDGER_CUTOFF &&
    LARK_PAID_REASONS.includes(entry.cashIssuedReason || '')
  );
}

export async function loadSgReopen(db: Db, from = REOPEN_FROM, to?: string) {
  const entries = await db.internalFinanceEntry.findMany({
    where: {
      branchId: SG_BRANCH_ID,
      direction: 'EXPENSE',
      sourceType: 'LARK_IMPORT',
      status: { not: 'CANCELLED' },
      occurredAt: {
        gte: new Date(`${from}T00:00:00+07:00`),
        // Đến hết ngày `to` (giờ VN), nếu có.
        ...(to
          ? {
              lt: new Date(
                new Date(`${to}T00:00:00+07:00`).getTime() + 86400000,
              ),
            }
          : {}),
      },
      // Tuần đã gửi / đã duyệt Approval thì giữ nguyên.
      AND: [
        {
          OR: [
            { weeklyBatchId: null },
            { weeklyBatch: { status: { notIn: SENT_WEEK_STATUSES } } },
          ],
        },
        {
          OR: [
            { managerReviewedAt: { not: null } },
            { accountantReviewedAt: { not: null } },
            { cashIssued: true },
          ],
        },
      ],
    },
    select: entrySelect,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const fundRows = entries.length
    ? await db.internalFundTransaction.findMany({
        where: {
          entryId: { in: entries.map((entry) => entry.id) },
          status: 'POSTED',
        },
        select: {
          id: true,
          code: true,
          amount: true,
          occurredAt: true,
          branchId: true,
          sourceKey: true,
          entryId: true,
        },
      })
    : [];
  const items: ReopenItem[] = entries.map((entry) => ({
    entry,
    fundRows: fundRows.filter((row) => row.entryId === entry.id),
    markLedger: shouldMarkLedger(entry),
  }));
  return { items, from, to };
}

export async function applySgReopen(
  prisma: PrismaClient,
  userId: number,
  from = REOPEN_FROM,
  to?: string,
) {
  const ledger = new InternalFundLedgerService();
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [SG_BRANCH_ID]);
      const plan = await loadSgReopen(tx, from, to);
      for (const { entry, fundRows, markLedger } of plan.items) {
        for (const row of fundRows)
          await ledger.releaseCancelled(tx, row, userId, REOPEN_NOTE);
        if (entry.weeklyBatchId) await ledger.detachFromBatch(tx, entry);
        await releaseEntryAllocations(tx, [entry.id], userId, REOPEN_NOTE);
        const snapshot =
          entry.sourceSnapshot && typeof entry.sourceSnapshot === 'object'
            ? (entry.sourceSnapshot as Record<string, unknown>)
            : {};
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            status: 'PENDING_ACCOUNTANT',
            managerReviewedBy: null,
            managerReviewedAt: null,
            accountantReviewedBy: null,
            accountantReviewedAt: null,
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
            ...(markLedger
              ? {
                  sourceSnapshot: {
                    ...snapshot,
                    larkLedgerRecorded: true,
                  } as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
        await tx.internalFinanceReview.create({
          data: {
            entryId: entry.id,
            role: 'MANAGER',
            decision: 'REOPEN',
            reason: REOPEN_NOTE,
            reviewerId: userId,
          },
        });
      }
      return plan;
    },
    { timeout: 120000 },
  );
}

/** Số dư quỹ Kho SG (mọi dòng POSTED). */
export async function sgFundBalance(db: Db) {
  const groups = await db.internalFundTransaction.groupBy({
    by: ['transactionType'],
    where: { branchId: SG_BRANCH_ID, status: 'POSTED' },
    _sum: { amount: true },
  });
  return groups.reduce(
    (sum, group) =>
      sum +
      (['RECEIPT', 'TRANSFER_IN'].includes(group.transactionType) ? 1 : -1) *
        Number(group._sum.amount || 0),
    0,
  );
}
