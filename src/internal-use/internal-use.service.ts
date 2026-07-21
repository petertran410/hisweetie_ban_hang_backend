import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInternalUseDto,
  UpdateInternalUseDto,
  InternalUseQueryDto,
  CancelInternalUseDto,
  CreatePurposeDto,
  UpdatePurposeDto,
} from './dto';
import { Prisma } from '@prisma/client';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

const SUPER_ADMIN_ROLE = 'Super Admin';
const COMPLETE_PERMISSION = 'internal-use:complete';

@Injectable()
export class InternalUseService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  /**
   * Chỉ user có quyền `internal-use:complete` (hoặc Super Admin) mới được
   * "duyệt/hoàn thành" phiếu (chuyển status 1 → 2, xuất kho). Người tạo
   * thường (chỉ có `internal-use:create`) chỉ được lưu tạm.
   */
  private ensureCanComplete(user: {
    permissions?: string[];
    roles?: string[];
  }): void {
    if (user.roles?.includes(SUPER_ADMIN_ROLE)) return;
    if (user.permissions?.includes(COMPLETE_PERMISSION)) return;
    throw new ForbiddenException(
      'Bạn không có quyền duyệt/hoàn thành phiếu. Cần quyền internal-use:complete.',
    );
  }

  // Bộ lọc dùng chung cho findAll + export (tổng quan/chi tiết) để file xuất
  // khớp đúng danh sách đang hiển thị trên UI.
  private buildInternalUseWhere(
    query: InternalUseQueryDto,
  ): Prisma.InternalUseWhereInput {
    const {
      branchIds,
      status,
      fromDate,
      toDate,
      search,
      createdById,
      userId,
      purposeId,
    } = query;

    const where: Prisma.InternalUseWhereInput = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (createdById) {
      where.createdById = createdById;
    }

    if (userId) {
      where.userId = userId;
    }

    if (purposeId) {
      where.purposeId = purposeId;
    }

    if (search) {
      where.code = { contains: search, mode: 'insensitive' };
    }

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = new Date(fromDate);
      }
      if (toDate) {
        where.createdAt.lte = new Date(toDate);
      }
    }

    return where;
  }

  async findAllPurposes() {
    return this.prisma.internalUsePurpose.findMany({
      where: { isDeleted: false },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
  }

  async createPurpose(dto: CreatePurposeDto) {
    return this.prisma.internalUsePurpose.create({
      data: { name: dto.name, order: dto.order ?? 999 },
    });
  }

  async updatePurpose(id: number, dto: UpdatePurposeDto) {
    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id },
    });
    if (!purpose || purpose.isDeleted) {
      throw new NotFoundException(`InternalUsePurpose with ID ${id} not found`);
    }
    return this.prisma.internalUsePurpose.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
      },
    });
  }

  async deletePurpose(id: number) {
    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id },
    });
    if (!purpose || purpose.isDeleted) {
      throw new NotFoundException(`InternalUsePurpose with ID ${id} not found`);
    }
    await this.prisma.internalUsePurpose.update({
      where: { id },
      data: { isDeleted: true },
    });
    return { message: 'Purpose deleted successfully' };
  }

  async findAll(query: InternalUseQueryDto) {
    const { pageSize = 15, currentItem = 0 } = query;

    const where = this.buildInternalUseWhere(query);

    const [data, total, agg] = await Promise.all([
      this.prisma.internalUse.findMany({
        where,
        include: {
          details: { include: { product: true } },
          purpose: true,
          branch: true,
          user: true,
          creator: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: pageSize,
      }),
      this.prisma.internalUse.count({ where }),
      this.prisma.internalUse.aggregate({ where, _sum: { totalValue: true } }),
    ]);

    return {
      data,
      total,
      pageSize,
      totalValue: Number(agg._sum.totalValue || 0),
    };
  }

  // Nhãn trạng thái dùng chung cho cả 2 file xuất.
  private static readonly EXPORT_STATUS_LABEL: Record<number, string> = {
    1: 'Phiếu tạm',
    2: 'Hoàn thành',
    3: 'Đã hủy',
  };

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu xuất dùng nội bộ = 1 dòng Excel. Bộ lọc
   * dùng chung buildInternalUseWhere với findAll để khớp danh sách đang hiển thị.
   */
  async exportInternalUses(
    query: InternalUseQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildInternalUseWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Xuất dùng nội bộ');

    sheet.columns = [
      { header: 'Mã xuất dùng nội bộ', key: 'code', width: 22 },
      { header: 'Thời gian', key: 'transDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Chi nhánh', key: 'branchName', width: 22 },
      { header: 'Mục đích sử dụng', key: 'purposeName', width: 24 },
      { header: 'Người sử dụng', key: 'userName', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Tổng mặt hàng', key: 'totalGoods', width: 14 },
      { header: 'Tổng SL xuất', key: 'totalQuantity', width: 14 },
      { header: 'Tổng giá trị', key: 'totalValue', width: 18 },
      { header: 'Ghi chú', key: 'description', width: 30 },
      { header: 'Trạng thái', key: 'status', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.internalUse.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { details: true, purpose: true },
      });

      if (batch.length === 0) break;

      for (const d of batch) {
        const totalQuantity = d.details.reduce(
          (s, item) => s + Number(item.quantity),
          0,
        );
        const row = sheet.addRow({
          code: d.code,
          transDate: fmtDateTime(d.transDate),
          createdAt: fmtDateTime(d.createdAt),
          branchName: d.branchName || '',
          purposeName: d.purpose?.name || '',
          userName: d.userName || '',
          createdBy: d.createdByName || '',
          totalGoods: d.details.length,
          totalQuantity,
          totalValue: Number(d.totalValue) || 0,
          description: d.description || '',
          status: InternalUseService.EXPORT_STATUS_LABEL[d.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi sản phẩm trong phiếu = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildInternalUseWhere với export tổng quan.
   */
  async exportInternalUsesDetail(
    query: InternalUseQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildInternalUseWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết xuất dùng nội bộ');

    sheet.columns = [
      { header: 'Mã xuất dùng nội bộ', key: 'code', width: 22 },
      { header: 'Thời gian', key: 'transDate', width: 20 },
      { header: 'Chi nhánh', key: 'branchName', width: 22 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'ĐVT', key: 'unit', width: 10 },
      { header: 'Số lượng xuất', key: 'quantity', width: 14 },
      { header: 'Giá vốn', key: 'cost', width: 14 },
      { header: 'Thành tiền', key: 'lineTotal', width: 16 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.internalUse.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { details: true, purpose: true },
      });

      if (batch.length === 0) break;

      for (const d of batch) {
        const base = {
          code: d.code,
          transDate: fmtDateTime(d.transDate),
          branchName: d.branchName || '',
          createdBy: d.createdByName || '',
          status: InternalUseService.EXPORT_STATUS_LABEL[d.status] || '',
        };

        if (!d.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            unit: '',
            quantity: 0,
            cost: 0,
            lineTotal: 0,
          });
          row.commit();
          continue;
        }

        for (const item of d.details) {
          const quantity = Number(item.quantity) || 0;
          const cost = Number(item.cost) || 0;
          const row = sheet.addRow({
            ...base,
            productCode: item.productCode || '',
            productName: item.productName || '',
            unit: item.unit || '',
            quantity,
            cost,
            lineTotal: Number(item.value) || quantity * cost,
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const internalUse = await this.prisma.internalUse.findUnique({
      where: { id },
      include: {
        details: { include: { product: true } },
        purpose: true,
        branch: true,
        user: true,
        creator: true,
      },
    });

    if (!internalUse) {
      throw new NotFoundException(`InternalUse with ID ${id} not found`);
    }

    return internalUse;
  }

  async create(
    dto: CreateInternalUseDto,
    userId: number,
    user: { permissions?: string[]; roles?: string[] },
  ) {
    const creator = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
    });

    if (!branch) {
      throw new NotFoundException(`Branch with ID ${dto.branchId} not found`);
    }

    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id: dto.purposeId },
    });
    if (!purpose) {
      throw new NotFoundException(
        `InternalUsePurpose with ID ${dto.purposeId} not found`,
      );
    }

    const isDraft = dto.isDraft ?? true;

    // Chỉ người duyệt (có internal-use:complete) mới được tạo và hoàn thành
    // trong một bước (isDraft=false). Người tạo thường chỉ được lưu tạm.
    if (!isDraft) {
      this.ensureCanComplete(user);
    }

    this.validateDetails(dto.internalUseDetails, isDraft);

    let usedUser: { name: string } | null = null;
    if (dto.userId) {
      usedUser = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { name: true },
      });
    }

    const code = await this.resolveCode(dto.code);
    const status = isDraft ? 1 : 2;
    const transDate = isDraft ? null : new Date();

    // Resolve giá vốn cho từng dòng: nếu client không gửi cost (user không có
    // quyền xem giá vốn) thì tự lấy từ inventory theo (product, branch).
    const resolvedDetails = await this.resolveDetailCosts(
      dto.internalUseDetails,
      dto.branchId,
    );

    let totalValue = 0;
    for (const detail of resolvedDetails) {
      totalValue += Number(detail.quantity) * Number(detail.cost);
    }

    const touchedProductIds = new Set<number>();

    const internalUse = await this.prisma.$transaction(async (tx) => {
      const created = await tx.internalUse.create({
        data: {
          code,
          branchId: dto.branchId,
          branchName: branch.name,
          status,
          transDate,
          purposeId: dto.purposeId,
          userId: dto.userId ?? null,
          userName: usedUser?.name ?? null,
          createdById: userId,
          createdByName: creator?.name || 'Unknown',
          description: dto.description,
          totalValue,
          details: {
            create: resolvedDetails.map((detail) => ({
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName || '',
              unit: detail.unit,
              quantity: detail.quantity,
              cost: detail.cost,
              value: Number(detail.quantity) * Number(detail.cost),
            })),
          },
        },
        include: { details: true },
      });

      if (!isDraft) {
        const touched = await this.decrementInventory(created.id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      return created;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'INTERNAL_USE_CREATE',
      entityType: 'internal_uses',
      entityId: internalUse.id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_CREATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_CREATE'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_CREATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_CREATE',
      userId,
      userName: creator?.name || creator?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return internalUse;
  }

  async update(
    id: number,
    dto: UpdateInternalUseDto,
    userId: number,
    user: { permissions?: string[]; roles?: string[] },
  ) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException(
        'Cannot update cancelled internal use voucher',
      );
    }

    if (internalUse.status === 2) {
      throw new BadRequestException(
        'Cannot update completed internal use voucher',
      );
    }

    const updateData: Prisma.InternalUseUpdateInput = {};

    if (dto.description !== undefined) {
      updateData.description = dto.description;
    }

    if (dto.purposeId !== undefined) {
      const purpose = await this.prisma.internalUsePurpose.findUnique({
        where: { id: dto.purposeId },
      });
      if (!purpose) {
        throw new NotFoundException(
          `InternalUsePurpose with ID ${dto.purposeId} not found`,
        );
      }
      updateData.purpose = { connect: { id: dto.purposeId } };
    }

    if (dto.userId !== undefined) {
      if (dto.userId === null) {
        updateData.user = { disconnect: true };
        updateData.userName = null;
      } else {
        const usedUser = await this.prisma.user.findUnique({
          where: { id: dto.userId },
          select: { name: true },
        });
        if (!usedUser) {
          throw new NotFoundException(`User with ID ${dto.userId} not found`);
        }
        updateData.user = { connect: { id: dto.userId } };
        updateData.userName = usedUser.name;
      }
    }

    if (dto.createdById !== undefined) {
      const creator = await this.prisma.user.findUnique({
        where: { id: dto.createdById },
      });
      if (!creator) {
        throw new NotFoundException(
          `User with ID ${dto.createdById} not found`,
        );
      }
      updateData.creator = { connect: { id: dto.createdById } };
      updateData.createdByName = creator.name;
    }

    if (dto.transDate !== undefined) {
      updateData.transDate = dto.transDate ? new Date(dto.transDate) : null;
    }

    const willComplete = dto.status === 2 || dto.isDraft === false;
    if (willComplete) {
      // Chỉ người duyệt (có internal-use:complete) mới được hoàn thành phiếu.
      this.ensureCanComplete(user);
      const details = dto.internalUseDetails ?? internalUse.details;
      this.validateDetails(details, false);
      updateData.status = 2;
      updateData.transDate = updateData.transDate ?? new Date();
    } else if (dto.status !== undefined) {
      updateData.status = dto.status;
    }

    const branchIdForCost = internalUse.branchId;
    const resolvedDetails = dto.internalUseDetails
      ? await this.resolveDetailCosts(dto.internalUseDetails, branchIdForCost)
      : null;

    if (resolvedDetails) {
      let totalValue = 0;
      for (const detail of resolvedDetails) {
        totalValue += Number(detail.quantity) * Number(detail.cost);
      }
      updateData.totalValue = totalValue;
    }

    const touchedProductIds = new Set<number>();

    const updated = await this.prisma.$transaction(async (tx) => {
      if (resolvedDetails) {
        await tx.internalUseDetail.deleteMany({
          where: { internalUseId: id },
        });
        await tx.internalUseDetail.createMany({
          data: resolvedDetails.map((detail) => ({
            internalUseId: id,
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName || '',
            unit: detail.unit,
            quantity: detail.quantity,
            cost: detail.cost,
            value: Number(detail.quantity) * Number(detail.cost),
          })),
        });
      }

      const result = await tx.internalUse.update({
        where: { id },
        data: updateData,
        include: { details: true },
      });

      if (internalUse.status === 1 && willComplete) {
        const touched = await this.decrementInventory(id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      return result;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_UPDATE',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_UPDATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_UPDATE'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_UPDATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_UPDATE',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return updated;
  }

  async complete(id: number, userId: number) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException(
        'Cannot complete cancelled internal use voucher',
      );
    }
    if (internalUse.status === 2) {
      throw new BadRequestException('Internal use voucher already completed');
    }

    this.validateDetails(internalUse.details, false);

    const touchedProductIds = new Set<number>();

    const completed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.internalUse.update({
        where: { id },
        data: { status: 2, transDate: internalUse.transDate ?? new Date() },
        include: { details: true },
      });
      const touched = await this.decrementInventory(id, tx);
      for (const productId of touched) touchedProductIds.add(productId);
      return result;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_UPDATE',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_UPDATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_UPDATE'),
      snapshot: this.buildSnapshot(completed),
      message: renderAuditMessage('INTERNAL_USE_UPDATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_UPDATE',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return completed;
  }

  async cancel(id: number, dto: CancelInternalUseDto, userId: number) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException('Internal use voucher already cancelled');
    }

    const description = dto.cancelReason
      ? `${internalUse.description ? internalUse.description + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
      : internalUse.description;

    if (internalUse.status === 1) {
      await this.prisma.internalUse.update({
        where: { id },
        data: { status: 3, description },
      });
    } else {
      const touchedProductIds = new Set<number>();
      await this.prisma.$transaction(async (tx) => {
        await tx.internalUse.update({
          where: { id },
          data: { status: 3, description },
        });

        for (const detail of internalUse.details) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: internalUse.branchId,
              },
            },
            data: { onHand: { increment: detail.quantity } },
          });
          touchedProductIds.add(detail.productId);
        }

        // Xóa các dòng thẻ kho gốc của phiếu (transactionType INTERNAL_USE)
        // — không để lại dấu vết trên thẻ kho sản phẩm sau khi hủy.
        await tx.inventoryLog.deleteMany({
          where: { refType: 'internal_use', refId: internalUse.id },
        });

        // NGUỒN CHÂN LÝ: sau khi xóa log INTERNAL_USE, recalc onHand = Σ log
        // active (loại hẳn phần đã xuất của phiếu vừa hủy).
        await recalcOnHandForPairs(
          tx,
          internalUse.details.map((detail: any) => ({
            productId: detail.productId,
            branchId: internalUse.branchId,
          })),
        );
      });
      for (const productId of touchedProductIds) {
        this.larkProductSync.enqueueSync(productId);
      }
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_CANCEL',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_CANCEL'),
      severity: getSeverityFromActionCode('INTERNAL_USE_CANCEL'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_CANCEL', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_CANCEL',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return { message: 'Internal use voucher cancelled successfully' };
  }

  private validateDetails(
    details: { quantity: number | Prisma.Decimal }[] | undefined,
    requireComplete: boolean,
  ) {
    if (!requireComplete) return;

    if (!details || details.length === 0) {
      throw new BadRequestException(
        'Phiếu phải có ít nhất một dòng sản phẩm để hoàn thành',
      );
    }
    for (const detail of details) {
      if (Number(detail.quantity) <= 0) {
        throw new BadRequestException(
          'Số lượng xuất phải lớn hơn 0 để hoàn thành phiếu',
        );
      }
    }
  }

  private async resolveDetailCosts<
    T extends { productId: number; quantity: number | string; cost?: number },
  >(details: T[], branchId: number): Promise<(T & { cost: number })[]> {
    return Promise.all(
      details.map(async (detail) => {
        if (detail.cost !== undefined && detail.cost !== null) {
          return { ...detail, cost: Number(detail.cost) };
        }
        const inventory = await this.prisma.inventory.findUnique({
          where: {
            productId_branchId: { productId: detail.productId, branchId },
          },
          select: { cost: true },
        });
        return { ...detail, cost: inventory ? Number(inventory.cost) : 0 };
      }),
    );
  }

  private async resolveCode(inputCode?: string): Promise<string> {
    const code = inputCode?.trim();
    if (code) {
      const existing = await this.prisma.internalUse.findUnique({
        where: { code },
      });
      if (existing) {
        throw new BadRequestException(`Mã phiếu "${code}" đã tồn tại`);
      }
      return code;
    }
    return this.generateCode();
  }

  private async generateCode(): Promise<string> {
    const prefix = 'XDNB';

    const last = await this.prisma.internalUse.findFirst({
      where: { code: { startsWith: `${prefix}` } },
      orderBy: { code: 'desc' },
    });

    let sequence = 1;
    if (last) {
      const lastSequence = parseInt(last.code.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${sequence.toString().padStart(6, '0')}`;
  }

  private async decrementInventory(
    internalUseId: number,
    tx: any,
  ): Promise<Set<number>> {
    const touched = new Set<number>();
    const internalUse = await tx.internalUse.findUnique({
      where: { id: internalUseId },
      include: { details: true },
    });

    for (const detail of internalUse.details) {
      const inventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: internalUse.branchId,
          },
        },
        include: {
          product: { select: { weight: true, weightUnit: true } },
        },
      });

      const costPrice = inventory
        ? Number(inventory.cost)
        : Number(detail.cost);

      if (inventory) {
        const newOnHand = Number(inventory.onHand) - Number(detail.quantity);
        const weight = inventory.product.weight
          ? Number(inventory.product.weight)
          : 0;
        const weightUnit = inventory.product.weightUnit || 'g';
        const weightInGrams = weightUnit === 'kg' ? weight * 1000 : weight;
        const totalWeight = weightInGrams * newOnHand;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: internalUse.branchId,
            },
          },
          data: {
            onHand: { decrement: detail.quantity },
            totalWeight: totalWeight,
          },
        });
        touched.add(detail.productId);

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: internalUse.branchId,
            branchName: internalUse.branchName,
            transactionType: 'INTERNAL_USE',
            refCode: internalUse.code,
            refType: 'internal_use',
            refId: internalUse.id,
            quantity: -Number(detail.quantity),
            costPrice,
            transactionPrice: null,
            partnerName: null,
          },
        });
      }
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi ghi log INTERNAL_USE
    // cho mọi dòng, recalc lại onHand từ thẻ kho.
    await recalcOnHandForPairs(
      tx,
      internalUse.details.map((detail: any) => ({
        productId: detail.productId,
        branchId: internalUse.branchId,
      })),
    );
    return touched;
  }

  private buildSnapshot(d: any) {
    return {
      code: d.code,
      branchId: d.branchId,
      status: d.status,
      purposeId: d.purposeId,
      userId: d.userId,
      totalValue: Number(d.totalValue || 0),
      transDate: d.transDate,
      description: d.description,
      details: (d.details || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        cost: Number(item.cost),
        value: Number(item.value),
      })),
    };
  }
}
