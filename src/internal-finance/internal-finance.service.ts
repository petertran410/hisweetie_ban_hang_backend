import {
  BadRequestException,
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
} from './internal-finance.constants';
import {
  CreateFuelEntryDto,
  CreateManualExpenseDto,
  CreateManualReceiptDto,
  CreateVehicleCareEntryDto,
  AddInternalFinanceAttachmentsDto,
  InternalFinanceQueryDto,
  PrepareWeeklyBatchDto,
  ReviewInternalFinanceDto,
} from './dto';
import { InternalFinanceCodeService } from './internal-finance-code.service';

type DbClient = PrismaService | any;

@Injectable()
export class InternalFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashFlowsService: CashFlowsService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    private readonly config: ConfigService,
    private readonly codeService: InternalFinanceCodeService,
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
      throw new BadRequestException(
        'Phiếu thu tiền mặt phải có nguồn tiền',
      );
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
      const customerIds = new Set(invoices.map((invoice) => invoice.customerId));
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

  async createManualExpense(dto: CreateManualExpenseDto, userId: number) {
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
      userId,
    });
  }

  async createFuel(dto: CreateFuelEntryDto, userId: number) {
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
      userId,
    });
  }

  async createVehicleCare(dto: CreateVehicleCareEntryDto, userId: number) {
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
      userId,
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
          in: [INTERNAL_FINANCE_STATUS.APPROVED, INTERNAL_FINANCE_STATUS.POSTED],
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

  async prepareWeeklyBatch(
    dto: PrepareWeeklyBatchDto,
    userId: number,
  ) {
    await this.validateBranch(dto.branchId);
    const weekStart = this.startOfDay(new Date(dto.weekStart));
    const weekEnd = this.endOfDay(new Date(dto.weekEnd));
    if (weekStart > weekEnd) {
      throw new BadRequestException('Tuần có ngày bắt đầu sau ngày kết thúc');
    }

    const eligibleStatuses = [
      INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
      INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL,
    ];
    const existing = await this.prisma.internalFinanceWeeklyBatch.findUnique({
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

    const entries = await this.prisma.internalFinanceEntry.findMany({
      where: {
        branchId: dto.branchId,
        direction: INTERNAL_FINANCE_DIRECTION.EXPENSE,
        occurredAt: { gte: weekStart, lte: weekEnd },
        status: { in: eligibleStatuses },
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
    const code = `TCNB-TUAN-${
      INTERNAL_FINANCE_BRANCH_CODES[dto.branchId] || `B${dto.branchId}`
    }-${weekStart.getUTCFullYear()}-W${String(this.isoWeek(weekStart)).padStart(
      2,
      '0',
    )}`;

    const batch = await this.prisma.internalFinanceWeeklyBatch.upsert({
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
          connect: entries.map((entry) => ({ id: entry.id })),
        },
      },
      include: { entries: true, branch: true },
    });

    await this.prisma.internalFinanceEntry.updateMany({
      where: { id: { in: entries.map((entry) => entry.id) } },
      data: { status: INTERNAL_FINANCE_STATUS.READY_FOR_WEEKLY_APPROVAL },
    });

    return batch;
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
    const from = this.dateOnly(batch.weekStart);
    const to = this.dateOnly(batch.weekEnd);
    const week = String(this.isoWeek(batch.weekStart));
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
              ? 'ml657iu1-n0lwb9zjbi-0'
              : 'ml657iu1-7mvb2xfgje6-0',
        },
      );
    }

    const request = await this.approvalLifecycle.create(
      {
        kind,
        branchId: batch.branchId,
        clientUuid: `INTERNAL_FINANCE_WEEK:${batch.branchId}:${this.dateKey(batch.weekStart)}`,
        sourceType: 'INTERNAL_FINANCE_WEEKLY',
        sourceId: batch.id,
        form,
      },
      userId,
    );

    await this.prisma.$transaction([
      this.prisma.internalFinanceWeeklyBatch.update({
        where: { id: batch.id },
        data: {
          approvalRequestId: request.id,
          status: INTERNAL_FINANCE_WEEKLY_STATUS.IN_APPROVAL,
        },
      }),
      this.prisma.internalFinanceEntry.updateMany({
        where: { weeklyBatchId: batch.id },
        data: { status: INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL },
      }),
    ]);

    return request;
  }

  async updateCashIssued(entryId: number, cashIssued: boolean, userId: number) {
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { id: entryId },
      include: { weeklyBatch: true },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy dòng tài chính');
    if (entry.direction !== INTERNAL_FINANCE_DIRECTION.EXPENSE) {
      throw new BadRequestException('Chỉ khoản chi mới có trạng thái Đã chi');
    }
    if (entry.cashFlowId) {
      throw new BadRequestException(
        'Dòng tài chính đã có CashFlow và không thể đổi trạng thái Đã chi',
      );
    }
    if (cashIssued) {
      if (entry.status !== INTERNAL_FINANCE_STATUS.APPROVED) {
        throw new BadRequestException(
          'Chỉ khoản chi đã được Approval tuần duyệt mới được đánh dấu Đã chi',
        );
      }
      if (
        !entry.weeklyBatch ||
        entry.weeklyBatch.status !== INTERNAL_FINANCE_WEEKLY_STATUS.APPROVED
      ) {
        throw new BadRequestException(
          'Batch tuần chưa được Approval duyệt',
        );
      }
    }
    return this.prisma.internalFinanceEntry.update({
      where: { id: entryId },
      data: {
        cashIssued,
        cashIssuedAt: cashIssued ? new Date() : null,
        cashIssuedBy: cashIssued ? userId : null,
      },
      include: this.entryInclude(),
    });
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
    const snapshot =
      entry.sourceSnapshot &&
      typeof entry.sourceSnapshot === 'object' &&
      !Array.isArray(entry.sourceSnapshot)
        ? (entry.sourceSnapshot as Record<string, unknown>)
        : {};
    const receiptMethod =
      snapshot.method === 'transfer' ? 'transfer' : 'cash';
    return this.cashFlowsService.createInternalFinanceCashFlow(
      {
        entryId: entry.id,
        branchId: entry.branchId,
        amount: Number(entry.amount),
        transDate: entry.occurredAt.toISOString(),
        description: entry.description || entry.code,
        method:
          entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT
            ? receiptMethod
            : 'cash',
        isReceipt: entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT,
      },
      userId,
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

  private async reviewAsAccountant(entry: any, dto: ReviewInternalFinanceDto, userId: number) {
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.MARK_MISSING) {
      if (!dto.reason) {
        throw new BadRequestException(
          'Ghi nhận thiếu chứng từ phải có lý do',
        );
      }
      return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT, dto, {
        evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
        status:
          entry.direction === INTERNAL_FINANCE_DIRECTION.EXPENSE
            ? INTERNAL_FINANCE_STATUS.PENDING_MANAGER
            : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT,
      });
    }
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.REJECT) {
      return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT, dto, {
        status: INTERNAL_FINANCE_STATUS.REJECTED,
      });
    }
    if (dto.decision !== INTERNAL_FINANCE_REVIEW_DECISION.APPROVE) {
      throw new BadRequestException('Kế toán chỉ được xác nhận hoặc từ chối');
    }
    if (entry.requiresEvidence && entry.evidenceStatus === INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING) {
      throw new BadRequestException('Khoản chi đang thiếu chứng từ');
    }
    return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.ACCOUNTANT, dto, {
      status:
        entry.direction === INTERNAL_FINANCE_DIRECTION.RECEIPT
          ? INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED
          : INTERNAL_FINANCE_STATUS.PENDING_MANAGER,
      evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
    });
  }

  private async reviewAsManager(entry: any, dto: ReviewInternalFinanceDto, userId: number) {
    if (!entry.accountantReviewedBy) {
      throw new BadRequestException('Khoản này chưa được kế toán kiểm tra');
    }
    if (dto.decision === INTERNAL_FINANCE_REVIEW_DECISION.REJECT) {
      return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.MANAGER, dto, {
        status: INTERNAL_FINANCE_STATUS.REJECTED,
      });
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
      return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.MANAGER, dto, {
        status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
        evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.EXCEPTION_APPROVED,
        exceptionReason: dto.reason,
        exceptionDueAt: dto.dueAt ? new Date(dto.dueAt) : null,
      });
    }
    if (dto.decision !== INTERNAL_FINANCE_REVIEW_DECISION.APPROVE) {
      throw new BadRequestException('Quản lý chỉ được duyệt, duyệt ngoại lệ hoặc từ chối');
    }
    if (entry.evidenceStatus === INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING) {
      throw new BadRequestException(
        'Khoản chi thiếu chứng từ phải dùng Duyệt ngoại lệ',
      );
    }
    return this.applyReview(entry, userId, INTERNAL_FINANCE_REVIEW_ROLE.MANAGER, dto, {
      status: INTERNAL_FINANCE_STATUS.MANAGER_APPROVED,
      evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
    });
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
    if (!(INTERNAL_FINANCE_BRANCH_IDS as readonly number[]).includes(branchId)) {
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
      (packingSlip.invoices || []).find(
        (row: any) => row.invoice?.customerId,
      )?.invoice?.customerId ??
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
    if (packingSlip.paymentMethod === 'cash' && cashAmount > 0) {
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
        },
        occurredAt: packingSlip.createdAt,
        customerId,
        invoiceIds,
        attachments: attachmentData,
        userId,
      });
    }

    await db.internalFinanceEntry.updateMany({
      where: {
        packingSlipId: packingSlip.id,
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
    },
  ) {
    const existing = await db.internalFinanceEntry.findUnique({
      where: { sourceKey: data.sourceKey },
    });
    const evidenceStatus = data.attachments.length
      ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
      : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING;
    const direction =
      data.direction || INTERNAL_FINANCE_DIRECTION.EXPENSE;
    const requiresEvidence = direction === INTERNAL_FINANCE_DIRECTION.EXPENSE;
    if (existing) {
      if (
        existing.status !== INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT &&
        existing.status !== INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED &&
        existing.status !== INTERNAL_FINANCE_STATUS.PENDING_MANAGER
      ) {
        return existing;
      }
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
          description: data.description,
          branchId: data.branchId,
          occurredAt: data.occurredAt || undefined,
          customerId: data.customerId ?? undefined,
          subCategory: data.subCategory || data.category,
          requiresEvidence,
          evidenceStatus: requiresEvidence
            ? evidenceStatus
            : INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
          sourceSnapshot: data.sourceSnapshot,
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

  private toJson(value?: Record<string, unknown>): Prisma.InputJsonValue | undefined {
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
