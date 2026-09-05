import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DebtTrackingQueryDto,
  UpsertDebtPolicyDto,
  UpdateDebtNoteDto,
  CreateCollectionAttemptDto,
  EditCollectionAttemptDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  computeCustomerAging,
  evaluatePaymentFrequency,
  hasAnyDebtPolicy,
  type AgingInvoiceInput,
  type DebtPolicyInput,
} from './debt-aging.util';
import {
  evaluateAutoPaymentHistory,
  type AutoPaymentHistoryResult,
} from './payment-history.util';
import {
  DEBT_STATUS,
  DEBT_STATUS_WEIGHT,
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_TYPE,
  DEBT_TICKET_LINE_STATUS,
  INVOICE_STATUS_CANCELLED,
  MONEY_EPSILON,
} from './debt-tracking.constants';

/**
 * Số khách tối đa nạp vào bộ nhớ trong 1 lần tính.
 * Thực tế chỉ ~1.700 khách có dư nợ nên ngưỡng này rất thoáng; đặt ra để
 * phòng trường hợp dữ liệu phình bất thường, tránh treo tiến trình.
 */
const MAX_CUSTOMERS_SCAN = 5000;

/** Bản ghi chính sách công nợ đọc từ DB. */
export interface RawDebtPolicy {
  hasCreditLimit: boolean;
  creditLimit: unknown;
  hasTermDays: boolean;
  termDays: number | null;
  paymentFrequency: number | null;
  debtForm: string | null;
  salePicId: number | null;
  accountantPicId: number | null;
  requireFullPaymentForInvoice?: boolean;
}

export interface LastPaymentInfo {
  id: number;
  code: string;
  amount: number;
  transDate: Date;
  method: string | null;
  description: string | null;
}

export interface OpenTicketInfo {
  ticketId: number;
  ticketCode: string;
  ticketStatus: string;
  lineId: number;
  assigneeId: number;
  assignee: { id: number; name: string } | null;
  minimumPayment: number | null;
  confirmedAmount: number | null;
  confirmedDate: Date | null;
  debtAtCreate: number;
  lineStatus: string;
  isPaid: boolean;
  ticketType: string;
  requiredPaymentAmount: number;
  note: string | null;
}

export interface CollectionAttemptView {
  id: number;
  role: 'ACCOUNTANT' | 'SALES';
  attemptDate: string;
  recordedAt: Date;
  recordedBy: { id: number; name: string };
  isActive: boolean;
  actionType: string;
  supersedesId: number | null;
}

@Injectable()
export class DebtTrackingService {
  private readonly logger = new Logger(DebtTrackingService.name);

  constructor(
    private prisma: PrismaService,
    private auditLogs: AuditLogsService,
  ) {}

  // ================================================================
  // DANH SÁCH THEO DÕI CÔNG NỢ
  //
  // Thứ tự lấy dữ liệu bám đúng nghiệp vụ:
  //   1. Nợ hiện tại của khách    (customer.totalDebt — Formula A)
  //   2. Khoản thanh toán gần nhất (CashFlow thu)
  //   3. Rồi mới tới mốc báo đơn giao hàng để tính hạn
  // ================================================================
  async findAll(query: DebtTrackingQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    // ---- BƯỚC 1: nợ hiện tại + chính sách ----
    // Chỉ lấy khách CÓ chính sách công nợ (ít nhất một chiều bật) và ĐANG
    // có dư nợ. Khách tắt cả hai chiều = không công nợ ⇒ loại khỏi theo dõi.
    const policyWhere: Record<string, unknown> = { isActive: true };

    if (query.hasCreditLimit !== undefined) {
      policyWhere.hasCreditLimit = query.hasCreditLimit;
    }
    if (query.hasTermDays !== undefined) {
      policyWhere.hasTermDays = query.hasTermDays;
    }
    if (query.hasCreditLimit === undefined && query.hasTermDays === undefined) {
      policyWhere.OR = [{ hasCreditLimit: true }, { hasTermDays: true }];
    }
    if (query.debtForm) policyWhere.debtForm = query.debtForm;
    if (query.salePicId) policyWhere.salePicId = query.salePicId;
    if (query.accountantPicId) {
      policyWhere.accountantPicId = query.accountantPicId;
    }

    const customerWhere: Record<string, unknown> = {
      totalDebt: { gt: 0 },
      debtPolicy: { is: policyWhere },
    };

    if (query.branchId) customerWhere.branchId = query.branchId;

    if (query.search?.trim()) {
      const s = query.search.trim();
      customerWhere.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
        { contactNumber: { contains: s } },
        { phone: { contains: s } },
      ];
    }

    const customers = await this.prisma.customer.findMany({
      where: customerWhere,
      take: MAX_CUSTOMERS_SCAN,
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        phone: true,
        totalDebt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        debtPolicy: true,
        debtNote: true,
      },
    });

    if (customers.length === 0) {
      return {
        data: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 },
      };
    }

    const customerIds = customers.map((c) => c.id);

    // ---- BƯỚC 2: thanh toán (gần nhất + lịch sử trong tháng) ----
    const { lastPaymentMap, monthPaymentDates } =
      await this.getPaymentInfo(customerIds);

    // ---- BƯỚC 3: hóa đơn + mốc báo đơn giao hàng ----
    const invoiceMap = await this.getInvoicesForAging(customerIds);

    // ---- Phiếu thu hồi nợ đang mở ----
    const ticketMap = await this.getOpenTicketLines(customerIds);

    // ---- Lịch sử thanh toán tự tính 6 tháng ----
    const paymentHistoryMap = await this.getAutoPaymentHistories(customerIds);

    // ---- Người phụ trách ----
    const picMap = await this.getPicUsers(customers);
    const collectionAttemptMap =
      await this.getCollectionAttemptMap(customerIds);

    // ---- Tính toán ----
    const now = new Date();
    let rows = customers.map((c) => {
      const policy = this.toPolicyInput(c.debtPolicy as RawDebtPolicy | null);
      const aging = computeCustomerAging(
        Number(c.totalDebt),
        invoiceMap.get(c.id) ?? [],
        policy,
        now,
      );

      const frequency = evaluatePaymentFrequency(
        monthPaymentDates.get(c.id) ?? [],
        policy.paymentFrequency,
        now,
      );

      const p = c.debtPolicy as
        | (RawDebtPolicy & {
            paymentHistoryOverride?: string | null;
            paymentHistoryOverrideNote?: string | null;
            paymentHistoryOverriddenBy?: number | null;
            paymentHistoryOverriddenAt?: Date | null;
          })
        | null;
      const autoPaymentHistory =
        paymentHistoryMap.get(c.id) ??
        evaluateAutoPaymentHistory({
          lateCount: 0,
          maxDaysOverdue: 0,
          currentOverdueDays: 0,
          sampleSize: 0,
        });
      const appliedPaymentHistory = p?.paymentHistoryOverride
        ? p.paymentHistoryOverride
        : autoPaymentHistory.history;
      const debtNote = c.debtNote as {
        note?: string | null;
        noteAt?: Date | null;
      } | null;

      return {
        customerId: c.id,
        code: c.code,
        name: c.name,
        contactNumber: c.contactNumber ?? c.phone ?? null,
        branch: c.branch,

        // 1. Nợ hiện tại
        totalDebt: Number(c.totalDebt),

        // 2. Thanh toán gần nhất
        lastPayment: lastPaymentMap.get(c.id) ?? null,
        paymentFrequency: frequency,

        // 3. Hạn nợ tính từ mốc báo đơn
        policy: {
          hasCreditLimit: policy.hasCreditLimit,
          creditLimit: policy.creditLimit ?? null,
          hasTermDays: policy.hasTermDays,
          termDays: policy.termDays ?? null,
          paymentFrequency: policy.paymentFrequency ?? null,
          debtForm: p?.debtForm ?? null,
          paymentHistory: {
            auto: autoPaymentHistory,
            applied: appliedPaymentHistory,
            isOverridden: !!p?.paymentHistoryOverride,
            overrideNote: p?.paymentHistoryOverrideNote ?? null,
            overriddenAt: p?.paymentHistoryOverriddenAt ?? null,
          },
          salePic: p?.salePicId ? (picMap.get(p.salePicId) ?? null) : null,
          accountantPic: p?.accountantPicId
            ? (picMap.get(p.accountantPicId) ?? null)
            : null,
          salePicId: p?.salePicId ?? null,
          accountantPicId: p?.accountantPicId ?? null,
          requireFullPaymentForInvoice:
            p?.requireFullPaymentForInvoice ?? false,
        },

        overdueAmount: aging.overdueAmount,
        dueAmount: aging.dueAmount,
        dueSoonAmount: aging.dueSoonAmount,
        notDueAmount: aging.notDueAmount,
        undeliveredAmount: aging.undeliveredAmount,
        unallocatedAmount: aging.unallocatedAmount,
        nearestDueDate: aging.nearestDueDate,
        maxDaysOverdue: aging.maxDaysOverdue,
        creditLimit: aging.creditLimit,
        creditUsageRatio: aging.creditUsageRatio,
        limitReached: aging.limitReached,
        overLimitAmount: aging.overLimitAmount,
        limitOverdueAmount: aging.limitOverdueAmount,
        invoiceRequiredAmount: aging.invoiceRequiredAmount,
        requiredPaymentAmount: aging.requiredPaymentAmount,
        requiredPaymentSource: aging.requiredPaymentSource,
        debtStatus: aging.debtStatus,
        outstandingCount: aging.outstandingInvoices.length,

        // Ghi chú dùng chung và lịch sử các lần đòi nợ
         note: debtNote?.note ?? null,
         noteAt: debtNote?.noteAt ?? null,
         accountantCollectionAttempts:
           collectionAttemptMap.get(c.id)?.ACCOUNTANT ?? [],
         salesCollectionAttempts: collectionAttemptMap.get(c.id)?.SALES ?? [],

        // Phiếu thu hồi nợ
        openTicket: ticketMap.get(c.id)?.openTicket ?? null,
        latestStopTicket: ticketMap.get(c.id)?.latestStopTicket ?? null,
      };
    });

    // ---- Lọc sau khi tính (giá trị suy ra, không có trong DB) ----
    if (query.paymentHistory) {
      rows = rows.filter(
        (r) => r.policy.paymentHistory.applied === query.paymentHistory,
      );
    }
    if (query.debtStatus) {
      rows = rows.filter((r) => r.debtStatus === query.debtStatus);
    }
    if (query.overLimitOnly) {
      rows = rows.filter((r) => r.overLimitAmount > MONEY_EPSILON);
    }
    if (query.withoutOpenTicket) {
      rows = rows.filter((r) => !r.openTicket);
    }

    // ---- Sắp xếp ----
    const dir = query.orderDirection === 'asc' ? 1 : -1;
    const orderBy = query.orderBy ?? 'debtStatus';
    rows.sort((a, b) => {
      switch (orderBy) {
        case 'totalDebt':
          return (a.totalDebt - b.totalDebt) * dir;
        case 'overdueAmount':
          return (a.overdueAmount - b.overdueAmount) * dir;
        case 'requiredPaymentAmount':
          return (a.requiredPaymentAmount - b.requiredPaymentAmount) * dir;
        case 'daysOverdue':
          return (a.maxDaysOverdue - b.maxDaysOverdue) * dir;
        case 'overLimit':
          return (a.overLimitAmount - b.overLimitAmount) * dir;
        case 'name':
          return a.name.localeCompare(b.name, 'vi') * (dir === 1 ? 1 : -1);
        case 'debtStatus':
        default: {
          // Mặc định: nghiêm trọng nhất lên đầu, cùng mức thì nợ lớn hơn trước.
          const wa = DEBT_STATUS_WEIGHT[a.debtStatus] ?? 99;
          const wb = DEBT_STATUS_WEIGHT[b.debtStatus] ?? 99;
          if (wa !== wb) return wa - wb;
          if (a.maxDaysOverdue !== b.maxDaysOverdue)
            return b.maxDaysOverdue - a.maxDaysOverdue;
          return b.totalDebt - a.totalDebt;
        }
      }
    });

    const total = rows.length;
    const start = (page - 1) * pageSize;

    return {
      data: rows.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  // ================================================================
  // TỔNG HỢP
  // ================================================================
  async getSummary(query: DebtTrackingQueryDto) {
    // Dùng lại findAll với pageSize lớn để số liệu tổng hợp và danh sách
    // không bao giờ lệch nhau về cách tính.
    const all = await this.findAll({
      ...query,
      page: 1,
      pageSize: MAX_CUSTOMERS_SCAN,
      debtStatus: undefined,
    });

    const rows = all.data;
    const sum = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((acc, r) => acc + f(r), 0);
    const countBy = (st: string) =>
      rows.filter((r) => r.debtStatus === st).length;

    return {
      totalCustomers: rows.length,
      totalDebt: sum((r) => r.totalDebt),
      overdueAmount: sum((r) => r.overdueAmount),
      dueAmount: sum((r) => r.dueAmount),
      dueSoonAmount: sum((r) => r.dueSoonAmount),
      notDueAmount: sum((r) => r.notDueAmount),
      undeliveredAmount: sum((r) => r.undeliveredAmount),
      unallocatedAmount: sum((r) => r.unallocatedAmount),
      overLimitAmount: sum((r) => r.overLimitAmount),
      limitOverdueAmount: sum((r) => r.limitOverdueAmount),
      invoiceRequiredAmount: sum((r) => r.invoiceRequiredAmount),
      requiredPaymentAmount: sum((r) => r.requiredPaymentAmount),
      byDebtStatus: {
        OVERDUE: countBy(DEBT_STATUS.OVERDUE),
        DUE: countBy(DEBT_STATUS.DUE),
        NORMAL: countBy(DEBT_STATUS.NORMAL),
      },
      customersOverLimit: rows.filter((r) => r.overLimitAmount > MONEY_EPSILON)
        .length,
      customersWithOpenTicket: rows.filter((r) => r.openTicket).length,
    };
  }

  // ================================================================
  // CHI TIẾT MỘT KHÁCH
  // ================================================================
  async getDetail(customerId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        phone: true,
        totalDebt: true,
        branch: { select: { id: true, name: true } },
        debtPolicy: true,
        debtNote: true,
      },
    });

    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const policy = this.toPolicyInput(
      customer.debtPolicy as RawDebtPolicy | null,
    );
    const invoices =
      (await this.getInvoicesForAging([customerId])).get(customerId) ?? [];
    const now = new Date();
    const aging = computeCustomerAging(
      Number(customer.totalDebt),
      invoices,
      policy,
      now,
    );

    const [recentPayments, ticketLines] = await Promise.all([
      this.getRecentPayments(customerId, 20),
      this.prisma.debtTicketCustomer.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          ticket: {
            select: {
              id: true,
              code: true,
              status: true,
              ticketType: true,
              createdAt: true,
              closedAt: true,
              assignee: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);

    const frequency = evaluatePaymentFrequency(
      recentPayments.map((p) => p.transDate),
      policy.paymentFrequency,
      now,
    );

    return {
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        contactNumber: customer.contactNumber ?? customer.phone ?? null,
        branch: customer.branch,
        totalDebt: Number(customer.totalDebt),
      },
      policy: customer.debtPolicy,
      note: customer.debtNote,
      aging,
      paymentFrequency: frequency,
      recentPayments,
      tickets: ticketLines.map((l) => ({
        ticketId: l.ticketId,
        ticketCode: l.ticket.code,
        ticketStatus: l.ticket.status,
        assignee: l.ticket.assignee,
        ticketType: l.ticket.ticketType,
        requiredPaymentAmount: Number(l.requiredPaymentAmount),
        debtAtCreate: Number(l.debtAtCreate),
        minimumPayment:
          l.minimumPayment !== null ? Number(l.minimumPayment) : null,
        confirmedAmount:
          l.confirmedAmount !== null ? Number(l.confirmedAmount) : null,
        confirmedDate: l.confirmedDate,
        status: l.status,
        isLatest: l.isLatest,
        paidAt: l.paidAt,
        paidAmount: l.paidAmount !== null ? Number(l.paidAmount) : null,
        createdAt: l.ticket.createdAt,
        closedAt: l.ticket.closedAt,
      })),
    };
  }

  // ================================================================
  // CHÍNH SÁCH CÔNG NỢ
  // ================================================================
  async getPolicy(customerId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, code: true, name: true, totalDebt: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const policy = await this.prisma.customerDebtPolicy.findUnique({
      where: { customerId },
    });

    return { customer, policy };
  }

  async upsertPolicy(
    customerId: number,
    dto: UpsertDebtPolicyDto,
    userId: number,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    // Chỉ giữ tham số thuộc chiều đang BẬT, tránh dữ liệu rác gây hiểu nhầm
    // khi tắt một chiều (ví dụ tắt hạn mức mà creditLimit còn sót lại).
    const data = {
      hasCreditLimit: dto.hasCreditLimit,
      creditLimit: dto.hasCreditLimit ? (dto.creditLimit ?? null) : null,
      hasTermDays: dto.hasTermDays,
      termDays: dto.hasTermDays ? (dto.termDays ?? null) : null,
      paymentFrequency: dto.paymentFrequency ?? null,
      debtForm: dto.debtForm ?? null,
      salePicId: dto.salePicId ?? null,
      accountantPicId: dto.accountantPicId ?? null,
      isActive: dto.isActive ?? true,
    };

    const createData = {
      ...data,
      requireFullPaymentForInvoice:
        dto.requireFullPaymentForInvoice ?? false,
    };
    const updateData =
      dto.requireFullPaymentForInvoice === undefined
        ? data
        : {
            ...data,
            requireFullPaymentForInvoice: dto.requireFullPaymentForInvoice,
          };

    return this.prisma.customerDebtPolicy.upsert({
      where: { customerId },
      create: {
        customerId,
        ...createData,
        createdBy: userId,
        updatedBy: userId,
      },
      update: { ...updateData, updatedBy: userId },
    });
  }

  // ================================================================
  // GHI CHÚ — một nguồn dùng chung
  // ================================================================
  async updateNote(
    customerId: number,
    dto: UpdateDebtNoteDto,
    userId: number,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const now = new Date();
    const data: Record<string, unknown> = {};

    if (dto.note !== undefined) {
      data.note = dto.note || null;
      data.noteBy = userId;
      data.noteAt = dto.note ? now : null;
    }

    if (Object.keys(data).length === 0) {
      return this.prisma.customerDebtNote.findUnique({ where: { customerId } });
    }

    return this.prisma.customerDebtNote.upsert({
      where: { customerId },
      create: { customerId, ...data },
      update: data,
    });
  }

  async getCollectionAttempts(customerId: number) {
    const rows = await this.prisma.customerDebtCollectionAttempt.findMany({
      where: { customerId },
      orderBy: [{ role: 'asc' }, { attemptDate: 'asc' }, { recordedAt: 'asc' }],
      include: { recordedBy: { select: { id: true, name: true } } },
    });
    return {
      customerId,
      accountant: rows
        .filter((row) => row.role === 'ACCOUNTANT')
        .map((row) => this.serializeCollectionAttempt(row)),
      sales: rows
        .filter((row) => row.role === 'SALES')
        .map((row) => this.serializeCollectionAttempt(row)),
    };
  }

  async createCollectionAttempt(
    customerId: number,
    dto: CreateCollectionAttemptDto,
    userId: number,
  ) {
    const attemptDate = this.parseCollectionAttemptDate(dto.attemptDate);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`;
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true, code: true, name: true, branchId: true },
      });
      if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

      const latest = await tx.customerDebtCollectionAttempt.findFirst({
        where: { customerId, role: dto.role, isActive: true },
        orderBy: [{ attemptDate: 'desc' }, { recordedAt: 'desc' }],
        select: { attemptDate: true },
      });
      if (latest && attemptDate <= latest.attemptDate) {
        throw new BadRequestException(
          `Ngày đòi nợ ${dto.role === 'ACCOUNTANT' ? 'kế toán' : 'sale'} phải sau ngày ${this.formatDateOnly(latest.attemptDate)}.`,
        );
      }

      const created = await tx.customerDebtCollectionAttempt.create({
        data: {
          customerId,
          role: dto.role,
          attemptDate,
          recordedById: userId,
        },
        include: { recordedBy: { select: { id: true, name: true } } },
      });
      return created;
    });

    await this.writeCollectionAttemptAudit('CREATE', created, null, userId);
    return this.serializeCollectionAttempt(created);
  }

  async editCollectionAttempt(
    customerId: number,
    attemptId: number,
    dto: EditCollectionAttemptDto,
    userId: number,
  ) {
    if (!dto.reason?.trim()) {
      throw new BadRequestException('Lý do chỉnh sửa không được để trống');
    }
    const attemptDate = this.parseCollectionAttemptDate(dto.attemptDate);
    const { created, previousDate } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`;
      const current = await tx.customerDebtCollectionAttempt.findFirst({
        where: { id: attemptId, customerId, isActive: true },
        include: { recordedBy: { select: { id: true, name: true } } },
      });
      if (!current) throw new NotFoundException('Không tìm thấy lần đòi nợ');

      const [previous, next] = await Promise.all([
        tx.customerDebtCollectionAttempt.findFirst({
          where: {
            customerId,
            role: current.role,
            isActive: true,
            id: { not: current.id },
            attemptDate: { lt: current.attemptDate },
          },
          orderBy: { attemptDate: 'desc' },
          select: { attemptDate: true },
        }),
        tx.customerDebtCollectionAttempt.findFirst({
          where: {
            customerId,
            role: current.role,
            isActive: true,
            id: { not: current.id },
            attemptDate: { gt: current.attemptDate },
          },
          orderBy: { attemptDate: 'asc' },
          select: { attemptDate: true },
        }),
      ]);
      if (previous && attemptDate <= previous.attemptDate) {
        throw new BadRequestException(
          `Ngày mới phải sau ngày ${this.formatDateOnly(previous.attemptDate)}.`,
        );
      }
      if (next && attemptDate >= next.attemptDate) {
        throw new BadRequestException(
          `Ngày mới phải trước ngày ${this.formatDateOnly(next.attemptDate)}.`,
        );
      }

      await tx.customerDebtCollectionAttempt.update({
        where: { id: current.id },
        data: { isActive: false },
      });
      const created = await tx.customerDebtCollectionAttempt.create({
        data: {
          customerId,
          role: current.role,
          attemptDate,
          recordedById: userId,
          supersedesId: current.id,
          actionType: 'EDIT',
          reason: dto.reason.trim(),
        },
        include: { recordedBy: { select: { id: true, name: true } } },
      });
      return {
        created,
        previousDate: current.attemptDate,
      };
    });

    await this.writeCollectionAttemptAudit(
      'EDIT',
      created,
      attemptId,
      userId,
      dto.reason,
      previousDate,
    );
    return this.serializeCollectionAttempt(created);
  }

  private async getCollectionAttemptMap(customerIds: number[]) {
    const rows = await this.prisma.customerDebtCollectionAttempt.findMany({
      where: { customerId: { in: customerIds }, isActive: true },
      orderBy: [{ customerId: 'asc' }, { role: 'asc' }, { attemptDate: 'asc' }],
      include: { recordedBy: { select: { id: true, name: true } } },
    });
    const map = new Map<
      number,
      { ACCOUNTANT: CollectionAttemptView[]; SALES: CollectionAttemptView[] }
    >();
    for (const row of rows) {
      const current =
        map.get(row.customerId) ?? { ACCOUNTANT: [], SALES: [] };
      if (row.role === 'ACCOUNTANT' || row.role === 'SALES') {
        current[row.role].push(this.serializeCollectionAttempt(row));
      }
      map.set(row.customerId, current);
    }
    return map;
  }

  private parseCollectionAttemptDate(value: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const today = new Date();
    const todayKey = this.formatDateOnly(
      new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
    );
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new BadRequestException('Ngày đòi nợ không hợp lệ.');
    }
    if (value > todayKey) {
      throw new BadRequestException('Không thể chọn ngày đòi nợ trong tương lai.');
    }
    return date;
  }

  private formatDateOnly(value: Date): string {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }

  private serializeCollectionAttempt(row: any): CollectionAttemptView {
    return {
      id: row.id,
      role: row.role,
      attemptDate: this.formatDateOnly(row.attemptDate),
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy,
      isActive: row.isActive,
      actionType: row.actionType,
      supersedesId: row.supersedesId ?? null,
    };
  }

  private async writeCollectionAttemptAudit(
    action: 'CREATE' | 'EDIT',
    row: any,
    supersedesId: number | null,
    userId: number,
    reason?: string,
    previousDate?: Date,
  ) {
    const [user, customer] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, branchId: true },
      }),
      this.prisma.customer.findUnique({
        where: { id: row.customerId },
        select: { id: true, code: true, name: true },
      }),
    ]);
    await this.auditLogs.create({
      actionType: 'POST',
      actionCode:
        action === 'CREATE'
          ? 'CUSTOMER_DEBT_COLLECTION_ATTEMPT_CREATE'
          : 'CUSTOMER_DEBT_COLLECTION_ATTEMPT_EDIT',
      entityType: 'customer_debt_collection_attempts',
      entityId: String(row.id),
      entityCode: customer?.code ?? undefined,
      category: 'customer_debt',
      severity: 'info',
      snapshot: {
        id: row.id,
        customerId: row.customerId,
        customerCode: customer?.code,
        customerName: customer?.name,
        role: row.role,
        attemptDate: this.formatDateOnly(row.attemptDate),
        supersedesId,
      },
      changes: supersedesId
        ? [
            {
              field: 'attemptDate',
              label: 'Ngày đòi nợ',
              from: previousDate
                ? this.formatDateOnly(previousDate)
                : null,
              to: this.formatDateOnly(row.attemptDate),
            },
            ...(reason
              ? [{ field: 'reason', label: 'Lý do chỉnh sửa', to: reason }]
              : []),
          ]
        : undefined,
      message:
        action === 'CREATE'
          ? `Thêm lần đòi nợ cho khách ${customer?.name ?? row.customerId}`
          : `Chỉnh sửa lần đòi nợ của khách ${customer?.name ?? row.customerId}${reason ? `: ${reason}` : ''}`,
      messageTemplate: `CUSTOMER_DEBT_COLLECTION_ATTEMPT_${action}`,
      userId,
      userName: user?.name ?? `User#${userId}`,
      branchId: user?.branchId ?? undefined,
      metadata: {
        customerId: row.customerId,
        role: row.role,
        supersedesId,
        reason,
      },
    });
  }

  // ================================================================
  // HELPERS
  // ================================================================

  private toPolicyInput(policy: RawDebtPolicy | null): DebtPolicyInput {
    if (!policy) return { hasCreditLimit: false, hasTermDays: false };
    return {
      hasCreditLimit: !!policy.hasCreditLimit,
      creditLimit:
        policy.creditLimit !== null && policy.creditLimit !== undefined
          ? Number(policy.creditLimit)
          : null,
      hasTermDays: !!policy.hasTermDays,
      termDays: policy.termDays,
      paymentFrequency: policy.paymentFrequency,
    };
  }

  /**
   * Tự đánh giá thanh toán trong 6 tháng gần nhất từ InvoicePayment. Kết quả
   * chỉ là gợi ý; người dùng có thể override kèm lý do.
   */
  private async getAutoPaymentHistories(customerIds: number[]) {
    const now = new Date();
    const from = new Date(now);
    from.setMonth(from.getMonth() - 6);

    const [invoices, policies] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          customerId: { in: customerIds },
          status: { notIn: [INVOICE_STATUS_CANCELLED] },
          deliveredAt: { not: null, gte: from },
          grandTotal: { gt: 0 },
        },
        select: {
          customerId: true,
          grandTotal: true,
          deliveredAt: true,
          payments: {
            where: { status: { not: 2 } },
            select: { amount: true, paymentDate: true },
          },
        },
      }),
      this.prisma.customerDebtPolicy.findMany({
        where: { customerId: { in: customerIds } },
        select: { customerId: true, hasTermDays: true, termDays: true },
      }),
    ]);

    const policyMap = new Map(policies.map((p) => [p.customerId, p]));
    const stats = new Map<
      number,
      { lateCount: number; maxDaysOverdue: number; sampleSize: number }
    >();

    for (const invoice of invoices) {
      if (!invoice.customerId || !invoice.deliveredAt) continue;
      const policy = policyMap.get(invoice.customerId);
      // Không có hạn theo ngày thì chưa đủ dữ liệu để chấm đúng/trễ.
      if (!policy?.hasTermDays || policy.termDays === null) continue;

      // Lịch sử thanh toán vẫn dùng ngày hết ân hạn làm mốc đánh giá đúng/trễ.
      const due = new Date(invoice.deliveredAt);
      due.setHours(0, 0, 0, 0);
      due.setDate(due.getDate() + policy.termDays + 5);

      const stat = stats.get(invoice.customerId) ?? {
        lateCount: 0,
        maxDaysOverdue: 0,
        sampleSize: 0,
      };
      stat.sampleSize++;

      const paid = invoice.payments.reduce(
        (sum, payment) => sum + Number(payment.amount),
        0,
      );
      const lastPayment = invoice.payments
        .map((payment) => payment.paymentDate)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const comparedAt =
        paid >= Number(invoice.grandTotal) - MONEY_EPSILON && lastPayment
          ? lastPayment
          : now;
      const overdueDays = Math.max(
        0,
        Math.floor((comparedAt.getTime() - due.getTime()) / 86400000),
      );

      if (overdueDays > 0) {
        stat.lateCount++;
        stat.maxDaysOverdue = Math.max(stat.maxDaysOverdue, overdueDays);
      }
      stats.set(invoice.customerId, stat);
    }

    return new Map(
      customerIds.map((customerId) => {
        const stat = stats.get(customerId) ?? {
          lateCount: 0,
          maxDaysOverdue: 0,
          sampleSize: 0,
        };
        return [
          customerId,
          evaluateAutoPaymentHistory({
            ...stat,
            currentOverdueDays: stat.maxDaysOverdue,
          }),
        ];
      }),
    );
  }

  async updatePaymentHistoryOverride(
    customerId: number,
    override: string,
    reason: string,
    userId: number,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    return this.prisma.customerDebtPolicy.upsert({
      where: { customerId },
      create: {
        customerId,
        hasCreditLimit: false,
        hasTermDays: false,
        paymentHistoryOverride: override,
        paymentHistoryOverrideNote: reason.trim(),
        paymentHistoryOverriddenBy: userId,
        paymentHistoryOverriddenAt: new Date(),
        createdBy: userId,
        updatedBy: userId,
      },
      update: {
        paymentHistoryOverride: override,
        paymentHistoryOverrideNote: reason.trim(),
        paymentHistoryOverriddenBy: userId,
        paymentHistoryOverriddenAt: new Date(),
        updatedBy: userId,
      },
    });
  }

  /**
   * Hóa đơn chưa hủy dùng để tính tuổi nợ.
   * Lấy `deliveredAt` (mốc báo đơn giao hàng đầu tiên) — nguồn gốc tính hạn.
   */
  private async getInvoicesForAging(customerIds: number[]) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        customerId: { in: customerIds },
        status: { notIn: [INVOICE_STATUS_CANCELLED] },
        grandTotal: { gt: 0 },
      },
      select: {
        id: true,
        code: true,
        customerId: true,
        grandTotal: true,
        deliveredAt: true,
        purchaseDate: true,
      },
      orderBy: { purchaseDate: 'desc' },
    });

    const map = new Map<number, AgingInvoiceInput[]>();
    for (const inv of invoices) {
      if (inv.customerId === null) continue;
      const arr = map.get(inv.customerId) ?? [];
      arr.push({
        id: inv.id,
        code: inv.code,
        grandTotal: Number(inv.grandTotal),
        deliveredAt: inv.deliveredAt,
        purchaseDate: inv.purchaseDate,
      });
      map.set(inv.customerId, arr);
    }
    return map;
  }

  /**
   * Thông tin thanh toán: khoản GẦN NHẤT + các ngày thanh toán trong tháng
   * hiện tại (phục vụ đánh giá cam kết tần suất "1 tháng N lần").
   *
   * Điều kiện lọc bám sát Formula A (common/customer-debt.util.ts): chỉ tính
   * phiếu THU chưa hủy và loại mã TTTUHD (thanh toán trước hóa đơn) để không
   * hiển thị khoản không thực sự làm giảm công nợ.
   */
  private async getPaymentInfo(customerIds: number[]) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const payments = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'C',
        partnerId: { in: customerIds },
        isReceipt: true,
        status: { not: 2 },
        NOT: [{ code: { startsWith: 'TTTUHD' } }],
      },
      select: {
        id: true,
        code: true,
        partnerId: true,
        amount: true,
        transDate: true,
        method: true,
        description: true,
      },
      orderBy: { transDate: 'desc' },
    });

    const lastPaymentMap = new Map<number, LastPaymentInfo>();
    const monthPaymentDates = new Map<number, Date[]>();

    for (const p of payments) {
      if (p.partnerId === null) continue;

      // Đã sort giảm dần nên bản ghi đầu tiên gặp là mới nhất.
      if (!lastPaymentMap.has(p.partnerId)) {
        lastPaymentMap.set(p.partnerId, {
          id: p.id,
          code: p.code,
          amount: Number(p.amount),
          transDate: p.transDate,
          method: p.method,
          description: p.description,
        });
      }

      if (p.transDate >= monthStart) {
        const arr = monthPaymentDates.get(p.partnerId) ?? [];
        arr.push(p.transDate);
        monthPaymentDates.set(p.partnerId, arr);
      }
    }

    return { lastPaymentMap, monthPaymentDates };
  }

  private async getRecentPayments(customerId: number, take: number) {
    const rows = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'C',
        partnerId: customerId,
        isReceipt: true,
        status: { not: 2 },
        NOT: [{ code: { startsWith: 'TTTUHD' } }],
      },
      select: {
        id: true,
        code: true,
        amount: true,
        transDate: true,
        method: true,
        description: true,
      },
      orderBy: { transDate: 'desc' },
      take,
    });
    return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  }

  /**
   * Lấy phiếu STOP_DELIVERY mới nhất và phiếu STOP_DELIVERY đang mở của từng khách.
   */
  private async getOpenTicketLines(customerIds: number[]) {
    const lines = await this.prisma.debtTicketCustomer.findMany({
      where: {
        customerId: { in: customerIds },
        ticket: { ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY },
      },
      include: {
        ticket: {
          select: {
            id: true,
            code: true,
            status: true,
            assigneeId: true,
            ticketType: true,
            assignee: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ isLatest: 'desc' }, { createdAt: 'desc' }],
    });

    const map = new Map<number, { openTicket: OpenTicketInfo | null; latestStopTicket: OpenTicketInfo | null }>();
    for (const l of lines) {
      const ticket = {
        ticketId: l.ticketId,
        ticketCode: l.ticket.code,
        ticketStatus: l.ticket.status,
        lineId: l.id,
        assigneeId: l.ticket.assigneeId,
        assignee: l.ticket.assignee,
        minimumPayment:
          l.minimumPayment !== null ? Number(l.minimumPayment) : null,
        confirmedAmount:
          l.confirmedAmount !== null ? Number(l.confirmedAmount) : null,
        confirmedDate: l.confirmedDate,
        debtAtCreate: Number(l.debtAtCreate),
        lineStatus: l.status,
        isPaid: l.status === DEBT_TICKET_LINE_STATUS.PAID,
        ticketType: l.ticket.ticketType,
        requiredPaymentAmount: Number(l.requiredPaymentAmount),
        note: l.note ?? null,
      };
      const current = map.get(l.customerId) ?? { openTicket: null, latestStopTicket: null };
      if (!current.latestStopTicket) current.latestStopTicket = ticket;
      if (!current.openTicket && DEBT_TICKET_OPEN_STATUSES.includes(l.ticket.status)) current.openTicket = ticket;
      map.set(l.customerId, current);
    }
    return map;
  }

  /** Nạp thông tin người phụ trách (Sale PIC / Kế toán PIC). */
  private async getPicUsers(
    customers: Array<{ debtPolicy: unknown }>,
  ): Promise<Map<number, { id: number; name: string }>> {
    const ids = new Set<number>();
    for (const c of customers) {
      const p = c.debtPolicy as RawDebtPolicy | null;
      if (p?.salePicId) ids.add(p.salePicId);
      if (p?.accountantPicId) ids.add(p.accountantPicId);
    }
    if (ids.size === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  /** Dùng cho export: lấy toàn bộ dòng không phân trang. */
  async findAllForExport(query: DebtTrackingQueryDto) {
    const res = await this.findAll({
      ...query,
      page: 1,
      pageSize: MAX_CUSTOMERS_SCAN,
    });
    return res.data;
  }

  /**
   * Số tiền đến hạn của một khách — dùng làm GỢI Ý cho "Số tiền tối thiểu
   * cần phải thanh toán" khi tạo phiếu thu hồi nợ.
   */
  async getSuggestedMinimumPayment(customerId: number): Promise<number> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { totalDebt: true, debtPolicy: true },
    });
    if (!customer) return 0;

    const policy = this.toPolicyInput(
      customer.debtPolicy as RawDebtPolicy | null,
    );
    if (!hasAnyDebtPolicy(policy)) return 0;

    const invoices =
      (await this.getInvoicesForAging([customerId])).get(customerId) ?? [];
    const aging = computeCustomerAging(
      Number(customer.totalDebt),
      invoices,
      policy,
    );

    return aging.requiredPaymentAmount;
  }
}
