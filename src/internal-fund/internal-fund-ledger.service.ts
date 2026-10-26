import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RECEIPT_FIELD_IDS } from '../approval-lifecycle/approval-lifecycle.constants';

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
  LARK_PAYMENT_VOUCHER: 'LARK_PAYMENT_VOUCHER',
  // Bút toán lịch sử đồng bộ từ sổ quỹ cũ: chỉ đọc trên POS.
  LEDGER_HISTORY: 'LEDGER_HISTORY',
} as const;

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
}

@Injectable()
export class InternalFundLedgerService {
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

  async invalidateClosings(
    tx: Prisma.TransactionClient,
    branchId: number,
    date: Date,
  ) {
    await tx.internalFundDailyClosing.updateMany({
      where: {
        branchId,
        closingDate: { gte: fundClosingDate(date) },
        closedAt: { not: null },
      },
      data: { reconciliationStatus: 'PENDING' },
    });
  }

  async issueExpense(
    tx: Prisma.TransactionClient,
    entry: { id: number; branchId: number },
    userId: number,
    adjust = false,
    manualReason?: string,
  ) {
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
    // Tiền ra khỏi quỹ vào lúc tick Đã chi, không phải ngày của phiếu chi.
    const issuedAt = new Date();
    if (approved) {
      await this.assertOpen(tx, current.branchId, issuedAt, adjust);
      return this.postExpenseRow(tx, current, userId, {
        approvalRequestId: current.weeklyBatch!.approvalRequestId!,
        issuedAt,
        invalidate: adjust,
      });
    }

    // Chi ngoài Approval tuần: bắt buộc có lý do, phiếu rời khỏi batch chưa gửi.
    const reason = manualReason?.trim();
    if (!reason) {
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
      await this.detachFromBatch(tx, current);
    }
    await this.assertOpen(tx, current.branchId, issuedAt, adjust);
    return this.postExpenseRow(tx, current, userId, {
      reason,
      issuedAt,
      invalidate: adjust,
    });
  }

  // Rút phiếu khỏi batch tuần chưa gửi Approval và tính lại tổng tiền.
  async detachFromBatch(
    tx: Prisma.TransactionClient,
    entry: { id: number; weeklyBatchId: number | null },
  ) {
    const batchId = entry.weeklyBatchId;
    if (!batchId) return;
    await tx.internalFinanceEntry.update({
      where: { id: entry.id },
      data: { weeklyBatchId: null },
    });
    const rest = await tx.internalFinanceEntry.aggregate({
      where: { weeklyBatchId: batchId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    if (!rest._count._all) {
      await tx.internalFinanceWeeklyBatch.delete({ where: { id: batchId } });
      return;
    }
    await tx.internalFinanceWeeklyBatch.update({
      where: { id: batchId },
      data: { totalAmount: rest._sum.amount || 0 },
    });
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
      /** Ngày tiền ra khỏi quỹ: ngày duyệt Approval hoặc ngày tick Đã chi. */
      issuedAt: Date;
      invalidate?: boolean;
    },
  ) {
    // Phiếu đồng bộ từ Lark đã có dòng trừ quỹ trong sổ quỹ Lark: chỉ tick Đã
    // chi theo luật POS, không trừ quỹ lần nữa.
    if (isLarkLedgerRecorded(current)) {
      await tx.internalFinanceEntry.update({
        where: { id: current.id },
        data: {
          cashIssued: true,
          cashIssuedAt: options.issuedAt,
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
        occurredAt: options.issuedAt,
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
      await this.invalidateClosings(tx, current.branchId, options.issuedAt);
    return row;
  }

  // Approval tuần được duyệt: mọi phiếu trong batch tự ghi quỹ và thành Đã chi.
  async issueApprovedBatch(
    tx: Prisma.TransactionClient,
    batchId: number,
    approvalRequestId: number,
    userId: number,
  ) {
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
    // Ghi quỹ vào ngày Approval duyệt — ngày tiền thật sự chi ra.
    const request = await tx.approvalRequest.findUnique({
      where: { id: approvalRequestId },
      select: { completedAt: true },
    });
    const issuedAt = request?.completedAt ?? new Date();
    for (const entry of entries)
      await this.postExpenseRow(tx, entry, userId, {
        approvalRequestId,
        issuedAt,
        invalidate: true,
      });
    return entries.length;
  }

  // Approval tuần bị thu hồi sau khi duyệt: rút lại các bút toán đã tự ghi.
  async revertApprovedBatch(
    tx: Prisma.TransactionClient,
    batchId: number,
    approvalRequestId: number,
    userId: number,
  ) {
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
      await this.releaseCancelled(
        tx,
        row,
        userId,
        'Approval tuần bị thu hồi trên Lark',
      );
      if (entryId)
        await tx.internalFinanceEntry.update({
          where: { id: entryId },
          data: {
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
          },
        });
    }
    return rows.length;
  }

  async applyApproval(tx: Prisma.TransactionClient, request: FundApprovalData) {
    if (
      !['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
        request.sourceType || '',
      )
    )
      return;
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
        await tx.internalFundTransfer.update({
          where: { id: transfer.id },
          data: {
            status: request.status === 'PENDING' ? 'PENDING' : 'REJECTED',
          },
        });
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
      for (const [branchId, type] of [
        [current.sourceBranchId, 'TRANSFER_OUT'],
        [current.destinationBranchId, 'TRANSFER_IN'],
      ] as const) {
        await tx.internalFundTransaction.create({
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
      }
      await tx.internalFundTransfer.update({
        where: { id: current.id },
        data: { status: 'POSTED' },
      });
      for (const branchId of [
        current.sourceBranchId,
        current.destinationBranchId,
      ])
        await this.invalidateClosings(tx, branchId, current.occurredAt);
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
    await tx.internalFundTransaction.create({
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
    // Late approvals preserve the captured closing and flag it for reconciliation.
    await this.invalidateClosings(tx, request.branchId, date);
  }

  // Ghi quỹ cho nguồn không qua Approval của POS (tiền mặt kho, Sepay, đơn Lark).
  async postSystemTransaction(
    tx: Prisma.TransactionClient,
    input: SystemFundTransactionInput,
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
      await this.assertOpen(
        tx,
        input.branchId,
        input.occurredAt,
        input.adjust,
      );
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
    await this.invalidateClosings(tx, input.branchId, input.occurredAt);
    return row;
  }

  // Đơn PHIẾU CHI tạo trên Lark: duyệt thì trừ quỹ, thu hồi sau duyệt thì hủy.
  async applyPaymentVoucher(
    tx: Prisma.TransactionClient,
    request: {
      id: number;
      status: string;
      branchId: number | null;
      createdById: number;
      completedAt: Date | null;
      formSnapshot: unknown;
    },
  ) {
    const key = `PAYMENT_VOUCHER:${request.id}`;
    if (request.status === 'REVERTED') {
      await this.cancelBySource(
        tx,
        key,
        request.createdById,
        'Đơn PHIẾU CHI bị thu hồi trên Lark',
      );
      return;
    }
    if (request.status !== 'APPROVED') return;
    const cash = (request.formSnapshot as { metadata?: any } | null)?.metadata;
    if (!request.branchId || !cash?.amount)
      throw new BadRequestException('Đơn PHIẾU CHI thiếu quỹ hoặc số tiền mặt');
    await this.postSystemTransaction(tx, {
      branchId: request.branchId,
      transactionType: 'EXPENSE',
      codeKind: 'CHI',
      amount: cash.amount,
      occurredAt: request.completedAt || new Date(),
      description: cash.description || 'Phiếu chi Lark',
      sourceType: FUND_SOURCE_TYPE.LARK_PAYMENT_VOUCHER,
      sourceKey: key,
      sourceId: String(request.id),
      approvalRequestId: request.id,
      userId: request.createdById,
    });
  }

  // Hủy và nhả sourceKey/entryId để nguồn có thể ghi quỹ lại.
  async cancelBySource(
    tx: Prisma.TransactionClient,
    sourceKey: string,
    userId: number,
    reason: string,
  ) {
    const row = await tx.internalFundTransaction.findUnique({
      where: { sourceKey },
    });
    if (!row) return null;
    await this.lock(tx, [row.branchId]);
    return this.releaseCancelled(tx, row, userId, reason);
  }

  async releaseCancelled(
    tx: Prisma.TransactionClient,
    row: { id: number; branchId: number; occurredAt: Date; sourceKey: string },
    userId: number,
    reason: string,
  ) {
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
    await this.invalidateClosings(tx, row.branchId, row.occurredAt);
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
