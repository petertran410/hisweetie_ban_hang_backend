import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InternalFundTransaction } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  RECEIPT_FIELD_IDS,
  larkLedgerCutoff,
} from '../approval-lifecycle/approval-lifecycle.constants';
import {
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
  OFFICE_BRANCH_IDS,
  VPSG_BRANCH_ID,
} from '../internal-finance/internal-finance.constants';
import {
  FINANCE_AUDIT_ENTITY,
  FinanceAuditService,
  auditActor,
  batchStatusLabel,
  branchLabel,
  formatDate,
  formatMoney,
  fundSourceLabel,
  fundTransferStatusLabel,
  fundTxnTypeLabel,
  reasonSuffix,
  type AuditActor,
  type FinanceAuditChange,
  type FinanceAuditEntityType,
  type FinanceAuditEntry,
} from '../finance-audit';

export function fundDateKey(value: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('Ngày không hợp lệ');
  return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

export function fundDayStart(value: string | Date): Date {
  return new Date(`${fundDateKey(value)}T00:00:00+07:00`);
}

/** Lý do Đã chi của phiếu mà tiền đã trừ trong sổ quỹ Lark trước khi lên POS. */
export const LARK_LEDGER_RECORDED_REASON = 'Đã trừ quỹ trên Lark';

/** Phiếu nhập từ Lark có dòng trừ quỹ tương ứng trong sổ quỹ Lark. */
export function isLarkLedgerRecorded(entry: { sourceSnapshot?: unknown }) {
  const snapshot = entry.sourceSnapshot;
  return Boolean(
    snapshot &&
    typeof snapshot === 'object' &&
    (snapshot as { larkLedgerRecorded?: unknown }).larkLedgerRecorded === true,
  );
}

/**
 * Ngày ghi quỹ của phiếu chi trong Approval tuần: ngày chi của phiếu, không phải
 * ngày Approval duyệt xong. Phiếu trước mốc quỹ lên POS (sổ quỹ Lark là số đúng
 * tới hết ngày trước mốc) ghi vào đầu ngày mốc để không đổi số các ngày cũ.
 */
export function approvedExpenseDate(entry: {
  branchId: number;
  occurredAt: Date;
}): Date {
  const cutoff = larkLedgerCutoff(entry.branchId);
  return entry.occurredAt < cutoff ? cutoff : entry.occurredAt;
}

export function fundClosingDate(value: string | Date): Date {
  return new Date(`${fundDateKey(value)}T00:00:00Z`);
}

interface FundApprovalData {
  id: number;
  status: string;
  sourceType: string | null;
  sourceId?: number | null;
  branchId?: number | null;
  createdById?: number;
  formSnapshot?: unknown;
}

export const FUND_SOURCE_TYPE = {
  WAREHOUSE_CASH_RECEIPT: 'WAREHOUSE_CASH_RECEIPT',
  /** Tiền vào tài khoản VPSG ghi vào quỹ nội bộ VPSG (trang Biến động số dư). */
  SEPAY_VPSG: 'SEPAY_VPSG',
  /** Cân bằng quỹ theo tiền mặt đếm thực tế (quỹ VPSG). */
  BALANCE_ADJUSTMENT: 'BALANCE_ADJUSTMENT',
  LARK_PAYMENT_VOUCHER: 'LARK_PAYMENT_VOUCHER',
  LARK_SALARY_ADVANCE: 'LARK_SALARY_ADVANCE',
  // Bút toán lịch sử đồng bộ từ sổ quỹ cũ: chỉ đọc trên POS.
  LEDGER_HISTORY: 'LEDGER_HISTORY',
} as const;

/** Đơn Lark chi tiền mặt từ quỹ (PHIẾU CHI, TẠM ỨNG LƯƠNG). */
interface LarkCashRequest {
  id: number;
  status: string;
  branchId: number | null;
  createdById: number;
  completedAt: Date | null;
  formSnapshot: unknown;
}

export interface SystemFundTransactionInput {
  branchId: number;
  transactionType: 'RECEIPT' | 'EXPENSE';
  codeKind: string;
  amount: Prisma.Decimal | number | string;
  occurredAt: Date;
  description?: string | null;
  sourceType: string;
  sourceKey: string;
  sourceId?: string;
  entryId?: number;
  approvalRequestId?: number;
  userId: number;
  assertOpen?: boolean;
  adjust?: boolean;
  /** Người/hệ thống thực hiện cho lịch sử; mặc định là `userId`. */
  auditActor?: AuditActor;
}

/** Kết quả rút phiếu khỏi batch tuần chưa gửi Approval. */
export interface DetachFromBatchResult {
  batchId: number;
  batchCode: string | null;
  /** Batch không còn phiếu nên được hủy (giữ lại, trạng thái Đã hủy). */
  batchCancelled: boolean;
  remainingTotal: number;
}

export interface DetachFromBatchOptions {
  /** Người rút phiếu; người hủy batch khi batch rỗng là actor USER. */
  actor?: AuditActor;
  /** Lý do rút phiếu, cũng là lý do hủy batch khi batch rỗng. */
  reason?: string;
  /**
   * Bên gọi tự đặt trạng thái phiếu ngay sau đó (hủy phiếu, bỏ tick, hủy báo
   * đơn): không đổi trạng thái "Đã gom tuần" ở đây.
   */
  keepStatus?: boolean;
}

/** Lý do mặc định khi batch tự hủy vì không còn phiếu. */
export const EMPTY_BATCH_CANCEL_REASON = 'Tự hủy: không còn phiếu';

type AuditLog = FinanceAuditEntry[];
type FundRowRef = {
  id: number;
  branchId: number;
  occurredAt: Date;
  sourceKey: string;
};

const SYSTEM_TRIGGER = 'fund-ledger';
const LARK_TRIGGER = 'lark-approval';

function fundRowLines(row: InternalFundTransaction) {
  return [
    { label: 'Quỹ', value: branchLabel(row.branchId) },
    { label: 'Loại', value: fundTxnTypeLabel(row.transactionType) },
    { label: 'Số tiền', value: formatMoney(row.amount) },
    { label: 'Ngày ghi quỹ', value: formatDate(row.occurredAt) },
    { label: 'Nội dung', value: row.description || '—' },
    { label: 'Nguồn', value: fundSourceLabel(row.sourceType) },
  ];
}

@Injectable()
export class InternalFundLedgerService {
  // Không có FinanceAuditService (script/spec tạo `new InternalFundLedgerService()`)
  // thì bỏ qua ghi lịch sử.
  constructor(@Optional() private readonly audit?: FinanceAuditService) {}

  /** Thêm một dòng lịch sử (chỉ dựng khi có FinanceAuditService). */
  private record(log: AuditLog, build: () => FinanceAuditEntry | null) {
    if (!this.audit) return;
    const entry = build();
    if (entry) log.push(entry);
  }

  private async flush(tx: Prisma.TransactionClient, log: AuditLog) {
    if (this.audit && log.length) await this.audit.write(tx, log);
  }

  private async withLog<T>(
    tx: Prisma.TransactionClient,
    run: (log: AuditLog) => Promise<T>,
  ): Promise<T> {
    const log: AuditLog = [];
    const result = await run(log);
    await this.flush(tx, log);
    return result;
  }

  private statusChange(
    entityType: FinanceAuditEntityType,
    field: string,
    from: unknown,
    to: unknown,
  ): FinanceAuditChange[] {
    return this.audit
      ? this.audit.diff(entityType, { [field]: from }, { [field]: to }, [field])
      : [];
  }

  private fundPostEntry(
    row: InternalFundTransaction,
    actor: AuditActor,
  ): FinanceAuditEntry {
    return {
      action: 'FIN_FUND_TXN_POST',
      entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
      entityId: row.id,
      entityCode: row.code,
      branchId: row.branchId,
      actor,
      params: {
        typeLabel: fundTxnTypeLabel(row.transactionType),
        code: row.code,
        amount: Number(row.amount),
        sourceLabel: fundSourceLabel(row.sourceType),
      },
      snapshot: { lines: fundRowLines(row) },
      metadata: {
        sourceType: row.sourceType,
        sourceKey: row.sourceKey,
        sourceId: row.sourceId ?? null,
        entryId: row.entryId ?? null,
        approvalRequestId: row.approvalRequestId ?? null,
        transferId: row.transferId ?? null,
      },
    };
  }

  // All fund mutations and closings share branch locks to prevent close/post races.
  async lock(tx: Prisma.TransactionClient, branchIds: number[]) {
    for (const id of [...new Set(branchIds)].sort((a, b) => a - b)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${id}::integer)`;
    }
  }

  async lockApproval(tx: Prisma.TransactionClient, approvalRequestId: number) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(68126, ${approvalRequestId}::integer)
    `;
  }

  async assertOpen(
    tx: Prisma.TransactionClient,
    branchId: number,
    date: Date,
    adjust = false,
  ) {
    const closing = await tx.internalFundDailyClosing.findFirst({
      where: {
        branchId,
        closingDate: { gte: fundClosingDate(date) },
        closedAt: { not: null },
      },
    });
    if (closing && !adjust)
      throw new BadRequestException('Ngày đã chốt sổ; cần quyền điều chỉnh');
  }

  /**
   * Chốt sổ từ ngày `date` trở đi cần đối soát lại. `cause` ghi vào lịch sử
   * (chỉ các ngày thật sự chuyển sang PENDING).
   */
  async invalidateClosings(
    tx: Prisma.TransactionClient,
    branchId: number,
    date: Date,
    cause?: string,
    actor?: AuditActor,
  ) {
    await this.withLog(tx, (log) =>
      this.invalidateClosingsInto(tx, branchId, date, log, cause, actor),
    );
  }

  private async invalidateClosingsInto(
    tx: Prisma.TransactionClient,
    branchId: number,
    date: Date,
    log: AuditLog,
    cause?: string,
    actor?: AuditActor,
  ) {
    const where = {
      branchId,
      closingDate: { gte: fundClosingDate(date) },
      closedAt: { not: null },
    };
    const flipping = this.audit
      ? await tx.internalFundDailyClosing.findMany({
          where: { ...where, reconciliationStatus: { not: 'PENDING' } },
          select: {
            id: true,
            branchId: true,
            closingDate: true,
            reconciliationStatus: true,
          },
          orderBy: { closingDate: 'asc' },
        })
      : [];
    await tx.internalFundDailyClosing.updateMany({
      where,
      data: { reconciliationStatus: 'PENDING' },
    });
    if (!flipping.length) return;
    const by = actor ?? auditActor.system('SYSTEM', SYSTEM_TRIGGER);
    for (const closing of flipping)
      this.record(log, () => ({
        action: 'FIN_FUND_CLOSING_INVALIDATE',
        entityType: FINANCE_AUDIT_ENTITY.FUND_CLOSING,
        entityId: closing.id,
        branchId: closing.branchId,
        actor: by,
        params: {
          branch: branchLabel(closing.branchId),
          date: formatDate(closing.closingDate),
          cause: cause || 'giao dịch quỹ thay đổi',
        },
        changes: this.statusChange(
          FINANCE_AUDIT_ENTITY.FUND_CLOSING,
          'reconciliationStatus',
          closing.reconciliationStatus,
          'PENDING',
        ),
        snapshot: {
          lines: [
            { label: 'Quỹ', value: branchLabel(closing.branchId) },
            { label: 'Ngày chốt', value: formatDate(closing.closingDate) },
          ],
        },
        metadata: { statusBefore: closing.reconciliationStatus },
      }));
  }

  async issueExpense(
    tx: Prisma.TransactionClient,
    entry: { id: number; branchId: number },
    userId: number,
    adjust = false,
    manualReason?: string,
    actor?: AuditActor,
  ) {
    const by = actor ?? auditActor.user(userId);
    return this.withLog(tx, async (log) => {
      await this.lock(tx, [entry.branchId]);
      const current = await tx.internalFinanceEntry.findUnique({
        where: { id: entry.id },
        include: { weeklyBatch: { include: { approvalRequest: true } } },
      });
      if (!current || current.direction !== 'EXPENSE')
        throw new BadRequestException('Không tìm thấy khoản chi');
      const existing = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: `EXPENSE:${current.id}` },
      });
      if (existing) return existing;
      if (current.cashFlowId || current.cashIssued) {
        throw new BadRequestException(
          'Khoản chi lịch sử đã ghi nhận; không tự động ghi lại vào quỹ mới',
        );
      }
      const approved =
        current.status === 'APPROVED' &&
        current.weeklyBatch?.status === 'APPROVED' &&
        Boolean(current.weeklyBatch.approvalRequestId) &&
        current.weeklyBatch.approvalRequest?.status === 'APPROVED';
      // Phiếu trong Approval tuần đã duyệt: ghi quỹ vào ngày chi của phiếu.
      if (approved) {
        const occurredAt = approvedExpenseDate(current);
        await this.assertOpen(tx, current.branchId, occurredAt, adjust);
        return this.postExpenseRow(tx, current, userId, {
          approvalRequestId: current.weeklyBatch!.approvalRequestId!,
          occurredAt,
          invalidate: adjust,
          actor: by,
          log,
        });
      }

      // VPSG: phiếu tay thành Đã chi khi Kế toán duyệt (tick Kế toán).
      if (
        current.branchId === VPSG_BRANCH_ID &&
        current.sourceType === 'MANUAL_EXPENSE'
      )
        throw new BadRequestException(
          'Phiếu chi VPSG đã chi khi Kế toán duyệt; hãy tick Kế toán duyệt',
        );

      // Chi ngoài Approval tuần: bắt buộc có lý do, phiếu rời khỏi batch chưa gửi.
      // Văn phòng HN không có Approval tuần: phiếu tay chi thẳng từ quỹ.
      const reason = manualReason?.trim() || undefined;
      const office =
        (OFFICE_BRANCH_IDS as readonly number[]).includes(current.branchId) &&
        !current.weeklyBatch;
      if (!reason && !office) {
        throw new BadRequestException(
          'Khoản chi chưa nằm trong Approval tuần đã duyệt; cần nhập lý do Đã chi',
        );
      }
      if (['CANCELLED', 'REJECTED'].includes(current.status))
        throw new BadRequestException('Khoản chi đã hủy hoặc bị từ chối');
      if (current.weeklyBatch) {
        if (current.weeklyBatch.status !== 'READY')
          throw new BadRequestException(
            'Khoản chi đang chờ duyệt Approval tuần, không thể tự đánh dấu Đã chi',
          );
        // Rời batch và trả trạng thái "Đã gom tuần" về như trước khi gom.
        await this.detachFromBatchInto(
          tx,
          current,
          {
            actor: by,
            reason: `Đã chi ngoài Approval tuần${reasonSuffix(reason)}`,
          },
          log,
        );
      }
      // Chi ngoài Approval tuần: tiền ra khỏi quỹ lúc tick Đã chi.
      const issuedAt = new Date();
      await this.assertOpen(tx, current.branchId, issuedAt, adjust);
      return this.postExpenseRow(tx, current, userId, {
        reason,
        occurredAt: issuedAt,
        invalidate: adjust,
        actor: by,
        log,
      });
    });
  }

  /**
   * Phiếu chi tay VPSG: Kế toán duyệt là Đã chi, trừ quỹ ngay lúc duyệt.
   * Gọi trong transaction của bước duyệt; chạy lại không ghi quỹ lần 2.
   */
  async issueReviewedExpense(
    tx: Prisma.TransactionClient,
    entry: { id: number; branchId: number },
    userId: number,
    adjust = false,
    actor?: AuditActor,
  ) {
    const by = actor ?? auditActor.user(userId);
    return this.withLog(tx, async (log) => {
      await this.lock(tx, [entry.branchId]);
      const current = await tx.internalFinanceEntry.findUnique({
        where: { id: entry.id },
      });
      if (!current || current.direction !== 'EXPENSE')
        throw new BadRequestException('Không tìm thấy khoản chi');
      const existing = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: `EXPENSE:${current.id}` },
      });
      if (existing) return existing;
      const issuedAt = new Date();
      await this.assertOpen(tx, current.branchId, issuedAt, adjust);
      return this.postExpenseRow(tx, current, userId, {
        occurredAt: issuedAt,
        invalidate: adjust,
        actor: by,
        log,
      });
    });
  }

  /** Bỏ duyệt phiếu chi tay VPSG: hủy dòng quỹ đã trừ lúc duyệt. */
  async revertReviewedExpense(
    tx: Prisma.TransactionClient,
    entry: { id: number; branchId: number },
    userId: number,
    adjust = false,
    actor?: AuditActor,
  ) {
    await this.lock(tx, [entry.branchId]);
    const row = await tx.internalFundTransaction.findUnique({
      where: { sourceKey: `EXPENSE:${entry.id}` },
    });
    if (!row || row.status !== 'POSTED') return null;
    await this.assertOpen(tx, row.branchId, row.occurredAt, adjust);
    return this.releaseCancelled(
      tx,
      row,
      userId,
      'Kế toán bỏ duyệt phiếu chi',
      actor,
    );
  }

  /**
   * Rút phiếu khỏi batch tuần chưa gửi Approval và tính lại tổng tiền. Batch
   * không còn phiếu thì hủy (giữ lại, trạng thái Đã hủy), không xóa. Phiếu
   * đang "Đã gom tuần" trở về như trước khi gom (đủ hai tick → Đã kiểm tra,
   * thiếu → Chờ kiểm tra), trừ khi `keepStatus` (bên gọi tự đặt trạng thái).
   * Trả null khi phiếu không nằm trong batch nào.
   */
  async detachFromBatch(
    tx: Prisma.TransactionClient,
    entry: { id: number; weeklyBatchId: number | null },
    opts: DetachFromBatchOptions = {},
  ): Promise<DetachFromBatchResult | null> {
    return this.withLog(tx, (log) =>
      this.detachFromBatchInto(tx, entry, opts, log),
    );
  }

  private async detachFromBatchInto(
    tx: Prisma.TransactionClient,
    entry: { id: number; weeklyBatchId: number | null },
    opts: DetachFromBatchOptions,
    log: AuditLog,
  ): Promise<DetachFromBatchResult | null> {
    const batchId = entry.weeklyBatchId;
    if (!batchId) return null;
    const batchBefore = this.audit
      ? await tx.internalFinanceWeeklyBatch.findUnique({
          where: { id: batchId },
          select: {
            code: true,
            status: true,
            totalAmount: true,
            cancelReason: true,
          },
        })
      : null;
    const detached = await tx.internalFinanceEntry.update({
      where: { id: entry.id },
      data: { weeklyBatchId: null },
    });
    const statusBefore = detached?.status ?? null;
    let statusAfter = statusBefore;
    if (
      !opts.keepStatus &&
      statusBefore === INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL
    ) {
      statusAfter =
        detached.managerReviewedAt && detached.accountantReviewedAt
          ? INTERNAL_FINANCE_STATUS.MANAGER_APPROVED
          : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT;
      await tx.internalFinanceEntry.update({
        where: { id: entry.id },
        data: { status: statusAfter },
      });
    }
    const rest = await tx.internalFinanceEntry.aggregate({
      where: { weeklyBatchId: batchId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const batchCancelled = !rest._count._all;
    const cancelReason = opts.reason?.trim() || EMPTY_BATCH_CANCEL_REASON;
    const batch = batchCancelled
      ? await tx.internalFinanceWeeklyBatch.update({
          where: { id: batchId },
          data: {
            status: INTERNAL_FINANCE_WEEKLY_STATUS.CANCELLED,
            cancelledAt: new Date(),
            cancelledBy: opts.actor?.kind === 'USER' ? opts.actor.userId : null,
            cancelReason,
            cancelledEntryIds: [entry.id],
          },
        })
      : await tx.internalFinanceWeeklyBatch.update({
          where: { id: batchId },
          data: { totalAmount: rest._sum.amount || 0 },
        });
    const result: DetachFromBatchResult = {
      batchId,
      batchCode: batch?.code ?? batchBefore?.code ?? null,
      batchCancelled,
      remainingTotal: Number(rest._sum.amount || 0),
    };
    const by = opts.actor ?? auditActor.system('SYSTEM', SYSTEM_TRIGGER);
    const entryCode =
      detached?.code ?? (entry as { code?: string }).code ?? null;
    this.record(log, () => ({
      action: 'FIN_ENTRY_BATCH_REMOVE',
      entityType: FINANCE_AUDIT_ENTITY.ENTRY,
      entityId: entry.id,
      entityCode: entryCode,
      branchId: detached?.branchId ?? batch?.branchId ?? null,
      actor: by,
      params: {
        code: entryCode ?? `#${entry.id}`,
        batchCode: result.batchCode ?? `#${batchId}`,
        reasonSuffix: reasonSuffix(opts.reason),
      },
      changes: [
        {
          field: 'weeklyBatchId',
          label: 'Approval tuần',
          from: result.batchCode ?? `#${batchId}`,
          to: '—',
          type: 'field_changed',
          detail: { from: batchId, to: null },
        },
        ...this.statusChange(
          FINANCE_AUDIT_ENTITY.ENTRY,
          'status',
          statusBefore,
          statusAfter,
        ),
      ],
      metadata: {
        batchId,
        batchCancelled,
        remainingTotal: result.remainingTotal,
        statusBefore,
      },
    }));
    if (batchCancelled)
      this.record(log, () => ({
        action: 'FIN_BATCH_CANCEL',
        entityType: FINANCE_AUDIT_ENTITY.BATCH,
        entityId: batchId,
        entityCode: result.batchCode,
        branchId: batch?.branchId ?? detached?.branchId ?? null,
        actor: by,
        params: {
          batchCode: result.batchCode ?? `#${batchId}`,
          reasonSuffix: reasonSuffix(cancelReason),
        },
        changes: this.audit!.diff(
          FINANCE_AUDIT_ENTITY.BATCH,
          {
            status: batchBefore?.status ?? null,
            totalAmount: batchBefore?.totalAmount ?? null,
            cancelReason: batchBefore?.cancelReason ?? null,
          },
          {
            status: INTERNAL_FINANCE_WEEKLY_STATUS.CANCELLED,
            totalAmount: batchBefore?.totalAmount ?? null,
            cancelReason,
          },
        ),
        snapshot: {
          lines: [
            {
              label: 'Trạng thái trước khi hủy',
              value: batchStatusLabel(batchBefore?.status),
            },
            {
              label: 'Tổng tiền',
              value: formatMoney(batchBefore?.totalAmount),
            },
          ],
        },
        metadata: {
          autoCancelled: true,
          cancelledEntryIds: [entry.id],
          statusBefore: batchBefore?.status ?? null,
        },
      }));
    return result;
  }

  private async postExpenseRow(
    tx: Prisma.TransactionClient,
    current: {
      id: number;
      code: string;
      branchId: number;
      amount: Prisma.Decimal;
      occurredAt: Date;
      description: string | null;
      sourceSnapshot?: Prisma.JsonValue;
    },
    userId: number,
    options: {
      approvalRequestId?: number;
      reason?: string;
      /**
       * Ngày ghi quỹ: ngày chi của phiếu (Approval tuần) hoặc lúc tick Đã chi
       * (chi ngoài Approval tuần).
       */
      occurredAt: Date;
      invalidate?: boolean;
      actor: AuditActor;
      log: AuditLog;
    },
  ) {
    // Phiếu đồng bộ từ Lark đã có dòng trừ quỹ trong sổ quỹ Lark: chỉ tick Đã
    // chi theo luật POS, không trừ quỹ lần nữa.
    if (isLarkLedgerRecorded(current)) {
      await tx.internalFinanceEntry.update({
        where: { id: current.id },
        data: {
          cashIssued: true,
          cashIssuedAt: new Date(),
          cashIssuedBy: userId,
          cashIssuedReason: options.reason ?? LARK_LEDGER_RECORDED_REASON,
          posManagedAt: new Date(),
        },
      });
      return null;
    }
    const description = current.description || current.code;
    const row = await tx.internalFundTransaction.create({
      data: {
        code: this.code('CHI'),
        sourceKey: `EXPENSE:${current.id}`,
        branchId: current.branchId,
        entryId: current.id,
        transactionType: 'EXPENSE',
        amount: current.amount,
        occurredAt: options.occurredAt,
        description: options.reason
          ? `${description} (Lý do: ${options.reason})`
          : description,
        sourceType: 'INTERNAL_FINANCE_ENTRY',
        sourceId: String(current.id),
        approvalRequestId: options.approvalRequestId,
        status: 'POSTED',
        createdBy: userId,
      },
    });
    this.record(options.log, () => this.fundPostEntry(row, options.actor));
    await tx.internalFinanceEntry.update({
      where: { id: current.id },
      data: {
        cashIssued: true,
        cashIssuedAt: new Date(),
        cashIssuedBy: userId,
        cashIssuedReason: options.reason ?? null,
        posManagedAt: new Date(),
      },
    });
    if (options.invalidate)
      await this.invalidateClosingsInto(
        tx,
        current.branchId,
        options.occurredAt,
        options.log,
        `ghi dòng quỹ ${row.code}`,
        options.actor,
      );
    return row;
  }

  // Approval tuần được duyệt: mọi phiếu trong batch tự ghi quỹ và thành Đã chi.
  async issueApprovedBatch(
    tx: Prisma.TransactionClient,
    batchId: number,
    approvalRequestId: number,
    userId: number,
    actor?: AuditActor,
  ) {
    const by = actor ?? auditActor.system('LARK', LARK_TRIGGER, userId);
    return this.withLog(tx, async (log) => {
      const entries = await tx.internalFinanceEntry.findMany({
        where: {
          weeklyBatchId: batchId,
          direction: 'EXPENSE',
          cashIssued: false,
          cashFlowId: null,
          fundTransaction: null,
        },
        orderBy: { id: 'asc' },
      });
      // Ghi quỹ vào ngày chi của từng phiếu, không phải ngày Approval duyệt xong;
      // chốt sổ từ ngày đó trở đi được đánh dấu cần đối soát lại.
      for (const entry of entries) {
        const row = await this.postExpenseRow(tx, entry, userId, {
          approvalRequestId,
          occurredAt: approvedExpenseDate(entry),
          invalidate: true,
          actor: by,
          log,
        });
        const reason = row
          ? 'Approval tuần đã duyệt'
          : LARK_LEDGER_RECORDED_REASON;
        this.record(log, () => ({
          action: 'FIN_ENTRY_CASH_ISSUE',
          entityType: FINANCE_AUDIT_ENTITY.ENTRY,
          entityId: entry.id,
          entityCode: entry.code,
          branchId: entry.branchId,
          actor: by,
          params: { code: entry.code, reasonSuffix: reasonSuffix(reason) },
          changes: [
            {
              field: 'cashIssued',
              label: 'Đã chi',
              from: 'Không',
              to: 'Có',
              type: 'field_changed',
              detail: { from: false, to: true },
            },
          ],
          metadata: {
            batchId,
            approvalRequestId,
            fundTransactionId: row?.id ?? null,
            fundTransactionCode: row?.code ?? null,
          },
        }));
      }
      return entries.length;
    });
  }

  // Approval tuần bị thu hồi sau khi duyệt: rút lại các bút toán đã tự ghi.
  async revertApprovedBatch(
    tx: Prisma.TransactionClient,
    batchId: number,
    approvalRequestId: number,
    userId: number,
    actor?: AuditActor,
  ) {
    const by = actor ?? auditActor.system('LARK', LARK_TRIGGER, userId);
    const reason = 'Approval tuần bị thu hồi trên Lark';
    return this.withLog(tx, async (log) => {
      const rows = await tx.internalFundTransaction.findMany({
        where: {
          approvalRequestId,
          status: 'POSTED',
          sourceType: 'INTERNAL_FINANCE_ENTRY',
          entry: { weeklyBatchId: batchId },
        },
      });
      for (const row of rows) {
        const entryId = row.entryId;
        await this.releaseCancelledInto(tx, row, userId, reason, by, log);
        if (entryId) {
          const before = this.audit
            ? await tx.internalFinanceEntry.findUnique({
                where: { id: entryId },
                select: {
                  code: true,
                  branchId: true,
                  cashIssuedAt: true,
                  cashIssuedBy: true,
                  cashIssuedReason: true,
                },
              })
            : null;
          await tx.internalFinanceEntry.update({
            where: { id: entryId },
            data: {
              cashIssued: false,
              cashIssuedAt: null,
              cashIssuedBy: null,
              cashIssuedReason: null,
            },
          });
          this.record(log, () => ({
            action: 'FIN_ENTRY_CASH_ISSUE_REVERT',
            entityType: FINANCE_AUDIT_ENTITY.ENTRY,
            entityId: entryId,
            entityCode: before?.code ?? null,
            branchId: before?.branchId ?? row.branchId,
            actor: by,
            params: {
              code: before?.code ?? `#${entryId}`,
              reasonSuffix: reasonSuffix(reason),
            },
            changes: [
              {
                field: 'cashIssued',
                label: 'Đã chi',
                from: 'Có',
                to: 'Không',
                type: 'field_changed',
                detail: { from: true, to: false },
              },
            ],
            snapshot: {
              lines: [
                {
                  label: 'Đã chi lúc',
                  value: formatDate(before?.cashIssuedAt),
                },
                {
                  label: 'Lý do Đã chi',
                  value: before?.cashIssuedReason || '—',
                },
              ],
              cashIssuedAt: before?.cashIssuedAt ?? null,
              cashIssuedBy: before?.cashIssuedBy ?? null,
              cashIssuedReason: before?.cashIssuedReason ?? null,
            },
            metadata: {
              batchId,
              approvalRequestId,
              fundTransactionId: row.id,
              fundTransactionCode: row.code,
            },
          }));
        }
      }
      return rows.length;
    });
  }

  /**
   * `skipBranchIds`: chuyển tiền giữa 2 quỹ mà một bên duyệt trước ngày quỹ đó
   * lên POS (sổ quỹ Lark đã ghi bên đó): chỉ ghi bên còn lại.
   * `auditActor`: mặc định là hệ thống (Lark Approval) thay người tạo đơn.
   */
  async applyApproval(
    tx: Prisma.TransactionClient,
    request: FundApprovalData,
    options: { skipBranchIds?: number[]; auditActor?: AuditActor } = {},
  ) {
    if (
      !['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
        request.sourceType || '',
      )
    )
      return;
    const by =
      options.auditActor ??
      auditActor.system('LARK', LARK_TRIGGER, request.createdById ?? null);
    return this.withLog(tx, (log) =>
      this.applyApprovalInto(tx, request, options.skipBranchIds || [], by, log),
    );
  }

  private async applyApprovalInto(
    tx: Prisma.TransactionClient,
    request: FundApprovalData,
    skip: number[],
    by: AuditActor,
    log: AuditLog,
  ) {
    const transfer =
      request.sourceType === 'INTERNAL_FUND_TRANSFER'
        ? await tx.internalFundTransfer.findUnique({
            where: { id: request.sourceId || 0 },
          })
        : null;
    if (request.sourceType === 'INTERNAL_FUND_TRANSFER' && !transfer) {
      throw new BadRequestException('Approval chưa gắn giao dịch chuyển tiền');
    }
    if (!transfer && (!request.branchId || !request.createdById))
      throw new BadRequestException('Approval thiếu chi nhánh/người tạo');
    const branches = transfer
      ? [transfer.sourceBranchId, transfer.destinationBranchId]
      : [request.branchId];
    await this.lock(
      tx,
      branches.filter((id): id is number => typeof id === 'number'),
    );
    if (request.status !== 'APPROVED') {
      if (
        transfer &&
        transfer.status !== 'POSTED' &&
        transfer.status !== 'CANCELLED'
      ) {
        const status = request.status === 'PENDING' ? 'PENDING' : 'REJECTED';
        await tx.internalFundTransfer.update({
          where: { id: transfer.id },
          data: { status },
        });
        if (transfer.status !== status)
          this.record(log, () =>
            this.transferStatusEntry(transfer, status, by, request.id),
          );
      }
      return;
    }
    if (transfer) {
      const current = await tx.internalFundTransfer.findUnique({
        where: { id: transfer.id },
      });
      if (!current || ['CANCELLED', 'POSTED'].includes(current.status)) return;
      await tx.internalFundTransfer.update({
        where: { id: current.id },
        data: { approvalRequestId: request.id },
      });
      const legs = (
        [
          [current.sourceBranchId, 'TRANSFER_OUT'],
          [current.destinationBranchId, 'TRANSFER_IN'],
        ] as const
      ).filter(([branchId]) => !skip.includes(branchId));
      for (const [branchId, type] of legs) {
        const row = await tx.internalFundTransaction.create({
          data: {
            code: this.code(type),
            sourceKey: `TRANSFER:${current.id}:${type}`,
            branchId,
            transactionType: type,
            amount: current.amount,
            occurredAt: current.occurredAt,
            description: current.description,
            sourceType: 'INTERNAL_FUND_TRANSFER',
            sourceId: String(current.id),
            approvalRequestId: request.id,
            transferId: current.id,
            status: 'POSTED',
            createdBy: current.createdBy,
          },
        });
        this.record(log, () => this.fundPostEntry(row, by));
      }
      await tx.internalFundTransfer.update({
        where: { id: current.id },
        data: { status: 'POSTED' },
      });
      this.record(log, () =>
        this.transferStatusEntry(current, 'POSTED', by, request.id),
      );
      for (const [branchId] of legs)
        await this.invalidateClosingsInto(
          tx,
          branchId,
          current.occurredAt,
          log,
          `chuyển quỹ ${current.code}`,
          by,
        );
      return;
    }
    const key = `RECEIPT:${request.id}`;
    if (
      await tx.internalFundTransaction.findUnique({ where: { sourceKey: key } })
    )
      return;
    const snapshot = request.formSnapshot as { form?: unknown } | null;
    const form = Array.isArray(snapshot?.form)
      ? (snapshot.form as unknown[])
      : [];
    const value = (id: string): unknown => {
      const item = form.find(
        (row) =>
          row &&
          typeof row === 'object' &&
          (row as Record<string, unknown>).id === id,
      );
      return item && typeof item === 'object'
        ? (item as Record<string, unknown>).value
        : undefined;
    };
    const amount = new Prisma.Decimal(String(value(RECEIPT_FIELD_IDS.amount)));
    if (!amount.isPositive() || !request.branchId || !request.createdById)
      throw new BadRequestException('Approval thiếu tiền hoặc chi nhánh');
    const date = fundDayStart(String(value(RECEIPT_FIELD_IDS.date)));
    const description = value(RECEIPT_FIELD_IDS.description);
    const row = await tx.internalFundTransaction.create({
      data: {
        code: this.code('THU'),
        sourceKey: key,
        branchId: request.branchId,
        transactionType: 'RECEIPT',
        amount,
        occurredAt: date,
        description: typeof description === 'string' ? description : '',
        sourceType: 'INTERNAL_FUND_RECEIPT',
        sourceId: String(request.id),
        approvalRequestId: request.id,
        status: 'POSTED',
        createdBy: request.createdById,
      },
    });
    this.record(log, () => this.fundPostEntry(row, by));
    // Late approvals preserve the captured closing and flag it for reconciliation.
    await this.invalidateClosingsInto(
      tx,
      request.branchId,
      date,
      log,
      `thu quỹ ${row.code}`,
      by,
    );
  }

  private transferStatusEntry(
    transfer: {
      id: number;
      code: string;
      status: string;
      sourceBranchId: number;
      amount: Prisma.Decimal;
    },
    status: string,
    actor: AuditActor,
    approvalRequestId: number,
  ): FinanceAuditEntry {
    return {
      action: 'FIN_FUND_TRANSFER_STATUS',
      entityType: FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
      entityId: transfer.id,
      entityCode: transfer.code,
      branchId: transfer.sourceBranchId,
      actor,
      params: {
        code: transfer.code,
        statusLabel: fundTransferStatusLabel(status),
      },
      changes: this.statusChange(
        FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
        'status',
        transfer.status,
        status,
      ),
      metadata: {
        approvalRequestId,
        statusBefore: transfer.status,
        amount: Number(transfer.amount),
      },
    };
  }

  // Ghi quỹ cho nguồn không qua Approval của POS (tiền mặt kho, Sepay, đơn Lark).
  async postSystemTransaction(
    tx: Prisma.TransactionClient,
    input: SystemFundTransactionInput,
  ) {
    return this.withLog(tx, (log) =>
      this.postSystemTransactionInto(tx, input, log),
    );
  }

  private async postSystemTransactionInto(
    tx: Prisma.TransactionClient,
    input: SystemFundTransactionInput,
    log: AuditLog,
  ) {
    await this.lock(tx, [input.branchId]);
    const existing = await tx.internalFundTransaction.findUnique({
      where: { sourceKey: input.sourceKey },
    });
    if (existing) return existing;
    const amount = new Prisma.Decimal(String(input.amount));
    if (!amount.isPositive())
      throw new BadRequestException('Số tiền ghi quỹ phải lớn hơn 0');
    if (input.assertOpen)
      await this.assertOpen(tx, input.branchId, input.occurredAt, input.adjust);
    const row = await tx.internalFundTransaction.create({
      data: {
        code: this.code(input.codeKind),
        sourceKey: input.sourceKey,
        branchId: input.branchId,
        transactionType: input.transactionType,
        amount,
        occurredAt: input.occurredAt,
        description: input.description || '',
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        entryId: input.entryId,
        approvalRequestId: input.approvalRequestId,
        status: 'POSTED',
        createdBy: input.userId,
      },
    });
    const by = input.auditActor ?? auditActor.user(input.userId);
    this.record(log, () => this.fundPostEntry(row, by));
    await this.invalidateClosingsInto(
      tx,
      input.branchId,
      input.occurredAt,
      log,
      `ghi dòng quỹ ${row.code}`,
      by,
    );
    return row;
  }

  // Đơn PHIẾU CHI tạo trên Lark: duyệt thì trừ quỹ, thu hồi sau duyệt thì hủy.
  applyPaymentVoucher(
    tx: Prisma.TransactionClient,
    request: LarkCashRequest,
    actor?: AuditActor,
  ) {
    return this.applyLarkCashExpense(
      tx,
      request,
      {
        keyPrefix: 'PAYMENT_VOUCHER',
        sourceType: FUND_SOURCE_TYPE.LARK_PAYMENT_VOUCHER,
        label: 'PHIẾU CHI',
        fallbackDescription: 'Phiếu chi Lark',
      },
      actor,
    );
  }

  // Đơn TẠM ỨNG LƯƠNG chi tiền mặt từ quỹ: duyệt thì trừ quỹ, thu hồi thì hủy.
  applySalaryAdvance(
    tx: Prisma.TransactionClient,
    request: LarkCashRequest,
    actor?: AuditActor,
  ) {
    return this.applyLarkCashExpense(
      tx,
      request,
      {
        keyPrefix: 'SALARY_ADVANCE',
        sourceType: FUND_SOURCE_TYPE.LARK_SALARY_ADVANCE,
        label: 'TẠM ỨNG LƯƠNG',
        fallbackDescription: 'Tạm ứng lương',
      },
      actor,
    );
  }

  private async applyLarkCashExpense(
    tx: Prisma.TransactionClient,
    request: LarkCashRequest,
    kind: {
      keyPrefix: string;
      sourceType: string;
      label: string;
      fallbackDescription: string;
    },
    actor?: AuditActor,
  ) {
    const by =
      actor ?? auditActor.system('LARK', LARK_TRIGGER, request.createdById);
    const key = `${kind.keyPrefix}:${request.id}`;
    if (request.status === 'REVERTED') {
      await this.cancelBySource(
        tx,
        key,
        request.createdById,
        `Đơn ${kind.label} bị thu hồi trên Lark`,
        by,
      );
      return;
    }
    if (request.status !== 'APPROVED') return;
    const cash = (request.formSnapshot as { metadata?: any } | null)?.metadata;
    if (!request.branchId || !cash?.amount)
      throw new BadRequestException(
        `Đơn ${kind.label} thiếu quỹ hoặc số tiền mặt`,
      );
    await this.postSystemTransaction(tx, {
      branchId: request.branchId,
      transactionType: 'EXPENSE',
      codeKind: 'CHI',
      amount: cash.amount,
      occurredAt: request.completedAt || new Date(),
      description: cash.description || kind.fallbackDescription,
      sourceType: kind.sourceType,
      sourceKey: key,
      sourceId: String(request.id),
      approvalRequestId: request.id,
      userId: request.createdById,
      auditActor: by,
    });
  }

  // Hủy và nhả sourceKey/entryId để nguồn có thể ghi quỹ lại.
  async cancelBySource(
    tx: Prisma.TransactionClient,
    sourceKey: string,
    userId: number,
    reason: string,
    actor?: AuditActor,
  ) {
    const row = await tx.internalFundTransaction.findUnique({
      where: { sourceKey },
    });
    if (!row) return null;
    await this.lock(tx, [row.branchId]);
    return this.releaseCancelled(tx, row, userId, reason, actor);
  }

  async releaseCancelled(
    tx: Prisma.TransactionClient,
    row: FundRowRef,
    userId: number,
    reason: string,
    actor?: AuditActor,
  ) {
    const by = actor ?? auditActor.user(userId);
    return this.withLog(tx, (log) =>
      this.releaseCancelledInto(tx, row, userId, reason, by, log),
    );
  }

  private async releaseCancelledInto(
    tx: Prisma.TransactionClient,
    row: FundRowRef,
    userId: number,
    reason: string,
    by: AuditActor,
    log: AuditLog,
  ) {
    // Dòng trước khi hủy (entryId/sourceKey bị nhả ra) để ghi lịch sử: chụp
    // lại trước khi update.
    const sourceKeyBefore = row.sourceKey;
    const before: InternalFundTransaction | null = this.audit
      ? 'entryId' in row && 'code' in row && 'amount' in row
        ? { ...(row as InternalFundTransaction) }
        : await tx.internalFundTransaction.findUnique({
            where: { id: row.id },
          })
      : null;
    const updated = await tx.internalFundTransaction.update({
      where: { id: row.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancelReason: reason,
        entryId: null,
        sourceKey: `${row.sourceKey}:CANCELLED:${row.id}`,
      },
    });
    this.record(log, () => {
      const source = before ?? updated;
      if (!source) return null;
      return {
        action: 'FIN_FUND_TXN_CANCEL',
        entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
        entityId: row.id,
        entityCode: source.code,
        branchId: row.branchId,
        actor: by,
        params: {
          code: source.code,
          amount: Number(source.amount),
          reasonSuffix: reasonSuffix(reason),
        },
        changes: this.statusChange(
          FINANCE_AUDIT_ENTITY.FUND_TXN,
          'status',
          before?.status ?? 'POSTED',
          'CANCELLED',
        ),
        snapshot: {
          lines: [
            ...fundRowLines(source),
            { label: 'Lý do hủy', value: reason || '—' },
          ],
          before: before ?? undefined,
        },
        metadata: {
          entryIdBefore: before?.entryId ?? null,
          sourceKeyBefore,
          sourceType: source.sourceType,
          transactionType: source.transactionType,
          approvalRequestId: source.approvalRequestId ?? null,
          transferId: source.transferId ?? null,
        },
      };
    });
    await this.invalidateClosingsInto(
      tx,
      row.branchId,
      row.occurredAt,
      log,
      `hủy dòng quỹ ${before?.code ?? updated?.code ?? row.id}`,
      by,
    );
    return updated;
  }

  async balance(tx: Prisma.TransactionClient, branchId: number, date: string) {
    const start = fundDayStart(date);
    const end = new Date(start.getTime() + 86400000);
    const openingGroups = await tx.internalFundTransaction.groupBy({
      by: ['transactionType'],
      where: { branchId, status: 'POSTED', occurredAt: { lt: start } },
      _sum: { amount: true },
    });
    const rows = await tx.internalFundTransaction.findMany({
      where: {
        branchId,
        status: 'POSTED',
        occurredAt: { gte: start, lt: end },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    let opening = new Prisma.Decimal(0),
      receipt = new Prisma.Decimal(0),
      expense = new Prisma.Decimal(0);
    for (const group of openingGroups) {
      const amount = group._sum.amount || new Prisma.Decimal(0);
      opening = ['RECEIPT', 'TRANSFER_IN'].includes(group.transactionType)
        ? opening.plus(amount)
        : opening.minus(amount);
    }
    for (const row of rows) {
      const incoming = ['RECEIPT', 'TRANSFER_IN'].includes(row.transactionType);
      if (incoming) receipt = receipt.plus(row.amount);
      else expense = expense.plus(row.amount);
    }
    return {
      opening,
      receipt,
      expense,
      closing: opening.plus(receipt).minus(expense),
      rows,
    };
  }

  code(kind: string) {
    return `QF-${kind}-${randomUUID()}`;
  }
}
