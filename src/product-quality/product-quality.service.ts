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
import { ProductQualityLarkService } from './product-quality-lark.service';
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
  ENDED: 'Đã hủy',
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
    private readonly larkService: ProductQualityLarkService,
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
   const andConditions: Prisma.ProductQualityTicketWhereInput[] = [];

   // Kiểm tra quyền xem chi nhánh
   const canViewAll =
     user?.roles?.includes('Super Admin') ||
     user?.roles?.includes('Admin') ||
     user?.permissions?.includes('product_quality:view_all_branches');

   if (!canViewAll) {
     const userBranchId = user?.branchId;
     if (userBranchId) {
       andConditions.push({
         OR: [
           { branchId: userBranchId },
           { branchId: null }, // Cho phép xem các phiếu import chưa xác định chi nhánh
         ],
       });
     }
   } else if (query.branchIds && query.branchIds.length > 0) {
     andConditions.push({ branchId: { in: query.branchIds } });
   } else if (query.branchId !== undefined && query.branchId !== null) {
     if (query.branchId === -1) {
       andConditions.push({ branchId: null });
     } else {
       andConditions.push({ branchId: query.branchId });
     }
   }

   // Tìm kiếm text
   if (query.search) {
     const s = query.search.trim();
     andConditions.push({
       OR: [
         { code: { contains: s, mode: 'insensitive' } },
         { legacyCode: { contains: s, mode: 'insensitive' } },
         { customerName: { contains: s, mode: 'insensitive' } },
         { customerCode: { contains: s, mode: 'insensitive' } },
         { productName: { contains: s, mode: 'insensitive' } },
         { productCode: { contains: s, mode: 'insensitive' } },
         { reason: { contains: s, mode: 'insensitive' } },
         { note: { contains: s, mode: 'insensitive' } },
       ],
     });
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
     andConditions.push({
       OR: [
         { createdById: user.id },
         { decisionMakerId: user.id },
         { tasks: { some: { assignedUserId: user.id } } },
       ],
     });
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

   if (andConditions.length > 0) {
     where.AND = andConditions;
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

    // Hóa đơn bán hàng liên quan (nhiều-nhiều). Truy vấn tách riêng và chịu lỗi
    // để không làm hỏng trang chi tiết nếu bảng liên kết chưa được tạo.
    let relatedInvoices: unknown[] = [];
    try {
      relatedInvoices = await this.prisma.productQualityTicketInvoice.findMany({
        where: { ticketId: id },
        include: {
          invoice: {
            select: { id: true, code: true, purchaseDate: true, grandTotal: true },
          },
        },
        orderBy: { id: 'asc' },
      });
    } catch (err: any) {
      this.logger.warn(
        `Không đọc được hóa đơn liên quan của phiếu #${id}: ${err?.message}`,
      );
    }

    return { ...ticket, relatedInvoices };
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
        select: { code: true, name: true, unit: true, middleName: true },
      });
      if (p) {
        productCode = p.code || productCode;
        productName = p.name || productName;
        unit = p.unit || unit;
        // Nguồn hàng lấy từ Product.middle_name (nhóm hàng cấp 2).
        sourceType = p.middleName || sourceType;
      }
    }

    // Hóa đơn bán hàng liên quan: cho phép nhiều hóa đơn, đồng bộ invoiceId/code
    // với hóa đơn đầu tiên để tương thích dữ liệu cũ.
    let invoiceId = dto.invoiceId;
    let invoiceCode = dto.invoiceCode;
    const relatedInvoiceIds = Array.from(
      new Set((dto.invoiceIds || []).filter((v) => Number.isFinite(v))),
    );
    const relatedInvoices =
      relatedInvoiceIds.length > 0
        ? await this.prisma.invoice.findMany({
            where: { id: { in: relatedInvoiceIds } },
            select: { id: true, code: true },
            orderBy: { id: 'asc' },
          })
        : [];
    if (relatedInvoices.length > 0) {
      invoiceId = relatedInvoices[0].id;
      invoiceCode = relatedInvoices.map((i) => i.code).join(', ');
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
          invoiceId,
          invoiceCode,
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

    // Lưu liên kết nhiều-nhiều hóa đơn bán hàng (chịu lỗi nếu bảng chưa được tạo).
    if (relatedInvoices.length > 0) {
      try {
        await this.prisma.productQualityTicketInvoice.createMany({
          data: relatedInvoices.map((i) => ({
            ticketId: ticket.id,
            invoiceId: i.id,
          })),
          skipDuplicates: true,
        });
      } catch (err: any) {
        this.logger.warn(
          `Không lưu được hóa đơn liên quan cho phiếu #${ticket.id}: ${err?.message}`,
        );
      }
    }

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

    if (ticket.status === QUALITY_STATUS.ENDED) {
      throw new BadRequestException(
        'Phiếu đã hủy, không thể cập nhật hướng xử lý.',
      );
    }

    let decisionMakerName: string | undefined;
    if (dto.decisionMakerId) {
      const u = await this.prisma.user.findUnique({
        where: { id: dto.decisionMakerId },
        select: { name: true },
      });
      decisionMakerName = u?.name;
    }

    const hasHandling = !!dto.handlingDirection?.trim();
    if (!hasHandling && !ticket.handlingDirection?.trim()) {
      throw new BadRequestException(
        'Vui lòng nhập hướng xử lý trước khi chuyển phiếu sang Đang xử lý',
      );
    }

    const nextDepartments = dto.assignedDepartments || ticket.assignedDepartments;
    if (!nextDepartments || nextDepartments.length === 0) {
      throw new BadRequestException(
        'Vui lòng chọn ít nhất một bộ phận thực hiện',
      );
    }

    // Nhà máy sản xuất: ưu tiên id để đồng bộ tên theo bảng factories.
    let factoryId = dto.factoryId !== undefined ? dto.factoryId : ticket.factoryId;
    let factoryName = dto.factoryName !== undefined ? dto.factoryName : ticket.factoryName;
    if (dto.factoryId) {
      const factory = await this.prisma.factory.findUnique({
        where: { id: dto.factoryId },
        select: { id: true, name: true },
      });
      if (!factory) throw new BadRequestException('Không tìm thấy nhà máy đã chọn');
      factoryId = factory.id;
      factoryName = factory.name;
    }

    // Hóa đơn xuất bù/hoàn: ưu tiên id để đồng bộ mã theo bảng invoices.
    let outboundInvoiceId =
      dto.outboundInvoiceId !== undefined ? dto.outboundInvoiceId : ticket.outboundInvoiceId;
    let outboundInvoiceCode =
      dto.outboundInvoiceCode !== undefined ? dto.outboundInvoiceCode : ticket.outboundInvoiceCode;
    if (dto.outboundInvoiceId) {
      const inv = await this.prisma.invoice.findUnique({
        where: { id: dto.outboundInvoiceId },
        select: { id: true, code: true },
      });
      if (!inv) throw new BadRequestException('Không tìm thấy hóa đơn xuất bù đã chọn');
      outboundInvoiceId = inv.id;
      outboundInvoiceCode = inv.code;
    }

    const isFirstHandling = hasHandling && !ticket.handledAt;
    const handledAt = isFirstHandling ? new Date() : ticket.handledAt;
    const dueAt = isFirstHandling ? this.calcDueDate(handledAt!, 5) : ticket.dueAt;

    let newStatus = ticket.status;
    if (isFirstHandling && ticket.status === QUALITY_STATUS.NEW) {
      newStatus = QUALITY_STATUS.IN_PROGRESS;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productQualityTicket.update({
        where: { id },
        data: {
          decisionMakerId: dto.decisionMakerId !== undefined ? dto.decisionMakerId : ticket.decisionMakerId,
          decisionMakerName: decisionMakerName !== undefined ? decisionMakerName : ticket.decisionMakerName,
          handlingDirection: dto.handlingDirection !== undefined ? dto.handlingDirection : ticket.handlingDirection,
          reason: dto.reason !== undefined ? dto.reason : ticket.reason,
          note: dto.note !== undefined ? dto.note : ticket.note,
          assignedDepartments: nextDepartments,
          severity: dto.severity !== undefined ? dto.severity : ticket.severity,
          responsibilities: dto.responsibilities !== undefined ? dto.responsibilities : ticket.responsibilities,
          factoryName,
          factoryId,
          outboundInvoiceId,
          outboundInvoiceCode,
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

      // Bỏ các ảnh/video người dùng đã xóa (chỉ trong phạm vi phiếu này).
      const removeIds = (dto.removeAttachmentIds || []).filter((v) =>
        Number.isFinite(v),
      );
      if (removeIds.length > 0) {
        await tx.productQualityAttachment.deleteMany({
          where: { ticketId: id, id: { in: removeIds } },
        });
      }

      // Thêm ảnh/video minh chứng mới.
      if (dto.attachments && dto.attachments.length > 0) {
        for (const a of dto.attachments) {
          await tx.productQualityAttachment.create({
            data: {
              ticketId: id,
              department: a.department,
              kind: a.kind || 'PROOF_IMAGE',
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
   * Chuyển phiếu từ "Đang xử lý" sang "Đang khắc phục".
   * Điều kiện: đã có hướng xử lý và ít nhất một bộ phận thực hiện.
   */
  async moveToRemediating(id: number, userId: number) {
    const ticket = await this.prisma.productQualityTicket.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    if (
      ticket.status === QUALITY_STATUS.COMPLETED ||
      ticket.status === QUALITY_STATUS.ENDED
    ) {
      throw new BadRequestException(
        'Phiếu đã hoàn thành hoặc đã kết thúc, không thể chuyển sang Đang khắc phục',
      );
    }
    if (!ticket.handlingDirection?.trim()) {
      throw new BadRequestException(
        'Vui lòng nhập hướng xử lý trước khi chuyển sang Đang khắc phục',
      );
    }
    if (!ticket.assignedDepartments || ticket.assignedDepartments.length === 0) {
      throw new BadRequestException(
        'Vui lòng chọn ít nhất một bộ phận thực hiện trước khi chuyển sang Đang khắc phục',
      );
    }

    // Đảm bảo mỗi bộ phận được giao đều có task trước khi bắt đầu khắc phục.
    const existingDepts = ticket.tasks.map((t) => t.department);
    const missingDepts = ticket.assignedDepartments.filter(
      (dept) => !existingDepts.includes(dept),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const dept of missingDepts) {
        await tx.productQualityTask.create({
          data: {
            ticketId: id,
            department: dept,
            assignedUserId: null,
            assignedUserName: null,
          },
        });
      }
      return tx.productQualityTicket.update({
        where: { id },
        data: {
          status: QUALITY_STATUS.REMEDIATING,
          isCompleted: false,
          completedAt: null,
          updatedById: userId,
        },
      });
    });

    const targetUserIds = [ticket.decisionMakerId, ticket.createdById].filter(
      (uid): uid is number => !!uid && uid !== userId,
    );
    if (targetUserIds.length > 0) {
      await this.notificationsService.createForUsers(targetUserIds, {
        type: 'product_quality_ticket',
        title: `Chuyển sang Đang khắc phục: ${ticket.code}`,
        body: `Phiếu ${ticket.code} đã chuyển sang giai đoạn Đang khắc phục. Vui lòng cập nhật kết quả theo bộ phận phụ trách.`,
        link: `/san-pham/chat-luong-hang-hoa/${ticket.id}`,
        dedupeKey: `remediating_${ticket.id}_${Date.now()}`,
      });
    }

    return this.findOne(updated.id, { id: userId, roles: ['Super Admin'] });
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
      // Bắt buộc có ảnh minh chứng hoàn thành cho bộ phận trước khi tick.
      const existingProof = await this.prisma.productQualityAttachment.findMany({
        where: { ticketId: id, department },
        select: { kind: true, mimetype: true },
      });
      const hasImageProof = [...existingProof, ...(dto.attachments || [])].some((a) =>
        this.isImageAttachment(a),
      );
      if (!hasImageProof) {
        throw new BadRequestException(
          `Vui lòng tải lên ít nhất 1 hình ảnh minh chứng hoàn thành cho bộ phận ${department}`,
        );
      }
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
        const allDone =
          assignedTasks.length === requiredDepartments.length &&
          assignedTasks.every((t) => t.isCompleted);
        const someDone = assignedTasks.some((t) => t.isCompleted);

        const canAutoComplete =
          ticket.status === QUALITY_STATUS.REMEDIATING ||
          ticket.status === QUALITY_STATUS.COMPLETED;

        if (allDone && canAutoComplete) {
          await tx.productQualityTicket.update({
            where: { id },
            data: {
              status: QUALITY_STATUS.COMPLETED,
              isCompleted: true,
              completedAt: new Date(),
              updatedById: userId,
            },
          });
        } else if (someDone || ticket.status === QUALITY_STATUS.REMEDIATING) {
          await tx.productQualityTicket.update({
            where: { id },
            data: {
              status: QUALITY_STATUS.REMEDIATING,
              isCompleted: false,
              completedAt: null,
              updatedById: userId,
            },
          });
        } else if (ticket.handledAt && ticket.status === QUALITY_STATUS.NEW) {
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

  /**
   * Tra cứu nhà máy đang hoạt động để liên kết ở bước nhập hướng xử lý.
   */
  async searchFactories(search?: string, limit?: number) {
    const take = Math.min(50, Math.max(1, limit || 20));
    const where: Prisma.FactoryWhereInput = { isActive: true };
    const keyword = search?.trim();
    if (keyword) {
      where.OR = [
        { code: { contains: keyword, mode: 'insensitive' } },
        { name: { contains: keyword, mode: 'insensitive' } },
        { fullName: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.factory.findMany({
        where,
        take,
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, fullName: true },
      }),
      this.prisma.factory.count({ where }),
    ]);

    return { data, total, page: 1, limit: take };
  }

  /**
   * Tra cứu hóa đơn để liên kết ở bước nhập hướng xử lý (hóa đơn xuất bù/hoàn)
   * hoặc ở bước tạo mới (hóa đơn bán hàng liên quan).
   */
  async searchInvoices(search?: string, customerId?: number, limit?: number) {
    const take = Math.min(50, Math.max(1, limit || 15));
    const where: Prisma.InvoiceWhereInput = {};
    if (customerId) where.customerId = customerId;
    const keyword = search?.trim();
    if (keyword) {
      where.code = { contains: keyword, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        take,
        orderBy: { id: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          grandTotal: true,
          customer: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total, page: 1, limit: take };
  }

  async close(id: number, dto: CloseProductQualityTicketDto, userId: number) {
    const ticket = await this.prisma.productQualityTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    if (ticket.status === QUALITY_STATUS.COMPLETED) {
      throw new BadRequestException('Phiếu đã hoàn thành, không thể hủy.');
    }
    if (ticket.status === QUALITY_STATUS.ENDED) {
      throw new BadRequestException('Phiếu đã được hủy trước đó.');
    }

    // Hủy phiếu chỉ cập nhật trạng thái + audit, không xóa bất kỳ dữ liệu nào
    // (task, hình ảnh, liên kết hóa đơn vẫn được giữ nguyên).
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
    const ticket = await this.prisma.productQualityTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException(`Không tìm thấy phiếu #${id}`);

    // Không hỗ trợ xóa cứng để bảo toàn dữ liệu lịch sử. Dùng chức năng Hủy phiếu.
    throw new BadRequestException(
      'Không hỗ trợ xóa phiếu chất lượng. Vui lòng sử dụng chức năng Hủy phiếu.',
    );
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
    return this.larkService.sync(dto, userId);
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private calcDueDate(startDate: Date, days: number): Date {
    const d = new Date(startDate.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  /** Coi là ảnh minh chứng nếu mimetype là ảnh, hoặc thiếu mimetype và không phải video. */
  private isImageAttachment(a: {
    kind?: string | null;
    mimetype?: string | null;
  }): boolean {
    const mime = (a.mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) return true;
    if (mime.startsWith('video/')) return false;
    return a.kind !== 'PROOF_VIDEO';
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
}
