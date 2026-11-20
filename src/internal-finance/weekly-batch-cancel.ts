import { Prisma } from '@prisma/client';
import {
  FINANCE_AUDIT_ENTITY,
  auditActor,
  batchStatusLabel,
  buildFinanceDiff,
  formatMoney,
  reasonSuffix,
  type AuditActor,
  type FinanceAuditChange,
  type FinanceAuditEntry,
  type FinanceAuditService,
} from '../finance-audit';
import {
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
} from './internal-finance.constants';

type AuditEntryRef = {
  id: number;
  code?: string | null;
  branchId?: number | null;
};
type AuditBatchRef = { id: number; code?: string | null };

function statusChanges(
  before?: string | null,
  after?: string | null,
): FinanceAuditChange[] {
  if (before === undefined || after === undefined) return [];
  return buildFinanceDiff(
    FINANCE_AUDIT_ENTITY.ENTRY,
    { status: before },
    { status: after },
  );
}

/** Dòng lịch sử "Đưa phiếu vào Approval tuần" (gom tuần, thêm phiếu sót). */
export function entryBatchAddAudit(input: {
  entry: AuditEntryRef;
  batch: AuditBatchRef;
  actor: AuditActor;
  statusBefore?: string | null;
  statusAfter?: string | null;
  metadata?: Record<string, unknown>;
}): FinanceAuditEntry {
  const batchCode = input.batch.code || `#${input.batch.id}`;
  return {
    action: 'FIN_ENTRY_BATCH_ADD',
    entityType: FINANCE_AUDIT_ENTITY.ENTRY,
    entityId: input.entry.id,
    entityCode: input.entry.code ?? null,
    branchId: input.entry.branchId ?? null,
    actor: input.actor,
    params: { code: input.entry.code || `#${input.entry.id}`, batchCode },
    changes: [
      {
        field: 'weeklyBatchId',
        label: 'Approval tuần',
        from: '—',
        to: batchCode,
        type: 'field_changed',
        detail: { from: null, to: input.batch.id },
      },
      ...statusChanges(input.statusBefore, input.statusAfter),
    ],
    metadata: {
      batchId: input.batch.id,
      statusBefore: input.statusBefore ?? null,
      ...(input.metadata ?? {}),
    },
  };
}

/** Dòng lịch sử "Bỏ phiếu khỏi Approval tuần" (metadata.statusBefore). */
export function entryBatchRemoveAudit(input: {
  entry: AuditEntryRef;
  batch: AuditBatchRef;
  actor: AuditActor;
  reason?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  metadata?: Record<string, unknown>;
}): FinanceAuditEntry {
  const batchCode = input.batch.code || `#${input.batch.id}`;
  return {
    action: 'FIN_ENTRY_BATCH_REMOVE',
    entityType: FINANCE_AUDIT_ENTITY.ENTRY,
    entityId: input.entry.id,
    entityCode: input.entry.code ?? null,
    branchId: input.entry.branchId ?? null,
    actor: input.actor,
    params: {
      code: input.entry.code || `#${input.entry.id}`,
      batchCode,
      reasonSuffix: reasonSuffix(input.reason),
    },
    changes: [
      {
        field: 'weeklyBatchId',
        label: 'Approval tuần',
        from: batchCode,
        to: '—',
        type: 'field_changed',
        detail: { from: input.batch.id, to: null },
      },
      ...statusChanges(input.statusBefore, input.statusAfter),
    ],
    metadata: {
      batchId: input.batch.id,
      statusBefore: input.statusBefore ?? null,
      ...(input.metadata ?? {}),
    },
  };
}

/**
 * Hủy batch tuần nhưng giữ lại dữ liệu: batch chuyển "Đã hủy" kèm người hủy
 * (null = hệ thống, khi Lark từ chối), lý do và danh sách phiếu lúc hủy. Phiếu
 * chưa Đã chi trả về Phiếu chi kho (đủ hai tick → chờ gom, thiếu → chờ kiểm
 * tra) để tổng hợp tuần lại. Gọi trong transaction đã khóa chi nhánh.
 *
 * Truyền `audit` thì ghi lịch sử trong cùng tx: FIN_BATCH_CANCEL và
 * FIN_ENTRY_BATCH_REMOVE cho từng phiếu được trả (metadata.statusBefore).
 * Người thực hiện mặc định: `cancelledBy` (USER) hoặc hệ thống Lark khi null.
 */
export async function cancelWeeklyBatchInTx(
  tx: Prisma.TransactionClient,
  batchId: number,
  cancel: { cancelledBy: number | null; reason: string; actor?: AuditActor },
  audit?: FinanceAuditService,
) {
  const entries = await tx.internalFinanceEntry.findMany({
    where: { weeklyBatchId: batchId },
    select: {
      id: true,
      code: true,
      branchId: true,
      status: true,
      cashIssued: true,
      managerReviewedAt: true,
      accountantReviewedAt: true,
    },
  });
  const batchBefore = audit
    ? await tx.internalFinanceWeeklyBatch.findUnique({
        where: { id: batchId },
        select: {
          code: true,
          branchId: true,
          status: true,
          totalAmount: true,
          cancelReason: true,
        },
      })
    : null;
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
  const cancelledEntryIds = entries.map((entry) => entry.id);
  const batch = await tx.internalFinanceWeeklyBatch.update({
    where: { id: batchId },
    data: {
      status: INTERNAL_FINANCE_WEEKLY_STATUS.CANCELLED,
      cancelledAt: new Date(),
      cancelledBy: cancel.cancelledBy,
      cancelReason: cancel.reason,
      cancelledEntryIds,
    },
  });

  if (audit) {
    const actor =
      cancel.actor ??
      (cancel.cancelledBy
        ? auditActor.user(cancel.cancelledBy)
        : auditActor.system('LARK', 'lark-approval'));
    const batchCode = batch?.code ?? batchBefore?.code ?? null;
    const batchRef = { id: batchId, code: batchCode };
    await audit.write(tx, [
      {
        action: 'FIN_BATCH_CANCEL',
        entityType: FINANCE_AUDIT_ENTITY.BATCH,
        entityId: batchId,
        entityCode: batchCode,
        branchId: batch?.branchId ?? batchBefore?.branchId ?? null,
        actor,
        params: {
          batchCode: batchCode ?? `#${batchId}`,
          reasonSuffix: reasonSuffix(cancel.reason),
        },
        changes: audit.diff(
          FINANCE_AUDIT_ENTITY.BATCH,
          {
            status: batchBefore?.status ?? null,
            cancelReason: batchBefore?.cancelReason ?? null,
          },
          {
            status: INTERNAL_FINANCE_WEEKLY_STATUS.CANCELLED,
            cancelReason: cancel.reason,
          },
        ),
        snapshot: {
          lines: [
            {
              label: 'Trạng thái trước khi hủy',
              value: batchStatusLabel(batchBefore?.status),
            },
            { label: 'Số phiếu lúc hủy', value: String(entries.length) },
            {
              label: 'Tổng tiền',
              value: formatMoney(batchBefore?.totalAmount),
            },
          ],
        },
        metadata: { cancelledEntryIds, released: entries.length },
      },
      ...entries.map((entry) =>
        entryBatchRemoveAudit({
          entry,
          batch: batchRef,
          actor,
          reason: cancel.reason,
          statusBefore: entry.status,
          statusAfter: entry.cashIssued
            ? entry.status
            : entry.managerReviewedAt && entry.accountantReviewedAt
              ? INTERNAL_FINANCE_STATUS.MANAGER_APPROVED
              : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
          metadata: { batchCancelled: true },
        }),
      ),
    ]);
  }
  return entries.length;
}
