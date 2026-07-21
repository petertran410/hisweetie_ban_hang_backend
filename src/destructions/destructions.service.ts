import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDestructionDto,
  UpdateDestructionDto,
  DestructionQueryDto,
  CancelDestructionDto,
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

@Injectable()
export class DestructionsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  // Bộ lọc dùng chung cho findAll + export (tổng quan/chi tiết) để file xuất
  // khớp đúng danh sách đang hiển thị trên UI.
  private buildDestructionWhere(
    query: DestructionQueryDto,
  ): Prisma.DestructionWhereInput {
    const {
      branchIds,
      status,
      fromDestructionDate,
      toDestructionDate,
      search,
      createdById,
    } = query;

    const where: Prisma.DestructionWhereInput = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (createdById) {
      where.createdById = createdById;
    }

    if (search) {
      where.code = { contains: search, mode: 'insensitive' };
    }

    if (fromDestructionDate || toDestructionDate) {
      where.createdAt = {};
      if (fromDestructionDate) {
        where.createdAt.gte = new Date(fromDestructionDate);
      }
      if (toDestructionDate) {
        where.createdAt.lte = new Date(toDestructionDate);
      }
    }

    return where;
  }

  async findAll(query: DestructionQueryDto) {
    const { pageSize = 15, currentItem = 0 } = query;

    const where = this.buildDestructionWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.destruction.findMany({
        where,
        include: {
          details: {
            include: { product: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: pageSize,
      }),
      this.prisma.destruction.count({ where }),
    ]);

    return { data, total, pageSize };
  }

  // Nhãn trạng thái dùng chung cho cả 2 file xuất.
  private static readonly EXPORT_STATUS_LABEL: Record<number, string> = {
    1: 'Phiếu tạm',
    2: 'Hoàn thành',
    3: 'Đã hủy',
  };

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu xuất hủy = 1 dòng Excel. Bộ lọc dùng chung
   * buildDestructionWhere với findAll để khớp danh sách đang hiển thị.
   */
  async exportDestructions(
    query: DestructionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildDestructionWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Xuất hủy');

    sheet.columns = [
      { header: 'Mã xuất hủy', key: 'code', width: 18 },
      { header: 'Thời gian hủy', key: 'destructionDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Chi nhánh', key: 'branchName', width: 22 },
      { header: 'Người xuất hủy', key: 'createdBy', width: 20 },
      { header: 'Tổng mặt hàng', key: 'totalGoods', width: 14 },
      { header: 'Tổng SL hủy', key: 'totalQuantity', width: 14 },
      { header: 'Tổng giá trị hủy', key: 'totalValue', width: 18 },
      { header: 'Ghi chú', key: 'note', width: 30 },
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
      const batch = await this.prisma.destruction.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { details: true },
      });

      if (batch.length === 0) break;

      for (const d of batch) {
        const totalQuantity = d.details.reduce(
          (s, item) => s + Number(item.quantity),
          0,
        );
        const row = sheet.addRow({
          code: d.code,
          destructionDate: fmtDateTime(d.destructionDate),
          createdAt: fmtDateTime(d.createdAt),
          branchName: d.branchName || '',
          createdBy: d.createdByName || '',
          totalGoods: d.details.length,
          totalQuantity,
          totalValue: Number(d.totalValue) || 0,
          note: d.note || '',
          status: DestructionsService.EXPORT_STATUS_LABEL[d.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi sản phẩm hủy trong phiếu = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildDestructionWhere với export tổng quan.
   */
  async exportDestructionsDetail(
    query: DestructionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildDestructionWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết xuất hủy');

    sheet.columns = [
      { header: 'Mã xuất hủy', key: 'code', width: 18 },
      { header: 'Thời gian hủy', key: 'destructionDate', width: 20 },
      { header: 'Chi nhánh', key: 'branchName', width: 22 },
      { header: 'Người xuất hủy', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'Số lượng hủy', key: 'quantity', width: 14 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Thành tiền', key: 'lineTotal', width: 16 },
      { header: 'Ghi chú dòng', key: 'lineNote', width: 30 },
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
      const batch = await this.prisma.destruction.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: { details: true },
      });

      if (batch.length === 0) break;

      for (const d of batch) {
        const base = {
          code: d.code,
          destructionDate: fmtDateTime(d.destructionDate),
          branchName: d.branchName || '',
          createdBy: d.createdByName || '',
          status: DestructionsService.EXPORT_STATUS_LABEL[d.status] || '',
        };

        if (!d.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            quantity: 0,
            price: 0,
            lineTotal: 0,
            lineNote: '',
          });
          row.commit();
          continue;
        }

        for (const item of d.details) {
          const quantity = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          const row = sheet.addRow({
            ...base,
            productCode: item.productCode || '',
            productName: item.productName || '',
            quantity,
            price,
            lineTotal: Number(item.totalValue) || quantity * price,
            lineNote: item.note || '',
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
    const destruction = await this.prisma.destruction.findUnique({
      where: { id },
      include: {
        details: {
          include: { product: true },
        },
        branch: true,
        creator: true,
      },
    });

    if (!destruction) {
      throw new NotFoundException(`Destruction with ID ${id} not found`);
    }

    return destruction;
  }

  async create(dto: CreateDestructionDto, userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
    });

    if (!branch) {
      throw new NotFoundException(`Branch with ID ${dto.branchId} not found`);
    }

    const code = await this.generateCode();
    const isDraft = dto.isDraft ?? true;
    const status = isDraft ? 1 : 2;
    const destructionDate = isDraft ? null : new Date();

    let totalValue = 0;
    for (const detail of dto.destructionDetails) {
      totalValue += Number(detail.quantity) * Number(detail.price);
    }

    const touchedProductIds = new Set<number>();
    const destruction = await this.prisma.$transaction(async (tx) => {
      const created = await tx.destruction.create({
        data: {
          code,
          branchId: dto.branchId,
          branchName: branch.name,
          status,
          destructionDate,
          createdById: userId,
          createdByName: user?.name || 'Unknown',
          note: dto.note,
          totalValue,
          details: {
            create: dto.destructionDetails.map((detail) => {
              const product = detail as any;
              return {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: product.productName || '',
                quantity: detail.quantity,
                price: detail.price,
                totalValue: Number(detail.quantity) * Number(detail.price),
                note: product.note,
              };
            }),
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
      actionCode: 'DESTRUCTION_CREATE',
      entityType: 'destructions',
      entityId: destruction.id.toString(),
      entityCode: destruction.code,
      category: getCategoryFromActionCode('DESTRUCTION_CREATE'),
      severity: getSeverityFromActionCode('DESTRUCTION_CREATE'),
      snapshot: this.buildDestructionSnapshot(destruction),
      message: renderAuditMessage('DESTRUCTION_CREATE', {
        destructionCode: destruction.code,
      }),
      messageTemplate: 'DESTRUCTION_CREATE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: destruction.branchId || undefined,
    });

    return destruction;
  }

  async update(id: number, dto: UpdateDestructionDto, userId: number) {
    const destruction = await this.findOne(id);

    if (destruction.status === 3) {
      if (dto.destructionDetails || dto.status || dto.branchId || dto.isDraft) {
        throw new BadRequestException(
          'Cannot update product details or status of cancelled destruction',
        );
      }
    }

    const updateData: any = {};

    if (dto.note !== undefined) {
      updateData.note = dto.note;
    }

    if (dto.createdById !== undefined) {
      const user = await this.prisma.user.findUnique({
        where: { id: dto.createdById },
      });
      if (!user) {
        throw new NotFoundException(
          `User with ID ${dto.createdById} not found`,
        );
      }
      updateData.createdById = dto.createdById;
      updateData.createdByName = user.name;
    }

    if (dto.destructionDate !== undefined) {
      updateData.destructionDate = dto.destructionDate
        ? new Date(dto.destructionDate)
        : null;
    }

    if (dto.status !== undefined) {
      if (destruction.status === 2 && dto.status !== 2) {
        throw new BadRequestException(
          'Cannot change status of completed destruction',
        );
      }
      updateData.status = dto.status;
      if (dto.status === 2 && !updateData.destructionDate) {
        updateData.destructionDate = new Date();
      }
    }

    if (dto.destructionDetails) {
      let totalValue = 0;
      for (const detail of dto.destructionDetails) {
        totalValue += Number(detail.quantity) * Number(detail.price);
      }
      updateData.totalValue = totalValue;
    }

    const touchedProductIds = new Set<number>();

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.destructionDetails) {
        await tx.destructionDetail.deleteMany({ where: { destructionId: id } });
        await tx.destructionDetail.createMany({
          data: dto.destructionDetails.map((detail) => {
            const product = detail as any;
            return {
              destructionId: id,
              productId: detail.productId,
              productCode: detail.productCode,
              productName: product.productName || '',
              quantity: detail.quantity,
              price: detail.price,
              totalValue: Number(detail.quantity) * Number(detail.price),
              note: product.note,
            };
          }),
        });
      }

      const result = await tx.destruction.update({
        where: { id },
        data: updateData,
        include: { details: true },
      });

      if (destruction.status === 1 && dto.status === 2) {
        const touched = await this.decrementInventory(id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      return result;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'DESTRUCTION_UPDATE',
      entityType: 'destructions',
      entityId: id.toString(),
      entityCode: destruction.code,
      category: getCategoryFromActionCode('DESTRUCTION_UPDATE'),
      severity: getSeverityFromActionCode('DESTRUCTION_UPDATE'),
      snapshot: this.buildDestructionSnapshot(destruction),
      message: renderAuditMessage('DESTRUCTION_UPDATE', {
        destructionCode: destruction.code,
      }),
      messageTemplate: 'DESTRUCTION_UPDATE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: destruction.branchId || undefined,
    });

    return updated;
  }

  async remove(id: number, userId: number) {
    const destruction = await this.findOne(id);

    if (destruction.status === 2) {
      throw new BadRequestException(
        'Cannot delete completed destruction. Please cancel it first.',
      );
    }

    await this.prisma.destruction.delete({ where: { id } });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'DELETE',
      actionCode: 'DESTRUCTION_DELETE',
      entityType: 'destructions',
      entityId: id.toString(),
      entityCode: destruction.code,
      category: getCategoryFromActionCode('DESTRUCTION_DELETE'),
      severity: getSeverityFromActionCode('DESTRUCTION_DELETE'),
      snapshot: this.buildDestructionSnapshot(destruction),
      message: renderAuditMessage('DESTRUCTION_DELETE', {
        destructionCode: destruction.code,
      }),
      messageTemplate: 'DESTRUCTION_DELETE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: destruction.branchId || undefined,
    });

    return { message: 'Destruction deleted successfully' };
  }

  async cancelDestruction(
    id: number,
    dto: CancelDestructionDto,
    userId: number,
  ) {
    const destruction = await this.findOne(id);

    if (destruction.status === 3) {
      throw new BadRequestException('Destruction already cancelled');
    }

    if (destruction.status === 1) {
      await this.prisma.destruction.update({
        where: { id },
        data: {
          status: 3,
          note: dto.cancelReason
            ? `${destruction.note ? destruction.note + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : destruction.note,
        },
      });
      return { message: 'Destruction cancelled successfully' };
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      await tx.destruction.update({
        where: { id },
        data: {
          status: 3,
          note: dto.cancelReason
            ? `${destruction.note ? destruction.note + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : destruction.note,
        },
      });

      if (destruction.status === 2) {
        for (const detail of destruction.details) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: destruction.branchId,
              },
            },
            data: {
              onHand: { increment: detail.quantity },
            },
          });
          touchedProductIds.add(detail.productId);
        }

        // NGUỒN CHÂN LÝ: status=3 → log DESTRUCTION rớt khỏi Σ active. Recalc.
        await recalcOnHandForPairs(
          tx,
          destruction.details.map((detail: any) => ({
            productId: detail.productId,
            branchId: destruction.branchId,
          })),
        );
      }
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'DESTRUCTION_CANCEL',
      entityType: 'destructions',
      entityId: id.toString(),
      entityCode: destruction.code,
      category: getCategoryFromActionCode('DESTRUCTION_CANCEL'),
      severity: getSeverityFromActionCode('DESTRUCTION_CANCEL'),
      snapshot: this.buildDestructionSnapshot(destruction),
      message: renderAuditMessage('DESTRUCTION_CANCEL', {
        destructionCode: destruction.code,
      }),
      messageTemplate: 'DESTRUCTION_CANCEL',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: destruction.branchId || undefined,
    });

    return { message: 'Destruction cancelled successfully' };
  }

  private async generateCode(): Promise<string> {
    const prefix = 'XH';

    const lastDestruction = await this.prisma.destruction.findFirst({
      where: { code: { startsWith: `${prefix}` } },
      orderBy: { code: 'desc' },
    });

    let sequence = 1;
    if (lastDestruction) {
      const lastSequence = parseInt(lastDestruction.code.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${sequence.toString().padStart(6, '0')}`;
  }

  private async decrementInventory(
    destructionId: number,
    tx: any,
  ): Promise<Set<number>> {
    const touched = new Set<number>();
    const destruction = await tx.destruction.findUnique({
      where: { id: destructionId },
      include: { details: true },
    });

    for (const detail of destruction.details) {
      const inventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: destruction.branchId,
          },
        },
        include: {
          product: {
            select: {
              weight: true,
              weightUnit: true,
            },
          },
        },
      });

      if (!inventory) {
        throw new NotFoundException(
          `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode}`,
        );
      }

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
            branchId: destruction.branchId,
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
          branchId: destruction.branchId,
          branchName: '',
          transactionType: 'DESTRUCTION',
          refCode: destruction.code,
          refType: 'destruction',
          refId: destruction.id,
          quantity: -Number(detail.quantity),
          costPrice: inventory ? Number(inventory.cost) : 0,
          transactionPrice: null,
          partnerName: null,
        },
      });
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active. Recalc sau khi ghi log DESTRUCTION.
    await recalcOnHandForPairs(
      tx,
      destruction.details.map((detail: any) => ({
        productId: detail.productId,
        branchId: destruction.branchId,
      })),
    );
    return touched;
  }

  private buildDestructionSnapshot(d: any) {
    return {
      code: d.code,
      branchId: d.branchId,
      status: d.status,
      totalValue: Number(d.totalValue || 0),
      destructionDate: d.destructionDate,
      note: d.note,
      details: (d.details || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        price: Number(item.price),
      })),
    };
  }
}
