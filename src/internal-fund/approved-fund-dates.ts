import { Prisma, PrismaClient } from '@prisma/client';
import {
  approvedExpenseDate,
  fundClosingDate,
  fundDateKey,
} from './internal-fund-ledger.service';

/**
 * Dòng quỹ của phiếu chi trong Approval tuần trước đây ghi vào ngày Approval
 * duyệt xong. Đúng phải là ngày chi của phiếu (xem `approvedExpenseDate`): dời
 * các dòng đó về đúng ngày, số dư cuối cùng của quỹ không đổi, chỉ đổi số thu
 * chi từng ngày trong tab Chốt sổ.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface FundDateFix {
  id: number;
  code: string;
  branchId: number;
  amount: number;
  entryCode: string;
  batchCode: string;
  from: Date;
  to: Date;
  /** Phiếu trước mốc quỹ lên POS: ghi vào đầu ngày mốc. */
  clamped: boolean;
}

export interface PlanOptions {
  /** Không dời phiếu trước mốc quỹ lên POS (giữ ngày đang ghi). */
  skipBeforeCutoff?: boolean;
  /** Chỉ sửa quỹ của chi nhánh này. */
  branchId?: number;
}

export async function planApprovedFundDates(
  db: Db,
  options: PlanOptions = {},
): Promise<FundDateFix[]> {
  const rows = await db.internalFundTransaction.findMany({
    where: {
      status: 'POSTED',
      transactionType: 'EXPENSE',
      sourceType: 'INTERNAL_FINANCE_ENTRY',
      approvalRequestId: { not: null },
      entry: { weeklyBatch: { approvalRequestId: { not: null } } },
      ...(options.branchId && { branchId: options.branchId }),
    },
    select: {
      id: true,
      code: true,
      branchId: true,
      amount: true,
      occurredAt: true,
      approvalRequestId: true,
      entry: {
        select: {
          code: true,
          branchId: true,
          occurredAt: true,
          weeklyBatch: { select: { code: true, approvalRequestId: true } },
        },
      },
    },
    orderBy: [{ branchId: 'asc' }, { occurredAt: 'asc' }, { id: 'asc' }],
  });
  const fixes: FundDateFix[] = [];
  for (const row of rows) {
    const entry = row.entry;
    // Chỉ dòng do chính Approval tuần của phiếu ghi.
    if (
      !entry?.weeklyBatch ||
      entry.weeklyBatch.approvalRequestId !== row.approvalRequestId
    )
      continue;
    const to = approvedExpenseDate({
      branchId: row.branchId,
      occurredAt: entry.occurredAt,
    });
    if (fundDateKey(to) === fundDateKey(row.occurredAt)) continue;
    const clamped = to.getTime() !== entry.occurredAt.getTime();
    if (clamped && options.skipBeforeCutoff) continue;
    fixes.push({
      id: row.id,
      code: row.code,
      branchId: row.branchId,
      amount: Number(row.amount),
      entryCode: entry.code,
      batchCode: entry.weeklyBatch.code,
      from: row.occurredAt,
      to,
      clamped,
    });
  }
  return fixes;
}

export interface ClosingImpact {
  branchId: number;
  /** Ngày chốt sổ, YYYY-MM-DD. */
  day: string;
  /** Số cuối kỳ kế toán đếm; null: chốt sổ chưa nhập số thực tế. */
  actual: number | null;
  /** Số cuối kỳ hệ thống hiện tại và sau khi dời ngày. */
  before: number;
  after: number;
  /** Lúc bấm chốt sổ và người chốt; `synced`: dòng đồng bộ từ sổ cũ. */
  closedAt: Date | null;
  closer: string | null;
  synced: boolean;
}

const cents = (value: number | Prisma.Decimal) =>
  Math.round(Number(value) * 100);

/** Chốt sổ khớp khi số cuối kỳ thực tế bằng số hệ thống (như tab Chốt sổ). */
export const closingMatched = (actual: number | null, system: number) =>
  actual !== null && cents(actual) === cents(system);

/**
 * Các chốt sổ có số cuối kỳ hệ thống đổi khi dời ngày: số hiện tại và số sau
 * khi sửa, để so với số kế toán đếm trước khi ghi thật.
 */
export async function closingImpact(
  db: Db,
  fixes: FundDateFix[],
): Promise<ClosingImpact[]> {
  const result: ClosingImpact[] = [];
  const branchIds = [...new Set(fixes.map((fix) => fix.branchId))].sort(
    (a, b) => a - b,
  );
  for (const branchId of branchIds) {
    const rows = fixes
      .filter((fix) => fix.branchId === branchId)
      .map((fix) => ({
        from: fundDateKey(fix.from),
        to: fundDateKey(fix.to),
        amount: cents(fix.amount),
      }));
    const earliest = rows.flatMap((row) => [row.from, row.to]).sort()[0];
    const closings = await db.internalFundDailyClosing.findMany({
      where: {
        branchId,
        closingDate: { gte: fundClosingDate(earliest) },
        closedAt: { not: null },
      },
      select: {
        closingDate: true,
        actualClosingBalance: true,
        closedAt: true,
        sourceKey: true,
        posManagedAt: true,
        closer: { select: { name: true } },
      },
      orderBy: { closingDate: 'asc' },
    });
    if (!closings.length) continue;
    const sums = await db.$queryRaw<
      Array<{ day: string; net: Prisma.Decimal }>
    >`
      SELECT to_char("occurredAt" + interval '7 hours', 'YYYY-MM-DD') AS day,
        SUM(CASE WHEN "transactionType" IN ('RECEIPT', 'TRANSFER_IN') THEN amount ELSE -amount END) AS net
      FROM internal_fund_transactions
      WHERE "branchId" = ${branchId} AND status = 'POSTED'
      GROUP BY 1`;
    for (const closing of closings) {
      const day = closing.closingDate.toISOString().slice(0, 10);
      const before = sums
        .filter((sum) => sum.day <= day)
        .reduce((total, sum) => total + cents(sum.net), 0);
      // Khoản chi dời về ngày sớm hơn: số dư các ngày từ ngày mới tới trước
      // ngày cũ giảm đúng bằng khoản đó.
      const shift = rows.reduce(
        (total, row) =>
          total +
          (row.from <= day ? row.amount : 0) -
          (row.to <= day ? row.amount : 0),
        0,
      );
      if (!shift) continue;
      result.push({
        branchId,
        day,
        actual:
          closing.actualClosingBalance === null
            ? null
            : Number(closing.actualClosingBalance),
        before: before / 100,
        after: (before + shift) / 100,
        closedAt: closing.closedAt,
        closer: closing.closer?.name ?? null,
        synced: Boolean(closing.sourceKey) && !closing.posManagedAt,
      });
    }
  }
  return result;
}

export async function applyApprovedFundDates(
  prisma: PrismaClient,
  options: PlanOptions = {},
) {
  return prisma.$transaction(
    async (tx) => {
      const branches = await tx.internalFundTransaction.findMany({
        where: {
          status: 'POSTED',
          sourceType: 'INTERNAL_FINANCE_ENTRY',
          approvalRequestId: { not: null },
        },
        distinct: ['branchId'],
        select: { branchId: true },
      });
      // Cùng khóa với InternalFundLedgerService.lock để không chạy song song
      // với ghi quỹ / chốt sổ.
      for (const id of branches
        .map((row) => row.branchId)
        .sort((a, b) => a - b))
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${id}::integer)`;
      const fixes = await planApprovedFundDates(tx, options);
      const closings = await closingImpact(tx, fixes);
      for (const fix of fixes)
        await tx.internalFundTransaction.update({
          where: { id: fix.id },
          data: { occurredAt: fix.to },
        });
      // Trạng thái lưu của chốt sổ theo số hệ thống mới (tab Chốt sổ vẫn tự
      // tính lại khi hiển thị).
      for (const closing of closings)
        await tx.internalFundDailyClosing.updateMany({
          where: {
            branchId: closing.branchId,
            closingDate: fundClosingDate(closing.day),
          },
          data: {
            reconciliationStatus:
              closing.actual === null
                ? 'PENDING'
                : closingMatched(closing.actual, closing.after)
                  ? 'MATCHED'
                  : 'MISMATCHED',
          },
        });
      return { fixes, closings };
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
}
