import { Prisma } from '@prisma/client';
import {
  INTERNAL_FINANCE_DIRECTION,
  INTERNAL_FINANCE_STATUS,
  WAREHOUSE_EXPENSE_CATEGORIES,
} from '../internal-finance/internal-finance.constants';
import {
  CASH_ADVANCE_ALLOCATION_STATUS,
  CASH_ADVANCE_BRANCH_IDS,
  CASH_ADVANCE_POSTED_STATUSES,
  CASH_ADVANCE_STATUS,
} from './cash-advance.constants';
import {
  addDaysKey,
  dateKeyToDb,
  dbDateKey,
  vnDateKey,
  vnDayStart,
} from './cash-advance-period';

// Đối chiếu tạm ứng với phiếu chi kho. File này chỉ dùng Prisma client truyền
// vào (không DI) vì InternalFundLedgerService gọi nó lúc tick Đã chi.

type Db = Prisma.TransactionClient;

/** Tiền tính bằng xu để cộng trừ không lệch số thực. */
export const toCents = (value: Prisma.Decimal | number | string | null) =>
  Math.round(Number(value || 0) * 100);
export const fromCents = (cents: number) => cents / 100;

const EXCLUDED_EXPENSE_STATUSES: string[] = [
  INTERNAL_FINANCE_STATUS.CANCELLED,
  INTERNAL_FINANCE_STATUS.REJECTED,
];

export interface CoverageAdvance {
  id: number;
  code: string;
  /** Thứ tự trừ: tạm ứng giao tiền trước nhận phiếu chi trước. */
  orderAt: Date;
  fromKey: string;
  toKey: string;
  amountCents: number;
  /** Tổng hoàn ứng chưa hủy (kể cả phiếu tạm). */
  refundedCents: number;
  /** Phần phiếu chi đã chốt (Đã chi) vào tạm ứng này. */
  lockedCents: number;
}

export interface CoverageExpense {
  id: number;
  dayKey: string;
  occurredAt: Date;
  amountCents: number;
}

export interface CoveragePart {
  entryId: number;
  advanceId: number;
  cents: number;
}

export interface CoveragePlan {
  parts: CoveragePart[];
  /** Phần còn lại của phiếu chi không tạm ứng nào phủ (vượt hạn mức). */
  uncovered: Map<number, number>;
  projectedByAdvance: Map<number, number>;
}

/** Hạn mức còn trống để nhận phiếu chi chưa Đã chi. */
export const lockedRemainingCents = (advance: CoverageAdvance) =>
  Math.max(
    0,
    advance.amountCents - advance.refundedCents - advance.lockedCents,
  );

const byOrder = <T extends { id: number }>(
  key: (row: T) => number,
): ((a: T, b: T) => number) => {
  return (a, b) => key(a) - key(b) || a.id - b.id;
};

/**
 * Dự kiến phần phiếu chi chưa Đã chi mà mỗi tạm ứng phủ: phiếu chi xếp theo
 * ngày, đổ vào tạm ứng giao tiền trước (kỳ chứa ngày phiếu) cho tới khi đầy
 * rồi chuyển sang tạm ứng kế tiếp; một phiếu có thể chia cho hai tạm ứng.
 */
export function planCoverage(
  advances: CoverageAdvance[],
  expenses: CoverageExpense[],
): CoveragePlan {
  const ordered = [...advances].sort(byOrder((row) => row.orderAt.getTime()));
  const room = new Map(
    ordered.map((advance) => [advance.id, lockedRemainingCents(advance)]),
  );
  const parts: CoveragePart[] = [];
  const uncovered = new Map<number, number>();
  const projectedByAdvance = new Map<number, number>(
    ordered.map((advance) => [advance.id, 0]),
  );
  const sortedExpenses = [...expenses].sort(
    byOrder((row) => row.occurredAt.getTime()),
  );
  for (const expense of sortedExpenses) {
    let left = expense.amountCents;
    for (const advance of ordered) {
      if (left <= 0) break;
      if (expense.dayKey < advance.fromKey || expense.dayKey > advance.toKey)
        continue;
      const free = room.get(advance.id) || 0;
      if (free <= 0) continue;
      const take = Math.min(left, free);
      room.set(advance.id, free - take);
      projectedByAdvance.set(
        advance.id,
        (projectedByAdvance.get(advance.id) || 0) + take,
      );
      parts.push({ entryId: expense.id, advanceId: advance.id, cents: take });
      left -= take;
    }
    if (left > 0) uncovered.set(expense.id, left);
  }
  return { parts, uncovered, projectedByAdvance };
}

/** Phiếu chi kho có tham gia đối chiếu tạm ứng (chưa xét Đã chi). */
export function isCoverableExpense(entry: {
  direction: string;
  branchId: number;
  category: string;
  status: string;
  cashFlowId?: number | null;
  sourceSnapshot?: unknown;
}) {
  const snapshot = entry.sourceSnapshot as
    | { larkLedgerRecorded?: unknown }
    | null
    | undefined;
  return (
    entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE &&
    (CASH_ADVANCE_BRANCH_IDS as readonly number[]).includes(entry.branchId) &&
    (WAREHOUSE_EXPENSE_CATEGORIES as readonly string[]).includes(
      entry.category,
    ) &&
    !EXCLUDED_EXPENSE_STATUSES.includes(entry.status) &&
    !entry.cashFlowId &&
    // Phiếu đã trừ trên sổ quỹ Lark: tiền không ra từ tạm ứng.
    !(snapshot && snapshot.larkLedgerRecorded === true)
  );
}

/** Điều kiện Prisma: phiếu chi kho của kho trong khoảng ngày (to inclusive). */
export function warehouseExpenseWhere(
  branchId: number,
  fromKey: string,
  toKey: string,
): Prisma.InternalFinanceEntryWhereInput {
  return {
    direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
    branchId,
    category: { in: [...WAREHOUSE_EXPENSE_CATEGORIES] },
    status: { notIn: EXCLUDED_EXPENSE_STATUSES },
    occurredAt: {
      gte: vnDayStart(fromKey),
      lt: vnDayStart(addDaysKey(toKey, 1)),
    },
  };
}

/** Tạm ứng đã giao tiền của kho, kèm tổng hoàn ứng và phần đã chốt. */
export async function loadPostedAdvances(
  db: Db,
  branchId: number,
): Promise<CoverageAdvance[]> {
  const advances = await db.cashAdvance.findMany({
    where: { branchId, status: { in: CASH_ADVANCE_POSTED_STATUSES } },
    select: {
      id: true,
      code: true,
      amount: true,
      periodFrom: true,
      periodTo: true,
      confirmedAt: true,
      createdAt: true,
    },
  });
  if (!advances.length) return [];
  const ids = advances.map((advance) => advance.id);
  const [refunds, locks] = await Promise.all([
    db.cashAdvanceRefund.groupBy({
      by: ['advanceId'],
      where: {
        advanceId: { in: ids },
        status: { not: CASH_ADVANCE_STATUS.CANCELLED },
      },
      _sum: { amount: true },
    }),
    db.cashAdvanceAllocation.groupBy({
      by: ['advanceId'],
      where: {
        advanceId: { in: ids },
        status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE,
      },
      _sum: { amount: true },
    }),
  ]);
  const refundOf = new Map(
    refunds.map((row) => [row.advanceId, toCents(row._sum.amount)]),
  );
  const lockOf = new Map(
    locks.map((row) => [row.advanceId, toCents(row._sum.amount)]),
  );
  return advances.map((advance) => ({
    id: advance.id,
    code: advance.code,
    orderAt: advance.confirmedAt ?? advance.createdAt,
    fromKey: dbDateKey(advance.periodFrom),
    toKey: dbDateKey(advance.periodTo),
    amountCents: toCents(advance.amount),
    refundedCents: refundOf.get(advance.id) || 0,
    lockedCents: lockOf.get(advance.id) || 0,
  }));
}

/** Phiếu chi kho chưa Đã chi nằm trong kỳ của các tạm ứng còn hạn mức. */
export async function loadOpenExpenses(
  db: Db,
  branchId: number,
  advances: CoverageAdvance[],
): Promise<CoverageExpense[]> {
  const open = advances.filter((advance) => lockedRemainingCents(advance) > 0);
  if (!open.length) return [];
  const fromKey = open.map((row) => row.fromKey).sort()[0];
  const toKey = open
    .map((row) => row.toKey)
    .sort()
    .reverse()[0];
  const rows = await db.internalFinanceEntry.findMany({
    where: {
      ...warehouseExpenseWhere(branchId, fromKey, toKey),
      cashIssued: false,
      cashFlowId: null,
    },
    select: {
      id: true,
      direction: true,
      branchId: true,
      category: true,
      status: true,
      cashFlowId: true,
      sourceSnapshot: true,
      amount: true,
      occurredAt: true,
    },
  });
  return rows.filter(isCoverableExpense).map((row) => ({
    id: row.id,
    dayKey: vnDateKey(row.occurredAt),
    occurredAt: row.occurredAt,
    amountCents: toCents(row.amount),
  }));
}

export interface BranchCoverage {
  advances: CoverageAdvance[];
  expenses: CoverageExpense[];
  plan: CoveragePlan;
}

export async function loadBranchCoverage(
  db: Db,
  branchId: number,
): Promise<BranchCoverage> {
  const advances = await loadPostedAdvances(db, branchId);
  const expenses = await loadOpenExpenses(db, branchId, advances);
  return { advances, expenses, plan: planCoverage(advances, expenses) };
}

export interface AdvanceUsage {
  amount: number;
  refunded: number;
  locked: number;
  projected: number;
  used: number;
  remaining: number;
  /** Hoàn ứng tối đa: hạn mức − phần đã chốt (bỏ qua chính phiếu đang sửa). */
  maxRefund: number;
  /** Hoàn ứng đề xuất: phần chưa dùng tới (gồm cả dự kiến). */
  suggestedRefund: number;
}

/** Số liệu đối chiếu của một tạm ứng; tạm ứng chưa giao tiền thì chưa dùng. */
export function advanceUsage(
  advance: {
    id: number;
    amount: Prisma.Decimal | number | string;
    status: string;
  },
  coverage: BranchCoverage | null,
  refundedCents = 0,
): AdvanceUsage {
  const row = coverage?.advances.find((item) => item.id === advance.id);
  const amountCents = toCents(advance.amount);
  const refunded = row ? row.refundedCents : refundedCents;
  const locked = row?.lockedCents || 0;
  const projected = row
    ? coverage!.plan.projectedByAdvance.get(advance.id) || 0
    : 0;
  const used = locked + projected;
  const maxRefund = Math.max(0, amountCents - refunded - locked);
  return {
    amount: fromCents(amountCents),
    refunded: fromCents(refunded),
    locked: fromCents(locked),
    projected: fromCents(projected),
    used: fromCents(used),
    remaining: fromCents(Math.max(0, amountCents - refunded - used)),
    maxRefund: fromCents(maxRefund),
    suggestedRefund: fromCents(Math.max(0, maxRefund - projected)),
  };
}

async function lockBranch(db: Db, branchId: number) {
  // Cùng khóa với InternalFundLedgerService.lock (khóa lồng nhau trong một
  // transaction là hợp lệ).
  await db.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${branchId}::integer)`;
}

export interface EntryCoverage {
  coveredCents: number;
  parts: Array<{ advanceId: number; code: string; cents: number }>;
}

/** Xem trước phần phiếu chi sẽ chi từ tạm ứng nếu tick Đã chi bây giờ. */
export async function previewEntryCoverage(
  db: Db,
  entry: {
    id: number;
    direction: string;
    branchId: number;
    category: string;
    status: string;
    cashFlowId?: number | null;
    cashIssued?: boolean;
    sourceSnapshot?: unknown;
  },
): Promise<EntryCoverage> {
  const none: EntryCoverage = { coveredCents: 0, parts: [] };
  if (entry.cashIssued || !isCoverableExpense(entry)) return none;
  const coverage = await loadBranchCoverage(db, entry.branchId);
  const codeOf = new Map(coverage.advances.map((row) => [row.id, row.code]));
  const parts = coverage.plan.parts
    .filter((part) => part.entryId === entry.id)
    .map((part) => ({
      advanceId: part.advanceId,
      code: codeOf.get(part.advanceId) || '',
      cents: part.cents,
    }));
  return {
    coveredCents: parts.reduce((sum, part) => sum + part.cents, 0),
    parts,
  };
}

/**
 * Tick Đã chi: chốt phần phiếu chi được tạm ứng phủ (theo đúng số đang dự
 * kiến) để phần đó không trừ quỹ lần hai. Gọi trong transaction.
 */
export async function allocateEntryCoverage(
  db: Db,
  entry: {
    id: number;
    direction: string;
    branchId: number;
    category: string;
    status: string;
    cashFlowId?: number | null;
    sourceSnapshot?: unknown;
  },
  userId: number,
): Promise<EntryCoverage> {
  if (!isCoverableExpense(entry)) return { coveredCents: 0, parts: [] };
  await lockBranch(db, entry.branchId);
  const existing = await db.cashAdvanceAllocation.findMany({
    where: {
      entryId: entry.id,
      status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE,
    },
    include: { advance: { select: { code: true } } },
  });
  if (existing.length)
    return {
      coveredCents: existing.reduce((sum, row) => sum + toCents(row.amount), 0),
      parts: existing.map((row) => ({
        advanceId: row.advanceId,
        code: row.advance.code,
        cents: toCents(row.amount),
      })),
    };
  const preview = await previewEntryCoverage(db, {
    ...entry,
    cashIssued: false,
  });
  if (!preview.parts.length) return preview;
  await db.cashAdvanceAllocation.createMany({
    data: preview.parts.map((part) => ({
      advanceId: part.advanceId,
      entryId: entry.id,
      amount: fromCents(part.cents),
      status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE,
      createdBy: userId,
    })),
  });
  return preview;
}

/** Bỏ Đã chi / hủy dòng quỹ: nhả phần đã chốt vào tạm ứng. */
export async function releaseEntryAllocations(
  db: Db,
  entryIds: number[],
  userId: number,
  reason: string,
) {
  if (!entryIds.length) return 0;
  const result = await db.cashAdvanceAllocation.updateMany({
    where: {
      entryId: { in: entryIds },
      status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE,
    },
    data: {
      status: CASH_ADVANCE_ALLOCATION_STATUS.RELEASED,
      releasedAt: new Date(),
      releasedBy: userId,
      releaseReason: reason,
    },
  });
  return result.count;
}

/** Phiếu chi có phần đã chi từ tạm ứng (chưa nhả). */
export async function activeAllocationEntryIds(db: Db, entryIds: number[]) {
  if (!entryIds.length) return new Set<number>();
  const rows = await db.cashAdvanceAllocation.findMany({
    where: {
      entryId: { in: entryIds },
      status: CASH_ADVANCE_ALLOCATION_STATUS.ACTIVE,
    },
    select: { entryId: true },
  });
  return new Set(rows.map((row) => row.entryId));
}

/**
 * Tạm ứng của người này đã quá hạn hoàn ứng (hết kỳ + 5 ngày) mà còn tiền
 * chưa dùng và chưa có phiếu hoàn ứng: chặn tạo tạm ứng mới cho người này.
 */
export async function blockingAdvancesFor(
  db: Db,
  recipientId: number,
  todayKey: string,
  excludeAdvanceId?: number,
) {
  const candidates = await db.cashAdvance.findMany({
    where: {
      recipientId,
      status: { in: CASH_ADVANCE_POSTED_STATUSES },
      refundDueDate: { lt: dateKeyToDb(todayKey) },
      refunds: { none: { status: { not: CASH_ADVANCE_STATUS.CANCELLED } } },
      ...(excludeAdvanceId ? { id: { not: excludeAdvanceId } } : {}),
    },
    select: {
      id: true,
      code: true,
      branchId: true,
      amount: true,
      status: true,
      refundDueDate: true,
    },
    orderBy: { refundDueDate: 'asc' },
  });
  if (!candidates.length) return [];
  const coverages = new Map<number, BranchCoverage>();
  for (const branchId of [...new Set(candidates.map((row) => row.branchId))])
    coverages.set(branchId, await loadBranchCoverage(db, branchId));
  return candidates
    .map((advance) => ({
      id: advance.id,
      code: advance.code,
      branchId: advance.branchId,
      refundDueDate: dbDateKey(advance.refundDueDate),
      remaining: advanceUsage(advance, coverages.get(advance.branchId) || null)
        .remaining,
    }))
    .filter((advance) => advance.remaining > 0);
}
