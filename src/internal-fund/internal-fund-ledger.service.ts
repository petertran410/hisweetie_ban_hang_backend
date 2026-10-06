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
  ) {
    await this.lock(tx, [entry.branchId]);
    const current = await tx.internalFinanceEntry.findUnique({
      where: { id: entry.id },
      include: { weeklyBatch: { include: { approvalRequest: true } } },
    });
    if (!current || current.direction !== 'EXPENSE')
      throw new BadRequestException('Không tìm thấy khoản chi');
    const key = `EXPENSE:${current.id}`;
    const existing = await tx.internalFundTransaction.findUnique({
      where: { sourceKey: key },
    });
    if (existing) return existing;
    if (current.cashFlowId || current.cashIssued) {
      throw new BadRequestException(
        'Khoản chi lịch sử đã ghi nhận; không tự động ghi lại vào quỹ mới',
      );
    }
    if (
      current.status !== 'APPROVED' ||
      current.weeklyBatch?.status !== 'APPROVED' ||
      !current.weeklyBatch.approvalRequestId ||
      current.weeklyBatch.approvalRequest?.status !== 'APPROVED'
    ) {
      throw new BadRequestException(
        'Khoản chi chỉ được ghi sổ sau khi Approval tuần được duyệt',
      );
    }
    await this.assertOpen(tx, current.branchId, current.occurredAt, adjust);
    const row = await tx.internalFundTransaction.create({
      data: {
        code: this.code('CHI'),
        sourceKey: key,
        branchId: current.branchId,
        entryId: current.id,
        transactionType: 'EXPENSE',
        amount: current.amount,
        occurredAt: current.occurredAt,
        description: current.description || current.code,
        sourceType: 'INTERNAL_FINANCE_ENTRY',
        sourceId: String(current.id),
        approvalRequestId: current.weeklyBatch.approvalRequestId,
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
      },
    });
    if (adjust)
      await this.invalidateClosings(tx, current.branchId, current.occurredAt);
    return row;
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
