import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DebtTrackingService } from '../debt-tracking/debt-tracking.service';
import {
  CreateDebtTicketDto,
  UpdateDebtTicketDto,
  UpdateDebtTicketLineDto,
  CloseDebtTicketDto,
  AddTicketCustomersDto,
  DebtTicketQueryDto,
} from './dto';
import {
  DEBT_TICKET_STATUS,
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_LINE_STATUS,
  DEBT_TICKET_CLOSE_MODE,
  DEBT_TICKET_CODE_PREFIX,
  DEBT_TICKET_TYPE,
  MIN_PAYMENT_RATIO_WARN,
  MONEY_EPSILON,
} from '../debt-tracking/debt-tracking.constants';
import { LarkDebtNotificationService } from '../lark-sync/services/lark-debt-notification.service';

@Injectable()
export class DebtTicketsService {
  private readonly logger = new Logger(DebtTicketsService.name);

  constructor(
    private prisma: PrismaService,
    private debtTracking: DebtTrackingService,
    private larkDebtNotification: LarkDebtNotificationService,
  ) {}

  // ================================================================
  // DANH SÁCH
  // ================================================================
  async findAll(query: DebtTicketQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.ticketType) where.ticketType = query.ticketType;
    else if (query.openOnly === 'true') {
      where.status = { in: DEBT_TICKET_OPEN_STATUSES };
    }
    if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.customerId) {
      where.customers = { some: { customerId: query.customerId } };
    }
    if (query.search?.trim()) {
      const s = query.search.trim();
      where.OR = [
        { code: { contains: s, mode: 'insensitive' } },
        { title: { contains: s, mode: 'insensitive' } },
        {
          customers: {
            some: {
              customer: {
                OR: [
                  { name: { contains: s, mode: 'insensitive' } },
                  { code: { contains: s, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ];
    }
    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const [tickets, total] = await Promise.all([
      this.prisma.debtTicket.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }],
        include: this.ticketInclude(),
      }),
      this.prisma.debtTicket.count({ where }),
    ]);

    return {
      data: tickets.map((t) => this.serializeTicket(t)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async findOne(id: number) {
    const ticket = await this.prisma.debtTicket.findUnique({
      where: { id },
      include: this.ticketInclude(),
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu thu hồi nợ');
    return this.serializeTicket(ticket);
  }

  // ================================================================
  // TẠO PHIẾU
  // ================================================================
  async create(
    dto: CreateDebtTicketDto,
    userId: number,
    requiredPaymentOverride?: number,
  ) {
    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assigneeId },
      select: { id: true },
    });
    if (!assignee) {
      throw new NotFoundException('Không tìm thấy nhân viên phụ trách');
    }

    const customerIds = [...new Set(dto.customers.map((c) => c.customerId))];
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, name: true, totalDebt: true },
    });
    if (customers.length !== customerIds.length) {
      throw new NotFoundException('Một số khách hàng không tồn tại');
    }

    const debtMap = new Map(customers.map((c) => [c.id, Number(c.totalDebt)]));
    const ticketType = dto.ticketType ?? DEBT_TICKET_TYPE.DEBT_COLLECTION;

    // Số tiền tối thiểu: hệ thống GỢI Ý phần nợ đã đến hạn, nhân viên có thể
    // gửi lên giá trị khác. Cảnh báo (không chặn) khi dưới 30% nợ đầu kì.
    const warnings: string[] = [];
    const lines: Array<{
      customerId: number;
      debtAtCreate: number;
      requiredPaymentAmount: number;
      minimumPayment: number;
      confirmedAmount: number | null;
      confirmedDate: Date | null;
      note: string | null;
    }> = [];

    for (const c of dto.customers) {
      const debt = debtMap.get(c.customerId) ?? 0;
      const requiredPaymentAmount =
        ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY
          ? (requiredPaymentOverride ??
            (await this.debtTracking.getSuggestedMinimumPayment(c.customerId)))
          : 0;
      const minimum =
        c.minimumPayment !== undefined
          ? c.minimumPayment
          : await this.debtTracking.getSuggestedMinimumPayment(c.customerId);

      if (debt > 0 && minimum < debt * MIN_PAYMENT_RATIO_WARN) {
        const name =
          customers.find((x) => x.id === c.customerId)?.name ??
          `KH#${c.customerId}`;
        warnings.push(
          `${name}: số tiền tối thiểu ${Math.round(minimum).toLocaleString('vi-VN')} ` +
            `thấp hơn 30% nợ hiện tại (${Math.round(debt).toLocaleString('vi-VN')})`,
        );
      }

      lines.push({
        customerId: c.customerId,
        debtAtCreate: debt,
        requiredPaymentAmount,
        minimumPayment: minimum,
        confirmedAmount: c.confirmedAmount ?? null,
        confirmedDate: c.confirmedDate ? new Date(c.confirmedDate) : null,
        note: c.note ?? null,
      });
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

      // Một khách được tạo phiếu nhiều đợt theo thời gian. Phiếu mới nhất
      // giữ cờ isLatest; các dòng cũ của cùng khách bị hạ cờ để trang theo
      // dõi công nợ chỉ hiển thị phiếu mới nhất.
      await tx.debtTicketCustomer.updateMany({
        where: { customerId: { in: customerIds }, isLatest: true },
        data: { isLatest: false },
      });

      return tx.debtTicket.create({
        data: {
          code,
          title: dto.title ?? null,
          assigneeId: dto.assigneeId,
          note: dto.note ?? null,
          createdById: userId,
          status: dto.status ?? DEBT_TICKET_STATUS.REQUESTED,
          ticketType,
          customers: {
            create: lines.map((l) => ({
              customerId: l.customerId,
              debtAtCreate: l.debtAtCreate,
              requiredPaymentAmount: l.requiredPaymentAmount,
              minimumPayment: l.minimumPayment,
              confirmedAmount: l.confirmedAmount,
              confirmedDate: l.confirmedDate,
              note: l.note,
              status: DEBT_TICKET_LINE_STATUS.PENDING,
              isLatest: true,
            })),
          },
        },
        include: this.ticketInclude(),
      });
    });

    // Ticket có thể được tạo sau khi sale đã gắn khách vào các giao dịch
    // Sepay. Đối chiếu lại ngay để không phải chờ một thao tác gắn mới.
    for (const customerId of customerIds) {
      await this.reconcileCustomerPayments(customerId);
    }

    const refreshedTicket = await this.prisma.debtTicket.findUnique({
      where: { id: ticket.id },
      include: this.ticketInclude(),
    });

    if (ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY) {
      for (const customerId of customerIds) {
        this.larkDebtNotification.notifyStopDeliveryCreatedAsync(customerId);
      }
    }

    return {
      ...this.serializeTicket(refreshedTicket ?? ticket),
      warnings,
    };
  }

  // ================================================================
  // CẬP NHẬT
  // ================================================================
  async update(id: number, dto: UpdateDebtTicketDto) {
    const ticket = await this.prisma.debtTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu thu hồi nợ');
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc, không thể sửa');
    }
    if (
      ticket.ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY &&
      dto.status &&
      !DEBT_TICKET_OPEN_STATUSES.includes(dto.status)
    ) {
      throw new BadRequestException(
        'Phiếu ngừng đi hàng chỉ được kết thúc bằng nút Kết thúc hoặc khi tự động thu đủ tiền',
      );
    }

    if (dto.assigneeId) {
      const u = await this.prisma.user.findUnique({
        where: { id: dto.assigneeId },
        select: { id: true },
      });
      if (!u) throw new NotFoundException('Không tìm thấy nhân viên phụ trách');
    }

    await this.prisma.debtTicket.update({
      where: { id },
      data: {
        title: dto.title,
        assigneeId: dto.assigneeId,
        status: dto.status,
        note: dto.note,
      },
    });

    return this.findOne(id);
  }

  async updateLine(
    ticketId: number,
    customerId: number,
    dto: UpdateDebtTicketLineDto,
  ) {
    const line = await this.prisma.debtTicketCustomer.findUnique({
      where: { ticketId_customerId: { ticketId, customerId } },
      include: { ticket: { select: { status: true, ticketType: true } } },
    });
    if (!line) {
      throw new NotFoundException('Không tìm thấy dòng khách trong phiếu');
    }
    if (!DEBT_TICKET_OPEN_STATUSES.includes(line.ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc, không thể sửa');
    }

    if (
      line.ticket.ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY &&
      dto.status === DEBT_TICKET_LINE_STATUS.PAID
    ) {
      throw new BadRequestException(
        'Dòng phiếu ngừng đi hàng chỉ được tự động đánh dấu đã thu khi đủ số tiền cần thanh toán',
      );
    }

    const warnings: string[] = [];
    if (dto.minimumPayment !== undefined) {
      const debt = Number(line.debtAtCreate);
      if (debt > 0 && dto.minimumPayment < debt * MIN_PAYMENT_RATIO_WARN) {
        warnings.push(
          `Số tiền tối thiểu thấp hơn 30% nợ đầu kì (${Math.round(
            debt,
          ).toLocaleString('vi-VN')})`,
        );
      }
    }

    await this.prisma.debtTicketCustomer.update({
      where: { id: line.id },
      data: {
        minimumPayment: dto.minimumPayment,
        confirmedAmount: dto.confirmedAmount,
        confirmedDate: dto.confirmedDate
          ? new Date(dto.confirmedDate)
          : undefined,
        note: dto.note,
        status: dto.status,
        // Đánh dấu đã thu bằng tay thì ghi luôn mốc thời gian cho khớp với
        // luồng tự động.
        paidAt:
          dto.status === DEBT_TICKET_LINE_STATUS.PAID ? new Date() : undefined,
      },
    });

    // Sửa tay cũng có thể làm phiếu đủ điều kiện kết thúc.
    await this.tryAutoCloseTicket(this.prisma, ticketId);

    return { ...(await this.findOne(ticketId)), warnings };
  }

  async addCustomers(ticketId: number, dto: AddTicketCustomersDto) {
    const ticket = await this.prisma.debtTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, ticketType: true },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu thu hồi nợ');
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc, không thể thêm khách');
    }

    const customerIds = [...new Set(dto.customers.map((c) => c.customerId))];
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, totalDebt: true },
    });
    if (customers.length !== customerIds.length) {
      throw new NotFoundException('Một số khách hàng không tồn tại');
    }

    const dup = await this.prisma.debtTicketCustomer.findMany({
      where: { ticketId, customerId: { in: customerIds } },
      select: { customerId: true },
    });
    if (dup.length > 0) {
      throw new BadRequestException('Có khách đã tồn tại trong phiếu này');
    }

    const debtMap = new Map(customers.map((c) => [c.id, Number(c.totalDebt)]));

    const rows = await Promise.all(
      dto.customers.map(async (c) => ({
        ticketId,
        customerId: c.customerId,
        debtAtCreate: debtMap.get(c.customerId) ?? 0,
      requiredPaymentAmount:
        ticket.ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY
          ? await this.debtTracking.getSuggestedMinimumPayment(c.customerId)
          : 0,
        minimumPayment:
          c.minimumPayment !== undefined
            ? c.minimumPayment
            : await this.debtTracking.getSuggestedMinimumPayment(c.customerId),
        confirmedAmount: c.confirmedAmount ?? null,
        confirmedDate: c.confirmedDate ? new Date(c.confirmedDate) : null,
        note: c.note ?? null,
        status: DEBT_TICKET_LINE_STATUS.PENDING,
        isLatest: true,
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.debtTicketCustomer.updateMany({
        where: { customerId: { in: customerIds }, isLatest: true },
        data: { isLatest: false },
      });
      await tx.debtTicketCustomer.createMany({ data: rows });
    });

    return this.findOne(ticketId);
  }

  async removeCustomer(ticketId: number, customerId: number) {
    const line = await this.prisma.debtTicketCustomer.findUnique({
      where: { ticketId_customerId: { ticketId, customerId } },
      include: { ticket: { select: { status: true } } },
    });
    if (!line) {
      throw new NotFoundException('Không tìm thấy dòng khách trong phiếu');
    }
    if (!DEBT_TICKET_OPEN_STATUSES.includes(line.ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc, không thể sửa');
    }

    const count = await this.prisma.debtTicketCustomer.count({
      where: { ticketId },
    });
    if (count <= 1) {
      throw new BadRequestException(
        'Phiếu phải có ít nhất 1 khách. Hãy hủy phiếu nếu không còn cần thiết.',
      );
    }

    await this.prisma.debtTicketCustomer.delete({ where: { id: line.id } });

    // Trả cờ isLatest về dòng gần nhất còn lại của khách này.
    const prev = await this.prisma.debtTicketCustomer.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (prev) {
      await this.prisma.debtTicketCustomer.update({
        where: { id: prev.id },
        data: { isLatest: true },
      });
    }

    await this.tryAutoCloseTicket(this.prisma, ticketId);
    return { message: 'Đã xóa khách khỏi phiếu' };
  }

  // ================================================================
  // KẾT THÚC / HỦY
  // ================================================================
  async close(id: number, dto: CloseDebtTicketDto, userId: number) {
    const ticket = await this.prisma.debtTicket.findUnique({
      where: { id },
      include: { customers: true },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu thu hồi nợ');
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc trước đó');
    }

    return this.prisma.debtTicket.update({
      where: { id },
      data: {
        status: dto.finalStatus ?? DEBT_TICKET_STATUS.DONE,
        closedAt: new Date(),
        closedById: userId,
        closeMode: DEBT_TICKET_CLOSE_MODE.MANUAL,
        closeReason: dto.reason,
      },
    });
  }

  /**
   * Đối chiếu tiền đã thu sau thời điểm mở hold. Dùng cho mọi nguồn thanh
   * toán (phiếu thu, thanh toán hóa đơn, Sepay), không phụ thuộc UI nào.
   */
  async reconcileStopDeliveryForCustomer(
    customerId: number,
    db: any = this.prisma,
  ): Promise<number> {
    const openLines = await db.debtTicketCustomer.findMany({
      where: {
        customerId,
        status: { not: DEBT_TICKET_LINE_STATUS.PAID },
        ticket: {
          ticketType: DEBT_TICKET_TYPE.STOP_DELIVERY,
          status: { in: DEBT_TICKET_OPEN_STATUSES },
        },
      },
      include: {
        ticket: { select: { id: true, code: true, createdAt: true, status: true } },
      },
      orderBy: [{ isLatest: 'desc' }, { createdAt: 'desc' }],
    });

    if (openLines.length === 0) return 0;

    let closed = 0;
    for (const line of openLines) {
      const receipts = await db.cashFlow.findMany({
        where: {
          partnerType: 'C',
          partnerId: customerId,
          isReceipt: true,
          status: { not: 2 },
          transDate: { gte: line.ticket.createdAt },
          NOT: [{ code: { startsWith: 'TTTUHD' } }],
        },
        select: { amount: true },
      });
      const received = receipts.reduce(
        (sum: number, receipt: any) => sum + Number(receipt.amount),
        0,
      );
      const required = Number(line.requiredPaymentAmount);

      if (required > MONEY_EPSILON && received < required - MONEY_EPSILON) {
        continue;
      }

      await db.debtTicketCustomer.update({
        where: { id: line.id },
        data: {
          status: DEBT_TICKET_LINE_STATUS.PAID,
          paidAt: new Date(),
          paidAmount: received,
        },
      });
      const closedTicket = await this.tryAutoCloseTicket(db, line.ticketId);
      if (closedTicket) closed++;
    }

    return closed;
  }

  /**
   * Đối chiếu mọi nguồn tiền của khách với ticket:
   * - CashFlow đã hạch toán kể từ lúc tạo ticket.
   * - Sepay chưa lập phiếu thu chỉ khi giao dịch có đúng một khách.
   * Giao dịch nhiều khách không được suy đoán tiền trước khi kế toán phân bổ.
   */
  async reconcileCustomerPayments(customerId: number): Promise<void> {
    const pending = await this.getPendingSingleCustomerSepay(customerId);
    const lines = await this.prisma.debtTicketCustomer.findMany({
      where: {
        customerId,
        ticket: { status: { in: DEBT_TICKET_OPEN_STATUSES } },
      },
      include: {
        ticket: {
          select: { id: true, ticketType: true, createdAt: true },
        },
      },
    });

    for (const line of lines) {
      if (line.ticket.ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY) {
        await this.prisma.debtTicketCustomer.update({
          where: { id: line.id },
          data:
            pending.amount > MONEY_EPSILON
              ? {
                  provisionalPaymentAmount: pending.amount,
                  provisionalSepayTxId:
                    pending.transactionIds[pending.transactionIds.length - 1],
                }
              : {
                  provisionalPaymentAmount: null,
                  provisionalSepayTxId: null,
                },
        });
        continue;
      }

      if (line.status === DEBT_TICKET_LINE_STATUS.PAID) continue;
      const receipts = await this.prisma.cashFlow.findMany({
        where: {
          partnerType: 'C',
          partnerId: customerId,
          isReceipt: true,
          status: { not: 2 },
          createdAt: { gte: line.ticket.createdAt },
        },
        select: { amount: true },
      });
      const officialAmount = receipts.reduce(
        (sum, receipt) => sum + Number(receipt.amount),
        0,
      );
      const received = officialAmount + pending.amount;
      const required = Number(
        line.confirmedAmount ?? line.minimumPayment ?? line.debtAtCreate,
      );
      const paid = required > MONEY_EPSILON && received >= required - MONEY_EPSILON;

      await this.prisma.debtTicketCustomer.update({
        where: { id: line.id },
        data: {
          status: paid
            ? DEBT_TICKET_LINE_STATUS.PAID
            : received > MONEY_EPSILON
              ? DEBT_TICKET_LINE_STATUS.PARTIAL
              : DEBT_TICKET_LINE_STATUS.PENDING,
          paidAt: paid ? new Date() : null,
          paidAmount: received > MONEY_EPSILON ? received : null,
          matchedSepayTxId:
            pending.transactionIds[pending.transactionIds.length - 1] ?? null,
        },
      });

      if (paid) {
        await this.tryAutoCloseTicket(this.prisma, line.ticketId);
      }
    }

    await this.reconcileStopDeliveryForCustomer(customerId);
  }

  private async getPendingSingleCustomerSepay(customerId: number): Promise<{
    amount: number;
    transactionIds: number[];
  }> {
    const candidates = await this.prisma.sepayAllocation.findMany({
      where: { customerId, cashFlowId: null },
      select: { sepayTransactionId: true },
    });
    const transactionIds = [
      ...new Set(candidates.map((row) => row.sepayTransactionId)),
    ];
    if (transactionIds.length === 0) {
      return { amount: 0, transactionIds: [] };
    }

    const allocations = await this.prisma.sepayAllocation.findMany({
      where: { sepayTransactionId: { in: transactionIds } },
      select: { sepayTransactionId: true, customerId: true, cashFlowId: true },
    });
    const transactions = await this.prisma.sepayTransaction.findMany({
      where: {
        id: { in: transactionIds },
        amountIn: { gt: 0 },
        hiddenAt: null,
      },
      select: { id: true, amountIn: true },
    });

    const byTransaction = new Map<number, typeof allocations>();
    for (const allocation of allocations) {
      const rows = byTransaction.get(allocation.sepayTransactionId) ?? [];
      rows.push(allocation);
      byTransaction.set(allocation.sepayTransactionId, rows);
    }

    const valid = transactions.filter((transaction) => {
      const rows = byTransaction.get(transaction.id) ?? [];
      return (
        rows.length === 1 &&
        rows[0].customerId === customerId &&
        rows[0].cashFlowId === null
      );
    });

    return {
      amount: valid.reduce(
        (sum, transaction) => sum + Number(transaction.amountIn),
        0,
      ),
      transactionIds: valid.map((transaction) => transaction.id),
    };
  }

  async cancel(id: number, dto: CloseDebtTicketDto, userId: number) {
    const ticket = await this.prisma.debtTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu thu hồi nợ');
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc trước đó');
    }

    return this.prisma.debtTicket.update({
      where: { id },
      data: {
        status: DEBT_TICKET_STATUS.ENDED,
        closedAt: new Date(),
        closedById: userId,
        closeMode: DEBT_TICKET_CLOSE_MODE.MANUAL,
        closeReason: dto.reason,
      },
    });
  }

  // ================================================================
  // TỰ KẾT THÚC PHIẾU
  // ================================================================

  /**
   * Kết thúc phiếu khi và chỉ khi MỌI dòng khách đã ở trạng thái PAID.
   * Chỉ cần một khách chưa thu đủ thì phiếu vẫn mở và phải kết thúc thủ công.
   */
  async tryAutoCloseTicket(db: any, ticketId: number): Promise<boolean> {
    const ticket = await db.debtTicket.findUnique({
      where: { id: ticketId },
      include: {
        customers: {
          select: {
            id: true,
            customerId: true,
            status: true,
            requiredPaymentAmount: true,
            paidAmount: true,
          },
        },
      },
    });

    if (!ticket) return false;
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) return false;
    if (ticket.customers.length === 0) return false;

    if (ticket.ticketType === DEBT_TICKET_TYPE.STOP_DELIVERY) {
      for (const line of ticket.customers as any[]) {
        if (line.status === DEBT_TICKET_LINE_STATUS.PAID) continue;
        const receipts = await db.cashFlow.findMany({
          where: {
            partnerType: 'C',
            partnerId: line.customerId,
            isReceipt: true,
            status: { not: 2 },
            transDate: { gte: ticket.createdAt },
            NOT: [{ code: { startsWith: 'TTTUHD' } }],
          },
          select: { amount: true },
        });
        const received = receipts.reduce(
          (sum: number, receipt: any) => sum + Number(receipt.amount),
          0,
        );
        const required = Number(line.requiredPaymentAmount);
        if (received < required - MONEY_EPSILON) return false;

        await db.debtTicketCustomer.update({
          where: { id: line.id },
          data: {
            status: DEBT_TICKET_LINE_STATUS.PAID,
            paidAt: new Date(),
            paidAmount: received,
          },
        });
      }
    }

    const currentCustomers = await db.debtTicketCustomer.findMany({
      where: { ticketId },
      select: { status: true },
    });
    const allPaid = currentCustomers.every(
      (c: any) => c.status === DEBT_TICKET_LINE_STATUS.PAID,
    );
    if (!allPaid) return false;

    await db.debtTicket.update({
      where: { id: ticketId },
      data: {
        status: DEBT_TICKET_STATUS.PAID,
        closedAt: new Date(),
        closeMode: DEBT_TICKET_CLOSE_MODE.AUTO,
        closeReason: 'Tự động: tất cả khách đã thanh toán đủ',
      },
    });

    this.logger.log(`Phiếu ${ticket.code} tự kết thúc (đủ thanh toán)`);
    return true;
  }

  /**
   * Mở lại phiếu đã TỰ ĐỘNG kết thúc, khi thanh toán bị gỡ (bỏ gán khách ở
   * Biến động số dư). Phiếu kết thúc THỦ CÔNG thì giữ nguyên — đó là quyết
   * định có chủ đích của con người, không được ghi đè.
   */
  async tryReopenTicket(db: any, ticketId: number): Promise<boolean> {
    const ticket = await db.debtTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, code: true, status: true, closeMode: true },
    });

    if (!ticket) return false;
    if (DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) return false;
    if (ticket.closeMode !== DEBT_TICKET_CLOSE_MODE.AUTO) return false;

    await db.debtTicket.update({
      where: { id: ticketId },
      data: {
        status: DEBT_TICKET_STATUS.IN_PROGRESS,
        closedAt: null,
        closedById: null,
        closeMode: null,
        closeReason: null,
      },
    });

    this.logger.log(`Phiếu ${ticket.code} mở lại (thanh toán bị gỡ)`);
    return true;
  }

  // ================================================================
  // HELPERS
  // ================================================================

  private ticketInclude() {
    return {
      assignee: { select: { id: true, name: true, email: true } },
      creator: { select: { id: true, name: true } },
      closer: { select: { id: true, name: true } },
      customers: {
        include: {
          customer: {
            select: {
              id: true,
              code: true,
              name: true,
              totalDebt: true,
              contactNumber: true,
              phone: true,
            },
          },
        },
      },
    };
  }

  private async generateCode(tx: any): Promise<string> {
    const last = await tx.debtTicket.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let next = 1;
    if (last) {
      const m = last.code.match(new RegExp(`${DEBT_TICKET_CODE_PREFIX}(\\d+)`));
      if (m) next = parseInt(m[1]) + 1;
    }

    return `${DEBT_TICKET_CODE_PREFIX}${next.toString().padStart(6, '0')}`;
  }

  private serializeTicket(t: any) {
    const lines = (t.customers ?? []).map((l: any) => ({
      id: l.id,
      customerId: l.customerId,
      customerCode: l.customer?.code,
      customerName: l.customer?.name,
      contactNumber: l.customer?.contactNumber ?? l.customer?.phone ?? null,
      /** Nợ đầu kì — snapshot lúc tạo phiếu. */
      debtAtCreate: Number(l.debtAtCreate),
      /** Nợ cuối kì — nợ HIỆN TẠI của khách, đọc live. */
      currentDebt:
        l.customer?.totalDebt !== undefined
          ? Number(l.customer.totalDebt)
          : null,
      minimumPayment:
        l.minimumPayment !== null ? Number(l.minimumPayment) : null,
      confirmedAmount:
        l.confirmedAmount !== null ? Number(l.confirmedAmount) : null,
      confirmedDate: l.confirmedDate,
      status: l.status,
      isLatest: l.isLatest,
      paidAt: l.paidAt,
      paidAmount: l.paidAmount !== null ? Number(l.paidAmount) : null,
      matchedSepayTxId: l.matchedSepayTxId,
      note: l.note,
      /** Cảnh báo mềm: tối thiểu dưới 30% nợ đầu kì. */
      belowMinRatio:
        Number(l.debtAtCreate) > 0 &&
        l.minimumPayment !== null &&
        Number(l.minimumPayment) <
          Number(l.debtAtCreate) * MIN_PAYMENT_RATIO_WARN,
      requiredPaymentAmount: Number(l.requiredPaymentAmount),
    }));

    const totalMinimum = lines.reduce(
      (s: number, l: any) => s + (l.minimumPayment ?? l.debtAtCreate),
      0,
    );
    const totalConfirmed = lines.reduce(
      (s: number, l: any) => s + (l.confirmedAmount ?? 0),
      0,
    );
    const totalPaid = lines.reduce(
      (s: number, l: any) => s + (l.paidAmount ?? 0),
      0,
    );
    const paidCount = lines.filter(
      (l: any) => l.status === DEBT_TICKET_LINE_STATUS.PAID,
    ).length;

    return {
      id: t.id,
      code: t.code,
      title: t.title,
      status: t.status,
      ticketType: t.ticketType,
      isOpen: DEBT_TICKET_OPEN_STATUSES.includes(t.status),
      note: t.note,
      assignee: t.assignee,
      creator: t.creator,
      closer: t.closer,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
      closeMode: t.closeMode,
      closeReason: t.closeReason,
      customers: lines,
      summary: {
        customerCount: lines.length,
        paidCount,
        pendingCount: lines.length - paidCount,
        totalDebtAtCreate: lines.reduce(
          (s: number, l: any) => s + l.debtAtCreate,
          0,
        ),
        totalCurrentDebt: lines.reduce(
          (s: number, l: any) => s + (l.currentDebt ?? 0),
          0,
        ),
        totalMinimum,
        totalConfirmed,
        totalPaid,
        isFullyPaid: lines.length > 0 && paidCount === lines.length,
      },
    };
  }

  /** So sánh tiền có tính sai số. */
  static isEnough(received: number, required: number) {
    return received >= required - MONEY_EPSILON;
  }
}
