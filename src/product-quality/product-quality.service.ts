import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import * as lark from '@larksuiteoapi/node-sdk';
import { ProductQualityImportService } from './product-quality-import.service';
import {
  ProductQualityQueryDto,
  CreateProductQualityTicketDto,
  UpdateProductQualityTicketDto,
  AssignProductQualityTicketDto,
  UpdateProductQualityTaskDto,
  CloseProductQualityTicketDto,
  UpsertRoutingConfigDto,
  UpsertDepartmentMemberDto,
  LarkImportDto,
} from './dto';
import { Prisma } from '@prisma/client';

export const QUALITY_STATUS = {
  NEW: 'NEW',
  IN_PROGRESS: 'IN_PROGRESS',
  REMEDIATING: 'REMEDIATING',
  COMPLETED: 'COMPLETED',
  ENDED: 'ENDED',
} as const;

export const QUALITY_STATUS_LABELS: Record<string, string> = {
  NEW: 'Mới',
  IN_PROGRESS: 'Đang xử lý',
  REMEDIATING: 'Đang khắc phục',
  COMPLETED: 'Hoàn thành',
  ENDED: 'Kết thúc (Dừng)',
};

export const QUALITY_DEPARTMENTS = [
  'Kinh Doanh',
  'Kho + Logistics',
  'Kế Toán Kho',
  'Thu Mua',
] as const;

export const CODE_PREFIX = 'CLSP';

const INCLUDE_FULL = {
  branch: { select: { id: true, name: true, code: true } },
  customer: { select: { id: true, code: true, name: true, phone: true } },
  product: { select: { id: true, code: true, name: true, unit: true, cargoType: true } },
  factory: { select: { id: true, code: true, name: true } },
  invoice: { select: { id: true, code: true, purchaseDate: true, grandTotal: true } },
  outboundInvoice: { select: { id: true, code: true, purchaseDate: true, grandTotal: true } },
  decisionMaker: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true, email: true } },
  closer: { select: { id: true, name: true, email: true } },
  tasks: {
    include: {
      assignedUser: { select: { id: true, name: true, email: true } },
      completedByUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { id: 'asc' as const },
  },
  attachments: {
    include: {
      creator: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' as const },
  },
};

@Injectable()
export class ProductQualityService {
  private readonly logger = new Logger(ProductQualityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly auditLogsService: AuditLogsService,
    private readonly importService: ProductQualityImportService,
    @Optional() @Inject(LARK_CLIENT) private readonly larkClient?: lark.Client,
  ) {}

  /**
   * Sinh mã phiếu theo quy tắc CLSP000001
   */
  async generateCode(): Promise<string> {
    const last = await this.prisma.productQualityTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    if (!last) return `${CODE_PREFIX}000001`;
    const numericPart = parseInt(last.code.replace(CODE_PREFIX, ''), 10);
    const next = isNaN(numericPart) ? 1 : numericPart + 1;
    return `${CODE_PREFIX}${next.toString().padStart(6, '0')}`;
  }

  /**
   * Dựng mệnh đề WHERE theo bộ lọc và phạm vi chi nhánh
   */
  private buildWhere(
    query: ProductQualityQueryDto,
    user: any,
  ): Prisma.ProductQualityTicketWhereInput {
    const where: Prisma.ProductQualityTicketWhereInput = {};

    // Kiểm tra quyền xem chi nhánh
    const canViewAll =
      user?.roles?.includes('Super Admin') ||
      user?.roles?.includes('Admin') ||
      user?.permissions?.includes('product_quality:view_all_branches');

    if (!canViewAll) {
      const userBranchId = user?.branchId;
      if (userBranchId) {
        where.OR = [
          { branchId: userBranchId },
          { branchId: null }, // Cho phép xem các phiếu import chưa xác định chi nhánh
        ];
      }
    } else if (query.branchIds && query.branchIds.length > 0) {
      where.branchId = { in: query.branchIds };
    } else if (query.branchId) {
      where.branchId = query.branchId;
    }

    // Tìm kiếm text
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { code: { contains: s, mode: 'insensitive' } },
        { legacyCode: { contains: s, mode: 'insensitive' } },
        { customerName: { contains: s, mode: 'insensitive' } },
        { customerCode: { contains: s, mode: 'insensitive' } },
        { productName: { contains: s, mode: 'insensitive' } },
        { productCode: { contains: s, mode: 'insensitive' } },
        { reason: { contains: s, mode: 'insensitive' } },
        { note: { contains: s, mode: 'insensitive' } },
      ];
    }

    // Bộ lọc trạng thái & tab
    if (query.tab === 'new') {
      where.status = QUALITY_STATUS.NEW;
    } else if (query.tab === 'processing') {
      where.status = {
        in: [QUALITY_STATUS.NEW, QUALITY_STATUS.IN_PROGRESS, QUALITY_STATUS.REMEDIATING],
      };
    } else if (query.tab === 'overdue') {
      where.status = { notIn: [QUALITY_STATUS.COMPLETED, QUALITY_STATUS.ENDED] };
      where.dueAt = { lt: new Date() };
      where.handledAt = { not: null };
    } else if (query.tab === 'completed') {
      where.status = QUALITY_STATUS.COMPLETED;
    } else if (query.tab === 'my' && user?.id) {
      where.OR = [
        { createdById: user.id },
        { decisionMakerId: user.id },
        { tasks: { some: { assignedUserId: user.id } } },
      ];
    } else if (query.statuses && query.statuses.length > 0) {
      where.status = { in: query.statuses };
    } else if (query.status) {
      where.status = query.status;
    }

    // Lọc theo quá hạn riêng lẻ
    if (query.isOverdue) {
      where.status = { notIn: [QUALITY_STATUS.COMPLETED, QUALITY_STATUS.ENDED] };
      where.dueAt = { lt: new Date() };
      where.handledAt = { not: null };
    }

    if (query.initialClassification) {
      where.initialClassification = query.initialClassification;
    }
    if (query.feedbackType) {
      where.feedbackType = query.feedbackType;
    }
    if (query.severity) {
      where.severity = query.severity;
    }
    if (query.department) {
      where.assignedDepartments = { has: query.department };
    }
    if (query.assignedUserId) {
      where.tasks = { some: { assignedUserId: query.assignedUserId } };
    }
    if (query.decisionMakerId) {
      where.decisionMakerId = query.decisionMakerId;
    }
    if (query.createdById) {
      where.createdById = query.createdById;
    }
    if (query.customerId) {
      where.customerId = query.customerId;
    }
    if (query.productId) {
      where.productId = query.productId;
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

    return where;
  }

  async findAll(query: ProductQualityQueryDto, user: any) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(200, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where = this.buildWhere(query, user);

    const orderByField = query.orderBy || 'createdAt';
    const orderDirection = query.orderDirection || 'desc';

    const [data, total] = await Promise.all([
      this.prisma.productQualityTicket.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderByField]: orderDirection },
        include: INCLUDE_FULL,
      }),
      this.prisma.productQualityTicket.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async getSummary(query: ProductQualityQueryDto, user: any) {
    const baseWhere = this.buildWhere({ ...query, status: undefined, statuses: undefined, tab: undefined, isOverdue: undefined }, user);

    const now = new Date();

    const [
      total,
      newCount,
      inProgressCount,
      remediatingCount,
      completedCount,
      endedCount,
      overdueCount,
      kdPending,
      khoPending,
      ktPending,
      tmPending,
    ] = await Promise.all([
      this.prisma.productQualityTicket.count({ where: baseWhere }),
      this.prisma.productQualityTicket.count({
        where: { ...baseWhere, status: QUALITY_STATUS.NEW },
      }),
      this.prisma.productQualityTicket.count({
        where: { ...baseWhere, status: QUALITY_STATUS.IN_PROGRESS },
      }),
      this.prisma.productQualityTicket.count({
        where: { ...baseWhere, status: QUALITY_STATUS.REMEDIATING },
      }),
      this.prisma.productQualityTicket.count({
        where: { ...baseWhere, status: QUALITY_STATUS.COMPLETED },
      }),
      this.prisma.productQualityTicket.count({
        where: { ...baseWhere, status: QUALITY_STATUS.ENDED },
      }),
      this.prisma.productQualityTicket.count({
        where: {
          ...baseWhere,
          status: { notIn: [QUALITY_STATUS.COMPLETED, QUALITY_STATUS.ENDED] },
          handledAt: { not: null },
          dueAt: { lt: now },
        },
      }),
      this.prisma.productQualityTask.count({
        where: {
          department: 'Kinh Doanh',
          isCompleted: false,
          ticket: baseWhere,
        },
      }),
      this.prisma.productQualityTask.count({
        where: {
          department: 'Kho + Logistics',
          isCompleted: false,
          ticket: baseWhere,
        },
      }),
      this.prisma.productQualityTask.count({
        where: {
          department: 'Kế Toán Kho',
          isCompleted: false,
          ticket: baseWhere,
        },
      }),
      this.prisma.productQualityTask.count({
        where: {
          department: 'Thu Mua',
          isCompleted: false,
          ticket: baseWhere,
        },
      }),
    ]);

    return {
      total,
      newCount,
      inProgressCount,
      remediatingCount,
      completedCount,
      endedCount,
      overdueCount,
      departmentPending: {
        'Kinh Doanh': kdPending,
        'Kho + Logistics': khoPending,
        'Kế Toán Kho': ktPending,
        'Thu Mua': tmPending,
      },
    };
  }

  async findOne(id: number, user: any) {
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: INCLUDE_FULL,
    });

    if (!ticket) {
      throw new NotFoundException(`Không tìm thấy phiếu sự cố #${id}`);
    }

    const canViewAll =
      user?.roles?.includes('Super Admin') ||
      user?.roles?.includes('Admin') ||
      user?.permissions?.includes('product_quality:view_all_branches');

    if (!canViewAll && user?.branchId && ticket.branchId && ticket.branchId !== user.branchId) {
      throw new BadRequestException('Bạn không có quyền xem phiếu của chi nhánh này');
    }

    return ticket;
  }

  async create(dto: CreateProductQualityTicketDto, userId: number, branchIdFromReq?: number) {
    const code = await this.generateCode();
    const branchId = dto.branchId || branchIdFromReq;

    let branchName: string | undefined;
    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true },
      });
      branchName = branch?.name;
    }

    let customerCode = dto.customerCode;
    let customerName = dto.customerName;
    if (dto.customerId) {
      const c = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
        select: { code: true, name: true },
      });
      if (c) {
        customerCode = c.code || customerCode;
        customerName = c.name || customerName;
      }
    }

    let productCode = dto.productCode;
    let productName = dto.productName;
    let unit = dto.unit;
    let sourceType = dto.sourceType;
    if (dto.productId) {
      const p = await this.prisma.product.findUnique({
        where: { id: dto.productId },
        select: { code: true, name: true, unit: true, cargoType: true },
      });
      if (p) {
        productCode = p.code || productCode;
        productName = p.name || productName;
        unit = p.unit || unit;
        sourceType = p.cargoType === 'COLD' ? 'Hàng lạnh' : sourceType || 'Hàng thường';
      }
    }

    const creator = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    // Tự động phân công người quyết định nếu chưa chọn
    let decisionMakerId = dto.decisionMakerId;
    let decisionMakerName = dto.decisionMakerName;
    if (decisionMakerId && !decisionMakerName) {
      const u = await this.prisma.user.findUnique({
        where: { id: decisionMakerId },
        select: { name: true },
      });
      decisionMakerName = u?.name;
    } else if (!decisionMakerId) {
      decisionMakerId = userId;
      decisionMakerName = creator?.name;
    }

    const assignedDepts = dto.assignedDepartments || [];

    // Tạo ticket cùng các task và attachments ban đầu
    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productQualityTicket.create({
        data: {
          code,
          branchId,
          branchName,
          customerId: dto.customerId,
          customerCode,
          customerName,
          productId: dto.productId,
          productCode,
          productName,
          unit,
          sourceType,
          quantity: dto.quantity,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
          reason: dto.reason,
          initialClassification: dto.initialClassification,
          feedbackType: dto.feedbackType,
          severity: dto.severity,
          responsibilities: dto.responsibilities || [],
          factoryName: dto.factoryName,
          factoryId: dto.factoryId,
          note: dto.note,
          invoiceId: dto.invoiceId,
          invoiceCode: dto.invoiceCode,
          outboundInvoiceId: dto.outboundInvoiceId,
          outboundInvoiceCode: dto.outboundInvoiceCode,
          decisionMakerId,
          decisionMakerName,
          handlingDirection: dto.handlingDirection,
          assignedDepartments: assignedDepts,
          status: dto.handlingDirection ? QUALITY_STATUS.IN_PROGRESS : QUALITY_STATUS.NEW,
          handledAt: dto.handlingDirection ? new Date() : undefined,
          dueAt: dto.handlingDirection ? this.calcDueDate(new Date(), 5) : undefined,
          createdById: userId,
          createdByName: creator?.name,
          attachments: dto.attachments && dto.attachments.length > 0
            ? {
                create: dto.attachments.map((a) => ({
                  filename: a.filename,
                  originalName: a.originalName,
                  url: a.url,
                  mimetype: a.mimetype,
                  size: a.size,
                  kind: a.kind || 'PROOF_IMAGE',
                  department: a.department,
                  larkFileToken: a.larkFileToken,
                  createdById: userId,
                })),
              }
            : undefined,
        },
      });

      // Tạo task cho các bộ phận nếu có
      if (assignedDepts.length > 0) {
        for (const dept of assignedDepts) {
          await tx.productQualityTask.create({
            data: {
              ticketId: created.id,
              department: dept,
              assignedUserId: null,
              assignedUserName: null,
            },
          });
        }
      }

      return created;
    });

    // Thông báo in-app cho người quyết định
    if (decisionMakerId && decisionMakerId !== userId) {
      await this.notificationsService.createForUsers([decisionMakerId], {
        type: 'product_quality_ticket',
        title: `Phiếu sự cố chất lượng mới: ${ticket.code}`,
        body: `${creator?.name || 'Nhân viên'} vừa tạo phiếu sự cố cho ${ticket.customerName} - ${ticket.productName} (${ticket.initialClassification})`,
        link: `/san-pham/chat-luong-hang-hoa/${ticket.id}`,
        dedupeKey: `created_${ticket.id}_${decisionMakerId}`,
      });
    }

    // Gửi Lark thông báo nhóm nếu được cấu hình
    this.sendLarkGroupNotificationAsync(ticket.id);

    // Ghi audit log
    void this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'product_quality.create',
      message: `Tạo phiếu sự cố chất lượng ${ticket.code} cho khách hàng ${ticket.customerName}`,
      entityType: 'product_quality_ticket',
      entityId: String(ticket.id),
      entityCode: ticket.code,
      userId,
      userName: creator?.name || 'Nhân viên',
      branchId: ticket.branchId || undefined,
      category: 'Sản phẩm',
      severity: 'info',
      snapshot: {
        code: ticket.code,
        customerName: ticket.customerName,
        productName: ticket.productName,
        quantity: Number(ticket.quantity),
        initialClassification: ticket.initialClassification,
      },
    });

    return this.findOne(ticket.id, { id: userId, roles: ['Super Admin'] });
  }

  async update(id: number, dto: UpdateProductQualityTicketDto, userId: number) {
    const existing = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!existing) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    const updated = await this.prisma.productQualityTicket.update({
      where: { id },
      data: {
        customerId: dto.customerId,
        customerName: dto.customerName,
        customerCode: dto.customerCode,
        productId: dto.productId,
        productName: dto.productName,
        productCode: dto.productCode,
        unit: dto.unit,
        sourceType: dto.sourceType,
        quantity: dto.quantity !== undefined ? dto.quantity : undefined,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
        reason: dto.reason,
        initialClassification: dto.initialClassification,
        feedbackType: dto.feedbackType,
        severity: dto.severity,
        responsibilities: dto.responsibilities,
        factoryName: dto.factoryName,
        factoryId: dto.factoryId,
        note: dto.note,
        invoiceId: dto.invoiceId,
        invoiceCode: dto.invoiceCode,
        outboundInvoiceId: dto.outboundInvoiceId,
        outboundInvoiceCode: dto.outboundInvoiceCode,
        status: dto.status,
        updatedById: userId,
      },
      include: INCLUDE_FULL,
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    void this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'product_quality.update',
      message: `Cập nhật phiếu sự cố chất lượng ${updated.code}`,
      entityType: 'product_quality_ticket',
      entityId: String(id),
      entityCode: updated.code,
      userId,
      userName: user?.name || 'Nhân viên',
      branchId: updated.branchId || undefined,
      category: 'Sản phẩm',
      severity: 'info',
      snapshot: { code: updated.code, status: updated.status },
    });

    return updated;
  }

  /**
   * Phân công người quyết định, cập nhật hướng xử lý & giao nhiệm vụ bộ phận
   */
  async assign(id: number, dto: AssignProductQualityTicketDto, userId: number) {
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    let decisionMakerName: string | undefined;
    if (dto.decisionMakerId) {
      const u = await this.prisma.user.findUnique({
        where: { id: dto.decisionMakerId },
        select: { name: true },
      });
      decisionMakerName = u?.name;
    }

    const hasHandling = !!dto.handlingDirection?.trim();
    const isFirstHandling = hasHandling && !ticket.handledAt;
    const handledAt = isFirstHandling ? new Date() : ticket.handledAt;
    const dueAt = isFirstHandling ? this.calcDueDate(handledAt!, 5) : ticket.dueAt;

    let newStatus = ticket.status;
    if (isFirstHandling && ticket.status === QUALITY_STATUS.NEW) {
      newStatus = QUALITY_STATUS.IN_PROGRESS;
    }

    const nextDepartments = dto.assignedDepartments || ticket.assignedDepartments;

    await this.prisma.$transaction(async (tx) => {
      await tx.productQualityTicket.update({
        where: { id },
        data: {
          decisionMakerId: dto.decisionMakerId !== undefined ? dto.decisionMakerId : ticket.decisionMakerId,
          decisionMakerName: decisionMakerName !== undefined ? decisionMakerName : ticket.decisionMakerName,
          handlingDirection: dto.handlingDirection !== undefined ? dto.handlingDirection : ticket.handlingDirection,
          assignedDepartments: nextDepartments,
          severity: dto.severity !== undefined ? dto.severity : ticket.severity,
          responsibilities: dto.responsibilities !== undefined ? dto.responsibilities : ticket.responsibilities,
          factoryName: dto.factoryName !== undefined ? dto.factoryName : ticket.factoryName,
          factoryId: dto.factoryId !== undefined ? dto.factoryId : ticket.factoryId,
          outboundInvoiceId: dto.outboundInvoiceId !== undefined ? dto.outboundInvoiceId : ticket.outboundInvoiceId,
          outboundInvoiceCode: dto.outboundInvoiceCode !== undefined ? dto.outboundInvoiceCode : ticket.outboundInvoiceCode,
          handledAt,
          dueAt,
          status: newStatus,
          updatedById: userId,
        },
      });

      // Đảm bảo mỗi department được giao đều có 1 task
      const existingDepts = ticket.tasks.map((t) => t.department);
      for (const dept of nextDepartments) {
        if (!existingDepts.includes(dept)) {
          await tx.productQualityTask.create({
            data: {
              ticketId: id,
              department: dept,
              assignedUserId: null,
              assignedUserName: null,
            },
          });
        }
      }
    });

    // Thông báo cho người phụ trách chính & người tạo phiếu
    const targetUserIds = [dto.decisionMakerId || ticket.decisionMakerId, ticket.createdById]
      .filter((uid): uid is number => !!uid && uid !== userId);
    if (targetUserIds.length > 0) {
      await this.notificationsService.createForUsers(targetUserIds, {
        type: 'product_quality_ticket',
        title: `Cập nhật hướng xử lý: ${ticket.code}`,
        body: `Phiếu sự cố ${ticket.code} đã được cập nhật hướng xử lý và giao các bộ phận liên quan.`,
        link: `/san-pham/chat-luong-hang-hoa/${ticket.id}`,
        dedupeKey: `assigned_${ticket.id}_${Date.now()}`,
      });
    }

    return this.findOne(id, { id: userId, roles: ['Super Admin'] });
  }

  /**
   * Cập nhật tiến độ task của từng bộ phận và tự động cập nhật trạng thái phiếu
   */
  async updateTask(
    id: number,
    department: string,
    dto: UpdateProductQualityTaskDto,
    userId: number,
  ) {
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    let assignedUserName: string | undefined;
    if (dto.assignedUserId) {
      const u = await this.prisma.user.findUnique({
        where: { id: dto.assignedUserId },
        select: { name: true },
      });
      assignedUserName = u?.name;
    }

    let completedAt: Date | null | undefined = undefined;
    let completedById: number | null | undefined = undefined;
    let completedByName: string | null | undefined = undefined;

    if (dto.isCompleted === true) {
      completedAt = new Date();
      completedById = userId;
      completedByName = user?.name;
    } else if (dto.isCompleted === false) {
      completedAt = null;
      completedById = null;
      completedByName = null;
    }

    await this.prisma.$transaction(async (tx) => {
      // Upsert task
      await tx.productQualityTask.upsert({
        where: { ticketId_department: { ticketId: id, department } },
        create: {
          ticketId: id,
          department,
          assignedUserId: dto.assignedUserId,
          assignedUserName,
          feedback: dto.feedback,
          isCompleted: dto.isCompleted ?? false,
          completedAt: completedAt ?? null,
          completedById: completedById ?? null,
          completedByName: completedByName ?? null,
        },
        update: {
          assignedUserId: dto.assignedUserId !== undefined ? dto.assignedUserId : undefined,
          assignedUserName: assignedUserName !== undefined ? assignedUserName : undefined,
          feedback: dto.feedback !== undefined ? dto.feedback : undefined,
          isCompleted: dto.isCompleted !== undefined ? dto.isCompleted : undefined,
          completedAt: completedAt !== undefined ? completedAt : undefined,
          completedById: completedById !== undefined ? completedById : undefined,
          completedByName: completedByName !== undefined ? completedByName : undefined,
        },
      });

      // Lưu attachments hoàn thành nếu có
      if (dto.attachments && dto.attachments.length > 0) {
        for (const a of dto.attachments) {
          await tx.productQualityAttachment.create({
            data: {
              ticketId: id,
              department,
              kind: a.kind || 'COMPLETION_PROOF',
              filename: a.filename,
              originalName: a.originalName,
              url: a.url,
              mimetype: a.mimetype,
              size: a.size,
              larkFileToken: a.larkFileToken,
              createdById: userId,
            },
          });
        }
      }

      // Tính toán lại trạng thái phiếu
      const allTasks = await tx.productQualityTask.findMany({ where: { ticketId: id } });
      const requiredDepartments = ticket.assignedDepartments;

      if (requiredDepartments.length > 0) {
        const assignedTasks = allTasks.filter((t) => requiredDepartments.includes(t.department));
        const allDone = assignedTasks.length === requiredDepartments.length && assignedTasks.every((t) => t.isCompleted);
        const someDone = assignedTasks.some((t) => t.isCompleted);

        if (allDone) {
          await tx.productQualityTicket.update({
            where: { id },
            data: {
              status: QUALITY_STATUS.COMPLETED,
              isCompleted: true,
              completedAt: new Date(),
              updatedById: userId,
            },
          });
        } else if (someDone) {
          await tx.productQualityTicket.update({
            where: { id },
            data: {
              status: QUALITY_STATUS.REMEDIATING,
              isCompleted: false,
              completedAt: null,
              updatedById: userId,
            },
          });
        } else if (ticket.handledAt) {
          await tx.productQualityTicket.update({
            where: { id },
            data: {
              status: QUALITY_STATUS.IN_PROGRESS,
              isCompleted: false,
              completedAt: null,
              updatedById: userId,
            },
          });
        }
      }
    });

    // Thông báo khi hoàn thành task
    if (dto.isCompleted === true) {
      const notifyUserIds = [ticket.decisionMakerId, ticket.createdById].filter(
        (uid): uid is number => !!uid && uid !== userId,
      );
      if (notifyUserIds.length > 0) {
        await this.notificationsService.createForUsers(notifyUserIds, {
          type: 'product_quality_ticket',
          title: `Bộ phận ${department} đã xử lý xong: ${ticket.code}`,
          body: `${user?.name || 'Nhân viên'} đã hoàn thành nhiệm vụ ${department} cho phiếu ${ticket.code}`,
          link: `/san-pham/chat-luong-hang-hoa/${ticket.id}`,
          dedupeKey: `done_${ticket.id}_${department}`,
        });
      }
    }

    return this.findOne(id, { id: userId, roles: ['Super Admin'] });
  }

  async close(id: number, dto: CloseProductQualityTicketDto, userId: number) {
    const ticket = await this.prisma.productQualityTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    const updated = await this.prisma.productQualityTicket.update({
      where: { id },
      data: {
        status: QUALITY_STATUS.ENDED,
        isCompleted: false,
        closedAt: new Date(),
        closedById: userId,
        closeReason: dto.reason,
        updatedById: userId,
      },
      include: INCLUDE_FULL,
    });

    return updated;
  }

  async delete(id: number, _userId: number) {
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);
    if (ticket.status !== QUALITY_STATUS.NEW && ticket.tasks.some((t) => t.isCompleted)) {
      throw new BadRequestException('Chỉ được xóa phiếu mới chưa có bộ phận nào xử lý');
    }

    await this.prisma.productQualityTicket.delete({ where: { id } });
    return { success: true, message: `Đã xóa phiếu ${ticket.code}` };
  }

  // ─────────────────────────────────────────────────────────────
  // Xuất file Excel
  // ─────────────────────────────────────────────────────────────

  async exportTickets(query: ProductQualityQueryDto, user: any, res: Response): Promise<void> {
    const where = this.buildWhere(query, user);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Sự cố chất lượng');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 16 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Khách hàng', key: 'customerName', width: 30 },
      { header: 'Sản phẩm', key: 'productName', width: 36 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Đơn vị', key: 'unit', width: 10 },
      { header: 'Hạn dùng', key: 'expiryDate', width: 14 },
      { header: 'Phân loại', key: 'initialClassification', width: 22 },
      { header: 'Loại phản hồi', key: 'feedbackType', width: 24 },
      { header: 'Mức độ', key: 'severity', width: 12 },
      { header: 'Người quyết định', key: 'decisionMakerName', width: 20 },
      { header: 'Hướng xử lý', key: 'handlingDirection', width: 32 },
      { header: 'Bộ phận thực hiện', key: 'assignedDepartments', width: 26 },
      { header: 'Trạng thái', key: 'status', width: 18 },
      { header: 'Ngày tạo', key: 'createdAt', width: 18 },
      { header: 'Ngày có xử lý', key: 'handledAt', width: 18 },
      { header: 'Hạn SLA', key: 'dueAt', width: 18 },
      { header: 'Ngày hoàn thành', key: 'completedAt', width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6F0FA' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let skip = 0;
    while (true) {
      const batch = await this.prisma.productQualityTicket.findMany({
        where,
        skip,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
      });
      if (batch.length === 0) break;

      for (const t of batch) {
        const row = sheet.addRow({
          code: t.code,
          branchName: t.branchName || '—',
          customerName: t.customerName,
          productName: t.productName,
          quantity: Number(t.quantity),
          unit: t.unit || '',
          expiryDate: t.expiryDate ? t.expiryDate.toISOString().slice(0, 10) : '',
          initialClassification: t.initialClassification,
          feedbackType: t.feedbackType,
          severity: t.severity || '—',
          decisionMakerName: t.decisionMakerName || '—',
          handlingDirection: t.handlingDirection || '—',
          assignedDepartments: t.assignedDepartments.join(', '),
          status: QUALITY_STATUS_LABELS[t.status] || t.status,
          createdAt: t.createdAt.toLocaleString('vi-VN'),
          handledAt: t.handledAt ? t.handledAt.toLocaleString('vi-VN') : '',
          dueAt: t.dueAt ? t.dueAt.toLocaleString('vi-VN') : '',
          completedAt: t.completedAt ? t.completedAt.toLocaleString('vi-VN') : '',
        });
        row.commit();
      }
      skip += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async exportTicketsDetail(query: ProductQualityQueryDto, user: any, res: Response): Promise<void> {
    const where = this.buildWhere(query, user);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết nhiệm vụ chất lượng');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 16 },
      { header: 'Khách hàng', key: 'customerName', width: 28 },
      { header: 'Sản phẩm', key: 'productName', width: 32 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Bộ phận', key: 'department', width: 18 },
      { header: 'Phản hồi bộ phận', key: 'feedback', width: 32 },
      { header: 'Trạng thái bộ phận', key: 'isCompleted', width: 18 },
      { header: 'Người hoàn thành', key: 'completedByName', width: 20 },
      { header: 'Thời gian hoàn thành', key: 'completedAt', width: 20 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6F0FA' },
    };
    headerRow.commit();

    const BATCH_SIZE = 200;
    let skip = 0;
    while (true) {
      const batch = await this.prisma.productQualityTicket.findMany({
        where,
        skip,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { tasks: true },
      });
      if (batch.length === 0) break;

      for (const t of batch) {
        if (!t.tasks.length) {
          sheet.addRow({
            code: t.code,
            customerName: t.customerName,
            productName: t.productName,
            quantity: Number(t.quantity),
            department: 'Chưa giao',
            feedback: '',
            isCompleted: 'Chưa giao',
            completedByName: '',
            completedAt: '',
          }).commit();
        } else {
          for (const task of t.tasks) {
            sheet.addRow({
              code: t.code,
              customerName: t.customerName,
              productName: t.productName,
              quantity: Number(t.quantity),
              department: task.department,
              feedback: task.feedback || '',
              isCompleted: task.isCompleted ? 'Đã xong' : 'Đang xử lý',
              completedByName: task.completedByName || '',
              completedAt: task.completedAt ? task.completedAt.toLocaleString('vi-VN') : '',
            }).commit();
          }
        }
      }
      skip += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  // ─────────────────────────────────────────────────────────────
  // Cấu hình Routing & Danh sách thành viên bộ phận
  // ─────────────────────────────────────────────────────────────

  async getRoutingConfigs() {
    return this.prisma.productQualityRoutingConfig.findMany({
      include: {
        decisionMaker: { select: { id: true, name: true, email: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  async upsertRoutingConfig(dto: UpsertRoutingConfigDto) {
    return this.prisma.productQualityRoutingConfig.upsert({
      where: {
        initialClassification_branchId: {
          initialClassification: dto.initialClassification,
          branchId: dto.branchId || null as any,
        },
      },
      create: {
        initialClassification: dto.initialClassification,
        branchId: dto.branchId,
        decisionMakerId: dto.decisionMakerId,
        fallbackToCreator: dto.fallbackToCreator ?? false,
      },
      update: {
        decisionMakerId: dto.decisionMakerId,
        fallbackToCreator: dto.fallbackToCreator ?? false,
      },
    });
  }

  async getDepartmentMembers(branchId?: number) {
    return this.prisma.productQualityDepartmentMember.findMany({
      where: branchId ? { branchId } : undefined,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: [{ department: 'asc' }, { isPrimary: 'desc' }],
    });
  }

  async upsertDepartmentMember(dto: UpsertDepartmentMemberDto) {
    return this.prisma.productQualityDepartmentMember.upsert({
      where: {
        department_branchId_userId: {
          department: dto.department,
          branchId: dto.branchId || null as any,
          userId: dto.userId,
        },
      },
      create: {
        department: dto.department,
        branchId: dto.branchId,
        userId: dto.userId,
        isPrimary: dto.isPrimary ?? false,
      },
      update: {
        isPrimary: dto.isPrimary ?? false,
      },
    });
  }

  async deleteDepartmentMember(id: number) {
    await this.prisma.productQualityDepartmentMember.delete({ where: { id } });
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────
  // Import từ file Excel (POS template hoặc xuất từ LarkBase)
  // ─────────────────────────────────────────────────────────────

  async getImportTemplate(): Promise<Buffer> {
    return this.importService.getTemplate();
  }

  async previewExcelImport(file: Express.Multer.File, user: any, branchId?: number) {
    return this.importService.preview(file, user, branchId);
  }

  async commitExcelImport(file: Express.Multer.File, user: any, branchId?: number) {
    return this.importService.commit(file, user, branchId);
  }

  // ─────────────────────────────────────────────────────────────
  // Import từ LarkBase
  // ─────────────────────────────────────────────────────────────

  async importFromLark(dto: LarkImportDto, userId: number) {
    const baseToken = dto.baseToken || 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
    const tableId = dto.tableId || 'tblF032Qb8D2dcyd';

    const appId = this.config.get<string>('LARK_APP_ID');
    const appSecret = this.config.get<string>('LARK_APP_SECRET');

    if (!appId || !appSecret) {
      throw new BadRequestException('LARK_APP_ID hoặc LARK_APP_SECRET chưa được cấu hình');
    }

    const token = await this.getLarkTenantAccessToken(appId, appSecret);

    // Đọc tất cả record từ bảng
    const records = await this.fetchAllLarkRecords(baseToken, tableId, token, dto.limit);

    this.logger.log(`Fetched ${records.length} records from LarkBase ${baseToken}/${tableId}`);

    // Chuẩn bị lookup cache để match nhanh
    const [customers, products, invoices, users, branches] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true, code: true, name: true, larkRecordId: true } }),
      this.prisma.product.findMany({ select: { id: true, code: true, name: true, unit: true, larkRecordId: true } }),
      this.prisma.invoice.findMany({ select: { id: true, code: true } }),
      this.prisma.user.findMany({ select: { id: true, name: true, larkUserId: true } }),
      this.prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);

    const customerByLarkId = new Map<string, typeof customers[0]>();
    const customerByName = new Map<string, typeof customers[0]>();
    for (const c of customers) {
      if (c.larkRecordId) customerByLarkId.set(c.larkRecordId, c);
      if (c.name) customerByName.set(c.name.trim().toLowerCase(), c);
    }

    const productByLarkId = new Map<string, typeof products[0]>();
    const productByCode = new Map<string, typeof products[0]>();
    for (const p of products) {
      if (p.larkRecordId) productByLarkId.set(p.larkRecordId, p);
      if (p.code) productByCode.set(p.code.trim().toUpperCase(), p);
    }

    const invoiceByCode = new Map<string, typeof invoices[0]>();
    for (const inv of invoices) {
      invoiceByCode.set(inv.code.trim().toUpperCase(), inv);
    }

    const userByLarkId = new Map<string, typeof users[0]>();
    const userByName = new Map<string, typeof users[0]>();
    for (const u of users) {
      if (u.larkUserId) userByLarkId.set(u.larkUserId, u);
      if (u.name) userByName.set(u.name.trim().toLowerCase(), u);
    }

    const branchByName = new Map<string, typeof branches[0]>();
    for (const b of branches) {
      branchByName.set(b.name.trim().toLowerCase(), b);
    }

    let matchedCustomers = 0;
    let matchedProducts = 0;
    let matchedInvoices = 0;
    let importedCount = 0;
    let skippedCount = 0;

    const itemsPreview: any[] = [];

    for (const rec of records) {
      const f = rec.fields || {};

      // Customer
      const customerLink = this.extractLinkRecord(f['Tên Khách Hàng']);
      let matchedCustomer = customerLink?.id ? customerByLarkId.get(customerLink.id) : undefined;
      if (!matchedCustomer && customerLink?.text) {
        matchedCustomer = customerByName.get(customerLink.text.trim().toLowerCase());
      }
      if (matchedCustomer) matchedCustomers++;

      // Product
      const productLink = this.extractLinkRecord(f['Tên Sản Phẩm']);
      let matchedProduct = productLink?.id ? productByLarkId.get(productLink.id) : undefined;
      if (!matchedProduct && productLink?.text) {
        // Thử tìm code SP bên trong tên, ví dụ "SP000390"
        const codeMatch = productLink.text.match(/SP\d{6}|[A-Z0-9]{5,15}/i);
        if (codeMatch) {
          matchedProduct = productByCode.get(codeMatch[0].toUpperCase());
        }
      }
      if (matchedProduct) matchedProducts++;

      // Invoice
      const invoiceLink = this.extractLinkRecord(f['Hóa Đơn']);
      const invoiceCode = invoiceLink?.text?.trim().toUpperCase();
      const matchedInvoice = invoiceCode ? invoiceByCode.get(invoiceCode) : undefined;
      if (matchedInvoice) matchedInvoices++;

      // Branch
      const rawKho = this.extractText(f['Kho']);
      let matchedBranch: typeof branches[0] | undefined;
      if (rawKho) {
        if (rawKho.includes('Hà Nội')) matchedBranch = branchByName.get('kho hà nội') || branches.find((b) => b.id === 6);
        else if (rawKho.includes('Sài Gòn')) matchedBranch = branchByName.get('kho sài gòn') || branches.find((b) => b.id === 1);
      }

      // Decision maker
      const rawDecisionMaker = this.extractUser(f['Người Quyết Định']);
      let matchedDecisionMaker = rawDecisionMaker?.id ? userByLarkId.get(rawDecisionMaker.id) : undefined;
      if (!matchedDecisionMaker && rawDecisionMaker?.name) {
        matchedDecisionMaker = userByName.get(rawDecisionMaker.name.trim().toLowerCase());
      }

      // Status
      const rawStatus = this.extractText(f['Trạng Thái Sự Cố']) || 'Mới';
      const status = this.mapLarkStatus(rawStatus);

      // Dates
      const createdAt = f['Ngày tạo'] ? new Date(Number(f['Ngày tạo'])) : new Date(rec.created_time || Date.now());
      const handledAt = f['Ngày Có Xử Lý'] ? new Date(Number(f['Ngày Có Xử Lý'])) : undefined;
      const completedAt = f['Ngày Hoàn Thành'] ? new Date(Number(f['Ngày Hoàn Thành'])) : undefined;
      const dueAt = handledAt ? this.calcDueDate(handledAt, 5) : undefined;

      // Assigned departments & checkboxes
      const assignedDepts = this.extractMultiSelect(f['Bộ Phận Thực Hiện']);
      const kdDone = !!f['Phòng Kinh Doanh'];
      const khoDone = !!f['Kho + Logistics'];
      const ktDone = !!f['Kế Toán Kho'];
      const tmDone = !!f['Thu Mua'];

      const item = {
        sourceRecordId: rec.record_id,
        legacyCode: this.extractText(f['Mã Phiếu']) || rec.record_id,
        branchId: matchedBranch?.id,
        branchName: matchedBranch?.name || rawKho,
        customerId: matchedCustomer?.id,
        customerCode: matchedCustomer?.code,
        customerName: customerLink?.text || 'Khách hàng',
        productId: matchedProduct?.id,
        productCode: matchedProduct?.code,
        productName: productLink?.text || 'Sản phẩm',
        unit: this.extractText(f['Đơn Vị Tính']) || matchedProduct?.unit,
        sourceType: this.extractText(f['Nguồn Hàng']),
        quantity: Number(this.extractText(f['Số Lượng']) || 1),
        expiryDate: f['Hạn Sử Dụng'] ? new Date(Number(f['Hạn Sử Dụng'])) : undefined,
        reason: this.extractText(f['Nguyên Nhân']),
        initialClassification: this.extractText(f['Phân Loại Sự Cố Ban Đầu']) || 'Chất Lượng Sản Phẩm',
        feedbackType: this.extractText(f['Loại phản hồi']) || 'Hàng Lỗi / Hỏng',
        severity: this.extractText(f['Mức Độ Nghiêm Trọng']),
        responsibilities: this.extractMultiSelect(f['Trách Nhiệm Thuộc Về']),
        factoryName: this.extractText(f['Nhà Máy Sản Xuất']),
        note: this.extractText(f['Ghi Chú']),
        invoiceId: matchedInvoice?.id,
        invoiceCode: invoiceCode || undefined,
        decisionMakerId: matchedDecisionMaker?.id,
        decisionMakerName: matchedDecisionMaker?.name || rawDecisionMaker?.name,
        handlingDirection: this.extractText(f['Hướng Xử Lý']),
        assignedDepartments: assignedDepts,
        status,
        isCompleted: status === QUALITY_STATUS.COMPLETED,
        handledAt,
        dueAt,
        completedAt,
        createdAt,
        tasks: [
          { dept: 'Kinh Doanh', isCompleted: kdDone, feedback: this.extractText(f['Phòng Kinh Doanh Phản Hồi ( Nếu có)']) },
          { dept: 'Kho + Logistics', isCompleted: khoDone, feedback: this.extractText(f['Kho Phản Hồi (Nếu Có)']) },
          { dept: 'Kế Toán Kho', isCompleted: ktDone, feedback: this.extractText(f['Kế Toán Phản Hồi ( Nếu Có)']) },
          { dept: 'Thu Mua', isCompleted: tmDone, feedback: this.extractText(f['Thu Mua Phản Hồi (Nếu Có)']) },
        ].filter((t) => assignedDepts.includes(t.dept) || t.isCompleted || !!t.feedback),
      };

      itemsPreview.push(item);

      if (!dto.dryRun) {
        try {
          const existing = await this.prisma.productQualityTicket.findUnique({
            where: { sourceRecordId: rec.record_id },
          });
          const ticketCode = existing ? existing.code : await this.generateCode();

          const savedTicket = await this.prisma.productQualityTicket.upsert({
            where: { sourceRecordId: rec.record_id },
            create: {
              code: ticketCode,
              legacyCode: item.legacyCode,
              sourceRecordId: item.sourceRecordId,
              branchId: item.branchId,
              branchName: item.branchName,
              customerId: item.customerId,
              customerCode: item.customerCode,
              customerName: item.customerName,
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              unit: item.unit,
              sourceType: item.sourceType,
              quantity: item.quantity,
              expiryDate: item.expiryDate,
              reason: item.reason,
              initialClassification: item.initialClassification,
              feedbackType: item.feedbackType,
              severity: item.severity,
              responsibilities: item.responsibilities,
              factoryName: item.factoryName,
              note: item.note,
              invoiceId: item.invoiceId,
              invoiceCode: item.invoiceCode,
              decisionMakerId: item.decisionMakerId,
              decisionMakerName: item.decisionMakerName,
              handlingDirection: item.handlingDirection,
              assignedDepartments: item.assignedDepartments,
              status: item.status,
              isCompleted: item.isCompleted,
              handledAt: item.handledAt,
              dueAt: item.dueAt,
              completedAt: item.completedAt,
              createdById: userId,
              createdAt: item.createdAt,
            },
            update: {
              branchId: item.branchId,
              branchName: item.branchName,
              customerId: item.customerId,
              customerCode: item.customerCode,
              customerName: item.customerName,
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              unit: item.unit,
              sourceType: item.sourceType,
              quantity: item.quantity,
              expiryDate: item.expiryDate,
              reason: item.reason,
              initialClassification: item.initialClassification,
              feedbackType: item.feedbackType,
              severity: item.severity,
              responsibilities: item.responsibilities,
              factoryName: item.factoryName,
              note: item.note,
              invoiceId: item.invoiceId,
              invoiceCode: item.invoiceCode,
              decisionMakerId: item.decisionMakerId,
              decisionMakerName: item.decisionMakerName,
              handlingDirection: item.handlingDirection,
              assignedDepartments: item.assignedDepartments,
              status: item.status,
              isCompleted: item.isCompleted,
              handledAt: item.handledAt,
              dueAt: item.dueAt,
              completedAt: item.completedAt,
            },
          });

          // Upsert tasks
          for (const t of item.tasks) {
            await this.prisma.productQualityTask.upsert({
              where: {
                ticketId_department: {
                  ticketId: savedTicket.id,
                  department: t.dept,
                },
              },
              create: {
                ticketId: savedTicket.id,
                department: t.dept,
                isCompleted: t.isCompleted,
                feedback: t.feedback,
                completedAt: t.isCompleted ? item.completedAt || item.handledAt : null,
              },
              update: {
                isCompleted: t.isCompleted,
                feedback: t.feedback,
                completedAt: t.isCompleted ? item.completedAt || item.handledAt : null,
              },
            });
          }

          importedCount++;
        } catch (err: any) {
          this.logger.error(`Error importing record ${rec.record_id}: ${err?.message}`);
          skippedCount++;
        }
      }
    }

    return {
      totalFetched: records.length,
      matchedCustomers,
      matchedProducts,
      matchedInvoices,
      importedCount: dto.dryRun ? 0 : importedCount,
      skippedCount: dto.dryRun ? 0 : skippedCount,
      dryRun: !!dto.dryRun,
      sample: itemsPreview.slice(0, 10),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private calcDueDate(startDate: Date, days: number): Date {
    const d = new Date(startDate.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  private mapLarkStatus(rawStatus: string): string {
    const s = (rawStatus || '').trim().toLowerCase();
    if (s.includes('hoàn thành') || s === 'done') return QUALITY_STATUS.COMPLETED;
    if (s.includes('khắc phục')) return QUALITY_STATUS.REMEDIATING;
    if (s.includes('đang xử lý')) return QUALITY_STATUS.IN_PROGRESS;
    if (s.includes('ended') || s.includes('dừng')) return QUALITY_STATUS.ENDED;
    return QUALITY_STATUS.NEW;
  }

  private async resolveRouting(
    classification: string,
    branchId?: number,
    creatorId?: number,
  ): Promise<{ decisionMakerId: number; decisionMakerName?: string } | null> {
    const config = await this.prisma.productQualityRoutingConfig.findFirst({
      where: {
        OR: [
          { initialClassification: classification, branchId: branchId || undefined },
          { initialClassification: classification, branchId: null },
          { initialClassification: 'DEFAULT', branchId: branchId || undefined },
          { initialClassification: 'DEFAULT', branchId: null },
        ],
      },
      include: { decisionMaker: { select: { id: true, name: true } } },
      orderBy: { branchId: 'desc' }, // Ưu tiên config theo đúng branch trước
    });

    if (config?.fallbackToCreator && creatorId) {
      const creator = await this.prisma.user.findUnique({
        where: { id: creatorId },
        select: { id: true, name: true },
      });
      if (creator) {
        return { decisionMakerId: creator.id, decisionMakerName: creator.name };
      }
    }

    if (config?.decisionMaker) {
      return {
        decisionMakerId: config.decisionMaker.id,
        decisionMakerName: config.decisionMaker.name,
      };
    }

    return null;
  }

  private sendLarkGroupNotificationAsync(ticketId: number) {
    if (!this.larkClient) return;
    const chatId = this.config.get<string>('LARK_QUALITY_CHAT_ID') || 'oc_114b8b90dde9fe06c02454a30cc81c1f';
    if (!chatId) return;

    this.sendLarkGroupNotification(ticketId, chatId).catch((err) => {
      this.logger.warn(`Failed to send Lark notification for ticket #${ticketId}: ${err?.message}`);
    });
  }

  private async sendLarkGroupNotification(ticketId: number, chatId: string) {
    if (!this.larkClient) return;
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id: ticketId },
      include: { branch: true },
    });
    if (!ticket) return;

    const contentText = [
      `[SỰ CỐ CHẤT LƯỢNG HÀNG HÓA - ${ticket.code}]`,
      `• Khách hàng: ${ticket.customerName}`,
      `• Sản phẩm: ${ticket.productName}`,
      `• Số lượng: ${ticket.quantity} ${ticket.unit || ''}`,
      `• Phân loại: ${ticket.initialClassification}`,
      `• Loại phản hồi: ${ticket.feedbackType}`,
      `• Chi nhánh: ${ticket.branchName || 'Chung'}`,
      `• Người quyết định: ${ticket.decisionMakerName || 'Chờ phân công'}`,
      ticket.reason ? `• Nguyên nhân: ${ticket.reason}` : '',
    ].filter(Boolean).join('\n');

    await this.larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: contentText }),
      },
    });
  }

  private async getLarkTenantAccessToken(appId: string, appSecret: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ app_id: appId, app_secret: appSecret });
      const req = https.request(
        {
          hostname: 'open.larksuite.com',
          path: '/open-apis/auth/v3/tenant_access_token/internal',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const body = JSON.parse(data);
              if (body.code === 0 && body.tenant_access_token) {
                resolve(body.tenant_access_token);
              } else {
                reject(new Error(body.msg || 'Auth failed'));
              }
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  private async fetchAllLarkRecords(
    baseToken: string,
    tableId: string,
    token: string,
    maxLimit?: number,
  ): Promise<any[]> {
    const all: any[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const pageSize = Math.min(100, maxLimit ? maxLimit - all.length : 100);
      if (pageSize <= 0) break;

      const qs = new URLSearchParams({
        page_size: String(pageSize),
        automatic_fields: 'true',
      });
      if (pageToken) qs.set('page_token', pageToken);

      const res: any = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'open.larksuite.com',
            path: `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${qs.toString()}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          },
          (response) => {
            let d = '';
            response.on('data', (c) => (d += c));
            response.on('end', () => {
              try {
                resolve(JSON.parse(d));
              } catch (err) {
                reject(err);
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) {
        this.logger.error(`Lark API error: ${res.msg}`);
        break;
      }

      const items = res.data?.items || [];
      all.push(...items);

      hasMore = res.data?.has_more || false;
      pageToken = res.data?.page_token;

      if (maxLimit && all.length >= maxLimit) break;
    }

    return all;
  }

  private extractText(v: any): string {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      return v.map((item) => this.extractText(item)).filter(Boolean).join(' ');
    }
    if (typeof v === 'object') {
      return v.text || v.name || v.full_address || '';
    }
    return String(v).trim();
  }

  private extractMultiSelect(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) {
      return v.map((item) => (typeof item === 'string' ? item : item.name || item.text || '')).filter(Boolean);
    }
    if (typeof v === 'string') {
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }

  private extractLinkRecord(v: any): { id?: string; text?: string } | null {
    if (!v) return null;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      const id = first.record_ids?.[0] || first.id;
      const text = first.text || first.name || (Array.isArray(first.text_arr) ? first.text_arr[0] : '');
      return { id, text };
    }
    if (typeof v === 'object') {
      const id = v.record_ids?.[0] || v.id;
      const text = v.text || v.name;
      return { id, text };
    }
    return null;
  }

  private extractUser(v: any): { id?: string; name?: string } | null {
    if (!v) return null;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      return { id: first.id, name: first.name };
    }
    if (typeof v === 'object') {
      return { id: v.id, name: v.name };
    }
    return null;
  }
}
