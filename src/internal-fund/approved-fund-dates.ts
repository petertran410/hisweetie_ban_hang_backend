import { Prisma, PrismaClient } from '@prisma/client';
import {
  FINANCE_AUDIT_ENTITY,
  branchLabel,
  financeAuditSystemUserId,
  formatDate,
  formatMoney,
} from '../finance-audit';
import {
  flushScriptLog,
  pushScriptRun,
  scriptChanges,
  scriptRun,
  type ScriptRun,
} from '../internal-finance/finance-script-audit';
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

/** Tên script ghi trong lịch sử (Cài đặt → Lịch sử). */
export const APPROVED_FUND_DATES_SCRIPT = 'fix-approval-fund-dates';

/** FIN_FUND_TXN_REDATE: một dòng lịch sử cho mỗi dòng quỹ đổi ngày. */
function pushRedate(run: ScriptRun, fix: FundDateFix) {
  run.log.push({
    action: 'FIN_FUND_TXN_REDATE',
    entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
    entityId: fix.id,
    entityCode: fix.code,
    branchId: fix.branchId,
    actor: run.actor,
    params: {
      code: fix.code,
      from: formatDate(fix.from),
      to: formatDate(fix.to),
    },
    changes: scriptChanges(
      run,
      FINANCE_AUDIT_ENTITY.FUND_TXN,
      { occurredAt: fix.from },
      { occurredAt: fix.to },
      ['occurredAt'],
    ),
    snapshot: {
      lines: [
        { label: 'Phiếu', value: fix.entryCode },
        { label: 'Approval tuần', value: fix.batchCode },
        { label: 'Số tiền', value: formatMoney(fix.amount) },
        ...(fix.clamped
          ? [
              {
                label: 'Ghi chú',
                value: 'Phiếu trước mốc quỹ lên POS: ghi vào đầu ngày mốc',
              },
            ]
          : []),
      ],
    },
    metadata: {
      script: run.name,
      entryCode: fix.entryCode,
      batchCode: fix.batchCode,
      clamped: fix.clamped,
      occurredAtBefore: fix.from,
      occurredAtAfter: fix.to,
    },
  });
}

export async function applyApprovedFundDates(
  prisma: PrismaClient,
  options: PlanOptions = {},
  /** Người chạy (--user), ghi vào lịch sử. */
  userId = financeAuditSystemUserId(),
  /** Tham số dòng lệnh, ghi vào lịch sử lần chạy. */
  args: string[] = [],
) {
  const run = scriptRun(APPROVED_FUND_DATES_SCRIPT, userId, args);
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
      for (const fix of fixes) {
        await tx.internalFundTransaction.update({
          where: { id: fix.id },
          data: { occurredAt: fix.to },
        });
        pushRedate(run, fix);
      }
      // Trạng thái lưu của chốt sổ theo số hệ thống mới (tab Chốt sổ vẫn tự
      // tính lại khi hiển thị). Đọc trạng thái cũ trước để ghi lịch sử.
      const closingKey = (branchId: number, day: string) =>
        `${branchId}|${day}`;
      const stored = closings.length
        ? await tx.internalFundDailyClosing.findMany({
            where: {
              OR: closings.map((closing) => ({
                branchId: closing.branchId,
                closingDate: fundClosingDate(closing.day),
              })),
            },
            select: {
              id: true,
              branchId: true,
              closingDate: true,
              reconciliationStatus: true,
            },
          })
        : [];
      const storedByKey = new Map(
        stored.map((row) => [
          closingKey(row.branchId, row.closingDate.toISOString().slice(0, 10)),
          row,
        ]),
      );
      const statusChanges: Array<{
        branchId: number;
        day: string;
        from: string;
        to: string;
      }> = [];
      for (const closing of closings) {
        const status =
          closing.actual === null
            ? 'PENDING'
            : closingMatched(closing.actual, closing.after)
              ? 'MATCHED'
              : 'MISMATCHED';
        await tx.internalFundDailyClosing.updateMany({
          where: {
            branchId: closing.branchId,
            closingDate: fundClosingDate(closing.day),
          },
          data: { reconciliationStatus: status },
        });
        const before = storedByKey.get(
          closingKey(closing.branchId, closing.day),
        );
        if (!before || before.reconciliationStatus === status) continue;
        statusChanges.push({
          branchId: closing.branchId,
          day: closing.day,
          from: before.reconciliationStatus,
          to: status,
        });
        if (status === 'PENDING')
          run.log.push({
            action: 'FIN_FUND_CLOSING_INVALIDATE',
            entityType: FINANCE_AUDIT_ENTITY.FUND_CLOSING,
            entityId: before.id,
            branchId: closing.branchId,
            actor: run.actor,
            params: {
              branch: branchLabel(closing.branchId),
              date: formatDate(before.closingDate),
              cause: 'dời ngày dòng quỹ Approval tuần',
            },
            snapshot: {
              lines: [
                { label: 'Quỹ', value: branchLabel(closing.branchId) },
                { label: 'Ngày chốt', value: formatDate(before.closingDate) },
              ],
            },
            changes: scriptChanges(
              run,
              FINANCE_AUDIT_ENTITY.FUND_CLOSING,
              { reconciliationStatus: before.reconciliationStatus },
              { reconciliationStatus: status },
              ['reconciliationStatus'],
            ),
            metadata: {
              script: run.name,
              statusBefore: before.reconciliationStatus,
            },
          });
      }

      const total = fixes.reduce((sum, fix) => sum + fix.amount, 0);
      const clamped = fixes.filter((fix) => fix.clamped).length;
      pushScriptRun(
        run,
        `Dời ${fixes.length} dòng quỹ Approval tuần về ngày chi (${formatMoney(total)})${
          clamped ? `, ${clamped} phiếu trước mốc ghi đầu ngày mốc` : ''
        }; chốt sổ đổi trạng thái đối soát: ${statusChanges.length}`,
        [
          { key: 'redated', label: 'Dòng quỹ đổi ngày', value: fixes.length },
          { key: 'amount', label: 'Tổng tiền', value: formatMoney(total) },
          {
            key: 'clamped',
            label: 'Phiếu trước mốc (ghi đầu ngày mốc)',
            value: clamped,
          },
          {
            key: 'closings',
            label: 'Chốt sổ đổi số hệ thống',
            value: closings.length,
          },
          {
            key: 'closingStatusChanges',
            label: 'Chốt sổ đổi trạng thái đối soát',
            value: statusChanges.length,
          },
        ],
        {
          branchId: options.branchId ?? null,
          metadata: {
            skipBeforeCutoff: Boolean(options.skipBeforeCutoff),
            closingStatusChanges: statusChanges,
          },
        },
      );
      await flushScriptLog(tx, run);
      return { fixes, closings };
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
}
