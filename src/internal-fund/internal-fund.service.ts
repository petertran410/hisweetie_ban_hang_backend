import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ApprovalLifecycleService } from '../approval-lifecycle/approval-lifecycle.service';
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
  InternalFundLedgerService,
} from './internal-fund-ledger.service';
import {
  buildFundReceiptForm,
  fundCashSourceLabel,
} from './internal-fund-template.registry';

@Injectable()
export class InternalFundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly ledger: InternalFundLedgerService,
  ) {}

  private scope(branchId: number) {
    return Object.entries(INTERNAL_FUND_SCOPE_BRANCHES).find(([, ids]) =>
      (ids as readonly number[]).includes(branchId),
    )?.[0];
  }

  private async has(
    userId: number,
    branchId: number,
    action: InternalFundPermissionAction,
  ) {
    const scope = this.scope(branchId);
    if (!scope) return false;
    const permissions = await this.authService.getPermissionsForBranch(
      userId,
      branchId,
    );
    if (permissions.includes(`internal_fund:${action}_${scope}`)) return true;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { name: true } } } } },
    });
    return (
      user?.userRoles.some((row) => row.role.name === 'Super Admin') || false
    );
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
    const profile = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { userRoles: { select: { role: { select: { name: true } } } } },
    });
    const superAdmin = profile?.userRoles.some(
      (row) => row.role.name === 'Super Admin',
    );
    for (const id of Object.values(INTERNAL_FUND_SCOPE_BRANCHES).flat()) {
      result[id] = [];
      const permissions = await this.authService.getPermissionsForBranch(
        user.id,
        id,
      );
      for (const action of [
        'view',
        'create_receipt',
        'create_expense',
        'transfer',
        'submit_approval',
        'mark_issued',
        'mark_received',
        'close',
        'cancel',
        'adjust',
      ] as InternalFundPermissionAction[]) {
        if (
          superAdmin ||
          permissions.includes(`internal_fund:${action}_${this.scope(id)}`)
        )
          result[id].push(action);
      }
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
            OR: ['code', 'description'].map((key) => ({
              [key]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    const page = query.page || 1,
      limit = Math.min(query.limit || 50, 100);
    const [data, total] = await Promise.all([
      this.prisma.internalFundTransaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        include: {
          branch: { select: { id: true, name: true } },
          transfer: true,
          approvalRequest: {
            select: { id: true, status: true, instanceCode: true },
          },
        },
      }),
      this.prisma.internalFundTransaction.count({ where }),
    ]);
    return { data, total, page, limit };
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

  async postExpenseEntry(id: number, userId: number, issued: boolean) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
    });
    if (!entry || entry.direction !== 'EXPENSE')
      throw new NotFoundException('Không tìm thấy khoản chi');
    const legacyScope = this.scope(entry.branchId);
    const permissions = await this.authService.getPermissionsForBranch(
      userId,
      entry.branchId,
    );
    if (!permissions.includes(`warehouse_expense:mark_issued_${legacyScope}`)) {
      await this.assertPermission(userId, entry.branchId, 'mark_issued');
    }
    if (!issued)
      throw new BadRequestException(
        'Không bỏ trạng thái Đã chi; hãy hủy giao dịch quỹ',
      );
    const adjust = await this.has(userId, entry.branchId, 'adjust');
    await this.prisma.$transaction((tx) =>
      this.ledger.issueExpense(tx, entry, userId, adjust),
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

  async listDailyClosings(
    query: InternalFundQueryDto,
    user: InternalFundActor,
  ) {
    const branches = await this.branches(query, user);
    const page = query.page || 1;
    const limit = Math.min(query.limit || 30, 100);
    const where: Prisma.InternalFundDailyClosingWhereInput = {
      branchId: { in: branches },
      ...(query.fromDate || query.toDate
        ? {
            closingDate: {
              ...(query.fromDate
                ? { gte: fundClosingDate(query.fromDate) }
                : {}),
              ...(query.toDate ? { lte: fundClosingDate(query.toDate) } : {}),
            },
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.internalFundDailyClosing.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ closingDate: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          branchId: true,
          closingDate: true,
          systemOpeningBalance: true,
          systemReceipt: true,
          systemExpense: true,
          systemClosingBalance: true,
          actualOpeningBalance: true,
          actualReceipt: true,
          actualExpense: true,
          actualClosingBalance: true,
          reconciliationStatus: true,
          notes: true,
          closedBy: true,
          closedAt: true,
        },
      }),
      this.prisma.internalFundDailyClosing.count({ where }),
    ]);
    return { data, total, page, limit };
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
      const existing = await tx.internalFundDailyClosing.findUnique({
        where: {
          branchId_closingDate: { branchId: dto.branchId, closingDate: date },
        },
      });
      if (existing?.closedAt && !adjust)
        throw new ForbiddenException('Cần quyền điều chỉnh để chốt lại');
      const summary = await this.ledger.balance(
        tx,
        dto.branchId,
        dto.closingDate,
      );
      const actuals = [
        dto.actualOpeningBalance,
        dto.actualReceipt,
        dto.actualExpense,
        dto.actualClosingBalance,
      ];
      const systems = [
        summary.opening,
        summary.receipt,
        summary.expense,
        summary.closing,
      ];
      const complete = actuals.every((v) => v !== undefined);
      const matched =
        complete &&
        actuals.every(
          (v, i) => v !== undefined && systems[i].equals(new Prisma.Decimal(v)),
        );
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
        actualClosingBalance: dto.actualClosingBalance ?? null,
        reconciliationStatus: complete
          ? matched
            ? 'MATCHED'
            : 'MISMATCHED'
          : 'PENDING',
        notes: dto.notes,
        snapshot,
        log: [...history, snapshot] as Prisma.InputJsonValue,
        closedAt: new Date(),
        closedBy: userId,
      };
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
