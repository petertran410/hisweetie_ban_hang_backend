import { Prisma, PrismaClient } from '@prisma/client';
import { VPSG_FUND_START } from '../approval-lifecycle/approval-lifecycle.constants';
import {
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from '../internal-fund/internal-fund-ledger.service';
import { VPSG_BRANCH_ID } from './internal-finance.constants';

/**
 * Cân bằng quỹ tiền mặt VPSG theo tiền đếm thực tế. Sau khi chép sổ quỹ Lark
 * (`yarn import:office-ledger --branch=7`), nếu tiền đếm khác số dư trên POS thì
 * ghi một dòng "Cân bằng quỹ" bằng phần chênh lệch, lúc 23:59:59 ngày đếm, nên
 * đầu kỳ ngày hôm sau đúng bằng số đếm. Chạy lại: hủy dòng cân bằng cũ rồi ghi
 * dòng mới. Lệnh import không hủy dòng này.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const VPSG_BALANCE_KEY = 'VPSG_BALANCE';
export const VPSG_BALANCE_REPLACED = 'Thay bằng lần cân bằng quỹ mới';

const DAY = 86400000;
const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const money = (value: Prisma.Decimal) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

/** Hết ngày đếm theo giờ Việt Nam; mặc định ngày trước mốc quỹ VPSG lên POS. */
export function countedDayEnd(date?: string) {
  if (!date) return VPSG_FUND_START;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('--date phải có dạng YYYY-MM-DD');
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

export async function applyVpsgBalance(
  prisma: PrismaClient,
  actual: number,
  userId: number,
  date?: string,
) {
  const ledger = new InternalFundLedgerService();
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [VPSG_BRANCH_ID]);
      const plan = await planVpsgBalance(tx, actual, date);
      if (plan.unchanged) return plan;
      if (plan.current)
        await ledger.releaseCancelled(
          tx,
          plan.current,
          userId,
          VPSG_BALANCE_REPLACED,
        );
      if (!plan.difference.isZero())
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
        });
      return plan;
    },
    { timeout: 120_000, maxWait: 60_000 },
  );
}
