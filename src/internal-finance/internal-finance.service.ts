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
import { AuthService } from '../auth/auth.service';
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
  INTERNAL_FINANCE_BRANCH_CODES,
  INTERNAL_FINANCE_SUBCATEGORY,
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
  INTERNAL_FINANCE_BRANCH_IDS,
  WAREHOUSE_CASH_BRANCH_IDS,
} from './internal-finance.constants';
import {
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  CreateWarehouseReceiptDto,
  CancelWarehouseReceiptDto,
  AddInternalFinanceAttachmentsDto,
  CreateWarehouseExpenseDto,
  InternalFinanceQueryDto,
  MarkWarehouseExpenseIssuedDto,
  PostWarehouseReceiptDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
  UpdateWarehouseReceiptDto,
  UpdateWarehouseExpenseDto,
  WarehouseExpenseQueryDto,
} from './dto';
import { InternalFinanceCodeService } from './internal-finance-code.service';
import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';
import { InternalFundService } from '../internal-fund/internal-fund.service';
import {
  fundDateKey,
  fundDayStart,
} from '../internal-fund/internal-fund-ledger.service';

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

type WarehouseExpenseAction =
  | 'view'
  | 'create'
  | 'update'
  | 'prepare'
  | 'submit'
  | 'mark_issued';

@Injectable()
export class InternalFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashFlowsService: CashFlowsService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly config: ConfigService,
    private readonly codeService: InternalFinanceCodeService,
    private readonly authService: AuthService,
    private readonly internalFund: InternalFundService,
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
    const conditions = Array.isArray(where.AND) ? where.AND : [];
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
      if (query.fromDate)
        occurredAt.gte = this.startOfDateString(query.fromDate);
      if (query.toDate) occurredAt.lt = this.nextDateStart(query.toDate);
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

  async listWarehouseExpenses(query: WarehouseExpenseQueryDto, user: any) {
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
    const page = query.page || 1;
    const limit = Math.min(query.limit || 50, 100);
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
    if (query.cashIssued === 'ISSUED') {
      conditions.push({ cashIssued: true });
    } else if (query.cashIssued === 'NOT_ISSUED') {
      conditions.push({ cashIssued: false });
    }
    if (query.fromDate || query.toDate) {
      const occurredAt: Record<string, Date> = {};
      if (query.fromDate) {
        occurredAt.gte = this.startOfDateString(query.fromDate);
      }
      if (query.toDate) {
        occurredAt.lt = this.nextDateStart(query.toDate);
      }
      conditions.push({ occurredAt });
    }
    if (query.search?.trim()) {
      const search = query.search.trim();
      conditions.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          {
            packingSlip: {
              code: { contains: search, mode: 'insensitive' },
            },
          },
        ],
      });
    }

    const where = { AND: conditions };
    const [data, total] = await Promise.all([
      this.prisma.internalFinanceEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: this.warehouseExpenseInclude(),
      }),
      this.prisma.internalFinanceEntry.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async createWarehouseExpense(dto: CreateWarehouseExpenseDto, user: any) {
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'create');
    return this.createManualExpense(
      {
        branchId: dto.branchId,
        category: INTERNAL_FINANCE_CATEGORY.OTHER_EXPENSE,
        amount: dto.amount,
        occurredAt: dto.occurredAt,
        description: dto.description.trim(),
        attachments: dto.attachments,
      },
      user,
    );
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
      if (entry.sourceType !== 'MANUAL_EXPENSE') {
        throw new BadRequestException(
          'Khoản chi từ báo đơn, xăng dầu hoặc chăm sóc xe phải sửa tại nguồn phát sinh',
        );
      }
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
        ].includes(entry.status as any)
      ) {
        throw new BadRequestException(
          'Khoản chi đã được tổng hợp hoặc kết thúc, không thể sửa',
        );
      }
      return tx.internalFinanceEntry.update({
        where: { id },
        data: {
          amount: dto.amount,
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

    return this.prisma.internalFinanceEntry.update({
      where: { id },
      data: {
        status: INTERNAL_FINANCE_STATUS.POSTED,
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

    const snapshot = this.snapshotOf(entry);
    const cashFlowIds = [
      ...new Set([
        ...this.postedCashFlows(snapshot).map((item) => Number(item.id)),
        ...(entry.cashFlowId ? [Number(entry.cashFlowId)] : []),
      ]),
    ]
      .filter((cashFlowId) => cashFlowId > 0)
      .sort((a, b) => a - b);
    const cancelledCashFlows: Array<{ cashFlow: any; updated: any }> = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.cancelCashFlows) {
        for (const cashFlowId of cashFlowIds) {
          cancelledCashFlows.push(
            await this.cashFlowsService.cancelInTransaction(tx, cashFlowId),
          );
        }
      }

      return tx.internalFinanceEntry.update({
        where: { id },
        data: { status: INTERNAL_FINANCE_STATUS.CANCELLED },
        include: this.warehouseInclude(),
      });
    });

    for (const result of cancelledCashFlows) {
      await this.cashFlowsService.logCancellation(result, userId);
    }

    return updated;
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
    this.assertWarehouseBranch(dto.branchId);
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: INTERNAL_FINANCE_CATEGORY.FUEL,
      subCategory: INTERNAL_FINANCE_SUBCATEGORY.FUEL,
      branchId: dto.branchId,
      amount: dto.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'FUEL',
      description: dto.description || `Xăng dầu - ${dto.vehicle}`,
      sourceSnapshot: {
        vehicle: dto.vehicle,
        location: dto.location,
        unitPrice: dto.unitPrice,
        liters: dto.liters,
        odo: dto.odo,
        consumptionLimit: dto.consumptionLimit,
        anomalyNote: dto.anomalyNote,
      },
      vehicleName: dto.vehicle,
      vehicleOdo: dto.odo,
      vehicleLiters: dto.liters,
      vehicleUnitPrice: dto.unitPrice,
      vehicleLocation: dto.location,
      vehicleAnomalyStatus: dto.anomalyNote,
      attachments: dto.attachments,
      userId: user.id,
    });
  }

  async createVehicleCare(dto: CreateVehicleCareEntryDto, user: any) {
    this.assertWarehouseBranch(dto.branchId);
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'create');
    await this.validateBranch(dto.branchId);
    return this.createManualEntry({
      direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
      category: INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE,
      subCategory: INTERNAL_FINANCE_SUBCATEGORY.VEHICLE_CARE,
      branchId: dto.branchId,
      amount: dto.amount,
      occurredAt: dto.occurredAt,
      sourceType: 'VEHICLE_CARE',
      description: dto.description || `${dto.serviceType} - ${dto.vehicle}`,
      sourceSnapshot: {
        vehicle: dto.vehicle,
        serviceType: dto.serviceType,
        location: dto.location,
        odo: dto.odo,
        dueAt: dto.dueAt,
        anomalyNote: dto.anomalyNote,
      },
      vehicleName: dto.vehicle,
      vehicleServiceType: dto.serviceType,
      vehicleOdo: dto.odo,
      vehicleLocation: dto.location,
      vehicleAnomalyStatus: dto.anomalyNote,
      attachments: dto.attachments,
      userId: user.id,
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
        occurredAt.gte = this.startOfDateString(query.fromDate);
      }
      if (query.toDate) {
        occurredAt.lt = this.nextDateStart(query.toDate);
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
    const where: any = {};
    if (query.branchIds?.length) where.branchId = { in: query.branchIds };
    if (query.status) where.status = query.status;
    if (query.fromDate || query.toDate) {
      where.weekStart = {};
      if (query.fromDate) {
        where.weekStart.gte = this.startOfDateString(query.fromDate);
      }
      if (query.toDate) {
        where.weekStart.lte = this.startOfDateString(query.toDate);
      }
    }
    const batches = await this.prisma.internalFinanceWeeklyBatch.findMany({
      where,
      orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
      take: Math.min(query.limit || 50, 100),
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
    await this.assertWarehouseExpensePermission(user, dto.branchId, 'prepare');
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
          occurredAt: { gte: weekStart, lte: weekEnd },
          status: { in: options.eligibleStatuses },
          ...(options.allowedCategories?.length
            ? { category: { in: options.allowedCategories } }
            : {}),
          cashFlowId: null,
          cashIssued: false,
          OR: existing
            ? [{ weeklyBatchId: null }, { weeklyBatchId: existing.id }]
            : [{ weeklyBatchId: null }],
        },
        select: { id: true, amount: true },
      });
      if (entries.length === 0) {
        if (existing) return existing;
        throw new BadRequestException(
          'Không có khoản chi đủ điều kiện để tổng hợp tuần',
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
        data: { status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL },
      });

      return batch;
    });
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
          clientUuid: `INTERNAL_FINANCE_WEEK:${batch.branchId}:${from}:${to}`,
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
    await this.assertWarehouseExpensePermission(user, batch.branchId, 'submit');
    return this.createWeeklyApproval(batchId, user.id, detailUrl, viewUrl);
  }

  async listWarehouseExpenseBatches(query: InternalFinanceQueryDto, user: any) {
    const allowedBranches = await this.allowedWarehouseExpenseBranches(
      user,
      'view',
    );
    if (!allowedBranches.length) {
      throw new ForbiddenException('Không có quyền xem phiếu chi kho');
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

  async getWarehouseExpenseBatch(id: number, user: any) {
    const batch = await this.prisma.internalFinanceWeeklyBatch.findUnique({
      where: { id },
      select: { id: true, branchId: true },
    });
    if (!batch) throw new NotFoundException('Không tìm thấy batch tuần');
    await this.assertWarehouseExpensePermission(user, batch.branchId, 'view');
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
    return this.updateCashIssued(entryId, dto.cashIssued, user.id);
  }

  async updateCashIssued(entryId: number, cashIssued: boolean, userId: number) {
    return this.internalFund.postExpenseEntry(entryId, userId, cashIssued);
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
    vehicleAnomalyStatus?: string;
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
          vehicleAnomalyStatus: input.vehicleAnomalyStatus,
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
        include: this.entryInclude(),
      });
    });
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
  ) {
    if (
      !(INTERNAL_FINANCE_BRANCH_IDS as readonly number[]).includes(
        Number(packingSlip.branchId),
      )
    ) {
      return;
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
        description: `${category} - ${packingSlip.code}`,
        sourceSnapshot: {
          packingSlipId: packingSlip.id,
          packingSlipCode: packingSlip.code,
          feeCategory: category,
          expensePayerId: packingSlip.expensePayerId,
          invoiceIds,
          orderIds,
        },
        occurredAt: packingSlip.createdAt,
        customerId,
        invoiceIds,
        attachments: attachmentData,
        userId,
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
          ],
        },
      },
      data: { status: INTERNAL_FINANCE_STATUS.CANCELLED },
    });
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
      preserveUserText?: boolean;
      reopenIfCancelled?: boolean;
    },
  ) {
    const existing = await db.internalFinanceEntry.findUnique({
      where: { sourceKey: data.sourceKey },
    });
    const evidenceStatus = data.attachments.length
      ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
      : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING;
    const direction = data.direction || INTERNAL_FINANCE_DIRECTION.EXPENSE;
    const requiresEvidence = direction === INTERNAL_FINANCE_DIRECTION.EXPENSE;
    if (existing) {
      if (
        existing.cashFlowId ||
        existing.cashIssued ||
        (direction === INTERNAL_FINANCE_DIRECTION.EXPENSE &&
          existing.weeklyBatchId)
      )
        return existing;
      const editableStatuses = [
        INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
        INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED,
        INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
        ...(data.reopenIfCancelled ? [INTERNAL_FINANCE_STATUS.CANCELLED] : []),
      ];
      if (!editableStatuses.includes(existing.status)) return existing;
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
          subCategory: data.subCategory || data.category,
          requiresEvidence,
          evidenceStatus: requiresEvidence
            ? evidenceStatus
            : INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
          status:
            existing.status === INTERNAL_FINANCE_STATUS.CANCELLED
              ? INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT
              : existing.status,
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

  private async allowedWarehouseExpenseBranches(
    user: any,
    action: WarehouseExpenseAction,
  ): Promise<number[]> {
    if (!user?.id) return [];
    if (user.roles?.includes('Super Admin')) {
      return WAREHOUSE_EXPENSE_SCOPES.flatMap((scope) => [...scope.branchIds]);
    }
    const branches: number[] = [];
    for (const scope of WAREHOUSE_EXPENSE_SCOPES) {
      const permission = `warehouse_expense:${action}_${scope.key}`;
      for (const branchId of scope.branchIds) {
        const permissions = await this.authService.getPermissionsForBranch(
          user.id,
          branchId,
        );
        const fundAction = this.internalFundExpenseAction(action);
        if (
          permissions.includes(permission) ||
          permissions.includes(`internal_fund:${fundAction}_${scope.key}`)
        ) {
          branches.push(branchId);
        }
      }
    }
    return [...new Set(branches)];
  }

  private async assertWarehouseExpensePermissionByUserId(
    userId: number,
    branchId: number,
    action: WarehouseExpenseAction,
  ) {
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    await this.assertWarehouseExpensePermission(
      {
        id: userId,
        roles: profile?.userRoles.map((row) => row.role.name) || [],
      },
      branchId,
      action,
    );
  }

  private async assertCashFlowPermission(
    userId: number,
    branchId: number,
    action: 'view' | 'create' | 'update',
  ) {
    const permissions = await this.authService.getPermissionsForBranch(
      userId,
      branchId,
    );
    if (!permissions.includes(`cash_flows:${action}`)) {
      throw new ForbiddenException(
        `Không có quyền cash_flows:${action} cho chi nhánh này`,
      );
    }
  }

  private async assertWarehouseExpensePermission(
    user: any,
    branchId: number,
    action: WarehouseExpenseAction,
  ) {
    if (user?.roles?.includes('Super Admin')) return;
    const scope = this.warehouseExpenseScopeForBranch(branchId);
    if (!scope) {
      throw new ForbiddenException(
        'Chi nhánh không thuộc phạm vi phiếu chi kho',
      );
    }
    const permissions = await this.authService.getPermissionsForBranch(
      user.id,
      branchId,
    );
    if (
      !permissions.includes(`warehouse_expense:${action}_${scope.key}`) &&
      !permissions.includes(
        `internal_fund:${this.internalFundExpenseAction(action)}_${scope.key}`,
      )
    ) {
      throw new ForbiddenException(
        `Không có quyền ${action} phiếu chi kho cho chi nhánh này`,
      );
    }
  }

  private internalFundExpenseAction(action: WarehouseExpenseAction) {
    if (action === 'create') return 'create_expense';
    if (action === 'update') return 'adjust';
    if (action === 'prepare' || action === 'submit') return 'submit_approval';
    return action;
  }

  private warehouseExpenseInclude() {
    return {
      ...this.entryInclude(),
      fundTransaction: { select: { id: true, code: true, status: true } },
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
