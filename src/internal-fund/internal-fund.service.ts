import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceAccessService } from '../auth/finance-access.service';
import { ApprovalLifecycleService } from '../approval-lifecycle/approval-lifecycle.service';
import {
  INTERNAL_FINANCE_STATUS,
  LARK_APPROVAL_SOURCE_TYPE,
} from '../internal-finance/internal-finance.constants';
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
import { releaseEntryAllocations } from '../cash-advances/cash-advance-coverage';

@Injectable()
export class InternalFundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access_: FinanceAccessService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly ledger: InternalFundLedgerService,
  ) {}

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

  async listTransactions(query: InternalFundQueryDto, user: InternalFundActor) {
    const branchIds = await this.branches(query, user);
    const where: Prisma.InternalFundTransactionWhereInput = {
      branchId: { in: branchIds },
      status: query.status || 'POSTED',
      ...(query.transactionType
        ? { transactionType: query.transactionType }
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
    const page = query.page || 1,
      limit = Math.min(query.limit || 50, 100);
    const direction = query.orderDirection === 'asc' ? 'asc' : 'desc';
    // Sắp xếp theo cột (Ngày ghi quỹ / Số tiền); cùng giá trị thì dòng mới trước.
    const orderBy: Prisma.InternalFundTransactionOrderByWithRelationInput[] =
      query.orderBy === 'amount'
        ? [{ amount: direction }, { occurredAt: 'desc' }, { id: 'desc' }]
        : [{ occurredAt: direction }, { id: direction }];
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
    // Dòng quỹ của phiếu tạm ứng / hoàn ứng: gắn mã phiếu để mở trang gốc.
    const idsOf = (sourceType: string) =>
      data
        .filter((row) => row.sourceType === sourceType && row.sourceId)
        .map((row) => Number(row.sourceId));
    const [advances, refunds] = await Promise.all([
      this.prisma.cashAdvance.findMany({
        where: { id: { in: idsOf(FUND_SOURCE_TYPE.CASH_ADVANCE) } },
        select: { id: true, code: true },
      }),
      this.prisma.cashAdvanceRefund.findMany({
        where: { id: { in: idsOf(FUND_SOURCE_TYPE.CASH_ADVANCE_REFUND) } },
        select: { id: true, code: true, advance: { select: { code: true } } },
      }),
    ]);
    const rows = data.map((row) => {
      const id = Number(row.sourceId);
      if (row.sourceType === FUND_SOURCE_TYPE.CASH_ADVANCE)
        return {
          ...row,
          cashAdvance: advances.find((item) => item.id === id) || null,
        };
      if (row.sourceType === FUND_SOURCE_TYPE.CASH_ADVANCE_REFUND) {
        const refund = refunds.find((item) => item.id === id);
        return {
          ...row,
          cashAdvanceRefund: refund
            ? {
                id: refund.id,
                code: refund.code,
                advanceCode: refund.advance.code,
              }
            : null,
        };
      }
      return row;
    });
    // Tổng của toàn bộ dòng khớp bộ lọc: tiền vào (thu, chuyển đến) và tiền ra.
    const sumOf = (types: string[]) =>
      sums
        .filter((row) => types.includes(row.transactionType))
        .reduce((sum, row) => sum + Number(row._sum.amount || 0), 0);
    const totals = {
      receipt: sumOf(['RECEIPT', 'TRANSFER_IN']),
      expense: sumOf(['EXPENSE', 'TRANSFER_OUT']),
    };
    return { data: rows, total, page, limit, totals };
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
    let sourceId: number | undefined;
    if (transfer) {
      const record = await this.prisma.internalFundTransfer.upsert({
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
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lockApproval(tx, id);
      const current = await tx.approvalRequest.findUnique({ where: { id } });
      if (current?.status !== 'APPROVED')
        throw new BadRequestException('Approval không còn được duyệt');
      await this.ledger.applyApproval(tx, current);
      return tx.internalFundTransaction.findMany({
        where: { approvalRequestId: id },
      });
    });
  }

  async postExpenseEntry(
    id: number,
    userId: number,
    issued: boolean,
    reason?: string,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
    });
    if (!entry || entry.direction !== 'EXPENSE')
      throw new NotFoundException('Không tìm thấy khoản chi');
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
    await this.prisma.$transaction((tx) =>
      this.ledger.issueExpense(tx, entry, userId, adjust, reason),
    );
    return this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      include: {
        attachments: true,
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
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, branches);
      const current = await tx.internalFundTransfer.findUnique({
        where: { id },
      });
      if (!current || current.status === 'CANCELLED')
        throw new BadRequestException('Chuyển tiền đã hủy');
      for (let i = 0; i < branches.length; i++)
        await this.ledger.assertOpen(
          tx,
          branches[i],
          current.occurredAt,
          adjust[i],
        );
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
          );
      return tx.internalFundTransfer.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: dto.reason,
        },
      });
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
    if (row.sourceType === FUND_SOURCE_TYPE.CASH_ADVANCE)
      throw new BadRequestException(
        'Giao dịch tạm ứng: hãy hủy phiếu tại trang Tạm ứng',
      );
    if (row.sourceType === FUND_SOURCE_TYPE.CASH_ADVANCE_REFUND)
      throw new BadRequestException(
        'Giao dịch hoàn ứng: hãy hủy phiếu tại trang Hoàn ứng',
      );
    await this.assertPermission(userId, row.branchId, 'cancel');
    const adjust = await this.has(userId, row.branchId, 'adjust');
    if (!dto.reason.trim()) throw new BadRequestException('Cần lý do hủy');
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.internalFundTransaction.findUnique({
        where: { id },
      });
      if (!current || current.status !== 'POSTED')
        throw new BadRequestException('Giao dịch đã hủy');
      await this.ledger.assertOpen(tx, row.branchId, row.occurredAt, adjust);
      // Khoản chi POS: trả về "chưa chi" và nhả khóa để bấm Đã chi lại được.
      // Khoản nhập từ Lark giữ nguyên khóa để lần nhập sau không tự ghi lại.
      const entry = current.entryId
        ? await tx.internalFinanceEntry.findUnique({
            where: { id: current.entryId },
            select: { id: true, sourceType: true, posManagedAt: true },
          })
        : null;
      // Dòng Tài chính nội bộ của đơn Lark Approval chỉ phản ánh giao dịch quỹ:
      // hủy giao dịch thì hủy luôn dòng đó.
      if (entry?.sourceType === LARK_APPROVAL_SOURCE_TYPE) {
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            status: INTERNAL_FINANCE_STATUS.CANCELLED,
            cancelReason: `Hủy giao dịch quỹ: ${dto.reason.trim()}`,
            cancelledAt: new Date(),
            cancelledBy: userId,
            cashIssued: false,
          },
        });
        return this.ledger.releaseCancelled(tx, current, userId, dto.reason);
      }
      if (
        current.transactionType === 'EXPENSE' &&
        entry &&
        (entry.sourceType !== 'LARK_IMPORT' || entry.posManagedAt)
      ) {
        // Phần đã chi từ tạm ứng cũng được nhả, bấm Đã chi lại sẽ tính lại.
        await releaseEntryAllocations(
          tx,
          [entry.id],
          userId,
          `Hủy giao dịch quỹ: ${dto.reason.trim()}`,
        );
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: {
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
          },
        });
        return this.ledger.releaseCancelled(tx, current, userId, dto.reason);
      }
      if (adjust)
        await this.ledger.invalidateClosings(tx, row.branchId, row.occurredAt);
      return tx.internalFundTransaction.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: dto.reason,
        },
      });
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
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [row.branchId]);
      const current = await tx.internalFundTransaction.findUnique({
        where: { id },
      });
      if (!current || current.status !== 'POSTED')
        throw new BadRequestException('Giao dịch đã hủy');
      return tx.internalFundTransaction.update({
        where: { id },
        data: {
          description: `${dto.description ?? row.description ?? ''}\nĐiều chỉnh: ${dto.reason}`,
        },
      });
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
      if (current)
        return tx.internalFundDailyClosing.update({
          where: { id: current.id },
          data: { ...data, closingDate: date },
        });
      return tx.internalFundDailyClosing.upsert({
        where: {
          branchId_closingDate: { branchId: dto.branchId, closingDate: date },
        },
        create: {
          ...data,
          branchId: dto.branchId,
          closingDate: date,
          createdBy: userId,
        },
        update: data,
      });
    });
  }
}
