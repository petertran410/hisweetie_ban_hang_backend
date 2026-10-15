import { Prisma } from '@prisma/client';
import {
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
} from './internal-finance.constants';

/**
 * Hủy batch tuần nhưng giữ lại dữ liệu: batch chuyển "Đã hủy" kèm người hủy
 * (null = hệ thống, khi Lark từ chối), lý do và danh sách phiếu lúc hủy. Phiếu
 * chưa Đã chi trả về Phiếu chi kho (đủ hai tick → chờ gom, thiếu → chờ kiểm
 * tra) để tổng hợp tuần lại. Gọi trong transaction đã khóa chi nhánh.
 */
export async function cancelWeeklyBatchInTx(
  tx: Prisma.TransactionClient,
  batchId: number,
  cancel: { cancelledBy: number | null; reason: string },
) {
  const entries = await tx.internalFinanceEntry.findMany({
    where: { weeklyBatchId: batchId },
    select: { id: true },
  });
  await tx.internalFinanceEntry.updateMany({
    where: {
      weeklyBatchId: batchId,
      cashIssued: false,
      managerReviewedAt: { not: null },
      accountantReviewedAt: { not: null },
    },
    data: { status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED },
  });
  await tx.internalFinanceEntry.updateMany({
    where: {
      weeklyBatchId: batchId,
      cashIssued: false,
      OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
    },
    data: { status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT },
  });
  await tx.internalFinanceEntry.updateMany({
    where: { weeklyBatchId: batchId },
    data: { weeklyBatchId: null },
  });
  await tx.internalFinanceWeeklyBatch.update({
    where: { id: batchId },
    data: {
      status: INTERNAL_FINANCE_WEEKLY_STATUS.CANCELLED,
      cancelledAt: new Date(),
      cancelledBy: cancel.cancelledBy,
      cancelReason: cancel.reason,
      cancelledEntryIds: entries.map((entry) => entry.id),
    },
  });
  return entries.length;
}
