import { Prisma, PrismaClient } from '@prisma/client';
import {
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from '../internal-fund/internal-fund-ledger.service';
import {
  flushScriptLog,
  pushScriptRun,
  scriptRun,
} from './finance-script-audit';
import { VPSG_BRANCH_ID } from './internal-finance.constants';

/**
 * Cân bằng quỹ tiền mặt VPSG theo tiền đếm thực tế (không bắt buộc). Sau khi
 * nhập sổ quỹ Lark + đơn duyệt (`yarn import:office-ledger --branch=7`), nếu
 * tiền đếm khác số dư trên POS thì ghi một dòng "Cân bằng quỹ" bằng phần chênh
 * lệch lúc 23:59:59 ngày đếm, nên số dư hết ngày đếm đúng bằng tiền đếm. Chạy
 * lại (đếm lại, hoặc sau khi nhập lại sổ): hủy dòng cũ rồi ghi dòng mới.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const VPSG_BALANCE_KEY = 'VPSG_BALANCE';
export const VPSG_BALANCE_REPLACED = 'Thay bằng lần cân bằng quỹ mới';

const DAY = 86400000;
const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const money = (value: Prisma.Decimal) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

/** Hết ngày đếm tiền theo giờ Việt Nam. */
export function countedDayEnd(date?: string) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('Cần --date=YYYY-MM-DD (ngày đếm tiền, tính tới hết ngày)');
  return new Date(new Date(`${date}T00:00:00+07:00`).getTime() + DAY);
}

export async function planVpsgBalance(db: Db, actual: number, date?: string) {
  if (!Number.isFinite(actual) || actual < 0)
    throw new Error('Tiền đếm phải là số không âm');
  const dayEnd = countedDayEnd(date);
  const at = new Date(dayEnd.getTime() - 1000);
  const [groups, current] = await Promise.all([
    db.internalFundTransaction.groupBy({
      by: ['transactionType'],
      where: {
        branchId: VPSG_BRANCH_ID,
        status: 'POSTED',
        occurredAt: { lt: dayEnd },
        // Không tính dòng cân bằng hiện có: chạy lại thì tính chênh lệch từ đầu.
        NOT: { sourceKey: VPSG_BALANCE_KEY },
      },
      _sum: { amount: true },
    }),
    db.internalFundTransaction.findUnique({
      where: { sourceKey: VPSG_BALANCE_KEY },
      select: {
        id: true,
        code: true,
        branchId: true,
        transactionType: true,
        amount: true,
        occurredAt: true,
        sourceKey: true,
        status: true,
      },
    }),
  ]);
  const system = groups.reduce(
    (total, group) =>
      ['RECEIPT', 'TRANSFER_IN'].includes(group.transactionType)
        ? total.plus(group._sum.amount || 0)
        : total.minus(group._sum.amount || 0),
    new Prisma.Decimal(0),
  );
  const counted = new Prisma.Decimal(actual);
  const difference = counted.minus(system);
  const live = current?.status === 'POSTED' ? current : null;
  const transactionType: 'RECEIPT' | 'EXPENSE' = difference.gt(0)
    ? 'RECEIPT'
    : 'EXPENSE';
  // Dòng hiện có đã đúng thì chạy lại không đổi gì.
  const unchanged = live
    ? live.occurredAt.getTime() === at.getTime() &&
      live.transactionType === transactionType &&
      live.amount.equals(difference.abs())
    : difference.isZero();
  return {
    at,
    actual: counted,
    system,
    difference,
    transactionType,
    current: live,
    unchanged,
  };
}

/** Tên script ghi trong lịch sử (Cài đặt → Lịch sử). */
export const VPSG_BALANCE_SCRIPT = 'balance-vpsg-fund';

export async function applyVpsgBalance(
  prisma: PrismaClient,
  actual: number,
  userId: number,
  date?: string,
  /** Tham số dòng lệnh, ghi vào lịch sử lần chạy. */
  args: string[] = [],
) {
  const run = scriptRun(VPSG_BALANCE_SCRIPT, userId, args);
  const ledger = new InternalFundLedgerService(run.service);
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [VPSG_BRANCH_ID]);
      const plan = await planVpsgBalance(tx, actual, date);
      const replaced = !plan.unchanged && Boolean(plan.current);
      const posted = !plan.unchanged && !plan.difference.isZero();
      if (replaced)
        await ledger.releaseCancelled(
          tx,
          plan.current!,
          userId,
          VPSG_BALANCE_REPLACED,
          run.actor,
        );
      if (posted)
        await ledger.postSystemTransaction(tx, {
          branchId: VPSG_BRANCH_ID,
          transactionType: plan.transactionType,
          codeKind: 'CANBANG',
          amount: plan.difference.abs(),
          occurredAt: plan.at,
          description: `Cân bằng quỹ theo tiền đếm ngày ${vnDate(plan.at)}: đếm ${money(plan.actual)}, sổ ${money(plan.system)}`,
          sourceType: FUND_SOURCE_TYPE.BALANCE_ADJUSTMENT,
          sourceKey: VPSG_BALANCE_KEY,
          userId,
          auditActor: run.actor,
        });
      // Một dòng lịch sử cho mỗi lần chạy --apply (cả khi không đổi gì).
      pushScriptRun(
        run,
        `Quỹ VPSG ngày ${vnDate(plan.at)}: đếm ${money(plan.actual)}, sổ ${money(plan.system)}, ${
          plan.unchanged
            ? 'không có gì thay đổi'
            : posted
              ? `ghi ${plan.transactionType === 'RECEIPT' ? 'THU' : 'CHI'} ${money(plan.difference.abs())}`
              : 'khớp sổ, bỏ dòng cân bằng'
        }`,
        [
          { key: 'actual', label: 'Tiền đếm', value: money(plan.actual) },
          {
            key: 'system',
            label: 'Số dư POS (không tính dòng cân bằng)',
            value: money(plan.system),
          },
          {
            key: 'difference',
            label: 'Chênh lệch',
            value: money(plan.difference),
          },
          {
            key: 'replaced',
            label: 'Hủy dòng cân bằng cũ',
            value: replaced ? 1 : 0,
          },
          {
            key: 'posted',
            label: 'Ghi dòng cân bằng mới',
            value: posted ? 1 : 0,
          },
        ],
        {
          branchId: VPSG_BRANCH_ID,
          metadata: {
            at: plan.at,
            actual: plan.actual,
            system: plan.system,
            difference: plan.difference,
            replacedFundId: replaced ? plan.current!.id : null,
          },
        },
      );
      await flushScriptLog(tx, run);
      return plan;
    },
    { timeout: 120_000, maxWait: 60_000 },
  );
}
