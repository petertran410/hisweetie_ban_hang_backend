import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashFlowsService } from '../cashflows/cashflows.service';
import { ApprovalLifecycleService } from '../approval-lifecycle/approval-lifecycle.service';
import {
  FinanceAccessService,
  type FinanceActor,
} from '../auth/finance-access.service';
import {
  EXPENSE_FIELD_IDS,
  type ApprovalFormItem,
} from '../approval-lifecycle/approval-lifecycle.constants';
import {
  DELIVERY_EXPENSE_CATEGORIES,
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_DIRECTION,
  INTERNAL_FINANCE_EVIDENCE_STATUS,
  INTERNAL_FINANCE_REVIEW_DECISION,
  INTERNAL_FINANCE_REVIEW_ROLE,
  PACKING_FEE_LABELS,
  INTERNAL_FINANCE_BRANCH_CODES,
  INTERNAL_FINANCE_SUBCATEGORY,
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
  INTERNAL_FINANCE_BRANCH_IDS,
  LARK_APPROVAL_LOCK_REASON,
  LARK_APPROVAL_SOURCE_TYPE,
  WAREHOUSE_CASH_BRANCH_IDS,
  WAREHOUSE_EXPENSE_ITEM,
} from './internal-finance.constants';
import {
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  CreateWarehouseReceiptDto,
  CancelWarehouseReceiptDto,
  CheckWarehouseExpenseDto,
  BulkCheckWarehouseExpenseDto,
  AddInternalFinanceAttachmentsDto,
  CreateWarehouseExpenseDto,
  InternalFinanceQueryDto,
  LarkApprovalQueryDto,
  MarkWarehouseExpenseIssuedDto,
  PostWarehouseReceiptDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
  UpdateWarehouseReceiptDto,
  UpdateWarehouseExpenseDto,
  UpdateVehicleEntryDto,
  VehicleEntryQueryDto,
  WarehouseExpenseQueryDto,
} from './dto';
import { InternalFinanceCodeService } from './internal-finance-code.service';
import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';
import { InternalFundService } from '../internal-fund/internal-fund.service';
import {
  fundClosingDate,
  fundDateKey,
  fundDayStart,
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
  isLarkLedgerRecorded,
} from '../internal-fund/internal-fund-ledger.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { VEHICLE_CHECK } from '../vehicles/vehicles.constants';

type DbClient = PrismaService | any;

const WAREHOUSE_EXPENSE_SCOPES = [
  { key: 'hn', branchIds: [6] },
  { key: 'sg', branchIds: [1] },
  { key: 'vp', branchIds: [4, 7] },
] as const;

const WAREHOUSE_EXPENSE_CATEGORIES = [
  INTERNAL_FINANCE_CATEGORY.DELIVERY_FEE,
  INTERNAL_FINANCE_CATEGORY.FUEL,
  INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE,
  INTERNAL_FINANCE_CATEGORY.OTHER_EXPENSE,
] as const;

/**
 * Phiếu sót tuần trước (đủ hai tick nhưng chưa vào tuần nào) chỉ được gộp từ
 * ngày bắt đầu dùng POS, để không kéo dữ liệu lịch sử từ Lark vào batch mới.
 */
const CARRY_OVER_FROM = new Date('2026-10-13T00:00:00+07:00');

// Approval Lark đã kết thúc mà không duyệt: batch tuần được phép hủy.
const CANCELLABLE_WEEKLY_APPROVAL_STATUSES = [
  'CANCELED',
  'REJECTED',
  'DELETED',
  'REVERTED',
  'CREATE_FAILED',
];

type WarehouseExpenseAction =
  | 'view'
  | 'create'
  | 'update'
  | 'mark_issued'
  | 'check_manager'
  | 'check_accountant'
  | 'cancel'
  | 'request_review';

/** Phiếu chi từ báo đơn không cập nhật theo báo đơn vì đang khóa. */
export type PackingFinanceLock = { code: string; reason: string };

type WeeklyApprovalAction = 'view' | 'prepare' | 'submit';

type WarehouseCashAction = 'view' | 'create' | 'update' | 'post' | 'cancel';

@Injectable()
export class InternalFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashFlowsService: CashFlowsService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly config: ConfigService,
    private readonly codeService: InternalFinanceCodeService,
    private readonly access: FinanceAccessService,
    private readonly internalFund: InternalFundService,
    private readonly vehicles: VehiclesService,
    private readonly fundLedger: InternalFundLedgerService,
  ) {}

  async findAll(query: InternalFinanceQueryDto) {
    const limit = Math.min(query.limit || 50, 100);
    const page = query.page || 1;
    const where = this.buildEntryWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          branch: { select: { id: true, name: true } },
          customer: { select: { id: true, code: true, name: true } },
          packingSlip: { select: { id: true, code: true } },
          weeklyBatch: {
            select: {
              id: true,
              code: true,
              status: true,
              approvalRequestId: true,
            },
          },
          cashFlow: { select: { id: true, code: true, status: true } },
          cashIssuer: { select: { id: true, name: true } },
          managerReviewer: { select: { id: true, name: true } },
          accountantReviewer: { select: { id: true, name: true } },
          attachments: true,
          invoiceLinks: {
            include: {
              invoice: {
                select: { id: true, code: true, customerId: true },
              },
            },
          },
          reviews: {
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { reviewer: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.internalFinanceEntry.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async getSummary(query: InternalFinanceQueryDto) {
    const where: any = this.buildEntryWhere(query);
    // Phiếu đã hủy / bị từ chối không tính vào tổng.
    const conditions = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      ...(query.status
        ? []
        : [
            {
              status: {
                notIn: [
                  INTERNAL_FINANCE_STATUS.CANCELLED,
                  INTERNAL_FINANCE_STATUS.REJECTED,
                ],
              },
            },
          ]),
    ];
    const withCondition = (condition: any) =>
      conditions.length ? { AND: [...conditions, condition] } : condition;
    const [receipt, expense, posted, missingEvidence] = await Promise.all([
      this.prisma.internalFinanceEntry.aggregate({
        where: withCondition({
          direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
        }),
        _sum: { amount: true },
      }),
      this.prisma.internalFinanceEntry.aggregate({
        where: withCondition({
          direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
        }),
        _sum: { amount: true },
      }),
      this.prisma.internalFinanceEntry.aggregate({
        where: withCondition({ status: INTERNAL_FINANCE_STATUS.POSTED }),
        _sum: { amount: true },
      }),
      this.prisma.internalFinanceEntry.aggregate({
        where: withCondition({
          evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
        }),
        _sum: { amount: true },
      }),
    ]);
    const summary = {
      receipt: Number(receipt._sum.amount || 0),
      expense: Number(expense._sum.amount || 0),
      posted: Number(posted._sum.amount || 0),
      missingEvidence: Number(missingEvidence._sum.amount || 0),
    };
    return { ...summary, balance: summary.receipt - summary.expense };
  }

  async createManualReceipt(dto: CreateManualReceiptDto, userId: number) {
    const invoiceIds = [...new Set(dto.invoiceIds || [])];
    await this.validateBranch(dto.branchId);
    if (dto.method === 'cash' && !dto.cashSource?.trim()) {
      throw new BadRequestException('Phiếu thu tiền mặt phải có nguồn tiền');
    }
    let resolvedCustomerId = dto.customerId;
    if (invoiceIds.length > 0) {
      const invoices = await this.prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, customerId: true },
      });
      if (invoices.length !== invoiceIds.length) {
        throw new BadRequestException('Có hóa đơn không tồn tại');
      }
      const customerIds = new Set(
        invoices.map((invoice) => invoice.customerId),
      );
      if (customerIds.size > 1) {
        throw new BadRequestException(
          'Các hóa đơn phải thuộc cùng một khách hàng',
        );
      }
      resolvedCustomerId = invoices[0]?.customerId ?? resolvedCustomerId;
    }

    return this.prisma.$transaction(async (tx) => {
      const occurredAt = new Date(dto.occurredAt);
      const code = await this.codeService.nextCode(tx, {
        direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
        category: INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
        branchId: dto.branchId,
        occurredAt,
      });
      return tx.internalFinanceEntry.create({
        data: {
          code,
          direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
          category: INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
          subCategory: INTERNAL_FINANCE_SUBCATEGORY.OTHER,
          branchId: dto.branchId,
          amount: dto.amount,
          occurredAt,
          sourceType: 'MANUAL_RECEIPT',
          sourceKey: `MANUAL_RECEIPT:${randomUUID()}`,
          sourceSnapshot: this.toJson({
            ...(dto.sourceSnapshot || {}),
            method: dto.method,
            ...(dto.cashSource ? { cashSource: dto.cashSource } : {}),
          }),
          description: dto.description,
          evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
          status: INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
          requiresEvidence: false,
          customerId: resolvedCustomerId,
          createdBy: userId,
          attachments: dto.attachments?.length
            ? {
                create: dto.attachments.map((file) => ({
                  kind: file.kind || 'EVIDENCE',
                  fileUrl: file.fileUrl,
                  fileName: file.fileName,
                  fileType: file.fileType,
                  fileSize: file.fileSize,
                  createdBy: userId,
                })),
              }
            : undefined,
          invoiceLinks: invoiceIds.length
            ? { create: invoiceIds.map((invoiceId) => ({ invoiceId })) }
            : undefined,
          reviews: {
            create: {
              role: INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
              decision: INTERNAL_FINANCE_REVIEW_DECISION.APPROVE,
              note: 'Phiếu thu thủ công được đánh dấu đã kiểm tra kế toán khi tạo.',
              reviewerId: userId,
            },
          },
        },
        include: this.entryInclude(),
      });
    });
  }

  async listWarehouseReceipts(query: InternalFinanceQueryDto) {
    const limit = Math.min(query.limit || 50, 100);
    const page = query.page || 1;
    const branchIds = (
      query.branchIds?.length ? query.branchIds : [...WAREHOUSE_CASH_BRANCH_IDS]
    ).filter((id) =>
      (WAREHOUSE_CASH_BRANCH_IDS as readonly number[]).includes(id),
    );
    if (!branchIds.length) return { data: [], total: 0, page, limit };

    const conditions: any[] = [
      { direction: INTERNAL_FINANCE_DIRECTION.RECEIPT },
      { branchId: { in: branchIds } },
      { sourceType: { in: ['PACKING_SLIP', 'MANUAL_RECEIPT'] } },
      {
        category: {
          in: [
            INTERNAL_FINANCE_CATEGORY.CUSTOMER_RECEIPT,
            INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
          ],
        },
      },
    ];
    if (query.receiptStatus === 'POSTED') {
      conditions.push({
        OR: [
          { status: INTERNAL_FINANCE_STATUS.POSTED },
          { cashFlowId: { not: null } },
        ],
      });
    } else if (query.receiptStatus === 'CANCELLED') {
      conditions.push({ status: INTERNAL_FINANCE_STATUS.CANCELLED });
    } else if (query.receiptStatus === 'OPEN') {
      conditions.push({
        cashFlowId: null,
        status: {
          notIn: [
            INTERNAL_FINANCE_STATUS.CANCELLED,
            INTERNAL_FINANCE_STATUS.REJECTED,
            INTERNAL_FINANCE_STATUS.POSTED,
          ],
        },
      });
    }
    if (query.fromDate || query.toDate) {
      const occurredAt: Record<string, Date> = {};
      if (query.fromDate) occurredAt.gte = fundDayStart(query.fromDate);
      if (query.toDate) occurredAt.lt = this.nextFundDayStart(query.toDate);
      conditions.push({ occurredAt });
    }
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
          { customer: { code: { contains: search, mode: 'insensitive' } } },
          { packingSlip: { code: { contains: search, mode: 'insensitive' } } },
          {
            invoiceLinks: {
              some: {
                invoice: { code: { contains: search, mode: 'insensitive' } },
              },
            },
          },
        ],
      });
    }

    const where = { AND: conditions };
    const [rows, total] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: this.warehouseInclude(),
      }),
      this.prisma.internalFinanceEntry.count({ where }),
    ]);
    return {
      data: await this.decorateWarehouseRows(rows),
      total,
      page,
      limit,
    };
  }

  async getWarehouseReceipt(id: number) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      include: this.warehouseInclude(),
    });
    if (!entry || !this.isWarehouseReceipt(entry)) {
      throw new NotFoundException('Không tìm thấy phiếu thu tiền mặt');
    }
    const [decorated] = await this.decorateWarehouseRows([entry]);
    if (this.isWarehouseSale(decorated)) {
      return { ...decorated, allocatableInvoices: [] };
    }
    const customerIds = this.customerIdsFromEntry(decorated);
    const allocatableInvoices = customerIds.length
      ? await this.prisma.invoice.findMany({
          where: {
            customerId: { in: customerIds },
            debtAmount: { gt: 0 },
            status: { not: INVOICE_STATUS.CANCELLED },
          },
          select: {
            id: true,
            code: true,
            customerId: true,
            debtAmount: true,
            purchaseDate: true,
          },
          orderBy: [{ purchaseDate: 'asc' }, { id: 'asc' }],
        })
      : [];
    return { ...decorated, allocatableInvoices };
  }

  /** Điều kiện lọc phiếu chi kho theo quyền + bộ lọc (danh sách và báo cáo). */
  private async warehouseExpenseConditions(
    query: WarehouseExpenseQueryDto,
    user: any,
  ): Promise<any[]> {
    const allowedBranches = await this.allowedWarehouseExpenseBranches(
      user,
      'view',
    );
    if (!allowedBranches.length) {
      throw new ForbiddenException('Không có quyền xem phiếu chi kho');
    }
    if (
      query.branchId !== undefined &&
      !allowedBranches.includes(Number(query.branchId))
    ) {
      throw new ForbiddenException(
        'Không có quyền xem phiếu chi của chi nhánh này',
      );
    }
    const branchIds = query.branchId
      ? [Number(query.branchId)]
      : allowedBranches;
    const conditions: any[] = [
      { direction: INTERNAL_FINANCE_DIRECTION.EXPENSE },
      { branchId: { in: branchIds } },
      { category: { in: [...WAREHOUSE_EXPENSE_CATEGORIES] } },
      {
        NOT: {
          branchId: { in: [4, 7] },
          category: { in: ['DELIVERY_FEE', 'FUEL', 'VEHICLE_CARE'] },
        },
      },
    ];
    if (query.category) conditions.push({ category: query.category });
    if (query.status) conditions.push({ status: query.status });
    // Phiếu đã hủy chỉ hiện khi lọc đúng trạng thái đó hoặc tìm theo mã
    // (link "Mở phiếu chi" trong tin Lark).
    else if (!query.search?.trim()) {
      conditions.push({
        status: { not: INTERNAL_FINANCE_STATUS.CANCELLED },
      });
    }
    if (query.cashIssued === 'ISSUED') {
      conditions.push({ cashIssued: true });
    } else if (query.cashIssued === 'NOT_ISSUED') {
      conditions.push({ cashIssued: false });
    }
    if (query.checkStatus === 'CHECKED') {
      conditions.push({
        managerReviewedAt: { not: null },
        accountantReviewedAt: { not: null },
      });
    } else if (query.checkStatus === 'UNCHECKED') {
      conditions.push({
        OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
      });
    }
    if (query.payerId) conditions.push({ payerId: query.payerId });
    if (query.expenseItem) conditions.push({ expenseItem: query.expenseItem });
    if (query.vehicleId) conditions.push({ vehicleId: query.vehicleId });
    if (query.fromDate || query.toDate) {
      const occurredAt: Record<string, Date> = {};
      if (query.fromDate) {
        occurredAt.gte = fundDayStart(query.fromDate);
      }
      if (query.toDate) {
        occurredAt.lt = this.nextFundDayStart(query.toDate);
      }
      conditions.push({ occurredAt });
    }
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { note: { contains: search, mode: 'insensitive' } },
          { vehicleName: { contains: search, mode: 'insensitive' } },
          // Phiếu cũ lưu mã loại phí ("FEE_GUI_BEN - …"): tìm "Phí gửi bến" vẫn ra.
          ...Object.entries(PACKING_FEE_LABELS)
            .filter(([, label]) =>
              label.toLowerCase().includes(search.toLowerCase()),
            )
            .map(([code]) => ({
              description: { contains: code },
            })),
          {
            packingSlip: {
              code: { contains: search, mode: 'insensitive' },
            },
          },
        ],
      });
    }

    return conditions;
  }

  /**
   * Báo cáo nhanh "ai đã chi bao nhiêu": cộng tiền theo người chi trên toàn bộ
   * phiếu khớp bộ lọc của trang Phiếu chi kho.
   */
  async warehouseExpensePayerSummary(
    query: WarehouseExpenseQueryDto,
    user: any,
  ) {
    const conditions = await this.warehouseExpenseConditions(query, user);
    const groups = await this.prisma.internalFinanceEntry.groupBy({
      by: ['payerId'],
      where: { AND: conditions },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const ids = groups
      .map((group) => group.payerId)
      .filter((id): id is number => id !== null);
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((item) => [item.id, item.name]));
    const rows = groups
      .map((group) => ({
        payerId: group.payerId,
        name:
          group.payerId === null
            ? 'Chưa có người chi'
            : names.get(group.payerId) || `#${group.payerId}`,
        count: group._count._all,
        amount: Number(group._sum.amount || 0),
      }))
      .sort((a, b) =>
        a.payerId === null
          ? 1
          : b.payerId === null
            ? -1
            : a.name.localeCompare(b.name, 'vi'),
      );
    return {
      rows,
      total: rows.reduce((sum, row) => sum + row.amount, 0),
      count: rows.reduce((sum, row) => sum + row.count, 0),
    };
  }

  async listWarehouseExpenses(query: WarehouseExpenseQueryDto, user: any) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 50, 100);
    const conditions = await this.warehouseExpenseConditions(query, user);
    const where = { AND: conditions };
    const direction = query.orderDirection === 'asc' ? 'asc' : 'desc';
    // Sắp xếp theo cột (Ngày chi / Số tiền); cùng giá trị thì phiếu mới trước.
    const orderBy: Prisma.InternalFinanceEntryOrderByWithRelationInput[] =
      query.orderBy === 'amount'
        ? [{ amount: direction }, { occurredAt: 'desc' }, { id: 'desc' }]
        : [{ occurredAt: direction }, { id: direction }];
    const [data, total, sums, issued] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: this.warehouseExpenseInclude(),
      }),
      this.prisma.internalFinanceEntry.count({ where }),
      this.prisma.internalFinanceEntry.aggregate({
        where,
        _sum: { amount: true },
      }),
      this.prisma.internalFinanceEntry.aggregate({
        where: { AND: [...conditions, { cashIssued: true }] },
        _sum: { amount: true },
      }),
    ]);
    // Tổng của toàn bộ phiếu khớp bộ lọc (dòng tổng dưới tên cột).
    const totals = {
      amount: Number(sums._sum.amount || 0),
      issuedAmount: Number(issued._sum.amount || 0),
    };
    return { data, total, page, limit, totals };
  }

  async createWarehouseExpense(dto: CreateWarehouseExpenseDto, user: any) {
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    const money = this.resolveExpenseAmount(
      dto.amount,
      dto.quantity,
      dto.unitPrice,
    );
    await this.assertPayer(dto.payerId);
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: INTERNAL_FINANCE_CATEGORY.OTHER_EXPENSE,
      subCategory: INTERNAL_FINANCE_SUBCATEGORY.OTHER,
      branchId: dto.branchId,
      amount: money.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'MANUAL_EXPENSE',
      description: dto.description.trim(),
      attachments: dto.attachments,
      expenseItem: dto.expenseItem,
      quantity: money.quantity,
      unitPrice: money.unitPrice,
      note: dto.note?.trim() || undefined,
      payerId: dto.payerId ?? user.id,
      userId: user.id,
    });
  }

  async updateWarehouseExpense(
    id: number,
    dto: UpdateWarehouseExpenseDto,
    user: any,
  ) {
    const branchHint = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      select: { branchId: true },
    });
    if (!branchHint) throw new NotFoundException('Không tìm thấy khoản chi');
    await this.assertWarehouseExpensePermission(
      user,
      branchHint.branchId,
      'update',
    );
    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [branchHint.branchId]);
      const entry = await tx.internalFinanceEntry.findUnique({
        where: { id },
        include: { weeklyBatch: true },
      });
      if (!entry || entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE) {
        throw new NotFoundException('Không tìm thấy khoản chi');
      }
      if (entry.sourceType === LARK_APPROVAL_SOURCE_TYPE)
        throw new BadRequestException(LARK_APPROVAL_LOCK_REASON);
      if (entry.sourceType !== 'MANUAL_EXPENSE') {
        throw new BadRequestException(
          'Khoản chi từ báo đơn, xăng dầu hoặc chăm sóc xe phải sửa tại nguồn phát sinh',
        );
      }
      this.assertExpenseOpenForEdit(entry);
      const touchesMoney =
        dto.amount !== undefined ||
        dto.quantity !== undefined ||
        dto.unitPrice !== undefined;
      const money = touchesMoney
        ? this.resolveExpenseAmount(
            dto.amount ?? Number(entry.amount),
            dto.quantity !== undefined
              ? dto.quantity
              : numberOrNull(entry.quantity),
            dto.unitPrice !== undefined
              ? dto.unitPrice
              : numberOrNull(entry.unitPrice),
          )
        : null;
      await this.assertPayer(dto.payerId);
      return tx.internalFinanceEntry.update({
        where: { id },
        data: {
          amount: money?.amount,
          quantity: money ? money.quantity : undefined,
          unitPrice: money ? money.unitPrice : undefined,
          expenseItem: dto.expenseItem,
          note: dto.note !== undefined ? dto.note.trim() || null : undefined,
          payerId: dto.payerId,
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
          description:
            dto.description !== undefined ? dto.description.trim() : undefined,
          evidenceStatus: dto.attachments
            ? dto.attachments.length
              ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
              : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING
            : undefined,
          ...(dto.attachments
            ? {
                attachments: {
                  deleteMany: {},
                  ...(dto.attachments.length
                    ? {
                        create: dto.attachments.map((file) => ({
                          kind: file.kind || 'EVIDENCE',
                          fileUrl: file.fileUrl,
                          fileName: file.fileName,
                          fileType: file.fileType,
                          fileSize: file.fileSize,
                          createdBy: user.id,
                        })),
                      }
                    : {}),
                },
              }
            : {}),
        },
        include: this.warehouseExpenseInclude(),
      });
    });
  }

  async createWarehouseReceipt(dto: CreateWarehouseReceiptDto, userId: number) {
    this.assertWarehouseBranch(dto.branchId);
    const sale = dto.receiptKind === 'WAREHOUSE_SALE';
    const customers = sale
      ? { customerIds: [] as number[], invoiceIds: [] as number[] }
      : await this.resolveWarehouseCustomers(dto.customers || []);
    return this.prisma.$transaction(async (tx) => {
      const occurredAt = new Date(dto.occurredAt);
      const code = await this.codeService.nextCode(tx, {
        direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
        category: INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
        branchId: dto.branchId,
        occurredAt,
      });
      return tx.internalFinanceEntry.create({
        data: {
          code,
          direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
          category: INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
          subCategory: sale
            ? INTERNAL_FINANCE_SUBCATEGORY.WAREHOUSE_ITEM_SALE
            : INTERNAL_FINANCE_SUBCATEGORY.OTHER,
          branchId: dto.branchId,
          amount: dto.amount,
          occurredAt,
          sourceType: 'MANUAL_RECEIPT',
          sourceKey: `MANUAL_RECEIPT:${randomUUID()}`,
          sourceSnapshot: this.toJson({
            method: 'cash',
            note: dto.note || '',
            customerIds: customers.customerIds,
            receiptKind: sale ? 'WAREHOUSE_SALE' : 'CUSTOMER',
            manual: true,
          }),
          description:
            dto.description?.trim() || (sale ? 'Bán đồ kho' : 'Thu tiền mặt'),
          evidenceStatus: dto.attachments?.length
            ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
            : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
          status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
          requiresEvidence: false,
          customerId: customers.customerIds[0] || null,
          createdBy: userId,
          attachments: dto.attachments?.length
            ? {
                create: dto.attachments.map((file) => ({
                  kind: file.kind || 'EVIDENCE',
                  fileUrl: file.fileUrl,
                  fileName: file.fileName,
                  fileType: file.fileType,
                  fileSize: file.fileSize,
                  createdBy: userId,
                })),
              }
            : undefined,
          invoiceLinks: customers.invoiceIds.length
            ? {
                create: customers.invoiceIds.map((invoiceId) => ({
                  invoiceId,
                })),
              }
            : undefined,
        },
        include: this.warehouseInclude(),
      });
    });
  }

  async updateWarehouseReceipt(
    id: number,
    dto: UpdateWarehouseReceiptDto,
    userId: number,
  ) {
    const entry = await this.getOpenWarehouseReceipt(id);
    const snapshot = this.snapshotOf(entry);
    const auto = this.isAutoWarehouseReceipt(entry);
    if (auto) {
      if (
        dto.branchId !== undefined ||
        dto.amount !== undefined ||
        dto.occurredAt !== undefined ||
        dto.customers !== undefined ||
        dto.attachments !== undefined
      ) {
        throw new BadRequestException(
          'Dòng từ báo đơn chỉ sửa được nội dung và ghi chú',
        );
      }
      return this.prisma.internalFinanceEntry.update({
        where: { id },
        data: {
          description:
            dto.description !== undefined
              ? dto.description.trim()
              : entry.description,
          sourceSnapshot: this.toJson({
            ...snapshot,
            note: dto.note !== undefined ? dto.note : snapshot.note || '',
            contentEdited:
              dto.description !== undefined || Boolean(snapshot.contentEdited),
            noteEdited: dto.note !== undefined || Boolean(snapshot.noteEdited),
          }),
        },
        include: this.warehouseInclude(),
      });
    }

    const branchId = dto.branchId ?? entry.branchId;
    this.assertWarehouseBranch(branchId);
    const sale = dto.receiptKind
      ? dto.receiptKind === 'WAREHOUSE_SALE'
      : this.isWarehouseSale(entry);
    const customers = sale
      ? { customerIds: [] as number[], invoiceIds: [] as number[] }
      : dto.customers
        ? await this.resolveWarehouseCustomers(dto.customers)
        : null;
    const linkedInvoiceIds = customers?.invoiceIds ?? [];
    return this.prisma.internalFinanceEntry.update({
      where: { id },
      data: {
        branchId,
        amount: dto.amount ?? Number(entry.amount),
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
        description:
          dto.description !== undefined
            ? dto.description.trim()
            : entry.description,
        subCategory: sale
          ? INTERNAL_FINANCE_SUBCATEGORY.WAREHOUSE_ITEM_SALE
          : dto.receiptKind === 'CUSTOMER'
            ? INTERNAL_FINANCE_SUBCATEGORY.OTHER
            : undefined,
        customerId: sale
          ? null
          : customers
            ? customers.customerIds[0] || null
            : entry.customerId,
        evidenceStatus: dto.attachments
          ? dto.attachments.length
            ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
            : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING
          : undefined,
        sourceSnapshot: this.toJson({
          ...snapshot,
          method: 'cash',
          note: dto.note !== undefined ? dto.note : snapshot.note || '',
          customerIds: sale
            ? []
            : customers
              ? customers.customerIds
              : this.customerIdsFromEntry(entry),
          receiptKind: sale ? 'WAREHOUSE_SALE' : 'CUSTOMER',
          manual: true,
        }),
        ...(sale || customers
          ? {
              invoiceLinks: {
                deleteMany: {},
                ...(linkedInvoiceIds.length
                  ? {
                      create: linkedInvoiceIds.map((invoiceId) => ({
                        invoiceId,
                      })),
                    }
                  : {}),
              },
            }
          : {}),
        ...(dto.attachments
          ? {
              attachments: {
                deleteMany: {},
                ...(dto.attachments.length
                  ? {
                      create: dto.attachments.map((file) => ({
                        kind: file.kind || 'EVIDENCE',
                        fileUrl: file.fileUrl,
                        fileName: file.fileName,
                        fileType: file.fileType,
                        fileSize: file.fileSize,
                        createdBy: userId,
                      })),
                    }
                  : {}),
              },
            }
          : {}),
      },
      include: this.warehouseInclude(),
    });
  }

  async postWarehouseReceipt(
    id: number,
    dto: PostWarehouseReceiptDto,
    userId: number,
  ) {
    const entry = await this.getWarehouseReceipt(id);
    if (entry.status === INTERNAL_FINANCE_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu thu đã hủy');
    }
    if (entry.status === INTERNAL_FINANCE_STATUS.POSTED) {
      throw new ConflictException('Phiếu thu đã được lập');
    }
    const customers = this.customerIdsFromEntry(entry);
    const sale = this.isWarehouseSale(entry);
    if (!sale && !customers.length) {
      throw new BadRequestException('Phiếu thu chưa có khách hàng');
    }
    const allocations = sale
      ? [{ customerId: 0, amount: Number(entry.amount), invoices: [] }]
      : dto.allocations || [];
    if (!sale) {
      await this.validateWarehouseAllocations(entry, allocations, customers);
    }
    const snapshot = this.snapshotOf(entry);
    const posted = this.postedCashFlows(snapshot);
    const done = new Set(posted.map((item) => Number(item.customerId)));
    const complete = allocations.every((item) => done.has(item.customerId));
    if (complete && (entry.cashFlowId || posted.length)) {
      throw new ConflictException('Phiếu thu đã được lập');
    }

    if (entry.status === INTERNAL_FINANCE_STATUS.POSTING) {
      const updatedAt = new Date(entry.updatedAt || 0).getTime();
      if (Date.now() - updatedAt < 20000) {
        throw new ConflictException(
          'Phiếu thu đang được lập, vui lòng tải lại',
        );
      }
    } else {
      const claimed = await this.prisma.internalFinanceEntry.updateMany({
        where: {
          id,
          cashFlowId: null,
          status: {
            in: [
              INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
              INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
              INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
            ],
          },
        },
        data: { status: INTERNAL_FINANCE_STATUS.POSTING },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Phiếu thu đang được lập hoặc đã lập');
      }
    }

    let cashFlowId = entry.cashFlowId || null;
    if (sale && !entry.cashFlowId) {
      const created = await this.cashFlowsService.createStandaloneCashReceipt({
        branchId: entry.branchId,
        amount: Number(entry.amount),
        transDate: new Date(entry.occurredAt).toISOString(),
        description: entry.description || `Thu bán đồ kho ${entry.code}`,
        userId,
      });
      if (!created?.cashFlow?.id) {
        throw new BadRequestException('Không tạo được phiếu thu');
      }
      cashFlowId = created.cashFlow.id;
      posted.push({
        id: created.cashFlow.id,
        code: created.cashFlow.code,
        customerId: 0,
        amount: Number(entry.amount),
      });
      await this.prisma.internalFinanceEntry.update({
        where: { id },
        data: {
          status: INTERNAL_FINANCE_STATUS.POSTING,
          cashFlowId,
          sourceSnapshot: this.toJson({
            ...snapshot,
            method: 'cash',
            postedCashFlows: posted,
          }),
        },
      });
    }
    for (const allocation of sale ? [] : allocations) {
      if (done.has(allocation.customerId)) continue;
      const invoiceAllocs = (allocation.invoices || [])
        .filter((item) => Number(item.amount) > 0)
        .map((item) => ({
          invoiceId: item.invoiceId,
          amount: Number(item.amount),
        }));
      let result: { cashFlow?: { id: number; code: string } | null };
      try {
        result = await this.cashFlowsService.createCustomerPayment(
          {
            customerId: allocation.customerId,
            totalAmount: Number(allocation.amount),
            branchId: entry.branchId,
            transDate: new Date(entry.occurredAt).toISOString(),
            method: 'cash',
            collectorUserId: userId,
            description: entry.description || `Thu tiền mặt ${entry.code}`,
            ...(invoiceAllocs.length
              ? { allocateToInvoices: true, invoices: invoiceAllocs }
              : {}),
          } as any,
          userId,
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Không lập được phiếu thu',
        );
      }
      const cashFlow = result?.cashFlow;
      if (!cashFlow?.id) {
        throw new BadRequestException('Không tạo được phiếu thu');
      }
      posted.push({
        id: cashFlow.id,
        code: cashFlow.code,
        customerId: allocation.customerId,
        amount: Number(allocation.amount),
      });
      done.add(allocation.customerId);
      cashFlowId = cashFlowId || cashFlow.id;
      await this.prisma.internalFinanceEntry.update({
        where: { id },
        data: {
          status: INTERNAL_FINANCE_STATUS.POSTING,
          cashFlowId,
          sourceSnapshot: this.toJson({
            ...snapshot,
            method: 'cash',
            postedCashFlows: posted,
          }),
        },
      });
    }

    // Tiền thu tại kho vào quỹ nội bộ cùng lúc phiếu chuyển sang "Đã lập".
    return this.prisma.$transaction(async (tx) => {
      // Dòng đồng bộ về, hoặc phiếu đã có dòng trên sổ quỹ Lark (trước ngày
      // dùng POS), đã có bút toán trong sổ quỹ lịch sử: không cộng lần hai.
      if (
        !String(entry.sourceKey || '').startsWith('LARK_CASH:') &&
        !isLarkLedgerRecorded(entry)
      )
        await this.fundLedger.postSystemTransaction(tx, {
          branchId: entry.branchId,
          transactionType: 'RECEIPT',
          codeKind: 'THU',
          amount: entry.amount,
          occurredAt: new Date(entry.occurredAt),
          description: entry.description || entry.code,
          sourceType: FUND_SOURCE_TYPE.WAREHOUSE_CASH_RECEIPT,
          sourceKey: this.warehouseReceiptFundKey(id),
          sourceId: String(id),
          entryId: id,
          userId,
        });
      return tx.internalFinanceEntry.update({
        where: { id },
        data: {
          status: INTERNAL_FINANCE_STATUS.POSTED,
          posManagedAt: new Date(),
          cashFlowId,
          accountantReviewedBy: entry.accountantReviewedBy || userId,
          accountantReviewedAt: entry.accountantReviewedAt || new Date(),
          sourceSnapshot: this.toJson({
            ...snapshot,
            method: 'cash',
            postedCashFlows: posted,
          }),
        },
        include: this.warehouseInclude(),
      });
    });
  }

  private warehouseReceiptFundKey(entryId: number) {
    return `WAREHOUSE_RECEIPT:${entryId}`;
  }

  async cancelWarehouseReceipt(
    id: number,
    dto: CancelWarehouseReceiptDto,
    userId: number,
  ) {
    const entry = await this.getWarehouseReceipt(id);
    if (entry.status === INTERNAL_FINANCE_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu tiền mặt kho đã hủy');
    }
    if (
      entry.status === INTERNAL_FINANCE_STATUS.REJECTED ||
      entry.status === INTERNAL_FINANCE_STATUS.POSTING
    ) {
      throw new BadRequestException(
        'Không thể hủy phiếu ở trạng thái hiện tại',
      );
    }

    const cancelledCashFlows: Array<{ cashFlow: any; updated: any }> = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      cancelledCashFlows.push(
        ...(await this.cancelWarehouseReceiptCore(
          tx,
          entry,
          dto.cancelCashFlows,
          userId,
        )),
      );
      return tx.internalFinanceEntry.update({
        where: { id },
        data: { status: INTERNAL_FINANCE_STATUS.CANCELLED },
        include: this.warehouseInclude(),
      });
    });

    await this.logCancelledCashFlows(cancelledCashFlows, userId);

    return updated;
  }

  private receiptCashFlowIds(entry: any): number[] {
    return [
      ...new Set([
        ...this.postedCashFlows(this.snapshotOf(entry)).map((item) =>
          Number(item.id),
        ),
        ...(entry.cashFlowId ? [Number(entry.cashFlowId)] : []),
      ]),
    ]
      .filter((cashFlowId) => cashFlowId > 0)
      .sort((a, b) => a - b);
  }

  private async cancelWarehouseReceiptCore(
    tx: Prisma.TransactionClient,
    entry: any,
    cancelCashFlows: boolean,
    userId: number,
  ) {
    const cashFlowIds = this.receiptCashFlowIds(entry);
    const cancelled: Array<{ cashFlow: any; updated: any }> = [];
    if (cancelCashFlows) {
      for (const cashFlowId of cashFlowIds) {
        cancelled.push(
          await this.cashFlowsService.cancelInTransaction(tx, cashFlowId),
        );
      }
    }
    // Giữ phiếu thu công nợ thì tiền vẫn ở quỹ; hủy kèm (hoặc chưa có phiếu thu) thì rút khỏi quỹ.
    if (cancelCashFlows || !cashFlowIds.length) {
      await this.fundLedger.cancelBySource(
        tx,
        this.warehouseReceiptFundKey(entry.id),
        userId,
        'Hủy phiếu tiền mặt kho',
      );
    }
    await tx.internalFinanceEntry.update({
      where: { id: entry.id },
      data: {
        status: INTERNAL_FINANCE_STATUS.CANCELLED,
        posManagedAt: new Date(),
      },
    });
    return cancelled;
  }

  async logCancelledCashFlows(
    results: Array<{ cashFlow: any; updated: any }>,
    userId: number,
  ) {
    for (const result of results) {
      await this.cashFlowsService.logCancellation(result, userId);
    }
  }

  private async openPackingSlipEntries(db: DbClient, packingSlipId: number) {
    return db.internalFinanceEntry.findMany({
      where: {
        packingSlipId,
        status: {
          notIn: [
            INTERNAL_FINANCE_STATUS.REJECTED,
            INTERNAL_FINANCE_STATUS.CANCELLED,
          ],
        },
      },
      include: { weeklyBatch: { select: { id: true, status: true } } },
      orderBy: { id: 'asc' },
    });
  }

  private packingSlipCancelBlock(entries: any[]): string | null {
    for (const entry of entries) {
      if (entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE) {
        if (entry.cashIssued || entry.cashFlowId)
          return 'Không thể hủy báo đơn: khoản phí của báo đơn đã được ghi Đã chi';
        if (
          entry.weeklyBatch &&
          entry.weeklyBatch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.READY
        )
          return 'Không thể hủy báo đơn: khoản phí của báo đơn đã gửi Approval tuần';
      } else if (entry.status === INTERNAL_FINANCE_STATUS.POSTING) {
        return 'Phiếu thu của báo đơn đang được lập, vui lòng thử lại sau';
      }
    }
    return null;
  }

  // Cho màn báo đơn biết có cần hỏi "hủy kèm phiếu thu" trước khi hủy không.
  async packingSlipCancelCheck(packingSlipId: number) {
    const entries = await this.openPackingSlipEntries(
      this.prisma,
      packingSlipId,
    );
    return {
      receiptCashFlowCount: entries
        .filter(
          (entry: any) =>
            entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT,
        )
        .reduce(
          (sum: number, entry: any) =>
            sum + this.receiptCashFlowIds(entry).length,
          0,
        ),
      blockedReason: this.packingSlipCancelBlock(entries),
    };
  }

  async cancelPackingSlipEntriesInTransaction(
    tx: Prisma.TransactionClient,
    packingSlip: { id: number; branchId: number },
    userId: number,
    cancelCashFlows?: boolean,
  ) {
    await this.internalFund.lockBranch(tx, [Number(packingSlip.branchId)]);
    const entries = await this.openPackingSlipEntries(tx, packingSlip.id);
    const blocked = this.packingSlipCancelBlock(entries);
    if (blocked) throw new BadRequestException(blocked);
    const cancelled: Array<{ cashFlow: any; updated: any }> = [];
    for (const entry of entries) {
      if (entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT) {
        if (
          this.receiptCashFlowIds(entry).length &&
          cancelCashFlows === undefined
        ) {
          throw new BadRequestException(
            'Báo đơn đã có phiếu thu; cần chọn hủy kèm hay giữ phiếu thu',
          );
        }
        cancelled.push(
          ...(await this.cancelWarehouseReceiptCore(
            tx,
            entry,
            Boolean(cancelCashFlows),
            userId,
          )),
        );
        continue;
      }
      if (entry.weeklyBatchId) await this.fundLedger.detachFromBatch(tx, entry);
      await tx.internalFinanceEntry.update({
        where: { id: entry.id },
        data: { status: INTERNAL_FINANCE_STATUS.CANCELLED },
      });
    }
    return cancelled;
  }

  async createManualExpense(dto: CreateManualExpenseDto, user: any) {
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: dto.category,
      subCategory:
        dto.category === INTERNAL_FINANCE_CATEGORY.SALARY_ADVANCE
          ? INTERNAL_FINANCE_SUBCATEGORY.SALARY_ADVANCE
          : INTERNAL_FINANCE_SUBCATEGORY.OTHER,
      branchId: dto.branchId,
      amount: dto.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'MANUAL_EXPENSE',
      description: dto.description,
      sourceSnapshot: dto.sourceSnapshot,
      attachments: dto.attachments,
      userId: user.id,
    });
  }

  async createFuel(dto: CreateFuelEntryDto, user: any) {
    await this.vehicles.assertPermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    const vehicle = await this.vehicles.requireForBranch(
      dto.vehicleId,
      dto.branchId,
    );
    await this.assertPayer(dto.payerId);
    const liters = fuelLiters(dto.amount, dto.unitPrice, dto.liters);
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: INTERNAL_FINANCE_CATEGORY.FUEL,
      subCategory: INTERNAL_FINANCE_SUBCATEGORY.FUEL,
      branchId: dto.branchId,
      amount: dto.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'FUEL',
      description: `Xăng dầu - ${vehicle.label}`,
      sourceSnapshot: {
        vehicle: vehicle.label,
        location: dto.location,
        unitPrice: dto.unitPrice,
        liters: liters ?? undefined,
        odo: dto.odo,
      },
      vehicleId: vehicle.id,
      vehicleName: vehicle.label,
      vehicleOdo: dto.odo,
      vehicleLiters: liters ?? undefined,
      vehicleUnitPrice: dto.unitPrice,
      vehicleLocation: dto.location?.trim() || undefined,
      expenseItem: WAREHOUSE_EXPENSE_ITEM.FUEL,
      note: dto.note?.trim() || undefined,
      payerId: dto.payerId ?? user.id,
      attachments: dto.attachments,
      userId: user.id,
      include: this.vehicleEntryInclude(),
    });
  }

  async createVehicleCare(dto: CreateVehicleCareEntryDto, user: any) {
    await this.vehicles.assertPermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    const vehicle = await this.vehicles.requireForBranch(
      dto.vehicleId,
      dto.branchId,
    );
    await this.assertPayer(dto.payerId);
    const serviceTypes = Array.from(new Set(dto.serviceTypes));
    const serviceLabel = serviceTypes.join(', ');
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE,
      subCategory: INTERNAL_FINANCE_SUBCATEGORY.VEHICLE_CARE,
      branchId: dto.branchId,
      amount: dto.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'VEHICLE_CARE',
      description: `${serviceLabel} - ${vehicle.label}`,
      sourceSnapshot: {
        vehicle: vehicle.label,
        serviceType: serviceLabel,
        location: dto.location,
        odo: dto.odo,
        dueAt: dto.dueAt ? fundDateKey(dto.dueAt) : undefined,
      },
      vehicleId: vehicle.id,
      vehicleName: vehicle.label,
      vehicleServiceType: serviceLabel,
      vehicleServiceTypes: serviceTypes,
      vehicleDueAt: dto.dueAt ? fundClosingDate(dto.dueAt) : undefined,
      vehicleOdo: dto.odo,
      vehicleLocation: dto.location?.trim() || undefined,
      expenseItem: WAREHOUSE_EXPENSE_ITEM.VEHICLE_CARE,
      note: dto.note?.trim() || undefined,
      payerId: dto.payerId ?? user.id,
      attachments: dto.attachments,
      userId: user.id,
      include: this.vehicleEntryInclude(),
    });
  }

  async listVehicleEntries(query: VehicleEntryQueryDto, user: any) {
    const allowed = await this.vehicles.allowedBranches(user, ['view']);
    if (!allowed.length) {
      throw new ForbiddenException('Không có quyền xem phiếu xe');
    }
    if (query.branchId !== undefined && !allowed.includes(query.branchId)) {
      throw new ForbiddenException(
        'Không có quyền xem phiếu xe của chi nhánh này',
      );
    }
    const page = query.page || 1;
    const limit = Math.min(query.limit || 50, 100);
    const branchIds = query.branchId ? [query.branchId] : allowed;
    const isFuel = query.category === INTERNAL_FINANCE_CATEGORY.FUEL;
    const conditions: any[] = [
      { direction: INTERNAL_FINANCE_DIRECTION.EXPENSE },
      { category: query.category },
      { branchId: { in: branchIds } },
      // Phiếu đã hủy chỉ hiện khi lọc đúng trạng thái đó hoặc tìm theo mã
      // (link "Sửa ở Xe cộ" trong tin Lark).
      query.status
        ? { status: query.status }
        : query.search?.trim()
          ? {}
          : { status: { not: INTERNAL_FINANCE_STATUS.CANCELLED } },
    ];
    if (query.vehicleId) conditions.push({ vehicleId: query.vehicleId });
    if (query.serviceType) {
      conditions.push({ vehicleServiceTypes: { has: query.serviceType } });
    }
    if (query.fromDate || query.toDate) {
      const occurredAt: Record<string, Date> = {};
      if (query.fromDate) occurredAt.gte = fundDayStart(query.fromDate);
      if (query.toDate) occurredAt.lt = this.nextFundDayStart(query.toDate);
      conditions.push({ occurredAt });
    }
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { vehicleName: { contains: search, mode: 'insensitive' } },
          { vehicleLocation: { contains: search, mode: 'insensitive' } },
          { note: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (query.check && isFuel) {
      const vehicleIds = query.vehicleId
        ? [query.vehicleId]
        : (
            await this.prisma.vehicle.findMany({
              where: { branchId: { in: branchIds } },
              select: { id: true },
            })
          ).map((vehicle) => vehicle.id);
      const metrics = await this.vehicles.fuelMetrics(vehicleIds);
      const matched: number[] = [];
      for (const [entryId, item] of metrics) {
        const checks = [item.consumptionCheck, item.costCheck];
        const abnormal = checks.includes(VEHICLE_CHECK.ABNORMAL);
        const normal = checks.includes(VEHICLE_CHECK.NORMAL);
        if (
          query.check === VEHICLE_CHECK.ABNORMAL
            ? abnormal
            : normal && !abnormal
        ) {
          matched.push(entryId);
        }
      }
      conditions.push({ id: { in: matched } });
    }

    const where = { AND: conditions };
    const [rows, total] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: this.vehicleEntryInclude(),
      }),
      this.prisma.internalFinanceEntry.count({ where }),
    ]);
    if (!isFuel) return { data: rows, total, page, limit };

    const metrics = await this.vehicles.fuelMetrics(
      rows.map((row: any) => row.vehicleId).filter(Boolean),
    );
    return {
      data: rows.map((row: any) => ({
        ...row,
        metrics: metrics.get(row.id) || null,
      })),
      total,
      page,
      limit,
    };
  }

  async updateVehicleEntry(id: number, dto: UpdateVehicleEntryDto, user: any) {
    const branchHint = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      select: { branchId: true },
    });
    if (!branchHint) throw new NotFoundException('Không tìm thấy phiếu xe');
    await this.vehicles.assertPermission(user, branchHint.branchId, 'update');
    await this.assertPayer(dto.payerId);
    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [branchHint.branchId]);
      const entry = await tx.internalFinanceEntry.findUnique({ where: { id } });
      this.assertVehicleEntry(entry);
      this.assertExpenseOpenForEdit(entry);

      const isFuel = entry.category === INTERNAL_FINANCE_CATEGORY.FUEL;
      const vehicle =
        dto.vehicleId !== undefined && dto.vehicleId !== entry.vehicleId
          ? await this.vehicles.requireForBranch(dto.vehicleId, entry.branchId)
          : null;
      const vehicleLabel = vehicle?.label ?? entry.vehicleName ?? '';
      const serviceTypes =
        !isFuel && dto.serviceTypes
          ? Array.from(new Set(dto.serviceTypes))
          : null;
      const serviceLabel = serviceTypes
        ? serviceTypes.join(', ')
        : entry.vehicleServiceType || '';
      const amount = dto.amount ?? Number(entry.amount);
      const unitPrice =
        dto.unitPrice !== undefined
          ? dto.unitPrice
          : numberOrNull(entry.vehicleUnitPrice);
      const fuelChanged =
        dto.amount !== undefined ||
        dto.unitPrice !== undefined ||
        dto.liters !== undefined;
      const liters =
        isFuel && fuelChanged
          ? fuelLiters(amount, unitPrice, dto.liters)
          : undefined;
      const snapshot = this.snapshotOf(entry);

      return tx.internalFinanceEntry.update({
        where: { id },
        data: {
          amount: dto.amount,
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
          ...(vehicle
            ? { vehicleId: vehicle.id, vehicleName: vehicle.label }
            : {}),
          vehicleOdo: dto.odo,
          vehicleLocation:
            dto.location !== undefined
              ? dto.location.trim() || null
              : undefined,
          ...(isFuel
            ? { vehicleUnitPrice: dto.unitPrice, vehicleLiters: liters }
            : {
                ...(serviceTypes
                  ? {
                      vehicleServiceTypes: serviceTypes,
                      vehicleServiceType: serviceLabel,
                    }
                  : {}),
                vehicleDueAt:
                  dto.dueAt === undefined
                    ? undefined
                    : dto.dueAt
                      ? fundClosingDate(dto.dueAt)
                      : null,
              }),
          note: dto.note !== undefined ? dto.note.trim() || null : undefined,
          payerId: dto.payerId,
          // Phiếu chuyển từ Lark giữ nguyên nội dung gốc.
          description:
            entry.sourceType === 'LARK_IMPORT'
              ? undefined
              : isFuel
                ? `Xăng dầu - ${vehicleLabel}`
                : `${serviceLabel} - ${vehicleLabel}`,
          sourceSnapshot: this.toJson({
            ...snapshot,
            vehicle: vehicleLabel,
            ...(isFuel ? {} : { serviceType: serviceLabel }),
            ...(dto.location !== undefined ? { location: dto.location } : {}),
            ...(dto.odo !== undefined ? { odo: dto.odo } : {}),
            ...(isFuel && dto.unitPrice !== undefined
              ? { unitPrice: dto.unitPrice }
              : {}),
            ...(liters !== undefined ? { liters } : {}),
            ...(!isFuel && dto.dueAt !== undefined
              ? { dueAt: dto.dueAt ? fundDateKey(dto.dueAt) : null }
              : {}),
          }),
          ...(dto.attachments
            ? {
                evidenceStatus: dto.attachments.length
                  ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
                  : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
                attachments: {
                  deleteMany: {},
                  ...(dto.attachments.length
                    ? {
                        create: dto.attachments.map((file) => ({
                          kind: file.kind || 'EVIDENCE',
                          fileUrl: file.fileUrl,
                          fileName: file.fileName,
                          fileType: file.fileType,
                          fileSize: file.fileSize,
                          createdBy: user.id,
                        })),
                      }
                    : {}),
                },
              }
            : {}),
        },
        include: this.vehicleEntryInclude(),
      });
    });
  }

  async cancelVehicleEntry(id: number, user: any, reason: string) {
    const trimmed = this.requireCancelReason(reason);
    const branchHint = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      select: { branchId: true },
    });
    if (!branchHint) throw new NotFoundException('Không tìm thấy phiếu xe');
    await this.vehicles.assertPermission(user, branchHint.branchId, 'update');
    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [branchHint.branchId]);
      const entry = await tx.internalFinanceEntry.findUnique({
        where: { id },
        include: { weeklyBatch: { select: { status: true } } },
      });
      this.assertVehicleEntry(entry);
      return this.cancelExpenseInTx(
        tx,
        entry,
        user,
        trimmed,
        this.vehicleEntryInclude(),
      );
    });
  }

  async review(
    id: number,
    role: string,
    dto: ReviewInternalFinanceDto,
    userId: number,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy dòng tài chính');
    if (entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE) {
      await this.assertWarehouseExpensePermissionByUserId(
        userId,
        entry.branchId,
        'update',
      );
    } else {
      await this.assertCashFlowPermission(userId, entry.branchId, 'update');
    }

    if (role === 'accountant') {
      if (entry.status !== INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT) {
        throw new BadRequestException(
          'Dòng tài chính không còn ở bước kiểm tra kế toán',
        );
      }
      return this.reviewAsAccountant(entry, dto, userId);
    }
    if (role === 'manager') {
      if (entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT) {
        throw new BadRequestException('Phiếu thu không cần bước duyệt quản lý');
      }
      if (entry.status !== INTERNAL_FINANCE_STATUS.PENDING_MANAGER) {
        throw new BadRequestException(
          'Dòng tài chính không còn ở bước kiểm tra quản lý',
        );
      }
      return this.reviewAsManager(entry, dto, userId);
    }
    throw new BadRequestException('Vai trò review không hợp lệ');
  }

  async addAttachments(
    id: number,
    dto: AddInternalFinanceAttachmentsDto,
    userId: number,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy dòng tài chính');
    if (entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE) {
      await this.assertWarehouseExpensePermissionByUserId(
        userId,
        entry.branchId,
        'update',
      );
    } else {
      await this.assertCashFlowPermission(userId, entry.branchId, 'update');
    }
    if (
      [
        INTERNAL_FINANCE_STATUS.POSTED,
        INTERNAL_FINANCE_STATUS.REJECTED,
        INTERNAL_FINANCE_STATUS.CANCELLED,
      ].includes(entry.status as any)
    ) {
      throw new BadRequestException(
        'Dòng tài chính đã kết thúc, không thể bổ sung chứng từ',
      );
    }
    if (!dto.attachments?.length) {
      throw new BadRequestException('Cần có ít nhất một chứng từ');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.internalFinanceAttachment.createMany({
        data: dto.attachments.map((file) => ({
          entryId: id,
          kind: file.kind || 'EVIDENCE',
          fileUrl: file.fileUrl,
          fileName: file.fileName,
          fileType: file.fileType,
          fileSize: file.fileSize,
          createdBy: userId,
        })),
      });
      return tx.internalFinanceEntry.update({
        where: { id },
        data: {
          evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
          exceptionReason: null,
          exceptionDueAt: null,
        },
        include: this.entryInclude(),
      });
    });
  }

  private buildEntryWhere(query: InternalFinanceQueryDto): any {
    const conditions: any[] = [];

    if (query.branchIds?.length) {
      conditions.push({ branchId: { in: query.branchIds } });
    }
    if (query.direction) conditions.push({ direction: query.direction });
    if (query.category) conditions.push({ category: query.category });
    if (query.subCategory) conditions.push({ subCategory: query.subCategory });
    if (query.status) conditions.push({ status: query.status });
    if (query.accountantStatus === 'PENDING') {
      conditions.push({ status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT });
    } else if (query.accountantStatus === 'APPROVED') {
      conditions.push({
        status: {
          in: [
            INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
            INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
            INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
            INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
            INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL,
            INTERNAL_FINANCE_STATUS.APPROVED,
            INTERNAL_FINANCE_STATUS.POSTED,
          ],
        },
      });
    }
    if (query.managerStatus === 'PENDING') {
      conditions.push({ status: INTERNAL_FINANCE_STATUS.PENDING_MANAGER });
    } else if (query.managerStatus === 'APPROVED') {
      conditions.push({
        status: {
          in: [
            INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
            INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
            INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL,
            INTERNAL_FINANCE_STATUS.APPROVED,
            INTERNAL_FINANCE_STATUS.POSTED,
          ],
        },
      });
    } else if (query.managerStatus === 'NOT_REQUIRED') {
      conditions.push({ direction: INTERNAL_FINANCE_DIRECTION.RECEIPT });
    }
    if (query.weeklyApprovalStatus === 'READY') {
      conditions.push({
        status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
      });
    } else if (query.weeklyApprovalStatus === 'IN_APPROVAL') {
      conditions.push({ status: INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL });
    } else if (query.weeklyApprovalStatus === 'APPROVED') {
      conditions.push({
        status: {
          in: [
            INTERNAL_FINANCE_STATUS.APPROVED,
            INTERNAL_FINANCE_STATUS.POSTED,
          ],
        },
      });
    } else if (query.weeklyApprovalStatus === 'NOT_REQUIRED') {
      conditions.push({ direction: INTERNAL_FINANCE_DIRECTION.RECEIPT });
    }
    if (query.posted === 'POSTED') {
      conditions.push({ cashFlowId: { not: null } });
    }
    if (query.posted === 'UNPOSTED') {
      conditions.push({ cashFlowId: null });
    }
    if (query.cashIssued === 'ISSUED') {
      conditions.push({ cashIssued: true });
    } else if (query.cashIssued === 'NOT_ISSUED') {
      conditions.push({ cashIssued: false });
    }
    if (query.evidenceStatus) {
      conditions.push({ evidenceStatus: query.evidenceStatus });
    }
    if (query.sourceType) conditions.push({ sourceType: query.sourceType });
    if (query.fromDate || query.toDate) {
      const occurredAt: Record<string, Date> = {};
      if (query.fromDate) {
        occurredAt.gte = fundDayStart(query.fromDate);
      }
      if (query.toDate) {
        occurredAt.lt = this.nextFundDayStart(query.toDate);
      }
      conditions.push({ occurredAt });
    }
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    return conditions.length ? { AND: conditions } : {};
  }

  async findWeeklyBatches(query: InternalFinanceQueryDto) {
    return this.loadWeeklyBatches(
      this.weeklyBatchWhere(query),
      0,
      Math.min(query.limit || 50, 100),
    );
  }

  /** Approval tuần có phân trang, kèm tổng số batch và tổng tiền mọi trang. */
  async findWeeklyBatchPage(query: InternalFinanceQueryDto) {
    const where = this.weeklyBatchWhere(query);
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(query.limit || 20, 100);
    const [data, summary] = await Promise.all([
      this.loadWeeklyBatches(where, (page - 1) * limit, limit),
      this.prisma.internalFinanceWeeklyBatch.aggregate({
        where,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
    ]);
    return {
      data,
      total: summary._count._all,
      totalAmount: Number(summary._sum.totalAmount || 0),
      page,
      limit,
    };
  }

  private weeklyBatchWhere(query: InternalFinanceQueryDto) {
    const where: any = {};
    if (query.branchIds?.length) where.branchId = { in: query.branchIds };
    if (query.status) where.status = query.status;
    if (query.fromDate || query.toDate) {
      where.weekStart = {};
      if (query.fromDate) {
        // Mốc tuần lưu theo đầu ngày giờ VN (12/10 0h VN = 11/10 17h UTC).
        where.weekStart.gte = fundDayStart(query.fromDate);
      }
      if (query.toDate) {
        where.weekStart.lte = fundDayStart(query.toDate);
      }
    }
    return where;
  }

  private async loadWeeklyBatches(where: any, skip: number, take: number) {
    const batches = await this.prisma.internalFinanceWeeklyBatch.findMany({
      where,
      orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
      skip,
      take,
      include: {
        branch: { select: { id: true, name: true } },
        approvalRequest: {
          select: {
            id: true,
            status: true,
            instanceCode: true,
            currentNode: true,
          },
        },
        _count: { select: { entries: true } },
      },
    });
    const ids = batches.map((batch) => batch.id);
    if (!ids.length) return [];
    const cashIssuedRows = await this.prisma.internalFinanceEntry.groupBy({
      by: ['weeklyBatchId'],
      where: {
        weeklyBatchId: { in: ids },
        cashIssued: true,
      },
      _count: { _all: true },
    });
    const cashIssuedByBatch = new Map(
      cashIssuedRows.map((row) => [row.weeklyBatchId, row._count._all]),
    );
    return batches.map((batch) => ({
      ...batch,
      cashIssuedCount: cashIssuedByBatch.get(batch.id) || 0,
    }));
  }

  async findWeeklyBatch(id: number) {
    const batch = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        approvalRequest: {
          select: {
            id: true,
            status: true,
            instanceCode: true,
            currentNode: true,
          },
        },
        entries: {
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          include: {
            branch: { select: { id: true, name: true } },
            packingSlip: { select: { id: true, code: true } },
            cashIssuer: { select: { id: true, name: true } },
            payer: { select: { id: true, name: true } },
            vehicle: { select: { id: true, label: true, plate: true } },
            attachments: true,
            invoiceLinks: {
              include: { invoice: { select: { id: true, code: true } } },
            },
          },
        },
        _count: { select: { entries: true } },
      },
    });
    if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
    return batch;
  }

  async prepareWeeklyBatch(dto: PrepareWeeklyBatchDto, userId: number) {
    return this.prepareWeeklyBatchInternal(dto, userId, {
      eligibleStatuses: [
        INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
      ],
    });
  }

  async prepareWarehouseExpenseBatch(dto: PrepareWeeklyBatchDto, user: any) {
    await this.assertWeeklyApprovalPermission(user, dto.branchId, 'prepare');
    // Kho: chỉ gom phiếu đã được cả quản lý kho và kế toán kho tick.
    if (this.isWarehouseBranch(dto.branchId)) {
      return this.prepareWeeklyBatchInternal(dto, user.id, {
        eligibleStatuses: [
          INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
          INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
        ],
        allowedCategories: [...WAREHOUSE_EXPENSE_CATEGORIES],
        requireBothChecks: true,
      });
    }
    return this.prepareWeeklyBatchInternal(dto, user.id, {
      eligibleStatuses: [
        INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
        INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
        INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        INTERNAL_FINANCE_STATUS.APPROVED,
        INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
      ],
      allowedCategories: [4, 7].includes(dto.branchId)
        ? ['OTHER_EXPENSE']
        : [...WAREHOUSE_EXPENSE_CATEGORIES],
    });
  }

  private async prepareWeeklyBatchInternal(
    dto: PrepareWeeklyBatchDto,
    userId: number,
    options: {
      eligibleStatuses: string[];
      allowedCategories?: string[];
      requireBothChecks?: boolean;
    },
  ) {
    await this.validateBranch(dto.branchId);
    const weekStart = fundDayStart(dto.weekStart);
    const weekEnd = new Date(
      fundDayStart(dto.weekEnd).getTime() + 86400000 - 1,
    );
    if (weekStart > weekEnd) {
      throw new BadRequestException('Tuần có ngày bắt đầu sau ngày kết thúc');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [dto.branchId]);
      const existing = await tx.internalFinanceWeeklyBatch.findUnique({
        where: {
          branchId_weekStart_weekEnd: {
            branchId: dto.branchId,
            weekStart,
            weekEnd,
          },
        },
        include: {
          entries: true,
          branch: true,
          approvalRequest: true,
        },
      });
      if (
        existing &&
        ![
          INTERNAL_FINANCE_WEEKLY_STATUS.DRAFT,
          INTERNAL_FINANCE_WEEKLY_STATUS.READY,
        ].includes(existing.status as any)
      ) {
        throw new BadRequestException(
          'Batch tuần đã được gửi Approval hoặc đã ghi nhận, không thể chuẩn bị lại',
        );
      }

      const entries = await tx.internalFinanceEntry.findMany({
        where: {
          branchId: dto.branchId,
          direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
          status: { in: options.eligibleStatuses },
          ...(options.allowedCategories?.length
            ? { category: { in: options.allowedCategories } }
            : {}),
          cashFlowId: null,
          cashIssued: false,
          // Kho: dòng đồng bộ về cũng gom được khi đã đủ hai tick. Chi nhánh
          // khác giữ nguyên: khoản nhập lịch sử chỉ để hiển thị.
          ...(options.requireBothChecks
            ? {
                managerReviewedAt: { not: null },
                accountantReviewedAt: { not: null },
              }
            : { sourceType: { not: 'LARK_IMPORT' } }),
          OR: [
            // Phiếu trong tuần (chưa vào tuần nào, hoặc đang ở batch này).
            {
              occurredAt: { gte: weekStart, lte: weekEnd },
              weeklyBatchId: existing ? { in: [existing.id] } : null,
            },
            ...(existing
              ? [
                  {
                    occurredAt: { gte: weekStart, lte: weekEnd },
                    weeklyBatchId: null,
                  },
                  // Phiếu sót tuần trước đã được thêm tay vào batch: giữ lại.
                  { occurredAt: { lt: weekStart }, weeklyBatchId: existing.id },
                ]
              : []),
          ],
        },
        select: { id: true, amount: true },
      });
      if (entries.length === 0) {
        if (existing && !options.requireBothChecks) return existing;
        if (existing) {
          // Không còn phiếu đủ điều kiện: trả các phiếu cũ về trước khi gom.
          await tx.internalFinanceEntry.updateMany({
            where: { weeklyBatchId: existing.id },
            data: {
              weeklyBatchId: null,
              status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
            },
          });
          await tx.internalFinanceWeeklyBatch.delete({
            where: { id: existing.id },
          });
        }
        const reason = options.requireBothChecks
          ? await this.explainNoEligibleEntries(tx, {
              branchId: dto.branchId,
              weekStart,
              weekEnd,
              categories: options.allowedCategories,
              excludeBatchId: existing?.id,
              carryOverIgnored: true,
            })
          : '';
        throw new BadRequestException(
          `Không có khoản chi đủ điều kiện để tổng hợp tuần${reason}`,
        );
      }

      const totalAmount = entries.reduce(
        (sum, entry) => sum + Number(entry.amount),
        0,
      );
      const calendarStart = new Date(`${fundDateKey(weekStart)}T00:00:00Z`);
      const code = `TCNB-TUAN-${
        INTERNAL_FINANCE_BRANCH_CODES[dto.branchId] || `B${dto.branchId}`
      }-${calendarStart.getUTCFullYear()}-W${String(
        this.isoWeek(calendarStart),
      ).padStart(2, '0')}-${fundDateKey(weekStart)}-${fundDateKey(weekEnd)}`;

      if (existing) {
        // Gom lại batch chưa gửi: phiếu bị bỏ ra (vd bỏ tích gộp phiếu sót)
        // trả về trạng thái chờ gom, không kẹt ở "đã gom tuần".
        const keep = new Set(entries.map((entry) => entry.id));
        const dropped = existing.entries
          .filter((entry) => !keep.has(entry.id))
          .map((entry) => entry.id);
        if (dropped.length)
          await tx.internalFinanceEntry.updateMany({
            where: {
              id: { in: dropped },
              status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
            },
            data: { status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED },
          });
      }

      const batch = await tx.internalFinanceWeeklyBatch.upsert({
        where: {
          branchId_weekStart_weekEnd: {
            branchId: dto.branchId,
            weekStart,
            weekEnd,
          },
        },
        create: {
          code,
          branchId: dto.branchId,
          weekStart,
          weekEnd,
          totalAmount,
          status: INTERNAL_FINANCE_WEEKLY_STATUS.READY,
          preparedAt: new Date(),
          createdBy: userId,
          entries: {
            connect: entries.map((entry) => ({ id: entry.id })),
          },
        },
        update: {
          totalAmount,
          preparedAt: new Date(),
          status: INTERNAL_FINANCE_WEEKLY_STATUS.READY,
          entries: {
            set: entries.map((entry) => ({ id: entry.id })),
          },
        },
        include: { entries: true, branch: true },
      });

      await tx.internalFinanceEntry.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) } },
        data: {
          status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
          posManagedAt: new Date(),
        },
      });

      return batch;
    });
  }

  // Kho: nói rõ vì sao khoảng ngày không gom được phiếu nào.
  private async explainNoEligibleEntries(
    tx: Prisma.TransactionClient,
    scope: {
      branchId: number;
      weekStart: Date;
      weekEnd: Date;
      categories?: string[];
      excludeBatchId?: number;
      /** Đang bỏ tích "Gộp phiếu sót": báo số phiếu sót bị bỏ qua. */
      carryOverIgnored?: boolean;
    },
  ) {
    const base: Prisma.InternalFinanceEntryWhereInput = {
      branchId: scope.branchId,
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      occurredAt: { gte: scope.weekStart, lte: scope.weekEnd },
      status: { not: INTERNAL_FINANCE_STATUS.CANCELLED },
      ...(scope.categories?.length
        ? { category: { in: scope.categories } }
        : {}),
    };
    const free: Prisma.InternalFinanceEntryWhereInput = scope.excludeBatchId
      ? {
          OR: [
            { weeklyBatchId: null },
            { weeklyBatchId: scope.excludeBatchId },
          ],
        }
      : { weeklyBatchId: null };
    const [inOtherBatch, issued, unchecked] = await Promise.all([
      tx.internalFinanceEntry.count({
        where: {
          ...base,
          weeklyBatchId: { not: null },
          ...(scope.excludeBatchId
            ? { NOT: { weeklyBatchId: scope.excludeBatchId } }
            : {}),
        },
      }),
      tx.internalFinanceEntry.count({
        where: {
          AND: [
            base,
            free,
            { OR: [{ cashIssued: true }, { cashFlowId: { not: null } }] },
          ],
        },
      }),
      tx.internalFinanceEntry.count({
        where: {
          AND: [
            base,
            free,
            { cashIssued: false, cashFlowId: null },
            {
              OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
            },
          ],
        },
      }),
    ]);
    const range = [scope.weekStart, scope.weekEnd]
      .map((date) => fundDateKey(date).split('-').reverse().join('/'))
      .join('–');
    const leftover = scope.carryOverIgnored
      ? await tx.internalFinanceEntry.count({
          where: {
            branchId: scope.branchId,
            direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
            occurredAt: {
              gte: CARRY_OVER_FROM,
              lt: scope.weekStart,
            },
            weeklyBatchId: null,
            cashIssued: false,
            cashFlowId: null,
            managerReviewedAt: { not: null },
            accountantReviewedAt: { not: null },
            status: {
              in: [
                INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
                INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
              ],
            },
            ...(scope.categories?.length
              ? { category: { in: scope.categories } }
              : {}),
          },
        })
      : 0;
    const parts = [
      unchecked && `${unchecked} phiếu chưa đủ tick Quản lý kho/Kế toán kho`,
      issued && `${issued} phiếu đã chi`,
      inOtherBatch && `${inOtherBatch} phiếu đã thuộc batch tuần khác`,
      leftover &&
        `${leftover} phiếu sót tuần trước (thêm vào approval sau khi đã có batch tuần này)`,
    ].filter(Boolean);
    return ` ${range}: ${
      parts.length
        ? parts.join(', ')
        : 'không có phiếu chi nào trong khoảng này'
    }`;
  }

  async createWeeklyApproval(
    batchId: number,
    userId: number,
    detailUrl?: string,
    viewUrl?: string,
  ) {
    const batch = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id: batchId },
      include: { branch: true },
    });
    if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
    if (batch.approvalRequestId) {
      return this.approvalLifecycle.findOne(batch.approvalRequestId);
    }
    if (batch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.READY) {
      throw new BadRequestException('Batch chưa sẵn sàng tạo Approval');
    }

    const kind =
      batch.branchId === 6
        ? 'EXPENSE_HN'
        : batch.branchId === 1
          ? 'EXPENSE_SG'
          : 'EXPENSE_VP';
    const from = fundDateKey(batch.weekStart);
    const to = fundDateKey(batch.weekEnd);
    const week = String(this.isoWeek(new Date(`${from}T00:00:00Z`)));
    const ids =
      kind === 'EXPENSE_HN'
        ? EXPENSE_FIELD_IDS.HN
        : kind === 'EXPENSE_SG'
          ? EXPENSE_FIELD_IDS.SG
          : EXPENSE_FIELD_IDS.VP;
    const form: ApprovalFormItem[] = [
      { id: ids.week, type: 'input', value: week },
      { id: ids.from, type: 'input', value: from },
      { id: ids.to, type: 'input', value: to },
      {
        id: EXPENSE_FIELD_IDS.common.amount,
        type: 'amount',
        value: Number(batch.totalAmount),
      },
      {
        id: EXPENSE_FIELD_IDS.common.detail,
        type: 'input',
        value: detailUrl || this.batchLink(batch.id),
      },
      {
        id: EXPENSE_FIELD_IDS.common.view,
        type: 'input',
        value: viewUrl || this.batchLink(batch.id),
      },
    ];
    if (kind === 'EXPENSE_VP') {
      form.push(
        {
          id: EXPENSE_FIELD_IDS.VP.method,
          type: 'radioV2',
          value: 'ml65570v-ih3r0g47mu-0',
        },
        {
          id: EXPENSE_FIELD_IDS.VP.cashSource,
          type: 'radioV2',
          value:
            batch.branchId === 7
              ? 'ml657iu1-n0lwb0zjbi-0'
              : 'ml657iu1-7mvb2xfgje6-0',
        },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [batch.branchId]);
      const claimed = await tx.internalFinanceWeeklyBatch.updateMany({
        where: {
          id: batch.id,
          status: 'READY',
          approvalRequestId: null,
          updatedAt: batch.updatedAt,
        },
        data: { status: 'IN_APPROVAL' },
      });
      if (claimed.count !== 1)
        throw new ConflictException('Batch đã thay đổi hoặc đang gửi Approval');
      await tx.internalFinanceEntry.updateMany({
        where: { weeklyBatchId: batch.id, status: 'READY_FOR_WEEKLY_APPROVAL' },
        data: { status: 'IN_WEEKLY_APPROVAL' },
      });
    });

    try {
      const request = await this.approvalLifecycle.create(
        {
          kind,
          branchId: batch.branchId,
          // Có id batch: batch bị hủy rồi tổng hợp lại cùng khoảng ngày phải ra
          // Approval mới, không dính Approval cũ (POS và Lark chống trùng theo mã).
          clientUuid: `INTERNAL_FINANCE_WEEK:${batch.id}:${batch.branchId}:${from}:${to}`,
          sourceType: 'INTERNAL_FINANCE_WEEKLY',
          sourceId: batch.id,
          form,
        },
        userId,
      );

      await this.prisma.internalFinanceWeeklyBatch.update({
        where: { id: batch.id },
        data: {
          approvalRequestId: request.id,
        },
      });

      return request;
    } catch (error) {
      await this.prisma.$transaction(async (tx) => {
        await this.internalFund.lockBranch(tx, [batch.branchId]);
        const reset = await tx.internalFinanceWeeklyBatch.updateMany({
          where: {
            id: batch.id,
            status: 'IN_APPROVAL',
            approvalRequestId: null,
          },
          data: { status: 'READY' },
        });
        if (reset.count === 1)
          await tx.internalFinanceEntry.updateMany({
            where: { weeklyBatchId: batch.id, status: 'IN_WEEKLY_APPROVAL' },
            data: { status: 'READY_FOR_WEEKLY_APPROVAL' },
          });
      });
      throw error;
    }
  }

  async createWarehouseExpenseApproval(
    batchId: number,
    user: any,
    detailUrl?: string,
    viewUrl?: string,
  ) {
    const batch = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id: batchId },
      select: { id: true, branchId: true },
    });
    if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWeeklyApprovalPermission(user, batch.branchId, 'submit');
    return this.createWeeklyApproval(batchId, user.id, detailUrl, viewUrl);
  }

  /** Phiếu sót tuần trước có thể gộp vào tuần bắt đầu từ `weekStart`. */
  async warehouseCarryOver(user: any, branchId: number, weekStart: string) {
    await this.assertWeeklyApprovalPermission(user, branchId, 'prepare');
    if (!this.isWarehouseBranch(branchId)) return { data: [], total: 0 };
    const start = fundDayStart(weekStart);
    const data = await this.prisma.internalFinanceEntry.findMany({
      where: {
        branchId,
        direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
        category: { in: [...WAREHOUSE_EXPENSE_CATEGORIES] },
        occurredAt: { gte: CARRY_OVER_FROM, lt: start },
        weeklyBatchId: null,
        cashIssued: false,
        cashFlowId: null,
        managerReviewedAt: { not: null },
        accountantReviewedAt: { not: null },
        status: {
          in: [
            INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
            INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
          ],
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        occurredAt: true,
        description: true,
        amount: true,
      },
    });
    return {
      data,
      total: data.reduce((sum, row) => sum + Number(row.amount), 0),
    };
  }

  /**
   * Thêm phiếu sót tuần trước vào batch chưa gửi Lark: từng phiếu hoặc tất cả.
   * Chỉ nhận phiếu đủ điều kiện phiếu sót; phiếu khác bị bỏ qua.
   */
  async addCarryOverEntries(batchId: number, entryIds: number[], user: any) {
    const found = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id: batchId },
      select: { branchId: true },
    });
    if (!found) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWeeklyApprovalPermission(user, found.branchId, 'prepare');
    const ids = [...new Set(entryIds)];

    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [found.branchId]);
      const batch = await tx.internalFinanceWeeklyBatch.findUnique({
        where: { id: batchId },
      });
      if (
        !batch ||
        batch.approvalRequestId ||
        batch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.READY
      ) {
        throw new BadRequestException(
          'Chỉ thêm được vào batch chưa gửi Approval Lark',
        );
      }
      const eligible = await tx.internalFinanceEntry.findMany({
        where: {
          id: { in: ids },
          branchId: batch.branchId,
          direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
          category: { in: [...WAREHOUSE_EXPENSE_CATEGORIES] },
          occurredAt: { gte: CARRY_OVER_FROM, lt: batch.weekStart },
          weeklyBatchId: null,
          cashIssued: false,
          cashFlowId: null,
          managerReviewedAt: { not: null },
          accountantReviewedAt: { not: null },
          status: {
            in: [
              INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
              INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
            ],
          },
        },
        select: { id: true },
      });
      if (!eligible.length) {
        throw new BadRequestException(
          'Không có phiếu sót đủ điều kiện để thêm vào approval',
        );
      }
      const added = eligible.map((row) => row.id);
      await tx.internalFinanceEntry.updateMany({
        where: { id: { in: added } },
        data: {
          weeklyBatchId: batch.id,
          status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
          posManagedAt: new Date(),
        },
      });
      const sum = await tx.internalFinanceEntry.aggregate({
        where: { weeklyBatchId: batch.id },
        _sum: { amount: true },
      });
      await tx.internalFinanceWeeklyBatch.update({
        where: { id: batch.id },
        data: { totalAmount: sum._sum.amount || 0 },
      });
      return {
        added: added.length,
        skipped: ids.filter((id) => !added.includes(id)).length,
      };
    });
  }

  /**
   * Bỏ phiếu khỏi batch chưa gửi Lark (thêm nhầm): phiếu giữ nguyên hai tick,
   * trở về chờ gom; batch tính lại tổng tiền, hết phiếu thì xóa batch.
   */
  async removeWeeklyBatchEntries(
    batchId: number,
    entryIds: number[],
    user: any,
  ) {
    const found = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id: batchId },
      select: { branchId: true },
    });
    if (!found) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWeeklyApprovalPermission(user, found.branchId, 'prepare');

    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [found.branchId]);
      const batch = await tx.internalFinanceWeeklyBatch.findUnique({
        where: { id: batchId },
      });
      if (
        !batch ||
        batch.approvalRequestId ||
        batch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.READY
      ) {
        throw new BadRequestException(
          'Chỉ bỏ được phiếu khỏi batch chưa gửi Approval Lark',
        );
      }
      const where = { id: { in: entryIds }, weeklyBatchId: batch.id };
      const removed = await tx.internalFinanceEntry.count({ where });
      if (!removed) {
        throw new BadRequestException('Phiếu không nằm trong batch này');
      }
      await tx.internalFinanceEntry.updateMany({
        where: {
          ...where,
          managerReviewedAt: { not: null },
          accountantReviewedAt: { not: null },
        },
        data: {
          weeklyBatchId: null,
          status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        },
      });
      await tx.internalFinanceEntry.updateMany({
        where,
        data: {
          weeklyBatchId: null,
          status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        },
      });
      const rest = await tx.internalFinanceEntry.aggregate({
        where: { weeklyBatchId: batch.id },
        _sum: { amount: true },
        _count: { _all: true },
      });
      if (!rest._count._all) {
        await tx.internalFinanceWeeklyBatch.delete({ where: { id: batch.id } });
        return { removed, batchDeleted: true };
      }
      await tx.internalFinanceWeeklyBatch.update({
        where: { id: batch.id },
        data: { totalAmount: rest._sum.amount || 0 },
      });
      return { removed, batchDeleted: false };
    });
  }

  // Hủy batch chưa gửi Lark, hoặc có Approval Lark đã kết thúc mà không duyệt:
  // trả phiếu về Phiếu chi kho (giữ tick, Đã chi, quỹ) rồi xóa batch để tổng
  // hợp lại. Approval đang duyệt hoặc đã duyệt thì không hủy được.
  async cancelWarehouseExpenseBatch(batchId: number, user: any) {
    const found = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id: batchId },
      select: { branchId: true },
    });
    if (!found) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWeeklyApprovalPermission(user, found.branchId, 'prepare');

    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [found.branchId]);
      const batch = await tx.internalFinanceWeeklyBatch.findUnique({
        where: { id: batchId },
        select: {
          id: true,
          code: true,
          status: true,
          approvalRequest: { select: { status: true } },
        },
      });
      if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
      const approvalStatus = batch.approvalRequest?.status;
      if (
        ['IN_APPROVAL', 'APPROVED'].includes(batch.status) ||
        (approvalStatus &&
          !CANCELLABLE_WEEKLY_APPROVAL_STATUSES.includes(approvalStatus))
      ) {
        throw new BadRequestException(
          'Approval tuần đang duyệt hoặc đã duyệt, không thể hủy batch',
        );
      }

      const released = await tx.internalFinanceEntry.count({
        where: { weeklyBatchId: batch.id },
      });
      await tx.internalFinanceEntry.updateMany({
        where: {
          weeklyBatchId: batch.id,
          cashIssued: false,
          managerReviewedAt: { not: null },
          accountantReviewedAt: { not: null },
        },
        data: { status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED },
      });
      await tx.internalFinanceEntry.updateMany({
        where: {
          weeklyBatchId: batch.id,
          cashIssued: false,
          OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
        },
        data: { status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT },
      });
      await tx.internalFinanceEntry.updateMany({
        where: { weeklyBatchId: batch.id },
        data: { weeklyBatchId: null },
      });
      await tx.internalFinanceWeeklyBatch.delete({ where: { id: batch.id } });
      return { id: batch.id, code: batch.code, released };
    });
  }

  async listWarehouseExpenseBatches(query: InternalFinanceQueryDto, user: any) {
    const allowedBranches = await this.allowedWeeklyApprovalBranches(
      user,
      'view',
    );
    if (!allowedBranches.length) {
      throw new ForbiddenException('Không có quyền xem Approval tuần');
    }
    const requested = query.branchIds?.length
      ? query.branchIds.map(Number)
      : allowedBranches;
    if (requested.some((branchId) => !allowedBranches.includes(branchId))) {
      throw new ForbiddenException(
        'Không có quyền xem phiếu chi của chi nhánh này',
      );
    }
    return this.findWeeklyBatches({
      ...query,
      branchIds: requested,
    });
  }

  async pageWarehouseExpenseBatches(query: InternalFinanceQueryDto, user: any) {
    const allowedBranches = await this.allowedWeeklyApprovalBranches(
      user,
      'view',
    );
    if (!allowedBranches.length) {
      throw new ForbiddenException('Không có quyền xem Approval tuần');
    }
    const requested = query.branchIds?.length
      ? query.branchIds.map(Number)
      : allowedBranches;
    if (requested.some((branchId) => !allowedBranches.includes(branchId))) {
      throw new ForbiddenException(
        'Không có quyền xem phiếu chi của chi nhánh này',
      );
    }
    return this.findWeeklyBatchPage({ ...query, branchIds: requested });
  }

  async getWarehouseExpenseBatch(id: number, user: any) {
    const batch = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id },
      select: { id: true, branchId: true },
    });
    if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWeeklyApprovalPermission(user, batch.branchId, 'view');
    return this.findWeeklyBatch(id);
  }

  async markWarehouseExpenseIssued(
    entryId: number,
    user: any,
    dto: MarkWarehouseExpenseIssuedDto,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: { id: true, branchId: true },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy khoản chi');
    await this.assertWarehouseExpensePermission(
      user,
      entry.branchId,
      'mark_issued',
    );
    return this.internalFund.postExpenseEntry(
      entryId,
      user.id,
      dto.cashIssued,
      dto.reason,
    );
  }

  // Hủy phiếu chi kho bị từ chối hẳn: chỉ khi chưa Đã chi và chưa vào Approval
  // tuần đang duyệt/đã duyệt. Phiếu trong batch chưa gửi Lark được gỡ ra trước.
  async cancelWarehouseExpense(entryId: number, user: any, reason: string) {
    const trimmed = this.requireCancelReason(reason);
    const hint = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: { branchId: true },
    });
    if (!hint) throw new NotFoundException('Không tìm thấy khoản chi');
    await this.assertWarehouseExpensePermission(user, hint.branchId, 'cancel');

    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [hint.branchId]);
      const entry = await tx.internalFinanceEntry.findUnique({
        where: { id: entryId },
        include: { weeklyBatch: { select: { status: true } } },
      });
      if (!entry || entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE) {
        throw new NotFoundException('Không tìm thấy khoản chi');
      }
      if (entry.sourceType === LARK_APPROVAL_SOURCE_TYPE)
        throw new BadRequestException(LARK_APPROVAL_LOCK_REASON);
      return this.cancelExpenseInTx(
        tx,
        entry,
        user,
        trimmed,
        this.warehouseExpenseInclude(),
      );
    });
  }

  private requireCancelReason(reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('Cần nhập lý do hủy phiếu');
    return trimmed;
  }

  /** Lõi hủy phiếu chi dùng chung cho Phiếu chi kho và Xe cộ (đã khóa quỹ). */
  private async cancelExpenseInTx(
    tx: Prisma.TransactionClient,
    entry: {
      id: number;
      status: string;
      cashIssued: boolean;
      cashFlowId: number | null;
      weeklyBatchId: number | null;
      weeklyBatch?: { status: string } | null;
    },
    user: any,
    reason: string,
    include: any,
  ) {
    if (entry.status === INTERNAL_FINANCE_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu chi đã được hủy');
    }
    if (entry.cashIssued || entry.cashFlowId) {
      throw new BadRequestException(
        'Phiếu đã chi: hủy giao dịch ở Quỹ nội bộ trước rồi mới hủy phiếu',
      );
    }
    if (entry.weeklyBatch && entry.weeklyBatch.status !== 'READY') {
      throw new BadRequestException(
        'Phiếu đang nằm trong Approval tuần đã gửi duyệt, không thể hủy',
      );
    }
    if (entry.weeklyBatchId) {
      await this.fundLedger.detachFromBatch(tx, entry);
    }
    const now = new Date();
    await tx.internalFinanceReview.create({
      data: {
        entryId: entry.id,
        role: INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
        decision: 'CANCEL',
        reason,
        reviewerId: user.id,
      },
    });
    return tx.internalFinanceEntry.update({
      where: { id: entry.id },
      data: {
        status: INTERNAL_FINANCE_STATUS.CANCELLED,
        cancelReason: reason,
        cancelledAt: now,
        cancelledBy: user.id,
        posManagedAt: now,
      },
      include,
    });
  }

  async updateCashIssued(entryId: number, cashIssued: boolean, userId: number) {
    return this.internalFund.postExpenseEntry(entryId, userId, cashIssued);
  }

  // Tick kiểm tra của quản lý kho / kế toán kho: độc lập, không cần thứ tự.
  /**
   * Tick hàng loạt một cột (Quản lý kho / Kế toán kho): mỗi phiếu chạy đúng
   * luật tick từng phiếu; phiếu không tick được thì bỏ qua và báo lý do.
   */
  async bulkCheckWarehouseExpenses(
    user: any,
    dto: BulkCheckWarehouseExpenseDto,
  ) {
    const ids = [...new Set(dto.ids)];
    const entries = await this.prisma.internalFinanceEntry.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        managerReviewedAt: true,
        accountantReviewedAt: true,
      },
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const updated: any[] = [];
    const skipped: Array<{ id: number; code: string; reason: string }> = [];
    let alreadyChecked = 0;
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        skipped.push({ id, code: String(id), reason: 'Không tìm thấy phiếu' });
        continue;
      }
      const at =
        dto.role === 'manager'
          ? entry.managerReviewedAt
          : entry.accountantReviewedAt;
      // Đã tick sẵn thì giữ nguyên người và giờ tick cũ.
      if (at) {
        alreadyChecked += 1;
        continue;
      }
      try {
        updated.push(
          await this.checkWarehouseExpense(id, user, {
            role: dto.role,
            checked: true,
          }),
        );
      } catch (error: any) {
        skipped.push({
          id,
          code: entry.code,
          reason: error?.message || 'Không tick được',
        });
      }
    }
    return { updated, skipped, alreadyChecked };
  }

  async checkWarehouseExpense(
    entryId: number,
    user: any,
    dto: CheckWarehouseExpenseDto,
  ) {
    const hint = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: { branchId: true },
    });
    if (!hint) throw new NotFoundException('Không tìm thấy khoản chi');
    if (!this.isWarehouseBranch(hint.branchId)) {
      throw new BadRequestException(
        'Tick kiểm tra chỉ áp dụng cho phiếu chi kho',
      );
    }
    const manager = dto.role === 'manager';
    await this.assertWarehouseExpensePermission(
      user,
      hint.branchId,
      manager ? 'check_manager' : 'check_accountant',
    );
    return this.prisma.$transaction(async (tx) => {
      await this.internalFund.lockBranch(tx, [hint.branchId]);
      const entry = await tx.internalFinanceEntry.findUnique({
        where: { id: entryId },
        include: { weeklyBatch: { select: { id: true, status: true } } },
      });
      if (!entry || entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE) {
        throw new NotFoundException('Không tìm thấy khoản chi');
      }
      if (entry.sourceType === LARK_APPROVAL_SOURCE_TYPE)
        throw new BadRequestException(LARK_APPROVAL_LOCK_REASON);
      if (
        entry.cashIssued ||
        entry.cashFlowId ||
        [
          INTERNAL_FINANCE_STATUS.CANCELLED,
          INTERNAL_FINANCE_STATUS.REJECTED,
        ].includes(entry.status as any)
      ) {
        throw new BadRequestException(
          'Khoản chi đã chi hoặc đã hủy, không thể đổi tick kiểm tra',
        );
      }
      if (
        entry.weeklyBatch &&
        entry.weeklyBatch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.READY
      ) {
        throw new BadRequestException(
          'Khoản chi đã gửi Approval tuần, không thể đổi tick kiểm tra',
        );
      }
      // Tick tính theo thời điểm kiểm tra: dòng đồng bộ về có tick nhưng có thể
      // không kèm người.
      const now = new Date();
      const managerAt = manager
        ? dto.checked
          ? now
          : null
        : entry.managerReviewedAt;
      const accountantAt = manager
        ? entry.accountantReviewedAt
        : dto.checked
          ? now
          : null;
      const both = Boolean(managerAt && accountantAt);
      // Bỏ tick khi phiếu đã nằm trong batch chưa gửi: rút khỏi batch.
      if (!both && entry.weeklyBatchId) {
        await this.fundLedger.detachFromBatch(tx, entry);
      }
      await tx.internalFinanceReview.create({
        data: {
          entryId,
          role: manager
            ? INTERNAL_FINANCE_REVIEW_ROLE.MANAGER
            : INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
          decision: dto.checked
            ? INTERNAL_FINANCE_REVIEW_DECISION.APPROVE
            : 'UNCHECK',
          reviewerId: user.id,
        },
      });
      return tx.internalFinanceEntry.update({
        where: { id: entryId },
        data: {
          posManagedAt: now,
          ...(manager
            ? {
                managerReviewedBy: dto.checked ? user.id : null,
                managerReviewedAt: managerAt,
              }
            : {
                accountantReviewedBy: dto.checked ? user.id : null,
                accountantReviewedAt: accountantAt,
              }),
          status: both
            ? entry.weeklyBatchId
              ? INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL
              : INTERNAL_FINANCE_STATUS.MANAGER_APPROVED
            : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        },
        include: this.warehouseExpenseInclude(),
      });
    });
  }

  private isWarehouseBranch(branchId: number) {
    return (WAREHOUSE_CASH_BRANCH_IDS as readonly number[]).includes(
      Number(branchId),
    );
  }

  async normalizeLegacyCodes() {
    return this.prisma.$transaction(async (tx) => {
      const entries = await tx.internalFinanceEntry.findMany({
        where: {
          code: { startsWith: 'IFE-' },
        },
        select: {
          id: true,
          code: true,
          direction: true,
          category: true,
          branchId: true,
          occurredAt: true,
        },
        orderBy: { id: 'asc' },
      });
      const updated: Array<{ id: number; from: string; to: string }> = [];
      for (const entry of entries) {
        const code = await this.codeService.nextCode(tx, {
          direction: entry.direction,
          category: entry.category,
          branchId: entry.branchId,
          occurredAt: entry.occurredAt,
        });
        await tx.internalFinanceEntry.update({
          where: { id: entry.id },
          data: { code },
        });
        updated.push({ id: entry.id, from: entry.code, to: code });
      }
      return { updated: updated.length, entries: updated };
    });
  }

  async postWeeklyBatch(batchId: number, userId: number) {
    void batchId;
    void userId;
    throw new BadRequestException(
      'Phiếu chi chưa có thao tác ghi CashFlow; hãy đánh dấu Đã chi trên từng dòng sau khi Approval tuần được duyệt',
    );
  }

  async postEntry(entryId: number, userId: number) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy dòng tài chính');
    if (entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE) {
      throw new BadRequestException(
        'Khoản chi phải được ghi nhận theo batch Approval tuần',
      );
    }
    void userId;
    throw new BadRequestException(
      'Phiếu thu nội bộ dùng Approval tại Quỹ nội bộ; thu khách dùng Tiền mặt kho',
    );
  }

  private async createManualEntry(input: {
    direction: string;
    category: string;
    subCategory?: string;
    branchId: number;
    amount: number;
    occurredAt: string;
    sourceType: string;
    description?: string;
    sourceSnapshot?: Record<string, unknown>;
    attachments?: Array<{
      fileUrl: string;
      fileName?: string;
      fileType?: string;
      fileSize?: number;
      kind?: string;
    }>;
    vehicleName?: string;
    vehicleServiceType?: string;
    vehicleOdo?: number;
    vehicleLiters?: number;
    vehicleUnitPrice?: number;
    vehicleLocation?: string;
    vehicleId?: number;
    vehicleDueAt?: Date;
    vehicleServiceTypes?: string[];
    payerId?: number;
    expenseItem?: string;
    quantity?: number | null;
    unitPrice?: number | null;
    note?: string;
    include?: Record<string, unknown>;
    userId: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const occurredAt = new Date(input.occurredAt);
      const code = await this.codeService.nextCode(tx, {
        direction: input.direction,
        category: input.category,
        branchId: input.branchId,
        occurredAt,
      });
      return tx.internalFinanceEntry.create({
        data: {
          code,
          direction: input.direction,
          category: input.category,
          subCategory: input.subCategory || input.category,
          branchId: input.branchId,
          amount: input.amount,
          occurredAt,
          sourceType: input.sourceType,
          sourceKey: `${input.sourceType}:${randomUUID()}`,
          sourceSnapshot: this.toJson(input.sourceSnapshot),
          description: input.description,
          evidenceStatus: input.attachments?.length
            ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
            : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
          status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
          requiresEvidence: true,
          vehicleName: input.vehicleName,
          vehicleServiceType: input.vehicleServiceType,
          vehicleOdo: input.vehicleOdo,
          vehicleLiters: input.vehicleLiters,
          vehicleUnitPrice: input.vehicleUnitPrice,
          vehicleLocation: input.vehicleLocation,
          vehicleId: input.vehicleId,
          vehicleDueAt: input.vehicleDueAt,
          vehicleServiceTypes: input.vehicleServiceTypes,
          payerId: input.payerId,
          expenseItem: input.expenseItem,
          quantity: input.quantity ?? undefined,
          unitPrice: input.unitPrice ?? undefined,
          note: input.note,
          createdBy: input.userId,
          attachments: input.attachments?.length
            ? {
                create: input.attachments.map((file) => ({
                  kind: file.kind || 'EVIDENCE',
                  fileUrl: file.fileUrl,
                  fileName: file.fileName,
                  fileType: file.fileType,
                  fileSize: file.fileSize,
                  createdBy: input.userId,
                })),
              }
            : undefined,
        },
        include: input.include || this.entryInclude(),
      });
    });
  }

  private resolveExpenseAmount(
    amount?: number | null,
    quantity?: number | null,
    unitPrice?: number | null,
  ) {
    if ((quantity == null) !== (unitPrice == null)) {
      throw new BadRequestException('Cần nhập cả số lượng và đơn giá');
    }
    const hasLine = quantity != null && unitPrice != null;
    const total = hasLine
      ? Math.round((quantity as number) * (unitPrice as number) * 100) / 100
      : amount;
    if (!total || total <= 0) {
      throw new BadRequestException('Số tiền khoản chi phải lớn hơn 0');
    }
    return {
      amount: total,
      quantity: hasLine ? quantity : null,
      unitPrice: hasLine ? unitPrice : null,
    };
  }

  private async assertPayer(payerId?: number | null) {
    if (!payerId) return;
    const payer = await this.prisma.user.findUnique({
      where: { id: payerId },
      select: { id: true },
    });
    if (!payer) throw new BadRequestException('Không tìm thấy người chi');
  }

  /** Khoản chi còn sửa/hủy được: chưa vào batch tuần, chưa chi, chưa kết thúc. */
  private assertExpenseOpenForEdit(entry: any) {
    if (
      entry.cashFlowId ||
      entry.cashIssued ||
      entry.weeklyBatchId ||
      [
        INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
        INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL,
        INTERNAL_FINANCE_STATUS.APPROVED,
        INTERNAL_FINANCE_STATUS.POSTED,
        INTERNAL_FINANCE_STATUS.REJECTED,
        INTERNAL_FINANCE_STATUS.CANCELLED,
      ].includes(entry.status)
    ) {
      throw new BadRequestException(
        'Khoản chi đã được tổng hợp hoặc kết thúc, không thể sửa',
      );
    }
  }

  private assertVehicleEntry(entry: any): asserts entry {
    if (
      !entry ||
      entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE ||
      !['FUEL', 'VEHICLE_CARE'].includes(entry.category) ||
      !['FUEL', 'VEHICLE_CARE', 'LARK_IMPORT'].includes(entry.sourceType)
    ) {
      // Phiếu chuyển từ Lark còn mở cũng sửa/hủy như phiếu tạo trên POS.
      throw new NotFoundException('Không tìm thấy phiếu xe có thể chỉnh sửa');
    }
  }

  private vehicleEntryInclude() {
    return {
      branch: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      payer: { select: { id: true, name: true } },
      vehicle: {
        select: {
          id: true,
          label: true,
          plate: true,
          driver: { select: { id: true, name: true } },
        },
      },
      weeklyBatch: { select: { id: true, code: true, status: true } },
      canceller: { select: { id: true, name: true } },
      attachments: true,
    };
  }

  private async reviewAsAccountant(
    entry: any,
    dto: ReviewInternalFinanceDto,
    userId: number,
  ) {
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.MARK_MISSING) {
      if (!dto.reason) {
        throw new BadRequestException('Ghi nhận thiếu chứng từ phải có lý do');
      }
      return this.applyReview(
        entry,
        userId,
        INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
        dto,
        {
          evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
          status:
            entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE
              ? INTERNAL_FINANCE_STATUS.PENDING_MANAGER
              : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        },
      );
    }
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.REJECT) {
      return this.applyReview(
        entry,
        userId,
        INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
        dto,
        {
          status: INTERNAL_FINANCE_STATUS.REJECTED,
        },
      );
    }
    if (dto.decision !== INTERNAL_FINANCE_REVIEW_DECISION.APPROVE) {
      throw new BadRequestException('Kế toán chỉ được xác nhận hoặc từ chối');
    }
    if (
      entry.requiresEvidence &&
      entry.evidenceStatus === INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING
    ) {
      throw new BadRequestException('Khoản chi đang thiếu chứng từ');
    }
    return this.applyReview(
      entry,
      userId,
      INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT,
      dto,
      {
        status:
          entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT
            ? INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED
            : INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
        evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
      },
    );
  }

  private async reviewAsManager(
    entry: any,
    dto: ReviewInternalFinanceDto,
    userId: number,
  ) {
    if (!entry.accountantReviewedBy) {
      throw new BadRequestException('Khoản này chưa được kế toán kiểm tra');
    }
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.REJECT) {
      return this.applyReview(
        entry,
        userId,
        INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
        dto,
        {
          status: INTERNAL_FINANCE_STATUS.REJECTED,
        },
      );
    }
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.EXCEPTION_APPROVE) {
      if (
        entry.evidenceStatus !== INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING ||
        !dto.reason ||
        !dto.dueAt
      ) {
        throw new BadRequestException(
          'Duyệt ngoại lệ phải có trạng thái thiếu chứng từ, lý do và hạn bổ sung',
        );
      }
      return this.applyReview(
        entry,
        userId,
        INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
        dto,
        {
          status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
          evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.EXCEPTION_APPROVED,
          exceptionReason: dto.reason,
          exceptionDueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        },
      );
    }
    if (dto.decision !== INTERNAL_FINANCE_REVIEW_DECISION.APPROVE) {
      throw new BadRequestException(
        'Quản lý chỉ được duyệt, duyệt ngoại lệ hoặc từ chối',
      );
    }
    if (entry.evidenceStatus === INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING) {
      throw new BadRequestException(
        'Khoản chi thiếu chứng từ phải dùng Duyệt ngoại lệ',
      );
    }
    return this.applyReview(
      entry,
      userId,
      INTERNAL_FINANCE_REVIEW_ROLE.MANAGER,
      dto,
      {
        status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
      },
    );
  }

  private async applyReview(
    entry: any,
    userId: number,
    role: string,
    dto: ReviewInternalFinanceDto,
    data: Record<string, unknown>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.internalFinanceReview.create({
        data: {
          entryId: entry.id,
          role,
          decision: dto.decision,
          note: dto.note,
          reason: dto.reason,
          dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
          reviewerId: userId,
        },
      });
      const updateData: any = {
        ...data,
        ...(role === INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT
          ? { accountantReviewedBy: userId, accountantReviewedAt: new Date() }
          : { managerReviewedBy: userId, managerReviewedAt: new Date() }),
      };
      const updated = await tx.internalFinanceEntry.update({
        where: { id: entry.id },
        data: updateData,
        include: this.entryInclude(),
      });
      return { entry: updated, review };
    });
  }

  private async validateBranch(branchId: number) {
    if (
      !(INTERNAL_FINANCE_BRANCH_IDS as readonly number[]).includes(branchId)
    ) {
      throw new BadRequestException(
        `Chi nhánh ${branchId} không thuộc phạm vi tài chính nội bộ`,
      );
    }
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, isActive: true },
    });
    if (!branch || !branch.isActive) {
      throw new BadRequestException(
        `Chi nhánh ${branchId} không tồn tại hoặc đang tắt`,
      );
    }
  }

  private async syncPackingSlipEntries(
    db: DbClient,
    packingSlip: any,
    userId: number,
  ): Promise<{ locked: PackingFinanceLock[] }> {
    const locked: PackingFinanceLock[] = [];
    if (
      !(INTERNAL_FINANCE_BRANCH_IDS as readonly number[]).includes(
        Number(packingSlip.branchId),
      )
    ) {
      return { locked };
    }
    await this.internalFund.lockBranch(db, [Number(packingSlip.branchId)]);
    const files = packingSlip.expenseFiles || [];
    const images = packingSlip.images || [];
    const attachmentData = [
      ...files.map((file: any) => ({
        kind: 'EVIDENCE',
        fileUrl: file.fileUrl,
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: file.fileSize,
      })),
      ...images.map((image: any) => ({
        kind: 'IMAGE',
        fileUrl: image.imageUrl,
      })),
    ];
    const invoiceIds = (packingSlip.invoices || [])
      .map((row: any) => row.invoiceId)
      .filter(Boolean);
    const orderIds = (packingSlip.invoices || [])
      .map((row: any) => row.invoice?.orderId)
      .filter(Boolean);
    const customerId =
      (packingSlip.invoices || []).find((row: any) => row.invoice?.customerId)
        ?.invoice?.customerId ??
      (packingSlip.invoices || []).find(
        (row: any) => row.consignment?.customerId,
      )?.consignment?.customerId ??
      null;
    const activeKeys: string[] = [];
    const expenseItems = [
      ['FEE_GUI_BEN', packingSlip.hasFeeGuiBen, packingSlip.feeGuiBen],
      ['FEE_GRAB', packingSlip.hasFeeGrab, packingSlip.feeGrab],
      ['SHIPPING_OUT', packingSlip.hasCuocGuiHang, packingSlip.cuocGuiHang],
      ['SHIPPING_IN', packingSlip.hasCuocNhanHang, packingSlip.cuocNhanHang],
    ] as const;

    for (const [category, enabled, rawAmount] of expenseItems) {
      if (![1, 6].includes(Number(packingSlip.branchId))) continue;
      const amount = Number(rawAmount || 0);
      if (!enabled || amount <= 0) continue;
      const sourceKey = `PACKING_SLIP:${packingSlip.id}:${category}`;
      activeKeys.push(sourceKey);
      await this.upsertPackingEntry(db, {
        sourceKey,
        sourceId: String(packingSlip.id),
        category: DELIVERY_EXPENSE_CATEGORIES[0],
        subCategory: category,
        amount,
        branchId: packingSlip.branchId,
        packingSlipId: packingSlip.id,
        description: `${PACKING_FEE_LABELS[category] || category} - ${packingSlip.code}`,
        sourceSnapshot: {
          packingSlipId: packingSlip.id,
          packingSlipCode: packingSlip.code,
          feeCategory: category,
          expensePayerId: packingSlip.expensePayerId,
          invoiceIds,
          orderIds,
        },
        payerId: packingSlip.expensePayerId ?? null,
        expenseItem: WAREHOUSE_EXPENSE_ITEM.DELIVERY,
        occurredAt: packingSlip.createdAt,
        customerId,
        invoiceIds,
        attachments: attachmentData,
        userId,
        locked,
      });
    }

    const cashAmount = Number(packingSlip.cashAmount || 0);
    const warehouseBranch = (
      WAREHOUSE_CASH_BRANCH_IDS as readonly number[]
    ).includes(Number(packingSlip.branchId));
    const customerIds = this.packingCustomerIds(packingSlip);
    if (
      warehouseBranch &&
      !packingSlip.cancelledAt &&
      packingSlip.paymentMethod === 'cash' &&
      cashAmount > 0
    ) {
      const sourceKey = `PACKING_SLIP:${packingSlip.id}:CUSTOMER_RECEIPT`;
      activeKeys.push(sourceKey);
      await this.upsertPackingEntry(db, {
        sourceKey,
        sourceId: String(packingSlip.id),
        category: INTERNAL_FINANCE_CATEGORY.CUSTOMER_RECEIPT,
        subCategory: INTERNAL_FINANCE_SUBCATEGORY.OTHER,
        direction: INTERNAL_FINANCE_DIRECTION.RECEIPT,
        amount: cashAmount,
        branchId: packingSlip.branchId,
        packingSlipId: packingSlip.id,
        description: `Thu tiền mặt báo đơn ${packingSlip.code}`,
        sourceSnapshot: {
          packingSlipId: packingSlip.id,
          packingSlipCode: packingSlip.code,
          paymentMethod: packingSlip.paymentMethod,
          cashAmount,
          invoiceIds,
          orderIds,
          customerIds,
          method: 'cash',
        },
        occurredAt: packingSlip.createdAt,
        customerId: customerIds[0] ?? customerId,
        invoiceIds,
        attachments: attachmentData,
        userId,
        preserveUserText: true,
        reopenIfCancelled: true,
      });
    }

    await db.internalFinanceEntry.updateMany({
      where: {
        packingSlipId: packingSlip.id,
        cashIssued: false,
        OR: [
          { direction: 'RECEIPT' },
          { direction: 'EXPENSE', weeklyBatchId: null },
        ],
        sourceKey: { notIn: activeKeys.length ? activeKeys : ['__none__'] },
        status: {
          in: [
            INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
            INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
            INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
            INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
          ],
        },
      },
      data: { status: INTERNAL_FINANCE_STATUS.CANCELLED },
    });
    return { locked };
  }

  // Vì sao phiếu từ báo đơn không được cập nhật theo báo đơn (null: sửa được).
  private packingLockReason(
    existing: {
      cashFlowId: number | null;
      cashIssued: boolean;
      weeklyBatchId: number | null;
      status: string;
      weeklyBatch?: { code: string; status: string } | null;
    },
    direction: string,
    editableStatuses: string[],
  ): string | null {
    if (existing.cashIssued || existing.cashFlowId) return 'đã chi';
    if (
      direction === INTERNAL_FINANCE_DIRECTION.EXPENSE &&
      existing.weeklyBatchId
    ) {
      const batch = existing.weeklyBatch;
      return batch?.status === 'READY'
        ? `đang trong Approval tuần ${batch.code} (chưa gửi Lark): bỏ tick Quản lý kho/Kế toán kho hoặc hủy batch rồi lưu lại báo đơn`
        : `đang trong Approval tuần ${batch?.code || ''} đã gửi duyệt`;
    }
    if (!editableStatuses.includes(existing.status)) {
      return existing.status === INTERNAL_FINANCE_STATUS.CANCELLED
        ? 'phiếu chi đã hủy'
        : 'phiếu chi đã kết thúc';
    }
    return null;
  }

  async syncPackingSlipEntriesInTransaction(
    db: DbClient,
    packingSlip: any,
    userId: number,
  ) {
    return this.syncPackingSlipEntries(db, packingSlip, userId);
  }

  private async upsertPackingEntry(
    db: DbClient,
    data: {
      sourceKey: string;
      sourceId: string;
      category: string;
      subCategory?: string;
      direction?: string;
      amount: number;
      branchId: number;
      packingSlipId: number;
      occurredAt?: Date;
      customerId?: number | null;
      description: string;
      sourceSnapshot: Record<string, unknown>;
      invoiceIds: number[];
      attachments: Array<Record<string, unknown>>;
      userId: number;
      payerId?: number | null;
      expenseItem?: string;
      preserveUserText?: boolean;
      reopenIfCancelled?: boolean;
      /** Gom phiếu chi đang khóa mà báo đơn đổi số tiền/chứng từ để báo lại. */
      locked?: PackingFinanceLock[];
    },
  ) {
    const existing = await db.internalFinanceEntry.findUnique({
      where: { sourceKey: data.sourceKey },
      include: {
        attachments: { select: { fileUrl: true } },
        weeklyBatch: { select: { code: true, status: true } },
      },
    });
    const evidenceStatus = data.attachments.length
      ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
      : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING;
    const direction = data.direction || INTERNAL_FINANCE_DIRECTION.EXPENSE;
    const requiresEvidence = direction === INTERNAL_FINANCE_DIRECTION.EXPENSE;
    if (existing) {
      const editableStatuses: string[] = [
        INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
        INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
        INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        ...(data.reopenIfCancelled ? [INTERNAL_FINANCE_STATUS.CANCELLED] : []),
      ];
      const lockReason = this.packingLockReason(
        existing,
        direction,
        editableStatuses,
      );
      if (lockReason) {
        // Phiếu chi khóa thì giữ nguyên; chỉ báo khi báo đơn thực sự đổi
        // số tiền hoặc chứng từ để người sửa biết phiếu chi chưa cập nhật.
        if (data.locked) {
          const fileKey = (files: Array<{ fileUrl?: unknown }>) =>
            files
              .map((file) => String(file.fileUrl || ''))
              .sort()
              .join('|');
          const oldFiles = Array.isArray(existing.attachments)
            ? existing.attachments
            : [];
          if (
            Number(existing.amount) !== Number(data.amount) ||
            fileKey(oldFiles) !== fileKey(data.attachments)
          ) {
            data.locked.push({ code: existing.code, reason: lockReason });
          }
        }
        return existing;
      }
      // Đổi số tiền sau khi đã tick kiểm tra thì phải kiểm tra lại.
      const recheck =
        existing.status === INTERNAL_FINANCE_STATUS.MANAGER_APPROVED &&
        Number(existing.amount) !== Number(data.amount);
      const previousSnapshot = this.snapshotOf(existing);
      const keepContent = Boolean(
        data.preserveUserText && previousSnapshot.contentEdited,
      );
      const keepNote = Boolean(
        data.preserveUserText && previousSnapshot.noteEdited,
      );
      const nextCode = !String(existing.code || '').startsWith('TCNB-')
        ? await this.codeService.nextCode(db, {
            direction,
            category: data.category,
            branchId: data.branchId,
            occurredAt: data.occurredAt || new Date(),
          })
        : undefined;
      return db.internalFinanceEntry.update({
        where: { id: existing.id },
        data: {
          ...(nextCode ? { code: nextCode } : {}),
          amount: data.amount,
          description: keepContent ? existing.description : data.description,
          branchId: data.branchId,
          occurredAt: data.occurredAt || undefined,
          customerId: data.customerId ?? undefined,
          payerId: data.payerId,
          expenseItem: data.expenseItem,
          subCategory: data.subCategory || data.category,
          requiresEvidence,
          evidenceStatus: requiresEvidence
            ? evidenceStatus
            : INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
          status:
            existing.status === INTERNAL_FINANCE_STATUS.CANCELLED || recheck
              ? INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT
              : existing.status,
          ...(recheck
            ? {
                managerReviewedBy: null,
                managerReviewedAt: null,
                accountantReviewedBy: null,
                accountantReviewedAt: null,
              }
            : {}),
          sourceSnapshot: {
            ...data.sourceSnapshot,
            ...(keepContent ? { contentEdited: true } : {}),
            ...(keepNote
              ? { note: previousSnapshot.note, noteEdited: true }
              : {}),
          },
          invoiceLinks: {
            deleteMany: {},
            ...(data.invoiceIds.length
              ? {
                  create: data.invoiceIds.map((invoiceId) => ({
                    invoiceId,
                  })),
                }
              : {}),
          },
          attachments: {
            deleteMany: {},
            ...(data.attachments.length
              ? {
                  create: data.attachments.map((file: any) => ({
                    ...file,
                    createdBy: data.userId,
                  })),
                }
              : {}),
          },
        },
      });
    }
    const nextCode = await this.codeService.nextCode(db, {
      direction,
      category: data.category,
      branchId: data.branchId,
      occurredAt: data.occurredAt || new Date(),
    });
    return db.internalFinanceEntry.create({
      data: {
        code: nextCode!,
        direction,
        category: data.category,
        subCategory: data.subCategory || data.category,
        branchId: data.branchId,
        amount: data.amount,
        occurredAt: data.occurredAt || new Date(),
        sourceType: 'PACKING_SLIP',
        sourceId: data.sourceId,
        sourceKey: data.sourceKey,
        sourceSnapshot: data.sourceSnapshot,
        description: data.description,
        evidenceStatus: requiresEvidence
          ? evidenceStatus
          : INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
        status: INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        requiresEvidence,
        createdBy: data.userId,
        payerId: data.payerId ?? undefined,
        expenseItem: data.expenseItem,
        packingSlipId: data.packingSlipId,
        customerId: data.customerId ?? undefined,
        invoiceLinks: data.invoiceIds.length
          ? { create: data.invoiceIds.map((invoiceId) => ({ invoiceId })) }
          : undefined,
        attachments: data.attachments.length
          ? {
              create: data.attachments.map((file: any) => ({
                ...file,
                createdBy: data.userId,
              })),
            }
          : undefined,
      },
    });
  }

  private packingCustomerIds(packingSlip: any): number[] {
    const ids = new Set<number>();
    for (const row of packingSlip.invoices || []) {
      const invoiceCustomer = Number(row.invoice?.customerId);
      const consignmentCustomer = Number(row.consignment?.customerId);
      if (invoiceCustomer) ids.add(invoiceCustomer);
      if (consignmentCustomer) ids.add(consignmentCustomer);
    }
    return [...ids];
  }

  private assertWarehouseBranch(branchId: number) {
    if (!(WAREHOUSE_CASH_BRANCH_IDS as readonly number[]).includes(branchId)) {
      throw new BadRequestException(
        'Phiếu thu tiền mặt chỉ dùng cho Kho Hà Nội và Kho Sài Gòn',
      );
    }
  }

  private isAutoWarehouseReceipt(entry: {
    sourceType?: string | null;
    sourceKey?: string | null;
  }) {
    return (
      entry.sourceType === 'PACKING_SLIP' ||
      String(entry.sourceKey || '').startsWith('PACKING_SLIP:')
    );
  }

  private isWarehouseSale(entry: any) {
    const snapshot = this.snapshotOf(entry || {});
    return (
      entry?.subCategory === INTERNAL_FINANCE_SUBCATEGORY.WAREHOUSE_ITEM_SALE ||
      snapshot.receiptKind === 'WAREHOUSE_SALE'
    );
  }

  private isWarehouseReceipt(entry: any) {
    return (
      entry?.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT &&
      (WAREHOUSE_CASH_BRANCH_IDS as readonly number[]).includes(
        entry.branchId,
      ) &&
      ['PACKING_SLIP', 'MANUAL_RECEIPT'].includes(entry.sourceType) &&
      [
        INTERNAL_FINANCE_CATEGORY.CUSTOMER_RECEIPT,
        INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT,
      ].includes(entry.category)
    );
  }

  private async getOpenWarehouseReceipt(id: number) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id },
      include: this.warehouseInclude(),
    });
    if (!entry || !this.isWarehouseReceipt(entry)) {
      throw new NotFoundException('Không tìm thấy phiếu thu tiền mặt');
    }
    if (
      entry.cashFlowId ||
      entry.status === INTERNAL_FINANCE_STATUS.POSTED ||
      entry.status === INTERNAL_FINANCE_STATUS.POSTING
    ) {
      throw new BadRequestException('Phiếu thu đã lập hoặc đang được lập');
    }
    if (
      entry.status === INTERNAL_FINANCE_STATUS.CANCELLED ||
      entry.status === INTERNAL_FINANCE_STATUS.REJECTED
    ) {
      throw new BadRequestException('Phiếu thu đã hủy');
    }
    return entry;
  }

  private async resolveWarehouseCustomers(
    customers: Array<{ customerId: number; invoiceIds?: number[] }>,
  ) {
    const customerIds = [...new Set(customers.map((item) => item.customerId))];
    if (!customerIds.length) {
      throw new BadRequestException('Cần chọn ít nhất một khách hàng');
    }
    const found = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true },
    });
    if (found.length !== customerIds.length) {
      throw new BadRequestException('Có khách hàng không tồn tại');
    }
    const invoiceIds = [
      ...new Set(customers.flatMap((item) => item.invoiceIds || [])),
    ];
    if (!invoiceIds.length) return { customerIds, invoiceIds };
    const invoices = await this.prisma.invoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { id: true, code: true, customerId: true },
    });
    if (invoices.length !== invoiceIds.length) {
      throw new BadRequestException('Có hóa đơn không tồn tại');
    }
    for (const invoice of invoices) {
      if (!customerIds.includes(Number(invoice.customerId))) {
        throw new BadRequestException(
          `Hóa đơn ${invoice.code} không thuộc khách hàng đã chọn`,
        );
      }
    }
    return { customerIds, invoiceIds };
  }

  private async validateWarehouseAllocations(
    entry: any,
    allocations: Array<{
      customerId: number;
      amount: number;
      invoices?: Array<{ invoiceId: number; amount: number }>;
    }>,
    customerIds: number[],
  ) {
    if (!allocations.length) {
      throw new BadRequestException('Chưa có phân bổ khách hàng');
    }
    const allocationIds = allocations.map((item) => item.customerId);
    if (new Set(allocationIds).size !== allocationIds.length) {
      throw new BadRequestException('Mỗi khách hàng chỉ được phân bổ một lần');
    }
    if (
      allocationIds.length !== customerIds.length ||
      allocationIds.some((id) => !customerIds.includes(id))
    ) {
      throw new BadRequestException(
        'Phân bổ phải đúng các khách hàng của phiếu thu',
      );
    }
    const cents = (value: number) => Math.round(Number(value) * 100);
    const total = allocations.reduce(
      (sum, item) => sum + Number(item.amount),
      0,
    );
    if (cents(total) !== cents(Number(entry.amount))) {
      throw new BadRequestException(
        `Tổng phân bổ (${total}) phải bằng số tiền mặt (${Number(entry.amount)})`,
      );
    }
    const requestedIds = [
      ...new Set(
        allocations.flatMap((allocation) =>
          (allocation.invoices || [])
            .filter((item) => Number(item.amount) > 0)
            .map((item) => item.invoiceId),
        ),
      ),
    ];
    const invoices = requestedIds.length
      ? await this.prisma.invoice.findMany({
          where: {
            id: { in: requestedIds },
            debtAmount: { gt: 0 },
            status: { not: INVOICE_STATUS.CANCELLED },
          },
          select: { id: true, code: true, customerId: true, debtAmount: true },
        })
      : [];
    const invoiceById = new Map(
      invoices.map((invoice) => [invoice.id, invoice]),
    );
    for (const allocation of allocations) {
      let invoiceTotal = 0;
      for (const item of allocation.invoices || []) {
        if (!(Number(item.amount) > 0)) continue;
        const invoice = invoiceById.get(item.invoiceId);
        if (!invoice) {
          throw new BadRequestException(
            'Hóa đơn không còn nợ hoặc không tồn tại',
          );
        }
        if (Number(invoice.customerId) !== allocation.customerId) {
          throw new BadRequestException(
            `Hóa đơn ${invoice.code} không thuộc khách hàng được phân bổ`,
          );
        }
        if (cents(item.amount) > cents(Number(invoice.debtAmount))) {
          throw new BadRequestException(
            `Số tiền hóa đơn ${invoice.code} vượt quá số còn nợ`,
          );
        }
        invoiceTotal += Number(item.amount);
      }
      if (cents(invoiceTotal) > cents(Number(allocation.amount))) {
        throw new BadRequestException(
          'Tiền phân bổ hóa đơn vượt quá phần tiền của khách',
        );
      }
    }
  }

  private customerIdsFromEntry(entry: any): number[] {
    const snapshot = this.snapshotOf(entry);
    const fromSnapshot = Array.isArray(snapshot.customerIds)
      ? snapshot.customerIds.map(Number).filter((id) => id > 0)
      : [];
    const fromInvoices = (entry.invoiceLinks || [])
      .map((link: any) => Number(link.invoice?.customerId))
      .filter((id: number) => id > 0);
    const ids = [...fromSnapshot, ...fromInvoices];
    if (entry.customerId) ids.push(Number(entry.customerId));
    return [...new Set(ids)];
  }

  private postedCashFlows(snapshot: Record<string, unknown>) {
    return Array.isArray(snapshot.postedCashFlows)
      ? snapshot.postedCashFlows.map((item: any) => ({
          id: Number(item.id),
          code: String(item.code || ''),
          customerId: Number(item.customerId),
          amount: Number(item.amount || 0),
        }))
      : [];
  }

  private async decorateWarehouseRows(rows: any[]) {
    const ids = [
      ...new Set(rows.flatMap((row) => this.customerIdsFromEntry(row))),
    ];
    const customers = ids.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const byId = new Map(customers.map((customer) => [customer.id, customer]));
    return rows.map((row) => {
      const snapshot = this.snapshotOf(row);
      const posted = this.postedCashFlows(snapshot);
      const linked = this.customerIdsFromEntry(row)
        .map((id) => byId.get(id))
        .filter(Boolean);
      const customerName =
        typeof snapshot.customerName === 'string'
          ? snapshot.customerName.trim()
          : '';
      const customers = linked.length
        ? linked
        : customerName
          ? [
              {
                id: 0,
                code:
                  typeof snapshot.customerCode === 'string'
                    ? snapshot.customerCode
                    : null,
                name: customerName,
              },
            ]
          : [];
      return {
        ...row,
        customers,
        note: typeof snapshot.note === 'string' ? snapshot.note : '',
        postedCashFlows: posted.length
          ? posted
          : row.cashFlow
            ? [
                {
                  id: row.cashFlow.id,
                  code: row.cashFlow.code,
                  customerId: row.customerId,
                  amount: Number(row.amount),
                },
              ]
            : [],
      };
    });
  }

  private warehouseExpenseScopeForBranch(branchId: number) {
    return WAREHOUSE_EXPENSE_SCOPES.find((scope) =>
      (scope.branchIds as readonly number[]).includes(Number(branchId)),
    );
  }

  /** Kho (HN, SG, VP) user được thao tác Approval tuần theo quyền `weekly_approval:*`. */
  private async allowedWeeklyApprovalBranches(
    user: any,
    action: WeeklyApprovalAction,
  ): Promise<number[]> {
    if (!user?.id) return [];
    return this.access.branchesFor(
      user,
      `weekly_approval:${action}`,
      WAREHOUSE_EXPENSE_SCOPES.flatMap((scope) => [...scope.branchIds]),
    );
  }

  private async assertWeeklyApprovalPermission(
    user: FinanceActor,
    branchId: number,
    action: WeeklyApprovalAction,
  ) {
    if (!this.warehouseExpenseScopeForBranch(branchId)) {
      throw new ForbiddenException(
        'Chi nhánh không thuộc phạm vi Approval tuần',
      );
    }
    if (!(await this.access.can(user, branchId, `weekly_approval:${action}`))) {
      throw new ForbiddenException(
        action === 'view'
          ? 'Không có quyền xem Approval tuần của chi nhánh này'
          : action === 'prepare'
            ? 'Không có quyền tổng hợp tuần ở chi nhánh này'
            : 'Không có quyền tạo approval tuần ở chi nhánh này',
      );
    }
  }

  // Quyền theo vai trò × chi nhánh; chi nhánh phải thuộc danh sách của user.
  private async allowedWarehouseExpenseBranches(
    user: any,
    action: WarehouseExpenseAction,
  ): Promise<number[]> {
    if (!user?.id) return [];
    return this.access.branchesFor(
      user,
      `warehouse_expense:${action}`,
      WAREHOUSE_EXPENSE_SCOPES.flatMap((scope) => [...scope.branchIds]),
    );
  }

  private async assertWarehouseExpensePermissionByUserId(
    userId: number,
    branchId: number,
    action: WarehouseExpenseAction,
  ) {
    await this.assertWarehouseExpensePermission(userId, branchId, action);
  }

  private async assertCashFlowPermission(
    userId: number,
    branchId: number,
    action: 'view' | 'create' | 'update',
  ) {
    if (!(await this.access.can(userId, branchId, `cash_flows:${action}`))) {
      throw new ForbiddenException(
        `Không có quyền cash_flows:${action} cho chi nhánh này`,
      );
    }
  }

  private async assertWarehouseExpensePermission(
    user: FinanceActor,
    branchId: number,
    action: WarehouseExpenseAction,
  ) {
    if (!this.warehouseExpenseScopeForBranch(branchId)) {
      throw new ForbiddenException(
        'Chi nhánh không thuộc phạm vi phiếu chi kho',
      );
    }
    if (
      !(await this.access.can(user, branchId, `warehouse_expense:${action}`))
    ) {
      throw new ForbiddenException(
        `Không có quyền ${action} phiếu chi kho cho chi nhánh này`,
      );
    }
  }

  /** Kho mà user được xem / thao tác tiền mặt kho. */
  async warehouseCashBranches(user: FinanceActor, action: WarehouseCashAction) {
    return this.access.branchesFor(
      user,
      `warehouse_cash:${action}`,
      WAREHOUSE_CASH_BRANCH_IDS,
    );
  }

  async assertWarehouseCash(
    user: FinanceActor,
    action: WarehouseCashAction,
    branchId: number,
  ) {
    if (!(await this.access.can(user, branchId, `warehouse_cash:${action}`))) {
      throw new ForbiddenException(
        `Không có quyền ${action} tiền mặt kho cho chi nhánh này`,
      );
    }
  }

  /** Kiểm quyền theo chi nhánh của chính phiếu tiền mặt kho. */
  async assertWarehouseCashEntry(
    user: FinanceActor,
    action: WarehouseCashAction,
    entryId: number,
  ) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      select: { branchId: true },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy phiếu tiền mặt');
    await this.assertWarehouseCash(user, action, entry.branchId);
  }

  /**
   * Trang "Đơn Lark Approval": mọi đơn PHIẾU THU / PHIẾU CHI / PHIẾU CHI KHO
   * nhân viên tạo trên Lark, kèm phiếu POS đã tạo hoặc lý do không tạo. Không
   * trả mã đơn Lark cho giao diện.
   */
  async listLarkApprovals(query: LarkApprovalQueryDto, user: FinanceActor) {
    const allowed = await this.access.branchesFor(
      user,
      'lark_approval:view',
      INTERNAL_FINANCE_BRANCH_IDS,
    );
    if (!allowed.length)
      throw new ForbiddenException('Không có quyền xem đơn Lark Approval');
    const requested = query.branchIds?.length
      ? query.branchIds.map(Number)
      : null;
    if (requested?.some((branchId) => !allowed.includes(branchId)))
      throw new ForbiddenException('Không có quyền xem đơn của chi nhánh này');
    const and: Prisma.LarkApprovalInstanceWhereInput[] = [
      // Đơn không gắn quỹ (chuyển khoản) không thuộc chi nhánh nào.
      requested
        ? { branchId: { in: requested } }
        : { OR: [{ branchId: { in: allowed } }, { branchId: null }] },
    ];
    if (query.formKind) and.push({ formKind: query.formKind });
    if (query.status) and.push({ status: query.status });
    if (query.scope) and.push({ inScope: query.scope === 'IN' });
    if (query.suspect === 'true')
      and.push({ suspectDuplicateOfId: { not: null } });
    if (query.fromDate || query.toDate)
      and.push({
        occurredAt: {
          ...(query.fromDate ? { gte: fundDayStart(query.fromDate) } : {}),
          ...(query.toDate
            ? { lt: new Date(fundDayStart(query.toDate).getTime() + 86400000) }
            : {}),
        },
      });
    const search = query.search?.trim();
    if (search) {
      const entryIds = (
        await this.prisma.internalFinanceEntry.findMany({
          where: {
            sourceType: LARK_APPROVAL_SOURCE_TYPE,
            code: { contains: search, mode: 'insensitive' },
          },
          select: { id: true },
          take: 50,
        })
      ).map((row) => row.id);
      and.push({
        OR: [
          { description: { contains: search, mode: 'insensitive' } },
          { requesterName: { contains: search, mode: 'insensitive' } },
          ...(entryIds.length ? [{ entryId: { in: entryIds } }] : []),
        ],
      });
    }
    const where: Prisma.LarkApprovalInstanceWhereInput = { AND: and };
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(query.limit || 50, 200);
    const [rows, summary] = await Promise.all([
      this.prisma.larkApprovalInstance.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.larkApprovalInstance.aggregate({
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);
    const linkedIds = [
      ...new Set(
        rows.flatMap((row) =>
          [row.entryId, row.suspectDuplicateOfId].filter(
            (id): id is number => typeof id === 'number',
          ),
        ),
      ),
    ];
    const entries = linkedIds.length
      ? await this.prisma.internalFinanceEntry.findMany({
          where: { id: { in: linkedIds } },
          select: { id: true, code: true, status: true },
        })
      : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: [...INTERNAL_FINANCE_BRANCH_IDS] } },
      select: { id: true, name: true },
    });
    const branchName = new Map(branches.map((row) => [row.id, row.name]));
    return {
      data: rows.map((row) => ({
        id: row.id,
        formKind: row.formKind,
        status: row.status,
        requesterName: row.requesterName,
        submittedAt: row.submittedAt,
        completedAt: row.completedAt,
        occurredAt: row.occurredAt,
        amount: row.amount === null ? null : Number(row.amount),
        cashAmount: row.cashAmount === null ? null : Number(row.cashAmount),
        method: row.method,
        cashSource: row.cashSource,
        description: row.description,
        branchId: row.branchId,
        branchName: row.branchId ? branchName.get(row.branchId) || null : null,
        direction: row.direction,
        inScope: row.inScope,
        skipReason: row.skipReason,
        entry: row.entryId ? byId.get(row.entryId) || null : null,
        suspectDuplicate: row.suspectDuplicateOfId
          ? byId.get(row.suspectDuplicateOfId) || null
          : null,
        syncedAt: row.syncedAt,
      })),
      total: summary._count._all,
      totalAmount: Number(summary._sum.amount || 0),
      page,
      limit,
    };
  }

  /** Chi nhánh user được xem ở trang Tài chính nội bộ. */
  async financeViewBranches(user: FinanceActor) {
    return this.access.branchesFor(
      user,
      'internal_finance:view',
      INTERNAL_FINANCE_BRANCH_IDS,
    );
  }

  financeAccessSummary(user: FinanceActor) {
    return this.access.summary(user);
  }

  async assertSuperAdmin(user: FinanceActor) {
    if (!(await this.access.isSuperAdmin(user)))
      throw new ForbiddenException('Chỉ Super Admin được đồng bộ dữ liệu');
  }

  private warehouseExpenseInclude() {
    return {
      ...this.entryInclude(),
      creator: { select: { id: true, name: true } },
      managerReviewer: { select: { id: true, name: true } },
      accountantReviewer: { select: { id: true, name: true } },
      fundTransaction: { select: { id: true, code: true, status: true } },
      canceller: { select: { id: true, name: true } },
      _count: { select: { reviewNotes: true } },
      branch: { select: { id: true, name: true } },
      packingSlip: { select: { id: true, code: true } },
      weeklyBatch: {
        select: {
          id: true,
          code: true,
          status: true,
          approvalRequestId: true,
          approvalRequest: {
            select: {
              id: true,
              status: true,
              instanceCode: true,
              currentNode: true,
            },
          },
        },
      },
      cashFlow: { select: { id: true, code: true, status: true } },
    };
  }

  private warehouseInclude() {
    return {
      branch: { select: { id: true, name: true } },
      customer: { select: { id: true, code: true, name: true } },
      packingSlip: { select: { id: true, code: true } },
      cashFlow: { select: { id: true, code: true, status: true } },
      attachments: true,
      invoiceLinks: {
        include: {
          invoice: {
            select: {
              id: true,
              code: true,
              customerId: true,
              debtAmount: true,
              grandTotal: true,
              customer: { select: { id: true, code: true, name: true } },
            },
          },
        },
      },
    };
  }

  private snapshotOf(entry: {
    sourceSnapshot?: unknown;
  }): Record<string, unknown> {
    return entry.sourceSnapshot &&
      typeof entry.sourceSnapshot === 'object' &&
      !Array.isArray(entry.sourceSnapshot)
      ? (entry.sourceSnapshot as Record<string, unknown>)
      : {};
  }

  private entryInclude() {
    return {
      branch: { select: { id: true, name: true } },
      customer: { select: { id: true, code: true, name: true } },
      cashIssuer: { select: { id: true, name: true } },
      payer: { select: { id: true, name: true } },
      vehicle: { select: { id: true, label: true, plate: true } },
      attachments: true,
      invoiceLinks: {
        include: { invoice: { select: { id: true, code: true } } },
      },
      reviews: {
        orderBy: { createdAt: 'desc' as const },
        take: 10,
        include: { reviewer: { select: { id: true, name: true } } },
      },
    };
  }

  private toJson(
    value?: Record<string, unknown>,
  ): Prisma.InputJsonValue | undefined {
    return value
      ? (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue)
      : undefined;
  }

  private startOfDay(value: Date) {
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
  }

  private endOfDay(value: Date) {
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
  }

  private startOfDateString(value: string) {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }

  /** Đầu ngày kế tiếp theo giờ Việt Nam, khớp cách cắt ngày của batch tuần. */
  private nextFundDayStart(value: string) {
    return new Date(fundDayStart(value).getTime() + 86400000);
  }

  private nextDateStart(value: string) {
    const date = this.startOfDateString(value);
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  private dateOnly(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private dateKey(value: Date) {
    return this.dateOnly(value).replace(/-/g, '');
  }

  private isoWeek(value: Date) {
    const date = new Date(
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
    );
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(
      ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
  }

  private batchLink(batchId: number) {
    const base = (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
    return `${base}/tai-chinh/approval-tuan?batchId=${batchId}`;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Số lít = Số tiền / Đơn giá khi người nhập không ghi số lít (như công thức Lark). */
function fuelLiters(
  amount: number,
  unitPrice?: number | null,
  liters?: number | null,
): number | null {
  if (liters != null) return liters;
  if (!unitPrice || unitPrice <= 0) return null;
  return Math.round((amount / unitPrice) * 10000) / 10000;
}
