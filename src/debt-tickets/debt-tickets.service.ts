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
  MIN_PAYMENT_RATIO_WARN,
  MONEY_EPSILON,
} from '../debt-tracking/debt-tracking.constants';

@Injectable()
export class DebtTicketsService {
  private readonly logger = new Logger(DebtTicketsService.name);

  constructor(
    private prisma: PrismaService,
    private debtTracking: DebtTrackingService,
  ) {}

  // ================================================================
  // DANH SÁCH
  // ================================================================
  async findAll(query: DebtTicketQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: any = {};
    if (query.status) where.status = query.status;
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
  async create(dto: CreateDebtTicketDto, userId: number) {
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

    // Số tiền tối thiểu: hệ thống GỢI Ý phần nợ đã đến hạn, nhân viên có thể
    // gửi lên giá trị khác. Cảnh báo (không chặn) khi dưới 30% nợ đầu kì.
    const warnings: string[] = [];
    const lines: Array<{
      customerId: number;
      debtAtCreate: number;
      minimumPayment: number;
      confirmedAmount: number | null;
      confirmedDate: Date | null;
      note: string | null;
    }> = [];

    for (const c of dto.customers) {
      const debt = debtMap.get(c.customerId) ?? 0;
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
          customers: {
            create: lines.map((l) => ({
              customerId: l.customerId,
              debtAtCreate: l.debtAtCreate,
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

    return { ...this.serializeTicket(ticket), warnings };
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
      include: { ticket: { select: { status: true } } },
    });
    if (!line) {
      throw new NotFoundException('Không tìm thấy dòng khách trong phiếu');
    }
    if (!DEBT_TICKET_OPEN_STATUSES.includes(line.ticket.status)) {
      throw new BadRequestException('Phiếu đã kết thúc, không thể sửa');
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
      select: { id: true, status: true },
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
      include: { customers: { select: { status: true } } },
    });

    if (!ticket) return false;
    if (!DEBT_TICKET_OPEN_STATUSES.includes(ticket.status)) return false;
    if (ticket.customers.length === 0) return false;

    const allPaid = ticket.customers.every(
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
