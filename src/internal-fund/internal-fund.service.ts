import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  InternalFundDailyClosing,
  InternalFundTransaction,
  InternalFundTransfer,
} from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceAccessService } from '../auth/finance-access.service';
import { ApprovalLifecycleService } from '../approval-lifecycle/approval-lifecycle.service';
import {
  INTERNAL_FINANCE_STATUS,
  LARK_APPROVAL_SOURCE_TYPE,
} from '../internal-finance/internal-finance.constants';
import {
  FUEL_ADVANCE_ISSUE_BLOCK,
  isFuelAdvanceEntry,
} from '../internal-finance/fuel-advance';
import {
  INTERNAL_FUND_SCOPE_BRANCHES,
  type InternalFundActor,
  type InternalFundPermissionAction,
} from './internal-fund.constants';
import {
  CancelInternalFundTransferDto,
  CloseInternalFundDayDto,
  CreateInternalFundReceiptApprovalDto,
  InternalFundAttachmentDto,
  InternalFundExportQueryDto,
  InternalFundQueryDto,
  UpdateInternalFundTransactionDto,
} from './dto/internal-fund.dto';
import {
  fundClosingDate,
  fundDateKey,
  fundDayStart,
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from './internal-fund-ledger.service';
import {
  buildFundReceiptForm,
  fundCashSourceLabel,
} from './internal-fund-template.registry';
import {
  FUND_EXPORT_SELECT,
  fundExportColumns,
  writeFundExport,
} from './internal-fund-export';
import { activeAttachments } from '../internal-finance/entry-files';
import {
  FINANCE_AUDIT_ENTITY,
  FinanceAuditService,
  approvalAuditRef,
  auditActor,
  branchLabel,
  entryKindLabel,
  entryStatusLabel,
  formatDate,
  formatMoney,
  fundSourceLabel,
  fundTransferStatusLabel,
  fundTxnTypeLabel,
  reasonSuffix,
  statusLabel,
  type AuditActor,
  type FinanceAuditChange,
  type FinanceAuditEntityType,
  type FinanceAuditEntry,
} from '../finance-audit';

// Trạng thái Đã chi của phiếu trước/sau khi ghi quỹ (lịch sử Đã chi).
const CASH_ISSUE_SELECT = {
  id: true,
  code: true,
  category: true,
  branchId: true,
  amount: true,
  occurredAt: true,
  status: true,
  weeklyBatchId: true,
  cashIssued: true,
  cashIssuedAt: true,
  cashIssuedBy: true,
  cashIssuedReason: true,
} satisfies Prisma.InternalFinanceEntrySelect;

/** Dòng chi tiết của một dòng quỹ trong lịch sử (giống sổ quỹ). */
function fundTxnLines(row: InternalFundTransaction) {
  return [
    { label: 'Quỹ', value: branchLabel(row.branchId) },
    { label: 'Loại', value: fundTxnTypeLabel(row.transactionType) },
    { label: 'Số tiền', value: formatMoney(row.amount) },
    { label: 'Ngày ghi quỹ', value: formatDate(row.occurredAt) },
    { label: 'Nội dung', value: row.description || '—' },
    { label: 'Nguồn', value: fundSourceLabel(row.sourceType) },
  ];
}

/** Dòng chi tiết của một yêu cầu chuyển quỹ trong lịch sử. */
function fundTransferLines(transfer: InternalFundTransfer) {
  return [
    { label: 'Từ quỹ', value: branchLabel(transfer.sourceBranchId) },
    { label: 'Đến quỹ', value: branchLabel(transfer.destinationBranchId) },
    { label: 'Số tiền', value: formatMoney(transfer.amount) },
    { label: 'Ngày chuyển', value: formatDate(transfer.occurredAt) },
    { label: 'Nội dung', value: transfer.description || '—' },
  ];
}

const cashIssuedChange = (from: boolean, to: boolean): FinanceAuditChange => ({
  field: 'cashIssued',
  label: 'Đã chi',
  from: from ? 'Có' : 'Không',
  to: to ? 'Có' : 'Không',
  type: 'field_changed',
  detail: { from, to },
});

@Injectable()
export class InternalFundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access_: FinanceAccessService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly ledger: InternalFundLedgerService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  /** Thay đổi trạng thái một trường (from/to hiển thị theo loại bản ghi). */
  private statusChange(
    entityType: FinanceAuditEntityType,
    from: unknown,
    to: unknown,
    field = 'status',
  ): FinanceAuditChange[] {
    return this.financeAudit.diff(
      entityType,
      { [field]: from },
      { [field]: to },
      [field],
    );
  }

  /** Lịch sử hủy dòng quỹ bằng update trực tiếp (không qua releaseCancelled). */
  private fundTxnCancelEntry(
    row: InternalFundTransaction,
    reason: string,
    actor: AuditActor,
    metadata: Record<string, unknown> = {},
  ): FinanceAuditEntry {
    return {
      action: 'FIN_FUND_TXN_CANCEL',
      entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
      entityId: row.id,
      entityCode: row.code,
      branchId: row.branchId,
      actor,
      params: {
        code: row.code,
        amount: Number(row.amount),
        reasonSuffix: reasonSuffix(reason),
      },
      changes: this.statusChange(
        FINANCE_AUDIT_ENTITY.FUND_TXN,
        row.status,
        'CANCELLED',
      ),
      snapshot: {
        lines: [
          ...fundTxnLines(row),
          { label: 'Lý do hủy', value: reason.trim() || '—' },
        ],
        before: row,
      },
      metadata: {
        sourceKey: row.sourceKey,
        sourceType: row.sourceType,
        transactionType: row.transactionType,
        entryId: row.entryId ?? null,
        approvalRequestId: row.approvalRequestId ?? null,
        transferId: row.transferId ?? null,
        ...metadata,
      },
    };
  }

  private isFundBranch(branchId: number) {
    return Object.values(INTERNAL_FUND_SCOPE_BRANCHES).some((ids) =>
      (ids as readonly number[]).includes(branchId),
    );
  }

  // Quyền theo vai trò × chi nhánh; chi nhánh phải thuộc danh sách của user.
  private async has(
    userId: number,
    branchId: number,
    action: InternalFundPermissionAction,
  ) {
    if (!this.isFundBranch(branchId)) return false;
    return this.access_.can(userId, branchId, `internal_fund:${action}`);
  }

  async assertPermission(
    userId: number,
    branchId: number,
    action: InternalFundPermissionAction,
  ) {
    if (!(await this.has(userId, branchId, action)))
      throw new ForbiddenException(
        `Thiếu quyền internal_fund:${action} cho chi nhánh`,
      );
  }

  async lockBranch(tx: Prisma.TransactionClient, branchIds: number[]) {
    await this.ledger.lock(tx, branchIds);
  }

  private async branches(query: InternalFundQueryDto, user: InternalFundActor) {
    const branches: number[] = [];
    for (const id of Object.values(INTERNAL_FUND_SCOPE_BRANCHES).flat()) {
      if (await this.has(user.id, id, 'view')) branches.push(id);
    }
    if (
      !branches.length ||
      (query.branchId && !branches.includes(query.branchId))
    )
      throw new ForbiddenException('Không có quyền xem quỹ chi nhánh');
    return query.branchId ? [query.branchId] : branches;
  }

  private approvalMetadata(request: any) {
    const snapshot =
      request.formSnapshot &&
      typeof request.formSnapshot === 'object' &&
      !Array.isArray(request.formSnapshot)
        ? request.formSnapshot
        : {};
    const metadata =
      snapshot.metadata &&
      typeof snapshot.metadata === 'object' &&
      !Array.isArray(snapshot.metadata)
        ? snapshot.metadata
        : {};
    const form = Array.isArray(snapshot.form) ? snapshot.form : [];
    const value = (id: string) => {
      const item = form.find(
        (row: any) => row && typeof row === 'object' && row.id === id,
      );
      return item?.value;
    };
    const attachments = Array.isArray((metadata as any).attachments)
      ? (metadata as any).attachments
      : Array.isArray(value('widget17321767077360001'))
        ? (value('widget17321767077360001') as string[]).map((code) => ({
            code,
            url: null,
            name: null,
            type: 'attachment',
          }))
        : [];

    return {
      classification:
        (metadata as any).classification || value('widget17321740179360001'),
      payer: (metadata as any).payer || value('widget17321810360090001'),
      occurredAt:
        (metadata as any).occurredAt || value('widget17321631178550001'),
      method: (metadata as any).method || 'cash',
      cashSource:
        (metadata as any).cashSource || value('widget17730449889490001'),
      cashSourceLabel: fundCashSourceLabel(
        (metadata as any).cashSource || value('widget17730449889490001'),
      ),
      amount: (metadata as any).amount || value('widget17321629138780001'),
      description:
        (metadata as any).description || value('widget17321628654580001') || '',
      from: (metadata as any).from || value('widget17863314165550001'),
      to: (metadata as any).to || value('widget17863314190270001'),
      tempAdvance:
        (metadata as any).tempAdvance || value('widget17780590040100001'),
      attachments: attachments.map((file: any) => ({
        code: String(file.code || ''),
        url: file.url ? String(file.url) : null,
        name: file.name ? String(file.name) : null,
        type: file.type ? String(file.type) : null,
      })),
    };
  }

  async access(user: InternalFundActor) {
    const result: Record<number, string[]> = {};
    const actions: InternalFundPermissionAction[] = [
      'view',
      'create_receipt',
      'transfer',
      'submit_approval',
      'mark_issued',
      'mark_received',
      'close',
      'cancel',
      'adjust',
    ];
    for (const id of Object.values(INTERNAL_FUND_SCOPE_BRANCHES).flat()) {
      result[id] = [];
      for (const action of actions)
        if (await this.has(user.id, id, action)) result[id].push(action);
    }
    return result;
  }

  async uploadFile(
    branchId: number,
    file: Express.Multer.File | undefined,
    userId: number,
  ) {
    await this.assertPermission(userId, branchId, 'create_receipt');
    await this.assertPermission(userId, branchId, 'submit_approval');
    return this.approvalLifecycle.uploadFile(file, 'attachment');
  }

  private transactionWhere(
    query: InternalFundQueryDto,
    branchIds: number[],
  ): Prisma.InternalFundTransactionWhereInput {
    return {
      branchId: { in: branchIds },
      status: query.status || 'POSTED',
      ...(query.transactionType
        ? { transactionType: query.transactionType }
        : {}),
      ...(query.direction
        ? {
            AND: [
              {
                transactionType: {
                  in:
                    query.direction === 'RECEIPT'
                      ? ['RECEIPT', 'TRANSFER_IN']
                      : ['EXPENSE', 'TRANSFER_OUT'],
                },
              },
            ],
          }
        : {}),
      ...(query.fromDate || query.toDate
        ? {
            occurredAt: {
              ...(query.fromDate ? { gte: fundDayStart(query.fromDate) } : {}),
              ...(query.toDate
                ? {
                    lt: new Date(
                      fundDayStart(query.toDate).getTime() + 86400000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              ...['code', 'description'].map((key) => ({
                [key]: { contains: query.search, mode: 'insensitive' },
              })),
              // Tìm theo mã phiếu gốc (TCNB-…) của dòng quỹ.
              {
                entry: {
                  code: { contains: query.search, mode: 'insensitive' },
                },
              },
            ] as Prisma.InternalFundTransactionWhereInput[],
          }
        : {}),
    };
  }

  private transactionOrderBy(
    query: InternalFundQueryDto,
  ): Prisma.InternalFundTransactionOrderByWithRelationInput[] {
    const direction = query.orderDirection === 'asc' ? 'asc' : 'desc';
    return query.orderBy === 'amount'
      ? [{ amount: direction }, { occurredAt: 'desc' }, { id: 'desc' }]
      : [{ occurredAt: direction }, { id: direction }];
  }

  async listTransactions(query: InternalFundQueryDto, user: InternalFundActor) {
    const branchIds = await this.branches(query, user);
    const where = this.transactionWhere(query, branchIds);
    const page = query.page || 1,
      limit = Math.min(query.limit || 50, 100);
    const orderBy = this.transactionOrderBy(query);
    const [data, total, sums] = await Promise.all([
      this.prisma.internalFundTransaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          branch: { select: { id: true, name: true } },
          transfer: true,
          approvalRequest: {
            select: { id: true, status: true, instanceCode: true },
          },
          // Phiếu gốc: quỹ ghi theo ngày tiền ra (vd. ngày duyệt Approval
          // tuần), phiếu giữ ngày chi thật để đối chiếu.
          entry: {
            select: {
              id: true,
              code: true,
              occurredAt: true,
              direction: true,
              category: true,
              sourceType: true,
              weeklyBatch: { select: { code: true } },
            },
          },
        },
      }),
      this.prisma.internalFundTransaction.count({ where }),
      this.prisma.internalFundTransaction.groupBy({
        by: ['transactionType'],
        where,
        _sum: { amount: true },
      }),
    ]);
    // Tổng của toàn bộ dòng khớp bộ lọc: tiền vào (thu, chuyển đến) và tiền ra.
    const sumOf = (types: string[]) =>
      sums
        .filter((row) => types.includes(row.transactionType))
        .reduce((sum, row) => sum + Number(row._sum.amount || 0), 0);
    const totals = {
      receipt: sumOf(['RECEIPT', 'TRANSFER_IN']),
      expense: sumOf(['EXPENSE', 'TRANSFER_OUT']),
    };
    return { data, total, page, limit, totals };
  }

  async exportTransactions(
    query: InternalFundExportQueryDto,
    user: InternalFundActor,
    res: Response,
    detail = false,
  ) {
    const branchIds = await this.branches(query, user);
    const where = this.transactionWhere(query, branchIds);
    const orderBy = this.transactionOrderBy(query);
    const columns = fundExportColumns(detail, query.columns);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=SoQuy_${detail ? 'ChiTiet' : 'TongQuan'}_${Date.now()}.xlsx`,
    );
    await writeFundExport(res, columns, detail, (skip, take) =>
      this.prisma.internalFundTransaction.findMany({
        where,
        orderBy,
        skip,
        take,
        select: FUND_EXPORT_SELECT,
      }),
    );
  }

  async summary(query: InternalFundQueryDto, user: InternalFundActor) {
    const branches = await this.branches(query, user);
    const date =
      query.fromDate ||
      new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const result: Array<{
      branchId: number;
      opening: string;
      receipt: string;
      expense: string;
      closing: string;
    }> = [];
    for (const branchId of branches) {
      const summary = await this.prisma.$transaction((tx) =>
        this.ledger.balance(tx, branchId, date),
      );
      result.push({
        branchId,
        opening: summary.opening.toString(),
        receipt: summary.receipt.toString(),
        expense: summary.expense.toString(),
        closing: summary.closing.toString(),
      });
    }
    return result;
  }

  async createReceiptApproval(
    dto: CreateInternalFundReceiptApprovalDto,
    userId: number,
  ) {
    await this.assertPermission(userId, dto.branchId, 'create_receipt');
    await this.assertPermission(userId, dto.branchId, 'submit_approval');
    const transfer = dto.classification === 'INTERNAL_TRANSFER';
    if (transfer) {
      await this.assertPermission(userId, dto.branchId, 'transfer');
      await this.assertPermission(
        userId,
        dto.destinationBranchId || 0,
        'transfer',
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { larkUserId: true },
    });
    if (!user?.larkUserId)
      throw new BadRequestException('Tài khoản chưa gắn larkUserId');
    const form = buildFundReceiptForm(dto, user.larkUserId);
    const previous = await this.prisma.approvalRequest.findUnique({
      where: { clientUuid: dto.clientUuid },
    });
    if (
      previous &&
      (previous.createdById !== userId ||
        previous.branchId !== dto.branchId ||
        previous.sourceType !==
          (transfer ? 'INTERNAL_FUND_TRANSFER' : 'INTERNAL_FUND_RECEIPT') ||
        JSON.stringify((previous.formSnapshot as { form?: unknown })?.form) !==
          JSON.stringify(form))
    ) {
      throw new BadRequestException('Mã yêu cầu đã dùng cho dữ liệu khác');
    }
    // Chuyển quỹ và đơn Approval của cùng một lần tạo dùng chung opId.
    const actor = auditActor.user(userId);
    let sourceId: number | undefined;
    if (transfer) {
      // Tạo chuyển quỹ và lịch sử trong cùng transaction; gửi lại cùng
      // clientUuid thì dùng bản ghi cũ, không ghi lịch sử lần nữa.
      const record = await this.prisma.$transaction(async (tx) => {
        const existed = await tx.internalFundTransfer.findUnique({
          where: { clientUuid: dto.clientUuid },
        });
        const saved = await tx.internalFundTransfer.upsert({
          where: { clientUuid: dto.clientUuid },
          update: {},
          create: {
            clientUuid: dto.clientUuid,
            code: this.ledger.code('CHUYEN'),
            sourceBranchId: dto.branchId,
            destinationBranchId: dto.destinationBranchId!,
            amount: dto.amount,
            occurredAt: new Date(dto.occurredAt),
            description: dto.description,
            status: 'PENDING',
            createdBy: userId,
          },
        });
        if (!existed)
          await this.financeAudit.write(tx, {
            action: 'FIN_FUND_TRANSFER_REQUEST',
            entityType: FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
            entityId: saved.id,
            entityCode: saved.code,
            branchId: saved.sourceBranchId,
            actor,
            params: {
              code: saved.code,
              amount: Number(saved.amount),
              fromBranch: branchLabel(saved.sourceBranchId),
              toBranch: branchLabel(saved.destinationBranchId),
            },
            snapshot: { lines: fundTransferLines(saved) },
            metadata: { clientUuid: saved.clientUuid },
          });
        return saved;
      });
      sourceId = record.id;
      if (record.status === 'CANCELLED')
        throw new BadRequestException('Yêu cầu chuyển tiền đã hủy');
      if (
        record.createdBy !== userId ||
        record.sourceBranchId !== dto.branchId ||
        record.destinationBranchId !== dto.destinationBranchId ||
        !record.amount.equals(dto.amount) ||
        record.occurredAt.getTime() !== new Date(dto.occurredAt).getTime()
      ) {
        throw new BadRequestException(
          'Mã chuyển tiền đã dùng cho dữ liệu khác',
        );
      }
    }
    const request = await this.approvalLifecycle.create(
      {
        kind: 'RECEIPT',
        branchId: dto.branchId,
        clientUuid: dto.clientUuid,
        sourceType: transfer
          ? 'INTERNAL_FUND_TRANSFER'
          : 'INTERNAL_FUND_RECEIPT',
        sourceId,
        form,
        metadata: {
          version: 1,
          classification: dto.classification || 'OTHER',
          payer: dto.payerOpenId || user.larkUserId,
          occurredAt: fundDateKey(dto.occurredAt),
          method: 'cash',
          cashSource: form.find((item) => item.id === 'widget17730449889490001')
            ?.value,
          amount: dto.amount,
          description: dto.description?.trim() || 'Thu quỹ nội bộ',
          attachments: (dto.attachmentFiles || []).map(
            (file: InternalFundAttachmentDto) => ({
              code: file.code,
              url: file.url || null,
              name: file.name || null,
              type: file.type || null,
            }),
          ),
          ...(dto.tempAdvance ? { tempAdvance: dto.tempAdvance } : {}),
          ...(transfer
            ? {
                destinationBranchId: dto.destinationBranchId,
              }
            : {}),
        },
      },
      userId,
      actor,
    );
    if (sourceId)
      await this.prisma.internalFundTransfer.update({
        where: { id: sourceId },
        data: { approvalRequestId: Number(request.id) },
      });
    return request;
  }

  async listApprovals(query: InternalFundQueryDto, user: InternalFundActor) {
    const branchIds = await this.branches(query, user);
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    const where: Prisma.ApprovalRequestWhereInput = {
      branchId: { in: branchIds },
      sourceType: { in: ['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'] },
      AND: [
        {
          OR: [
            { sourceType: 'INTERNAL_FUND_RECEIPT' },
            {
              sourceType: 'INTERNAL_FUND_TRANSFER',
              internalFundTransfers: {
                some: { destinationBranchId: { in: branchIds } },
              },
            },
          ],
        },
      ],
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.search) {
      (where.AND as Prisma.ApprovalRequestWhereInput[]).push({
        OR: [
          { instanceCode: { contains: query.search, mode: 'insensitive' } },
          { clientUuid: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }
    const [rows, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          kind: true,
          status: true,
          branchId: true,
          instanceCode: true,
          sourceType: true,
          sourceId: true,
          updatedAt: true,
          formSnapshot: true,
          internalFundTransactions: {
            select: { id: true, code: true, status: true },
          },
        },
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        ...row,
        metadata: this.approvalMetadata(row),
        formSnapshot: undefined,
      })),
      total,
      page,
      limit,
    };
  }

  async getApproval(id: number, user: InternalFundActor) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: {
        internalFundTransactions: {
          include: {
            branch: { select: { id: true, name: true } },
          },
          orderBy: { id: 'asc' },
        },
        internalFundTransfers: {
          include: {
            sourceBranch: { select: { id: true, name: true } },
            destinationBranch: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (
      !request ||
      !['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
        request.sourceType || '',
      )
    ) {
      throw new NotFoundException('Không tìm thấy Approval quỹ nội bộ');
    }
    await this.assertPermission(user.id, request.branchId || 0, 'view');
    if (request.sourceType === 'INTERNAL_FUND_TRANSFER') {
      const transfer = request.internalFundTransfers[0];
      if (!transfer) throw new NotFoundException('Không tìm thấy chuyển tiền');
      await this.assertPermission(
        user.id,
        transfer.destinationBranchId,
        'view',
      );
    }
    return {
      ...request,
      metadata: this.approvalMetadata(request),
      internalFundTransfer: request.internalFundTransfers[0] || null,
      internalFundTransfers: undefined,
      formSnapshot: undefined,
    };
  }

  async postApprovedApproval(id: number, userId: number) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });
    if (
      !request ||
      !['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
        request.sourceType || '',
      )
    )
      throw new NotFoundException('Không tìm thấy Approval nội bộ');
    if (request.sourceType === 'INTERNAL_FUND_TRANSFER') {
      const transfer = await this.prisma.internalFundTransfer.findUnique({
        where: { id: request.sourceId || 0 },
      });
      if (!transfer) throw new NotFoundException('Không tìm thấy chuyển tiền');
      await this.assertPermission(userId, transfer.sourceBranchId, 'transfer');
      await this.assertPermission(
        userId,
        transfer.destinationBranchId,
        'transfer',
      );
    } else {
      await this.assertPermission(
        userId,
        request.branchId || 0,
        'mark_received',
      );
    }
    if (request.status !== 'APPROVED')
      throw new BadRequestException('Approval chưa duyệt');
    const actor = auditActor.user(userId);
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lockApproval(tx, id);
      const current = await tx.approvalRequest.findUnique({ where: { id } });
      if (current?.status !== 'APPROVED')
        throw new BadRequestException('Approval không còn được duyệt');
      // Dòng quỹ đã có trước khi ghi: chạy lại (đã ghi rồi) không ghi lịch sử.
      const before = await tx.internalFundTransaction.findMany({
        where: { approvalRequestId: id },
        select: { id: true },
      });
      const known = new Set(before.map((row) => row.id));
      // Người bấm trên POS, không phải hệ thống Lark: sổ quỹ ghi dòng quỹ với
      // cùng actor/opId.
      await this.ledger.applyApproval(tx, current, { auditActor: actor });
      const rows = await tx.internalFundTransaction.findMany({
        where: { approvalRequestId: id },
      });
      const created = rows.filter((row) => !known.has(row.id));
      if (created.length) {
        const isTransfer = current.sourceType === 'INTERNAL_FUND_TRANSFER';
        // Chuyển quỹ: hai chân cùng số tiền; thu quỹ: một dòng.
        const amount = isTransfer
          ? Number(created[0].amount)
          : created.reduce((sum, row) => sum + Number(row.amount), 0);
        // Cùng mã với các dòng khác của đơn (số đơn Lark, tìm được theo số).
        const ref = approvalAuditRef(current);
        await this.financeAudit.write(tx, {
          action: 'FIN_APPROVAL_POST',
          entityType: FINANCE_AUDIT_ENTITY.APPROVAL,
          entityId: current.id,
          entityCode: ref.entityCode,
          branchId: current.branchId,
          actor,
          params: {
            kindLabel: ref.kindLabel,
            code: ref.code,
            amount,
          },
          snapshot: {
            lines: created.map((row) => ({
              label: `Dòng quỹ ${row.code}`,
              value: `${fundTxnTypeLabel(row.transactionType)} ${formatMoney(row.amount)} – ${branchLabel(row.branchId)}`,
            })),
          },
          metadata: {
            sourceType: current.sourceType,
            sourceId: current.sourceId ?? null,
            instanceCode: current.instanceCode ?? null,
            clientUuid: current.clientUuid ?? null,
            fundTransactionIds: created.map((row) => row.id),
            fundTransactionCodes: created.map((row) => row.code),
          },
        });
      }
      return rows;
    });
  }

  /**
   * Đánh dấu Đã chi và ghi quỹ. `actor`: bên gọi (vd trang Phiếu chi kho)
   * truyền vào để các dòng lịch sử của cùng thao tác dùng chung opId.
   */
  async postExpenseEntry(
    id: number,
    userId: number,
    issued: boolean,
    reason?: string,
    actor?: AuditActor,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
    });
    if (!entry || entry.direction !== 'EXPENSE')
      throw new NotFoundException('Không tìm thấy khoản chi');
    // Phiếu xăng Kho HN trừ vào tiền ứng xăng: quỹ đã trừ lúc chi đơn ứng.
    if (isFuelAdvanceEntry(entry))
      throw new BadRequestException(FUEL_ADVANCE_ISSUE_BLOCK);
    // Đã chi: quyền của trang Phiếu chi kho, hoặc quyền xác nhận chi của quỹ.
    if (
      !(await this.access_.can(
        userId,
        entry.branchId,
        'warehouse_expense:mark_issued',
      ))
    ) {
      await this.assertPermission(userId, entry.branchId, 'mark_issued');
    }
    if (!issued)
      throw new BadRequestException(
        'Không bỏ trạng thái Đã chi; hãy hủy giao dịch quỹ',
      );
    const adjust = await this.has(userId, entry.branchId, 'adjust');
    const by = actor ?? auditActor.user(userId);
    await this.prisma.$transaction(async (tx) => {
      // Khóa quỹ trước khi đọc trạng thái Đã chi (ledger khóa lại cùng khóa
      // trong cùng transaction vẫn được) để lần bấm trùng không ghi lịch sử 2 lần.
      await this.ledger.lock(tx, [entry.branchId]);
      const found = await tx.internalFinanceEntry.findUnique({
        where: { id },
        select: CASH_ISSUE_SELECT,
      });
      // Chụp giá trị trước khi ledger cập nhật phiếu.
      const before = found ? { ...found } : null;
      const row = await this.ledger.issueExpense(
        tx,
        entry,
        userId,
        adjust,
        reason,
        by,
      );
      const after = await tx.internalFinanceEntry.findUnique({
        where: { id },
        select: CASH_ISSUE_SELECT,
      });
      if (!after || before?.cashIssued || !after.cashIssued) return;
      await this.financeAudit.write(tx, {
        action: 'FIN_ENTRY_CASH_ISSUE',
        entityType: FINANCE_AUDIT_ENTITY.ENTRY,
        entityId: after.id,
        entityCode: after.code,
        branchId: after.branchId,
        actor: by,
        params: {
          code: after.code,
          reasonSuffix: reasonSuffix(after.cashIssuedReason),
        },
        changes: [cashIssuedChange(false, true)],
        snapshot: {
          lines: [
            { label: 'Loại phiếu', value: entryKindLabel(after.category) },
            { label: 'Số tiền', value: formatMoney(after.amount) },
            { label: 'Ngày chi', value: formatDate(after.occurredAt) },
            {
              label: 'Dòng quỹ',
              value: row?.code || 'Không trừ quỹ (đã trừ trên Lark)',
            },
            { label: 'Lý do Đã chi', value: after.cashIssuedReason || '—' },
          ],
        },
        metadata: {
          fundTransactionId: row?.id ?? null,
          fundTransactionCode: row?.code ?? null,
          approvalRequestId: row?.approvalRequestId ?? null,
          statusBefore: before?.status ?? null,
          weeklyBatchIdBefore: before?.weeklyBatchId ?? null,
          adjust,
        },
      });
    });
    return this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      include: {
        attachments: activeAttachments,
        weeklyBatch: true,
        cashIssuer: { select: { id: true, name: true } },
      },
    });
  }

  async postTransaction(id: number, userId: number) {
    const row = await this.prisma.internalFundTransaction.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Không tìm thấy giao dịch quỹ');
    await this.assertPermission(
      userId,
      row.branchId,
      ['EXPENSE', 'TRANSFER_OUT'].includes(row.transactionType)
        ? 'mark_issued'
        : 'mark_received',
    );
    if (row.status !== 'POSTED')
      throw new BadRequestException('Giao dịch không thể ghi lại');
    return row;
  }

  async listTransfers(query: InternalFundQueryDto, user: InternalFundActor) {
    const branches = await this.branches(query, user);
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    const transferWhere: Prisma.InternalFundTransferWhereInput = {
      AND: [
        { sourceBranchId: { in: branches } },
        { destinationBranchId: { in: branches } },
      ],
      ...(query.status ? { status: query.status } : {}),
      ...(query.fromDate || query.toDate
        ? {
            occurredAt: {
              ...(query.fromDate ? { gte: fundDayStart(query.fromDate) } : {}),
              ...(query.toDate
                ? {
                    lt: new Date(
                      fundDayStart(query.toDate).getTime() + 86400000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.internalFundTransfer.findMany({
        where: transferWhere,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        include: {
          sourceBranch: { select: { id: true, name: true } },
          destinationBranch: { select: { id: true, name: true } },
          transactions: {
            where: { branchId: { in: branches } },
          },
          approvalRequest: { select: { status: true, instanceCode: true } },
        },
      }),
      this.prisma.internalFundTransfer.count({ where: transferWhere }),
    ]);
    return { data, total, page, limit };
  }

  async cancelTransfer(
    id: number,
    dto: CancelInternalFundTransferDto,
    userId: number,
  ) {
    const transfer = await this.prisma.internalFundTransfer.findUnique({
      where: { id },
    });
    if (!transfer) throw new NotFoundException('Không tìm thấy chuyển tiền');
    const branches = [transfer.sourceBranchId, transfer.destinationBranchId];
    const adjust: boolean[] = [];
    for (const branch of branches) {
      await this.assertPermission(userId, branch, 'cancel');
      adjust.push(await this.has(userId, branch, 'adjust'));
    }
    if (!dto.reason.trim()) throw new BadRequestException('Cần lý do hủy');
    const actor = auditActor.user(userId);
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, branches);
      const current = await tx.internalFundTransfer.findUnique({
        where: { id },
      });
      if (!current || current.status === 'CANCELLED')
        throw new BadRequestException('Chuyển tiền đã hủy');
      // Chụp lại trước khi hủy để ghi lịch sử.
      const before = { ...current };
      for (let i = 0; i < branches.length; i++)
        await this.ledger.assertOpen(
          tx,
          branches[i],
          current.occurredAt,
          adjust[i],
        );
      // Hai chân chuyển quỹ hủy bằng updateMany: lấy danh sách trước để ghi
      // lịch sử từng dòng quỹ.
      const legs = (
        await tx.internalFundTransaction.findMany({
          where: { transferId: id, status: 'POSTED' },
          orderBy: { id: 'asc' },
        })
      ).map((leg) => ({ ...leg }));
      await tx.internalFundTransaction.updateMany({
        where: { transferId: id, status: 'POSTED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: dto.reason,
        },
      });
      for (let i = 0; i < branches.length; i++)
        if (adjust[i])
          await this.ledger.invalidateClosings(
            tx,
            branches[i],
            current.occurredAt,
            `hủy chuyển quỹ ${before.code}`,
            actor,
          );
      const updated = await tx.internalFundTransfer.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: dto.reason,
        },
      });
      await this.financeAudit.write(tx, [
        {
          action: 'FIN_FUND_TRANSFER_CANCEL',
          entityType: FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
          entityId: before.id,
          entityCode: before.code,
          branchId: before.sourceBranchId,
          actor,
          params: {
            code: before.code,
            reasonSuffix: reasonSuffix(dto.reason),
          },
          changes: this.statusChange(
            FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
            before.status,
            updated.status,
          ),
          snapshot: {
            lines: [
              ...fundTransferLines(before),
              {
                label: 'Trạng thái trước',
                value: fundTransferStatusLabel(before.status),
              },
              { label: 'Lý do hủy', value: dto.reason.trim() },
            ],
          },
          metadata: {
            statusBefore: before.status,
            approvalRequestId: before.approvalRequestId ?? null,
            cancelledTransactionIds: legs.map((leg) => leg.id),
            cancelledTransactionCodes: legs.map((leg) => leg.code),
          },
        },
        ...legs.map((leg) =>
          this.fundTxnCancelEntry(leg, dto.reason, actor, {
            transferCode: before.code,
          }),
        ),
      ]);
      return updated;
    });
  }

  async cancelTransaction(
    id: number,
    dto: CancelInternalFundTransferDto,
    userId: number,
  ) {
    const row = await this.prisma.internalFundTransaction.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Không tìm thấy giao dịch');
    if (row.transferId) return this.cancelTransfer(row.transferId, dto, userId);
    if (row.sourceType === FUND_SOURCE_TYPE.WAREHOUSE_CASH_RECEIPT)
      throw new BadRequestException(
        'Giao dịch thu tiền khách: hãy hủy phiếu tại Tiền mặt kho',
      );
    if (row.sourceType === FUND_SOURCE_TYPE.LEDGER_HISTORY)
      throw new BadRequestException('Bút toán lịch sử chỉ đọc, không hủy được');
    if (row.sourceType === FUND_SOURCE_TYPE.SEPAY_VPSG)
      throw new BadRequestException(
        'Thu từ tài khoản VPSG: hãy hủy ghi quỹ tại Biến động số dư',
      );
    await this.assertPermission(userId, row.branchId, 'cancel');
    const adjust = await this.has(userId, row.branchId, 'adjust');
    if (!dto.reason.trim()) throw new BadRequestException('Cần lý do hủy');
    const actor = auditActor.user(userId);
    const reason = dto.reason.trim();
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const found = await tx.internalFundTransaction.findUnique({
        where: { id },
      });
      if (!found || found.status !== 'POSTED')
        throw new BadRequestException('Giao dịch đã hủy');
      // Chụp lại dòng quỹ trước khi hủy để ghi lịch sử.
      const current = { ...found };
      await this.ledger.assertOpen(tx, row.branchId, row.occurredAt, adjust);
      // Khoản chi POS: trả về "chưa chi" và nhả khóa để bấm Đã chi lại được.
      // Khoản nhập từ Lark giữ nguyên khóa để lần nhập sau không tự ghi lại.
      const linked = current.entryId
        ? await tx.internalFinanceEntry.findUnique({
            where: { id: current.entryId },
            select: {
              ...CASH_ISSUE_SELECT,
              sourceType: true,
              posManagedAt: true,
            },
          })
        : null;
      const entry = linked ? { ...linked } : null;
      // Dòng Tài chính nội bộ của đơn Lark Approval chỉ phản ánh giao dịch quỹ:
      // hủy giao dịch thì hủy luôn dòng đó.
      if (entry?.sourceType === LARK_APPROVAL_SOURCE_TYPE) {
        const cancelReason = `Hủy giao dịch quỹ: ${reason}`;
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            status: INTERNAL_FINANCE_STATUS.CANCELLED,
            cancelReason,
            cancelledAt: new Date(),
            cancelledBy: userId,
            cashIssued: false,
          },
        });
        // Sổ quỹ ghi lịch sử hủy dòng quỹ (cùng actor/opId).
        const released = await this.ledger.releaseCancelled(
          tx,
          current,
          userId,
          dto.reason,
          actor,
        );
        await this.financeAudit.write(tx, {
          action: 'FIN_ENTRY_CANCEL',
          entityType: FINANCE_AUDIT_ENTITY.ENTRY,
          entityId: entry.id,
          entityCode: entry.code,
          branchId: entry.branchId,
          actor,
          params: {
            kindLabel: entryKindLabel(entry.category),
            code: entry.code,
            reasonSuffix: reasonSuffix(cancelReason),
          },
          changes: [
            ...this.statusChange(
              FINANCE_AUDIT_ENTITY.ENTRY,
              entry.status,
              INTERNAL_FINANCE_STATUS.CANCELLED,
            ),
            ...(entry.cashIssued ? [cashIssuedChange(true, false)] : []),
          ],
          snapshot: {
            lines: [
              { label: 'Số tiền', value: formatMoney(entry.amount) },
              { label: 'Ngày', value: formatDate(entry.occurredAt) },
              {
                label: 'Trạng thái trước',
                value: entryStatusLabel(entry.status),
              },
              { label: 'Dòng quỹ', value: current.code },
            ],
          },
          metadata: {
            statusBefore: entry.status,
            cashIssuedBefore: entry.cashIssued,
            fundTransactionId: current.id,
            fundTransactionCode: current.code,
          },
        });
        return released;
      }
      if (
        current.transactionType === 'EXPENSE' &&
        entry &&
        (entry.sourceType !== 'LARK_IMPORT' || entry.posManagedAt)
      ) {
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
          },
        });
        const released = await this.ledger.releaseCancelled(
          tx,
          current,
          userId,
          dto.reason,
          actor,
        );
        await this.financeAudit.write(tx, {
          action: 'FIN_ENTRY_CASH_ISSUE_REVERT',
          entityType: FINANCE_AUDIT_ENTITY.ENTRY,
          entityId: entry.id,
          entityCode: entry.code,
          branchId: entry.branchId,
          actor,
          params: { code: entry.code, reasonSuffix: reasonSuffix(reason) },
          changes: [cashIssuedChange(entry.cashIssued, false)],
          snapshot: {
            lines: [
              { label: 'Dòng quỹ đã hủy', value: current.code },
              { label: 'Số tiền', value: formatMoney(current.amount) },
              { label: 'Đã chi lúc', value: formatDate(entry.cashIssuedAt) },
              { label: 'Lý do Đã chi', value: entry.cashIssuedReason || '—' },
            ],
            cashIssuedAt: entry.cashIssuedAt,
            cashIssuedBy: entry.cashIssuedBy,
            cashIssuedReason: entry.cashIssuedReason,
          },
          metadata: {
            fundTransactionId: current.id,
            fundTransactionCode: current.code,
          },
        });
        return released;
      }
      if (adjust)
        await this.ledger.invalidateClosings(
          tx,
          row.branchId,
          row.occurredAt,
          `hủy dòng quỹ ${current.code}`,
          actor,
        );
      const updated = await tx.internalFundTransaction.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: dto.reason,
        },
      });
      // Hủy trực tiếp (giữ nguyên sourceKey/entryId): sổ quỹ không ghi lịch sử
      // cho đường này nên ghi ở đây.
      await this.financeAudit.write(
        tx,
        this.fundTxnCancelEntry(current, dto.reason, actor, {
          keptSourceKey: true,
        }),
      );
      return updated;
    });
  }

  async updateTransaction(
    id: number,
    dto: UpdateInternalFundTransactionDto,
    userId: number,
  ) {
    const row = await this.prisma.internalFundTransaction.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Không tìm thấy giao dịch');
    await this.assertPermission(userId, row.branchId, 'adjust');
    if (row.sourceType === FUND_SOURCE_TYPE.LEDGER_HISTORY)
      throw new BadRequestException('Bút toán lịch sử chỉ đọc, không sửa được');
    // Approval amount is immutable. Corrections cancel the original and submit a new request.
    if (
      dto.amount !== undefined ||
      dto.occurredAt !== undefined ||
      row.transferId
    ) {
      throw new BadRequestException(
        'Không sửa tiền/ngày đã duyệt; hủy và tạo yêu cầu mới',
      );
    }
    if (!dto.reason.trim())
      throw new BadRequestException('Cần lý do điều chỉnh');
    const actor = auditActor.user(userId);
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.internalFundTransaction.findUnique({
        where: { id },
      });
      if (!current || current.status !== 'POSTED')
        throw new BadRequestException('Giao dịch đã hủy');
      const before = { ...current };
      const updated = await tx.internalFundTransaction.update({
        where: { id },
        data: {
          description: `${dto.description ?? row.description ?? ''}\nĐiều chỉnh: ${dto.reason}`,
        },
      });
      const changes = this.financeAudit.diff(
        FINANCE_AUDIT_ENTITY.FUND_TXN,
        before,
        updated,
      );
      if (changes.length)
        await this.financeAudit.write(tx, {
          action: 'FIN_FUND_TXN_ADJUST',
          entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
          entityId: before.id,
          entityCode: before.code,
          branchId: before.branchId,
          actor,
          params: {
            code: before.code,
            reasonSuffix: reasonSuffix(dto.reason),
          },
          changes,
          snapshot: { lines: fundTxnLines(updated) },
          metadata: { reason: dto.reason.trim() },
        });
      return updated;
    });
  }

  /**
   * Mỗi dòng là một chốt sổ do người dùng tạo (hoặc đồng bộ sang). Số hệ
   * thống đặt cạnh để đối soát, tính trực tiếp từ sổ quỹ nên luôn mới nhất.
   */
  async listDailyClosings(
    query: InternalFundQueryDto,
    user: InternalFundActor,
  ) {
    const branches = await this.branches(query, user);
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    if (!branches.length) return { data: [], total: 0, page, limit };
    const [sums, closings] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          branchId: number;
          day: string;
          receipt: Prisma.Decimal;
          expense: Prisma.Decimal;
        }>
      >`
        SELECT "branchId",
          to_char("occurredAt" + interval '7 hours', 'YYYY-MM-DD') AS day,
          COALESCE(SUM(CASE WHEN "transactionType" IN ('RECEIPT', 'TRANSFER_IN') THEN amount ELSE 0 END), 0) AS receipt,
          COALESCE(SUM(CASE WHEN "transactionType" IN ('RECEIPT', 'TRANSFER_IN') THEN 0 ELSE amount END), 0) AS expense
        FROM internal_fund_transactions
        WHERE "branchId" IN (${Prisma.join(branches)}) AND status = 'POSTED'
        GROUP BY 1, 2`,
      this.prisma.internalFundDailyClosing.findMany({
        where: { branchId: { in: branches } },
      }),
    ]);
    const zero = new Prisma.Decimal(0);
    const from = query.fromDate ? fundDateKey(query.fromDate) : null;
    const to = query.toDate ? fundDateKey(query.toDate) : null;
    const rows: Array<Record<string, unknown> & { closingDate: string }> = [];
    for (const branchId of branches) {
      const moves = new Map(
        sums
          .filter((row) => Number(row.branchId) === branchId)
          .map((row) => [row.day, row]),
      );
      const saved = new Map(
        closings
          .filter((row) => row.branchId === branchId)
          .map((row) => [row.closingDate.toISOString().slice(0, 10), row]),
      );
      const days = [...new Set([...moves.keys(), ...saved.keys()])].sort();
      let balance = zero;
      for (const day of days) {
        const opening = balance;
        const receipt = new Prisma.Decimal(moves.get(day)?.receipt ?? 0);
        const expense = new Prisma.Decimal(moves.get(day)?.expense ?? 0);
        balance = opening.plus(receipt).minus(expense);
        const closing = saved.get(day);
        // Ngày chỉ có giao dịch mà chưa ai tạo chốt sổ thì không hiện.
        if (!closing || (from && day < from) || (to && day > to)) continue;
        const actualClosing = closing.actualClosingBalance;
        rows.push({
          id: closing.id,
          branchId,
          closingDate: day,
          systemOpeningBalance: opening,
          systemReceipt: receipt,
          systemExpense: expense,
          systemClosingBalance: balance,
          actualOpeningBalance: closing.actualOpeningBalance,
          actualReceipt: closing.actualReceipt,
          actualExpense: closing.actualExpense,
          actualClosingBalance: actualClosing,
          // Giống bảng chốt sổ cũ: chỉ so số cuối kỳ.
          reconciliationStatus: !actualClosing
            ? 'PENDING'
            : actualClosing.equals(balance)
              ? 'MATCHED'
              : 'MISMATCHED',
          notes: closing.notes,
          closedBy: closing.closedBy,
          closedAt: closing.closedAt,
        });
      }
    }
    rows.sort(
      (a, b) =>
        b.closingDate.localeCompare(a.closingDate) ||
        Number(a.branchId) - Number(b.branchId),
    );
    return {
      data: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
    };
  }

  async getDailyClosing(id: number, user: InternalFundActor) {
    const row = await this.prisma.internalFundDailyClosing.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Không tìm thấy chốt sổ');
    await this.assertPermission(user.id, row.branchId, 'view');
    return row;
  }

  async closeDay(dto: CloseInternalFundDayDto, userId: number) {
    await this.assertPermission(userId, dto.branchId, 'close');
    const adjust = await this.has(userId, dto.branchId, 'adjust');
    const actor = auditActor.user(userId);
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [dto.branchId]);
      const date = fundClosingDate(dto.closingDate);
      // Sửa theo id thì được dời dòng sang ngày khác, miễn ngày đó còn trống.
      const current = dto.id
        ? await tx.internalFundDailyClosing.findUnique({
            where: { id: dto.id },
          })
        : null;
      if (dto.id && current?.branchId !== dto.branchId)
        throw new NotFoundException('Không tìm thấy chốt sổ');
      const sameDay = await tx.internalFundDailyClosing.findUnique({
        where: {
          branchId_closingDate: { branchId: dto.branchId, closingDate: date },
        },
      });
      if (current && sameDay && sameDay.id !== current.id)
        throw new BadRequestException(
          `Ngày ${date.toISOString().slice(0, 10).split('-').reverse().join('/')} đã có chốt sổ`,
        );
      const existing = current ?? sameDay;
      // Chụp lại trước khi lưu để ghi lịch sử.
      const before = existing ? { ...existing } : null;
      const movedFrom =
        current && current.closingDate.getTime() !== date.getTime()
          ? current.closingDate.toISOString().slice(0, 10)
          : undefined;
      if (existing?.closedAt && !adjust)
        throw new ForbiddenException('Cần quyền điều chỉnh để chốt lại');
      const summary = await this.ledger.balance(
        tx,
        dto.branchId,
        dto.closingDate,
      );
      const entered = [
        dto.actualOpeningBalance,
        dto.actualReceipt,
        dto.actualExpense,
      ];
      const complete = entered.every((v) => v !== undefined);
      // Cuối kỳ của kế toán tự tính từ đầu kỳ + thu − chi, không gõ tay.
      const actualClosing = complete
        ? new Prisma.Decimal(dto.actualOpeningBalance!)
            .plus(dto.actualReceipt!)
            .minus(dto.actualExpense!)
        : dto.actualClosingBalance !== undefined
          ? new Prisma.Decimal(dto.actualClosingBalance)
          : null;
      const actuals = [...entered, actualClosing?.toNumber()];
      const systems = [
        summary.opening,
        summary.receipt,
        summary.expense,
        summary.closing,
      ];
      // Chỉ so số cuối kỳ với sổ quỹ.
      const matched =
        actualClosing !== null && summary.closing.equals(actualClosing);
      const snapshot = {
        capturedAt: new Date().toISOString(),
        actorId: userId,
        notes: dto.notes || '',
        transactions: summary.rows.map((row) => ({
          id: row.id,
          code: row.code,
          type: row.transactionType,
          amount: row.amount.toString(),
          date: row.occurredAt.toISOString(),
        })),
        system: systems.map(String),
        actual: actuals.map((v) => v ?? null),
        ...(movedFrom && { movedFrom }),
      };
      const history = Array.isArray(existing?.log) ? existing.log : [];
      const data = {
        systemOpeningBalance: summary.opening,
        systemReceipt: summary.receipt,
        systemExpense: summary.expense,
        systemClosingBalance: summary.closing,
        actualOpeningBalance: dto.actualOpeningBalance ?? null,
        actualReceipt: dto.actualReceipt ?? null,
        actualExpense: dto.actualExpense ?? null,
        actualClosingBalance: actualClosing,
        reconciliationStatus: actualClosing
          ? matched
            ? 'MATCHED'
            : 'MISMATCHED'
          : 'PENDING',
        notes: dto.notes,
        snapshot,
        log: [...history, snapshot] as Prisma.InputJsonValue,
        closedAt: new Date(),
        closedBy: userId,
        posManagedAt: new Date(),
      };
      const saved = current
        ? await tx.internalFundDailyClosing.update({
            where: { id: current.id },
            data: { ...data, closingDate: date },
          })
        : await tx.internalFundDailyClosing.upsert({
            where: {
              branchId_closingDate: {
                branchId: dto.branchId,
                closingDate: date,
              },
            },
            create: {
              ...data,
              branchId: dto.branchId,
              closingDate: date,
              createdBy: userId,
            },
            update: data,
          });
      const entry = this.closingSaveEntry(before, saved, movedFrom, actor);
      if (entry) await this.financeAudit.write(tx, entry);
      return saved;
    });
  }

  /**
   * Lịch sử lưu chốt sổ: số thực tế/ghi chú/đối soát đổi và dời ngày. Chốt
   * lần đầu luôn ghi; chốt lại không đổi gì thì không ghi.
   */
  private closingSaveEntry(
    before: InternalFundDailyClosing | null,
    saved: InternalFundDailyClosing,
    movedFrom: string | undefined,
    actor: AuditActor,
  ): FinanceAuditEntry | null {
    const changes = before
      ? this.financeAudit.diff(FINANCE_AUDIT_ENTITY.FUND_CLOSING, before, saved)
      : [];
    if (before && movedFrom)
      changes.unshift({
        field: 'closingDate',
        label: 'Ngày chốt',
        from: formatDate(before.closingDate),
        to: formatDate(saved.closingDate),
        type: 'field_changed',
        detail: {
          from: movedFrom,
          to: saved.closingDate.toISOString().slice(0, 10),
        },
      });
    const firstClose = !before?.closedAt;
    if (!firstClose && !changes.length) return null;
    return {
      action: 'FIN_FUND_CLOSING_SAVE',
      entityType: FINANCE_AUDIT_ENTITY.FUND_CLOSING,
      entityId: saved.id,
      branchId: saved.branchId,
      actor,
      params: {
        branch: branchLabel(saved.branchId),
        date: formatDate(saved.closingDate),
      },
      changes,
      snapshot: {
        lines: [
          { label: 'Quỹ', value: branchLabel(saved.branchId) },
          { label: 'Ngày chốt', value: formatDate(saved.closingDate) },
          {
            label: 'Tồn đầu thực tế',
            value: formatMoney(saved.actualOpeningBalance),
          },
          { label: 'Thu thực tế', value: formatMoney(saved.actualReceipt) },
          { label: 'Chi thực tế', value: formatMoney(saved.actualExpense) },
          {
            label: 'Tồn cuối thực tế',
            value: formatMoney(saved.actualClosingBalance),
          },
          {
            label: 'Tồn cuối hệ thống',
            value: formatMoney(saved.systemClosingBalance),
          },
          {
            label: 'Đối soát',
            value: statusLabel(
              FINANCE_AUDIT_ENTITY.FUND_CLOSING,
              saved.reconciliationStatus,
            ),
          },
          { label: 'Ghi chú', value: saved.notes || '—' },
        ],
      },
      metadata: {
        created: !before,
        reclosed: Boolean(before?.closedAt),
        movedFrom: movedFrom ?? null,
        system: {
          opening: saved.systemOpeningBalance,
          receipt: saved.systemReceipt,
          expense: saved.systemExpense,
          closing: saved.systemClosingBalance,
        },
      },
    };
  }
}
