import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateTransferDto,
  UpdateTransferDto,
  TransferQueryDto,
  CancelTransferDto,
  ConfirmShortageDto,
  TransferPlanningQueryDto,
} from './dto';
import { searchProductIds } from '../common/product-search.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
  InventoryLogActor,
} from '../common/inventory-log.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

@Injectable()
export class TransfersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  async findAll(query: TransferQueryDto) {
    const {
      search,
      fromBranchIds,
      toBranchIds,
      currentBranchId,
      status,
      pageSize = 20,
      currentItem = 0,
      fromReceivedDate,
      toReceivedDate,
      fromTransferDate,
      toTransferDate,
    } = query;

    const where: any = {};

    if (search && search.trim()) {
      where.code = { contains: search.trim(), mode: 'insensitive' };
    }

    if (currentBranchId) {
      const baseConditions: any[] = [
        { fromBranchId: currentBranchId },
        {
          toBranchId: currentBranchId,
          status: { gte: 2 },
        },
      ];

      if (fromBranchIds && fromBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
        ];
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
        ];
      } else {
        where.OR = baseConditions;
      }
    } else {
      if (
        fromBranchIds &&
        fromBranchIds.length > 0 &&
        toBranchIds &&
        toBranchIds.length > 0
      ) {
        where.AND = [
          { fromBranchId: { in: fromBranchIds } },
          { toBranchId: { in: toBranchIds } },
          { status: { gte: 2 } },
        ];
      } else if (fromBranchIds && fromBranchIds.length > 0) {
        where.fromBranchId = { in: fromBranchIds };
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.toBranchId = { in: toBranchIds };
        where.status = { gte: 2 };
      }
    }

    if (status && status.length > 0) {
      if (where.OR) {
        where.OR = where.OR.map((condition: any) => {
          if (condition.status && condition.status.gte) {
            return {
              ...condition,
              status: {
                in: status.filter((s) => s >= 2),
              },
            };
          }
          return {
            ...condition,
            status: { in: status },
          };
        });
      } else if (where.AND) {
        where.AND = where.AND.map((condition: any) => {
          if (condition.status) {
            return { status: { in: status } };
          }
          return condition;
        });
      } else {
        where.status = { in: status };
      }
    }

    if (fromReceivedDate || toReceivedDate) {
      where.receivedDate = {};
      if (fromReceivedDate) {
        where.receivedDate.gte = new Date(fromReceivedDate);
      }
      if (toReceivedDate) {
        where.receivedDate.lte = new Date(toReceivedDate);
      }
    }

    if (fromTransferDate || toTransferDate) {
      where.transferredDate = {};
      if (fromTransferDate) {
        where.transferredDate.gte = new Date(fromTransferDate);
      }
      if (toTransferDate) {
        where.transferredDate.lte = new Date(toTransferDate);
      }
    }

    const [total, data] = await Promise.all([
      this.prisma.transfer.count({ where }),
      this.prisma.transfer.findMany({
        where,
        skip: currentItem,
        take: Math.min(pageSize, 100),
        include: {
          fromBranch: {
            select: {
              id: true,
              name: true,
            },
          },
          toBranch: {
            select: {
              id: true,
              name: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          details: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  unit: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formattedData = data.map((transfer) => ({
      id: transfer.id,
      code: transfer.code,
      fromBranchId: transfer.fromBranchId,
      fromBranchName: transfer.fromBranch?.name || '',
      toBranchId: transfer.toBranchId,
      toBranchName: transfer.toBranch?.name || '',
      status: transfer.status,
      totalTransfer: Number(transfer.totalTransfer) || 0,
      totalReceive: Number(transfer.totalReceive) || 0,
      noteBySource: transfer.noteBySource || '',
      noteByDestination: transfer.noteByDestination || '',
      transferredDate: transfer.transferredDate,
      receivedDate: transfer.receivedDate,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      createdById: transfer.createdById,
      createdByName: transfer.creator?.name || '',
      details: transfer.details.map((detail) => ({
        id: detail.id,
        productId: detail.productId,
        productCode: detail.productCode,
        productName: detail.productName,
        sendQuantity: Number(detail.sendQuantity),
        receivedQuantity: Number(detail.receivedQuantity),
        sendPrice: Number(detail.sendPrice),
        receivePrice: Number(detail.receivePrice),
      })),
    }));

    return {
      total,
      pageSize: Math.min(pageSize, 100),
      currentItem,
      data: formattedData,
    };
  }

  /**
   * Dựng where filter cho phiếu chuyển hàng — GIỮ NGUYÊN logic của findAll.
   * Dùng chung cho export tổng quan và export chi tiết.
   */
  private buildTransferWhere(query: TransferQueryDto): any {
    const {
      search,
      fromBranchIds,
      toBranchIds,
      currentBranchId,
      status,
      fromReceivedDate,
      toReceivedDate,
      fromTransferDate,
      toTransferDate,
    } = query;

    const where: any = {};

    if (search && search.trim()) {
      where.code = { contains: search.trim(), mode: 'insensitive' };
    }

    if (currentBranchId) {
      const baseConditions: any[] = [
        { fromBranchId: currentBranchId },
        { toBranchId: currentBranchId, status: { gte: 2 } },
      ];

      if (fromBranchIds && fromBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
        ];
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
        ];
      } else {
        where.OR = baseConditions;
      }
    } else {
      if (
        fromBranchIds &&
        fromBranchIds.length > 0 &&
        toBranchIds &&
        toBranchIds.length > 0
      ) {
        where.AND = [
          { fromBranchId: { in: fromBranchIds } },
          { toBranchId: { in: toBranchIds } },
          { status: { gte: 2 } },
        ];
      } else if (fromBranchIds && fromBranchIds.length > 0) {
        where.fromBranchId = { in: fromBranchIds };
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.toBranchId = { in: toBranchIds };
        where.status = { gte: 2 };
      }
    }

    if (status && status.length > 0) {
      if (where.OR) {
        where.OR = where.OR.map((condition: any) => {
          if (condition.status && condition.status.gte) {
            return {
              ...condition,
              status: { in: status.filter((s) => s >= 2) },
            };
          }
          return { ...condition, status: { in: status } };
        });
      } else if (where.AND) {
        where.AND = where.AND.map((condition: any) => {
          if (condition.status) {
            return { status: { in: status } };
          }
          return condition;
        });
      } else {
        where.status = { in: status };
      }
    }

    if (fromReceivedDate || toReceivedDate) {
      where.receivedDate = {};
      if (fromReceivedDate) where.receivedDate.gte = new Date(fromReceivedDate);
      if (toReceivedDate) where.receivedDate.lte = new Date(toReceivedDate);
    }

    if (fromTransferDate || toTransferDate) {
      where.transferredDate = {};
      if (fromTransferDate)
        where.transferredDate.gte = new Date(fromTransferDate);
      if (toTransferDate) where.transferredDate.lte = new Date(toTransferDate);
    }

    return where;
  }

  async exportTransfers(query: TransferQueryDto, res: Response): Promise<void> {
    const where = this.buildTransferWhere(query);

    const STATUS_LABEL: Record<number, string> = {
      1: 'Phiếu tạm',
      2: 'Đang chuyển',
      3: 'Đã nhận',
      4: 'Đã hủy',
    };

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    // ── Stream Excel ──────────────────────────────────────────────────────────
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chuyển hàng');

    sheet.columns = [
      { header: 'Mã chuyển hàng', key: 'code', width: 18 },
      { header: 'Ngày chuyển', key: 'transferredDate', width: 20 },
      { header: 'Ngày nhận', key: 'receivedDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Từ chi nhánh', key: 'fromBranch', width: 22 },
      { header: 'Tới chi nhánh', key: 'toBranch', width: 22 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Tổng SL chuyển', key: 'totalSendQuantity', width: 16 },
      { header: 'Tổng SL nhận', key: 'totalReceivedQuantity', width: 16 },
      { header: 'Tổng mặt hàng', key: 'totalGoods', width: 14 },
      { header: 'Giá trị chuyển', key: 'totalTransfer', width: 16 },
      { header: 'Giá trị nhận', key: 'totalReceive', width: 16 },
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
      const batch = await this.prisma.transfer.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
          creator: { select: { name: true } },
          details: {
            select: { sendQuantity: true, receivedQuantity: true },
          },
        },
      });

      if (batch.length === 0) break;

      for (const t of batch) {
        const totalSendQuantity = t.details.reduce(
          (s, d) => s + Number(d.sendQuantity),
          0,
        );
        const totalReceivedQuantity = t.details.reduce(
          (s, d) => s + Number(d.receivedQuantity),
          0,
        );
        const row = sheet.addRow({
          code: t.code,
          transferredDate: fmtDateTime(t.transferredDate),
          receivedDate: fmtDateTime(t.receivedDate),
          createdAt: fmtDateTime(t.createdAt),
          fromBranch: t.fromBranch?.name || '',
          toBranch: t.toBranch?.name || '',
          createdBy: t.creator?.name || '',
          totalSendQuantity,
          totalReceivedQuantity,
          totalGoods: t.details.length,
          totalTransfer: Number(t.totalTransfer) || 0,
          totalReceive: Number(t.totalReceive) || 0,
          note: t.noteBySource || '',
          status: STATUS_LABEL[t.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm
   * thông tin phiếu. Bộ lọc dùng chung buildTransferWhere với export tổng quan.
   */
  async exportTransfersDetail(
    query: TransferQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildTransferWhere(query);

    const STATUS_LABEL: Record<number, string> = {
      1: 'Phiếu tạm',
      2: 'Đang chuyển',
      3: 'Đã nhận',
      4: 'Đã hủy',
    };

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết chuyển hàng');

    sheet.columns = [
      { header: 'Mã chuyển hàng', key: 'code', width: 18 },
      { header: 'Ngày chuyển', key: 'transferredDate', width: 20 },
      { header: 'Ngày nhận', key: 'receivedDate', width: 20 },
      { header: 'Từ chi nhánh', key: 'fromBranch', width: 22 },
      { header: 'Tới chi nhánh', key: 'toBranch', width: 22 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'SL chuyển', key: 'sendQuantity', width: 12 },
      { header: 'SL nhận', key: 'receivedQuantity', width: 12 },
      { header: 'Đơn giá', key: 'sendPrice', width: 14 },
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
      const batch = await this.prisma.transfer.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });

      if (batch.length === 0) break;

      for (const t of batch) {
        const base = {
          code: t.code,
          transferredDate: fmtDateTime(t.transferredDate),
          receivedDate: fmtDateTime(t.receivedDate),
          fromBranch: t.fromBranch?.name || '',
          toBranch: t.toBranch?.name || '',
          createdBy: t.creator?.name || '',
          status: STATUS_LABEL[t.status] || '',
        };

        if (!t.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            sendQuantity: 0,
            receivedQuantity: 0,
            sendPrice: 0,
            lineTotal: 0,
          });
          row.commit();
          continue;
        }

        for (const d of t.details) {
          const sendQuantity = Number(d.sendQuantity) || 0;
          const sendPrice = Number(d.sendPrice) || 0;
          const row = sheet.addRow({
            ...base,
            productCode: d.productCode || '',
            productName: d.productName || '',
            sendQuantity,
            // SL nhận chỉ có ý nghĩa khi phiếu đã nhận (status=3), giống UI.
            receivedQuantity:
              t.status === 3 ? Number(d.receivedQuantity) || 0 : 0,
            sendPrice,
            lineTotal: sendQuantity * sendPrice,
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
    const transfer = await this.prisma.transfer.findUnique({
      where: { id },
      include: {
        fromBranch: true,
        toBranch: true,
        creator: true,
        details: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer with ID ${id} not found`);
    }

    return transfer;
  }

  async create(dto: CreateTransferDto, userId: number) {
    const [fromBranch, toBranch, user] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: dto.fromBranchId } }),
      this.prisma.branch.findUnique({ where: { id: dto.toBranchId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);

    if (!fromBranch) {
      throw new NotFoundException(
        `Chi nhánh với ID ${dto.fromBranchId} không tồn tại`,
      );
    }
    if (!toBranch) {
      throw new NotFoundException(
        `Chi nhánh với ID ${dto.toBranchId} không tồn tại`,
      );
    }
    if (!user) {
      throw new NotFoundException(`Người dùng với ID ${userId} không tồn tại`);
    }

    const productIds = dto.transferDetails.map((d) => d.productId);
    const finalStatus = dto.status || 1;

    const [products, inventoriesTo] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.inventory.findMany({
        where: {
          productId: { in: productIds },
          branchId: dto.toBranchId,
        },
        select: { productId: true },
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p.name]));
    const inventoryToSet = new Set(inventoriesTo.map((inv) => inv.productId));

    if (finalStatus >= 2) {
      const missingInBranchB: string[] = [];
      for (const detail of dto.transferDetails) {
        if (!inventoryToSet.has(detail.productId)) {
          const product = products.find((p) => p.id === detail.productId);
          missingInBranchB.push(product?.code || `ID ${detail.productId}`);
        }
      }

      if (missingInBranchB.length > 0) {
        throw new BadRequestException(
          `Các sản phẩm sau chưa tồn tại ở chi nhánh "${toBranch.name}": ${missingInBranchB.join(', ')}. Vui lòng tạo sản phẩm tại chi nhánh đích trước khi chuyển hàng.`,
        );
      }

      // Cho phép chuyển vượt quá tồn kho hiện có — tồn kho chi nhánh nguồn
      // được phép âm (cộng dồn) theo yêu cầu nghiệp vụ.
    }

    const code = dto.code || (await this.generateTransferCode());

    const totalTransfer = dto.transferDetails.reduce(
      (sum, item) => sum + item.sendQuantity * item.price,
      0,
    );

    const transfer = await this.prisma.transfer.create({
      data: {
        code,
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        fromBranchName: fromBranch.name,
        toBranchName: toBranch.name,
        createdById: userId,
        createdByName: user.name,
        status: finalStatus,
        noteBySource: dto.description,
        totalTransfer,
        transferredDate: finalStatus === 2 ? new Date() : null,
        details: {
          create: dto.transferDetails.map((item) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: productMap.get(item.productId) || '',
            sendQuantity: item.sendQuantity,
            receivedQuantity: item.receivedQuantity || 0,
            sendPrice: item.price,
            receivePrice: item.price,
            totalTransfer: item.sendQuantity * item.price,
            totalReceive: (item.receivedQuantity || 0) * item.price,
          })),
        },
      },
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
        creator: true,
      },
    });

    // Actor cho InventoryLog (truy vết ai xuất/nhập kho khi chuyển hàng).
    const createLogActor = buildInventoryLogActor(userId, user.name);

    if (finalStatus === 2) {
      await this.decrementInventoryFromBranch(transfer.id, createLogActor);
    } else if (finalStatus === 3) {
      await this.decrementInventoryFromBranch(transfer.id, createLogActor);
      await this.incrementInventoryToBranch(transfer.id, createLogActor);
    }

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'TRANSFER_CREATE',
      entityType: 'transfers',
      entityId: transfer.id.toString(),
      entityCode: transfer.code,
      category: getCategoryFromActionCode('TRANSFER_CREATE'),
      severity: getSeverityFromActionCode('TRANSFER_CREATE'),
      snapshot: this.buildTransferSnapshot(transfer),
      message: renderAuditMessage('TRANSFER_CREATE', {
        transferCode: transfer.code,
        fromBranch: fromBranch.name,
        toBranch: toBranch.name,
      }),
      messageTemplate: 'TRANSFER_CREATE',
      userId,
      userName: user.name || 'System',
      branchId: fromBranch.id,
    });

    return transfer;
  }

  async update(id: number, dto: UpdateTransferDto, userId?: number) {
    const currentTransfer = await this.findOne(id);
    const newStatus =
      dto.status !== undefined ? dto.status : currentTransfer.status;

    if (newStatus >= 2 && dto.transferDetails) {
      const productIds = dto.transferDetails.map((d) => d.productId);

      const inventoriesTo = await this.prisma.inventory.findMany({
        where: {
          productId: { in: productIds },
          branchId: currentTransfer.toBranchId,
        },
        select: { productId: true },
      });

      const inventoryToSet = new Set(inventoriesTo.map((inv) => inv.productId));
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, code: true },
      });

      const missingInBranchB: string[] = [];
      for (const detail of dto.transferDetails) {
        if (!inventoryToSet.has(detail.productId)) {
          const product = products.find((p) => p.id === detail.productId);
          missingInBranchB.push(product?.code || `ID ${detail.productId}`);
        }
      }

      if (missingInBranchB.length > 0) {
        throw new BadRequestException(
          `Các sản phẩm sau chưa tồn tại ở chi nhánh đích: ${missingInBranchB.join(', ')}. Vui lòng tạo sản phẩm tại chi nhánh đích trước.`,
        );
      }
    }

    const totalTransfer =
      dto.transferDetails?.reduce((sum, item) => {
        return sum + item.sendQuantity * item.price;
      }, 0) || currentTransfer.totalTransfer;

    const totalReceive =
      dto.transferDetails?.reduce((sum, item) => {
        const receivedQty = item.receivedQuantity || 0;
        return sum + receivedQty * item.price;
      }, 0) || currentTransfer.totalReceive;

    const productIds = dto.transferDetails?.map((d) => d.productId) || [];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });

    const productMap = new Map(products.map((p) => [p.id, p.name]));

    const updatedTransfer = await this.prisma.transfer.update({
      where: { id },
      data: {
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        status: newStatus,
        noteBySource: dto.description,
        noteByDestination: dto.destination_description,
        totalTransfer,
        totalReceive,
        receivedDate:
          newStatus === 3 && currentTransfer.status !== 3
            ? new Date()
            : currentTransfer.receivedDate,
        transferredDate:
          newStatus === 2 && currentTransfer.status === 1
            ? new Date()
            : currentTransfer.transferredDate,
        ...(dto.transferDetails && {
          details: {
            deleteMany: {},
            create: dto.transferDetails.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: productMap.get(item.productId) || '',
              sendQuantity: item.sendQuantity,
              receivedQuantity: item.receivedQuantity || 0,
              sendPrice: item.price,
              receivePrice: item.price,
              totalTransfer: item.sendQuantity * item.price,
              totalReceive: (item.receivedQuantity || 0) * item.price,
            })),
          },
        }),
      },
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
      },
    });

    const oldStatus = currentTransfer.status;

    // Fetch người thực hiện sớm để truyền actor xuống các private method ghi
    // InventoryLog (truy vết ai xuất/nhập/hoàn kho khi cập nhật chuyển hàng).
    const updateUser = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        })
      : null;
    const updateLogActor = buildInventoryLogActor(
      userId,
      updateUser?.name || updateUser?.email,
    );

    if (oldStatus === 1 && newStatus === 2) {
      await this.decrementInventoryFromBranch(id, updateLogActor);
    } else if (oldStatus === 1 && newStatus === 3) {
      // Draft → Đã nhận (bỏ qua "Đang chuyển"): trừ kho chuyển theo send,
      // cộng kho nhận theo received, rồi reconcile chênh lệch (shortage/
      // surplus) để net kho chuyển = -received.
      await this.decrementInventoryFromBranch(id, updateLogActor);
      await this.incrementInventoryToBranch(id, updateLogActor);
      await this.returnShortageToFromBranch(id, updateLogActor);
      await this.deductSurplusFromFromBranch(id, updateLogActor);
    } else if (oldStatus === 2 && newStatus === 1) {
      await this.incrementInventoryFromBranch(id, updateLogActor);
    } else if (oldStatus === 2 && newStatus === 3) {
      await this.incrementInventoryToBranch(id, updateLogActor);
      // Hoàn shortage về kho chuyển: kho nhận nhận ít hơn → kho chuyển
      // vẫn giữ lại phần chênh lệch. Pattern y hệt KiotViet — dùng
      // receivedQuantity làm con số vừa trừ kho chuyển vừa cộng kho nhận.
      await this.returnShortageToFromBranch(id, updateLogActor);
      // Nhận dư (received > send): trừ thêm surplus khỏi kho chuyển —
      // thực tế hàng đã rời kho chuyển nhiều hơn số ghi lúc "Đang chuyển".
      await this.deductSurplusFromFromBranch(id, updateLogActor);
    } else if (oldStatus === 3 && newStatus === 2) {
      await this.decrementInventoryToBranch(id, updateLogActor);
    }

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'TRANSFER_UPDATE',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: updatedTransfer.code,
        category: getCategoryFromActionCode('TRANSFER_UPDATE'),
        severity: getSeverityFromActionCode('TRANSFER_UPDATE'),
        snapshot: this.buildTransferSnapshot(updatedTransfer),
        changes: buildChanges(
          'transfers',
          {
            status: currentTransfer.status,
            noteBySource: currentTransfer.noteBySource,
            noteByDestination: currentTransfer.noteByDestination,
          },
          {
            status: updatedTransfer.status,
            noteBySource: updatedTransfer.noteBySource,
            noteByDestination: updatedTransfer.noteByDestination,
          },
        ),
        message: renderAuditMessage('TRANSFER_UPDATE', {
          transferCode: updatedTransfer.code,
        }),
        messageTemplate: 'TRANSFER_UPDATE',
        userId,
        userName: user?.name || 'System',
        branchId: updatedTransfer.fromBranchId,
      });
    }

    return updatedTransfer;
  }

  async remove(id: number, userId?: number) {
    const transfer = await this.findOne(id);

    await this.prisma.transfer.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'TRANSFER_DELETE',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: transfer.code,
        category: getCategoryFromActionCode('TRANSFER_DELETE'),
        severity: getSeverityFromActionCode('TRANSFER_DELETE'),
        snapshot: this.buildTransferSnapshot(transfer),
        message: renderAuditMessage('TRANSFER_DELETE', {
          transferCode: transfer.code,
        }),
        messageTemplate: 'TRANSFER_DELETE',
        userId,
        userName: user?.name || 'System',
      });
    }

    return { message: 'Xóa dữ liệu thành công' };
  }

  async getDraftCandidates() {
    const branches = await this.prisma.branch.findMany({
      where: {
        isActive: true,
        name: { in: ['Kho Hà Nội', 'Kho Sài Gòn'] },
      },
      select: { id: true, name: true },
    });

    const hnBranch = branches.find((b) => b.name === 'Kho Hà Nội') || { id: 6 };
    const sgBranch = branches.find((b) => b.name === 'Kho Sài Gòn') || { id: 1 };

    const transfers = await this.prisma.transfer.findMany({
      where: {
        fromBranchId: hnBranch.id,
        toBranchId: sgBranch.id,
        status: 1,
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        createdAt: true,
        noteBySource: true,
        _count: { select: { details: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      data: transfers.map((t) => ({
        id: t.id,
        code: t.code,
        createdAt: t.createdAt,
        noteBySource: t.noteBySource,
        itemCount: t._count.details,
      })),
    };
  }

  private async generateTransferCode(): Promise<string> {
    const prefix = 'TRF';

    const last = await this.prisma.transfer.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });

    const lastNumber = last ? parseInt(last.code.replace(prefix, ''), 10) : 0;

    let nextNumber = lastNumber + 1;
    let code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

    // Đảm bảo không trùng trong trường hợp edge case
    while (await this.prisma.transfer.findUnique({ where: { code } })) {
      nextNumber++;
      code = `${prefix}${String(nextNumber).padStart(6, '0')}`;
    }

    return code;
  }

  private async decrementInventoryFromBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        fromBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
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
            `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.fromBranch.name}`,
          );
        }

        // Cho phép tồn kho chi nhánh nguồn âm (cộng dồn) — không chặn khi
        // onHand < sendQuantity theo yêu cầu nghiệp vụ.

        const newOnHand =
          Number(inventory.onHand) - Number(detail.sendQuantity);
        const weight = inventory.product.weight
          ? Number(inventory.product.weight)
          : 0;
        const totalWeight = weight * newOnHand;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
          data: {
            onHand: { decrement: detail.sendQuantity },
            totalWeight: totalWeight,
          },
        });
        touchedProductIds.add(detail.productId);

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.fromBranchId,
            branchName: transfer.fromBranch?.name || '',
            transactionType: 'TRANSFER_OUT',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: -Number(detail.sendQuantity),
            costPrice: inventory ? Number(inventory.cost) : 0,
            transactionPrice: null,
            partnerName: null,
            ...buildInventoryLogBase(actor),
          },
        });
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nguồn).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  private async incrementInventoryFromBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        fromBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
        });

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
          data: {
            onHand: { increment: detail.sendQuantity },
          },
        });
        touchedProductIds.add(detail.productId);

        // Ghi thẻ kho đảo chiều CHUYỂN khi hoàn tác (2→1): cộng lại số chuyển đi.
        // Gộp với dòng TRANSFER_OUT -sendQuantity trước đó sẽ triệt tiêu về 0.
        if (Number(detail.sendQuantity) > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_OUT',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: inventory ? Number(inventory.cost) : 0,
              transactionPrice: null,
              partnerName: null,
              ...buildInventoryLogBase(actor),
            },
          });
        }
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nguồn).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  private async incrementInventoryToBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        toBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.toBranchId,
            },
          },
        });

        if (!inventory) {
          throw new NotFoundException(
            `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.toBranch.name}`,
          );
        }

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.toBranchId,
            },
          },
          data: {
            onHand: { increment: detail.receivedQuantity },
          },
        });
        touchedProductIds.add(detail.productId);

        // Ghi thẻ kho chiều NHẬN: cộng đúng số lượng nhận thực tế của chi
        // nhánh nhận (có thể khác số chuyển đi). Bỏ qua khi nhận = 0.
        if (Number(detail.receivedQuantity) > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.toBranchId,
              branchName: transfer.toBranch?.name || '',
              transactionType: 'TRANSFER_IN',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.receivedQuantity),
              costPrice: inventory ? Number(inventory.cost) : 0,
              transactionPrice: null,
              partnerName: null,
              ...buildInventoryLogBase(actor),
            },
          });
        }
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nhận).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.toBranchId,
        })),
      );
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  /**
   * Trừ surplus khỏi kho chuyển — chạy ngay sau khi kho nhận xác nhận
   * "Đã nhận" (status 2→3) khi received > send.
   *
   * Ví dụ: send=1.5 → kho chuyển đã -1.5 lúc "Đang chuyển". Nhận 2.5
   * → kho nhận +2.5. Phần dư 1.0 thực tế cũng đã rời kho chuyển
   * (nhân viên để dư lúc chuyển) → trừ thêm 1.0 khỏi kho chuyển.
   *
   * Net log kho chuyển sau nhận dư: TRANSFER_OUT -send + TRANSFER_OUT
   * -surplus = -received. Khớp thực tế.
   *
   * Idempotent: skip nếu đã có log note chứa "Trừ surplus".
   */
  private async deductSurplusFromFromBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: { details: true, fromBranch: true },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const surplus =
          Number(detail.receivedQuantity) - Number(detail.sendQuantity);
        if (surplus <= 0) continue;

        // Idempotent: đã ghi log trừ surplus → skip.
        const existing = await tx.inventoryLog.findFirst({
          where: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
            transactionType: 'TRANSFER_OUT',
            refType: 'transfer',
            refId: transfer.id,
            note: { contains: 'Trừ surplus' },
          },
          select: { id: true },
        });
        if (existing) continue;

        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
        });

        // Cho phép âm (đồng bộ với policy tồn âm khi chuyển vượt).
        if (inventory) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
            data: {
              onHand: { decrement: surplus },
            },
          });
        }
        touchedProductIds.add(detail.productId);

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.fromBranchId,
            branchName: transfer.fromBranch?.name || '',
            transactionType: 'TRANSFER_OUT',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: -Number(surplus),
            costPrice: inventory ? Number(inventory.cost) : 0,
            transactionPrice: null,
            partnerName: null,
            note: `Trừ surplus (nhận dư) - phiếu ${transfer.code}`,
            ...buildInventoryLogBase(actor),
          },
        });
      }

      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  /**
   * Hoàn shortage về kho chuyển — chạy ngay sau khi kho nhận xác nhận
   * "Đã nhận" (status 2→3). Nếu kho nhận nhận ít hơn số chuyển, phần
   * chênh lệch vẫn còn thực tế ở kho chuyển → cộng lại vào tồn kho
   * kho chuyển.
   *
   * Pattern y hệt KiotViet: dùng `TRANSFER_OUT` với quantity dương
   * (gộp với dòng -sendQuantity trước đó sẽ triệt tiêu về -receivedQty).
   * Nhờ vậy "Tồn cuối" trên thẻ kho kho chuyển khớp tuyệt đối với
   * onHand sau khi recalc.
   *
   * Idempotent: nếu log hoàn shortage đã tồn tại (refType='transfer',
   * refId=transferId, transactionType='TRANSFER_OUT', quantity>0,
   * note chứa 'Hoàn shortage') thì bỏ qua — đảm bảo an toàn khi
   * confirmShortage được gọi 2 lần.
   */
  private async returnShortageToFromBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: { details: true, fromBranch: true },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const shortage =
          Number(detail.sendQuantity) - Number(detail.receivedQuantity);
        if (shortage <= 0) continue;

        // Idempotent check: nếu đã ghi log hoàn shortage cho dòng này
        // thì skip (tránh cộng 2 lần khi user F5/refresh dialog).
        const existing = await tx.inventoryLog.findFirst({
          where: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
            transactionType: 'TRANSFER_OUT',
            refType: 'transfer',
            refId: transfer.id,
            quantity: shortage,
            note: {
              contains: 'Hoàn shortage',
            },
          },
          select: { id: true },
        });
        if (existing) continue;

        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
        });

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
          data: {
            onHand: { increment: shortage },
          },
        });
        touchedProductIds.add(detail.productId);

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.fromBranchId,
            branchName: transfer.fromBranch?.name || '',
            transactionType: 'TRANSFER_OUT',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: Number(shortage),
            costPrice: inventory ? Number(inventory.cost) : 0,
            transactionPrice: null,
            partnerName: null,
            note: `Hoàn shortage - phiếu ${transfer.code}`,
            ...buildInventoryLogBase(actor),
          },
        });
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nguồn).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  private async decrementInventoryToBranch(
    transferId: number,
    actor?: InventoryLogActor,
  ) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    const touchedProductIds = new Set<number>();

    for (const detail of transfer.details) {
      const inventorySnapshot = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
      });

      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
        data: {
          onHand: { decrement: detail.receivedQuantity },
        },
      });
      touchedProductIds.add(detail.productId);

      // Ghi thẻ kho đảo chiều NHẬN khi hoàn tác (3→2): trừ đúng số đã nhận.
      // Gộp với dòng TRANSFER_IN +receivedQuantity trước đó sẽ triệt tiêu về 0.
      if (Number(detail.receivedQuantity) > 0) {
        await this.prisma.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.toBranchId,
            branchName: transfer.toBranchName || '',
            transactionType: 'TRANSFER_IN',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: -Number(detail.receivedQuantity),
            costPrice: inventorySnapshot ? Number(inventorySnapshot.cost) : 0,
            transactionPrice: null,
            partnerName: null,
            ...buildInventoryLogBase(actor),
          },
        });
      }
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nhận).
    await recalcOnHandForPairs(
      this.prisma,
      transfer.details.map((d) => ({
        productId: d.productId,
        branchId: transfer.toBranchId,
      })),
    );

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }
  }

  /**
   * Đảm bảo shortage được hoàn về kho chuyển (idempotent).
   *
   * Logic nghiệp vụ: khi kho nhận nhận ít hơn số chuyển, phần chênh lệch
   * (sendQty - receivedQty) vẫn thực tế ở kho chuyển → cộng lại tồn kho
   * kho chuyển. Method này idempotent — chạy nhiều lần vẫn an toàn.
   *
   * Lưu ý: Logic này ĐÃ ĐƯỢC tự động gọi khi transition status 2→3
   * (xem `update()` → `returnShortageToFromBranch`). Method `confirmShortage`
   * này tồn tại để:
   *  - Cho phép frontend force-sync nếu cần (vd sau lỗi mạng).
   *  - Đảm bảo idempotency cho retry từ client.
   *  - Ghi audit log để truy vết.
   */
  async confirmShortage(id: number, _dto: ConfirmShortageDto, userId?: number) {
    const transfer = await this.findOne(id);

    if (transfer.status === 4) {
      throw new BadRequestException('Phiếu chuyển hàng đã bị hủy');
    }
    if (transfer.status !== 3) {
      throw new BadRequestException(
        'Chỉ có thể xác nhận shortage sau khi kho nhận đã nhận hàng (status=3)',
      );
    }

    // Đếm số SP có shortage để ghi audit log
    const shortageCount = transfer.details.filter(
      (d) => Number(d.sendQuantity) > Number(d.receivedQuantity),
    ).length;

    // Fetch người thực hiện sớm để truyền actor xuống returnShortageToFromBranch
    // (truy vết ai hoàn shortage trên thẻ kho).
    const confirmUser = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        })
      : null;
    const confirmLogActor = buildInventoryLogActor(
      userId,
      confirmUser?.name || confirmUser?.email,
    );

    // Gọi lại logic hoàn shortage (idempotent)
    await this.returnShortageToFromBranch(id, confirmLogActor);

    if (userId && shortageCount > 0) {
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'TRANSFER_SHORTAGE_RESOLVE',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: transfer.code,
        category: getCategoryFromActionCode('TRANSFER_SHORTAGE_RESOLVE'),
        severity: getSeverityFromActionCode('TRANSFER_SHORTAGE_RESOLVE'),
        snapshot: this.buildTransferSnapshot(transfer),
        message: renderAuditMessage('TRANSFER_SHORTAGE_RESOLVE', {
          transferCode: transfer.code,
          shortageCount,
        }),
        messageTemplate: 'TRANSFER_SHORTAGE_RESOLVE',
        userId,
        userName: confirmUser?.name || confirmUser?.email || 'System',
        branchId: transfer.fromBranchId,
      });
    }

    return this.findOne(id);
  }

  async cancelTransfer(id: number, dto: CancelTransferDto, userId?: number) {
    const transfer = await this.findOne(id);

    // Fetch người thực hiện sớm để truyền actor vào mọi InventoryLog đảo chiều
    // khi hủy (truy vết ai hoàn/trừ kho khi hủy chuyển hàng).
    const cancelUser = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        })
      : null;
    const cancelLogActor = buildInventoryLogActor(
      userId,
      cancelUser?.name || cancelUser?.email,
    );

    if (transfer.status === 4) {
      throw new BadRequestException('Phiếu chuyển hàng đã bị hủy');
    }

    if (transfer.status === 1) {
      await this.prisma.transfer.update({
        where: { id },
        data: {
          status: 4,
          noteBySource: dto.cancelReason
            ? `${transfer.noteBySource ? transfer.noteBySource + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : transfer.noteBySource,
        },
      });

      // THÊM ĐOẠN NÀY trước return
      if (userId) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'TRANSFER_CANCEL',
          entityType: 'transfers',
          entityId: id.toString(),
          entityCode: transfer.code,
          category: getCategoryFromActionCode('TRANSFER_CANCEL'),
          severity: getSeverityFromActionCode('TRANSFER_CANCEL'),
          snapshot: this.buildTransferSnapshot(transfer),
          message: renderAuditMessage('TRANSFER_CANCEL', {
            transferCode: transfer.code,
            cancelReason: dto.cancelReason || 'Không có lý do',
          }),
          messageTemplate: 'TRANSFER_CANCEL',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: transfer.fromBranchId,
        });
      }

      return { message: 'Hủy phiếu chuyển hàng thành công' };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.transfer.update({
        where: { id },
        data: {
          status: 4,
          noteBySource: dto.cancelReason
            ? `${transfer.noteBySource ? transfer.noteBySource + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : transfer.noteBySource,
        },
      });

      if (transfer.status === 2) {
        for (const detail of transfer.details) {
          // Cộng lại tồn cho chi nhánh chuyển (atomic increment, không overwrite)
          const fromInv = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
          });

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });

          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_CANCEL',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: fromInv ? Number(fromInv.cost) : 0,
              transactionPrice: null,
              partnerName: null,
              ...buildInventoryLogBase(cancelLogActor),
            },
          });
        }
      }

      if (transfer.status === 3) {
        for (const detail of transfer.details) {
          // Cộng lại tồn cho chi nhánh chuyển (atomic increment, không overwrite)
          const fromInv = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
          });

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });

          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_CANCEL',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: fromInv ? Number(fromInv.cost) : 0,
              transactionPrice: null,
              partnerName: null,
              ...buildInventoryLogBase(cancelLogActor),
            },
          });

          // Nếu trước đó shortage đã được resolve (RETURN_TO_SOURCE/WRITE_OFF),
          // cần đảo ngược log hoàn shortage bằng log TRANSFER_CANCEL âm để
          // triệt tiêu về 0. Nếu không: triệt tiêu, tồn kho bị cộng thêm 1 lần.
          const shortage =
            Number(detail.sendQuantity) - Number(detail.receivedQuantity);
          if (shortage > 0) {
            // Tìm log "Hoàn shortage" tương ứng để đảo chiều
            const shortageLog = await tx.inventoryLog.findFirst({
              where: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
                transactionType: 'TRANSFER_OUT',
                refType: 'transfer',
                refId: transfer.id,
                note: { contains: 'Hoàn shortage' },
              },
              orderBy: { id: 'desc' },
            });
            if (shortageLog) {
              // Ghi log đảo chiều (-shortage) với transactionType TRANSFER_CANCEL
              // để cùng refType='transfer' bị loại khi transfer.status=4.
              await tx.inventoryLog.create({
                data: {
                  productId: detail.productId,
                  productCode: detail.productCode,
                  productName: detail.productName,
                  branchId: transfer.fromBranchId,
                  branchName: transfer.fromBranch?.name || '',
                  transactionType: 'TRANSFER_CANCEL',
                  refCode: transfer.code,
                  refType: 'transfer',
                  refId: transfer.id,
                  quantity: -Number(shortageLog.quantity),
                  costPrice: fromInv ? Number(fromInv.cost) : 0,
                  transactionPrice: null,
                  partnerName: null,
                  note: `Đảo chiều Hoàn shortage do hủy phiếu ${transfer.code}`,
                  ...buildInventoryLogBase(cancelLogActor),
                },
              });
            }
          }

          // Nhận dư (received > send): lúc nhận đã trừ thêm surplus khỏi
          // kho chuyển. Hủy phiếu phải đảo chiều log "Trừ surplus" để net
          // về 0 (cùng với TRANSFER_CANCEL +sendQuantity ở trên).
          const surplus =
            Number(detail.receivedQuantity) - Number(detail.sendQuantity);
          if (surplus > 0) {
            const surplusLog = await tx.inventoryLog.findFirst({
              where: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
                transactionType: 'TRANSFER_OUT',
                refType: 'transfer',
                refId: transfer.id,
                note: { contains: 'Trừ surplus' },
              },
              orderBy: { id: 'desc' },
            });
            if (surplusLog) {
              // surplusLog.quantity là âm (-surplus) → đảo chiều = +surplus
              await tx.inventoryLog.create({
                data: {
                  productId: detail.productId,
                  productCode: detail.productCode,
                  productName: detail.productName,
                  branchId: transfer.fromBranchId,
                  branchName: transfer.fromBranch?.name || '',
                  transactionType: 'TRANSFER_CANCEL',
                  refCode: transfer.code,
                  refType: 'transfer',
                  refId: transfer.id,
                  quantity: -Number(surplusLog.quantity),
                  costPrice: fromInv ? Number(fromInv.cost) : 0,
                  transactionPrice: null,
                  partnerName: null,
                  note: `Đảo chiều Trừ surplus do hủy phiếu ${transfer.code}`,
                  ...buildInventoryLogBase(cancelLogActor),
                },
              });
            }
          }

          // Trừ tồn ở chi nhánh nhận đúng số lượng đã nhận thực tế
          // (atomic decrement, không overwrite — cho phép âm vì hệ thống đã chấp nhận tồn âm)
          if (Number(detail.receivedQuantity) > 0) {
            const toInv = await tx.inventory.findUnique({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: transfer.toBranchId,
                },
              },
            });

            await tx.inventory.update({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: transfer.toBranchId,
                },
              },
              data: {
                onHand: { decrement: detail.receivedQuantity },
              },
            });

            await tx.inventoryLog.create({
              data: {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: detail.productName,
                branchId: transfer.toBranchId,
                branchName: transfer.toBranch?.name || '',
                transactionType: 'TRANSFER_CANCEL',
                refCode: transfer.code,
                refType: 'transfer',
                refId: transfer.id,
                quantity: -Number(detail.receivedQuantity),
                costPrice: toInv ? Number(toInv.cost) : 0,
                transactionPrice: null,
                partnerName: null,
                ...buildInventoryLogBase(cancelLogActor),
              },
            });
          }
        }
      }

      // NGUỒN CHÂN LÝ: phiếu đã hủy (status=4) → mọi log transfer thành
      // inactive → recalc loại sạch tác động transfer khỏi cả 2 chi nhánh.
      await recalcOnHandForPairs(tx, [
        ...transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
        ...transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.toBranchId,
        })),
      ]);
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'TRANSFER_CANCEL',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: transfer.code,
        category: getCategoryFromActionCode('TRANSFER_CANCEL'),
        severity: getSeverityFromActionCode('TRANSFER_CANCEL'),
        snapshot: this.buildTransferSnapshot(transfer),
        message: renderAuditMessage('TRANSFER_CANCEL', {
          // ✅ sửa từ hardcode string
          transferCode: transfer.code,
          cancelReason: dto.cancelReason || 'Không có lý do',
        }),
        messageTemplate: 'TRANSFER_CANCEL',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: transfer.fromBranchId,
      });
    }

    return { message: 'Hủy phiếu chuyển hàng thành công' };
  }

  private buildTransferSnapshot(transfer: any) {
    return {
      code: transfer.code,
      status: transfer.status,
      fromBranchId: transfer.fromBranchId,
      fromBranchName: transfer.fromBranchName || transfer.fromBranch?.name,
      toBranchId: transfer.toBranchId,
      toBranchName: transfer.toBranchName || transfer.toBranch?.name,
      totalTransfer: Number(transfer.totalTransfer || 0),
      totalReceive: Number(transfer.totalReceive || 0),
      noteBySource: transfer.noteBySource,
      noteByDestination: transfer.noteByDestination,
      transferredDate: transfer.transferredDate,
      receivedDate: transfer.receivedDate,
      createdByName: transfer.createdByName || transfer.creator?.name,
      details: (transfer.details || []).map((d: any) => ({
        productId: d.productId,
        productCode: d.productCode,
        productName: d.productName,
        sendQuantity: Number(d.sendQuantity),
        receivedQuantity: Number(d.receivedQuantity),
        sendPrice: Number(d.sendPrice),
      })),
    };
  }

  async getPlanningSummary(query: TransferPlanningQueryDto) {
    const {
      search,
      parentNames,
      middleNames,
      childNames,
      cargoType,
      tradeMarkIds,
      quickFilter,
      alertFilter,
      page = 1,
      limit = 25,
      sortBy = 'suggestedQuantity',
      sortDirection = 'desc',
    } = query;

    // 1. Resolve Branch ID cho Hà Nội và Sài Gòn
    const branches = await this.prisma.branch.findMany({
      where: {
        isActive: true,
        name: { in: ['Kho Hà Nội', 'Kho Sài Gòn'] },
      },
      select: { id: true, name: true },
    });

    const hnBranch = branches.find((b) => b.name === 'Kho Hà Nội') || { id: 6 };
    const sgBranch = branches.find((b) => b.name === 'Kho Sài Gòn') || { id: 1 };

    const branchHNId = hnBranch.id;
    const branchSGId = sgBranch.id;

    // 2. Build Prisma Filter cho Product (CHỈ SẢN PHẨM ĐANG HOẠT ĐỘNG)
    const productWhere: any = {
      isActive: true,
    };

    if (search && search.trim()) {
      const matchedIds = await searchProductIds(this.prisma, search.trim());
      productWhere.id = { in: matchedIds.length > 0 ? matchedIds : [-1] };
    }

    if (parentNames && parentNames.length > 0) {
      productWhere.parentName = { in: parentNames };
    }

    if (middleNames && middleNames.length > 0) {
      productWhere.middleName = { in: middleNames };
    }

    if (childNames && childNames.length > 0) {
      productWhere.childName = { in: childNames };
    }

    if (cargoType) {
      productWhere.cargoType = cargoType;
    }

    if (tradeMarkIds && tradeMarkIds.length > 0) {
      productWhere.tradeMarkId = { in: tradeMarkIds };
    }

    // 3. Query toàn bộ sản phẩm thỏa mãn điều kiện
    const activeProducts = await this.prisma.product.findMany({
      where: productWhere,
      select: {
        id: true,
        code: true,
        name: true,
        unit: true,
        conversionValue: true,
        parentName: true,
        middleName: true,
        childName: true,
        cargoType: true,
        tradeMarkId: true,
        tradeMark: { select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    });

    if (activeProducts.length === 0) {
      return {
        data: [],
        total: 0,
        page,
        limit,
        summary: {
          totalSku: 0,
          needTransferSku: 0,
          warningSku: 0,
          totalSuggestedQuantity: 0,
        },
      };
    }

    const productIds = activeProducts.map((p) => p.id);

    // 4. Lấy Tồn kho HN và SG
    const inventories = await this.prisma.inventory.findMany({
      where: {
        productId: { in: productIds },
        branchId: { in: [branchHNId, branchSGId] },
      },
      select: {
        productId: true,
        branchId: true,
        onHand: true,
        reserved: true,
      },
    });

    const stockHNMap = new Map<number, number>();
    const stockSGMap = new Map<number, number>();
    const committedMap = new Map<number, number>();

    for (const inv of inventories) {
      const onHand = Number(inv.onHand || 0);
      const reserved = Number(inv.reserved || 0);

      if (inv.branchId === branchHNId) {
        stockHNMap.set(inv.productId, onHand);
      } else if (inv.branchId === branchSGId) {
        stockSGMap.set(inv.productId, onHand);
        committedMap.set(inv.productId, reserved);
      }
    }

    // 5. Lấy Hàng đang chuyển nội bộ HN → SG (Transfer status = 2 & 3)
    const inTransitDetails = await this.prisma.transferDetail.findMany({
      where: {
        productId: { in: productIds },
        transfer: {
          fromBranchId: branchHNId,
          toBranchId: branchSGId,
          status: { in: [2, 3] },
        },
      },
      select: {
        productId: true,
        sendQuantity: true,
        receivedQuantity: true,
        transfer: { select: { status: true } },
      },
    });

    const inTransitMap = new Map<number, number>();
    for (const d of inTransitDetails) {
      const current = inTransitMap.get(d.productId) || 0;
      const sendQty = Number(d.sendQuantity || 0);
      const recvQty = Number(d.receivedQuantity || 0);
      // TH1 — Status = 2 (Đang chuyển): toàn bộ SL gửi đang trên đường.
      //      KHÔNG trừ receivedQuantity vì bên gửi có thể lưu
      //      receivedQuantity = sendQuantity (dữ liệu bẩn) — chỉ có ý nghĩa
      //      nghiệp vụ ở status = 3 (bug TRF002449).
      // TH2 — Status = 3 (Đã nhận): phần còn thiếu chưa nhận
      //      (send − received) vẫn được tính là đang chuyển; clamp 0 khi
      //      nhận dư (received > send).
      const netInTransit =
        d.transfer.status === 3
          ? Math.max(0, sendQty - recvQty)
          : Math.max(0, sendQty);
      inTransitMap.set(d.productId, current + netInTransit);
    }

    // 6. Lấy Phiếu tạm nội bộ HN → SG (Transfer status = 1 Phiếu tạm)
    const pendingTransferDetails = await this.prisma.transferDetail.findMany({
      where: {
        productId: { in: productIds },
        transfer: {
          fromBranchId: branchHNId,
          toBranchId: branchSGId,
          status: 1,
        },
      },
      select: {
        productId: true,
        sendQuantity: true,
      },
    });

    const pendingTransferMap = new Map<number, number>();
    for (const d of pendingTransferDetails) {
      const current = pendingTransferMap.get(d.productId) || 0;
      pendingTransferMap.set(
        d.productId,
        current + Number(d.sendQuantity || 0),
      );
    }

    // 7. Lấy Đơn hàng khách đã xác nhận tại SG (Order status = PENDING (1) hoặc CONFIRMED (5))
    const confirmedOrderItems = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        productId: { in: productIds },
        order: {
          branchId: branchSGId,
          status: { in: [1, 5] },
        },
      },
      _sum: { quantity: true },
    });

    const confirmedOrdersMap = new Map<number, number>();
    for (const item of confirmedOrderItems) {
      confirmedOrdersMap.set(
        item.productId,
        Number(item._sum.quantity || 0),
      );
    }

    // 8. Lấy Lịch sử bán 5 ngày, 30 ngày, 90 ngày tại Sài Gòn (InvoiceDetail trong 90 ngày)
    const now = new Date();
    const windowStart = new Date(now.getTime() - 90 * 86400000);
    const day5Start = new Date(now.getTime() - 5 * 86400000);
    const day30Start = new Date(now.getTime() - 30 * 86400000);

    const invoiceDetails = await this.prisma.invoiceDetail.findMany({
      where: {
        productId: { in: productIds },
        isGift: false,
        invoice: {
          branchId: branchSGId,
          status: { not: 2 }, // Không lấy hóa đơn đã hủy
          purchaseDate: { gte: windowStart },
        },
      },
      select: {
        productId: true,
        quantity: true,
        invoice: { select: { purchaseDate: true } },
      },
    });

    const sales5Map = new Map<number, number>();
    const sales30Map = new Map<number, number>();
    const sales90Map = new Map<number, number>();

    for (const d of invoiceDetails) {
      const pid = d.productId;
      const qty = Number(d.quantity || 0);
      const pDate = d.invoice?.purchaseDate;
      if (pid === null) continue;

      sales90Map.set(pid, (sales90Map.get(pid) || 0) + qty);

      if (pDate && pDate >= day30Start) {
        sales30Map.set(pid, (sales30Map.get(pid) || 0) + qty);
      }

      if (pDate && pDate >= day5Start) {
        sales5Map.set(pid, (sales5Map.get(pid) || 0) + qty);
      }
    }

    // 9. Tính toán các chỉ số cho từng sản phẩm
    const allCalculatedItems = activeProducts.map((p) => {
      const stockHN = stockHNMap.get(p.id) || 0;
      const stockSG = stockSGMap.get(p.id) || 0;
      const committed = committedMap.get(p.id) || 0;
      const inTransit = inTransitMap.get(p.id) || 0;
      const pendingTransfer = pendingTransferMap.get(p.id) || 0;
      const confirmedOrders = confirmedOrdersMap.get(p.id) || 0;

      const sales5 = sales5Map.get(p.id) || 0;
      const sales30 = sales30Map.get(p.id) || 0;
      const sales90 = sales90Map.get(p.id) || 0;

      const avg5PerDay = sales5 / 5;
      const avg30PerDay = sales30 / 30;
      const avg90PerDay = sales90 / 90;

      const demandPerDay =
        0.6 * avg5PerDay + 0.3 * avg30PerDay + 0.1 * avg90PerDay;
      const safetyStock = demandPerDay * 2;
      const transferPoint = safetyStock + demandPerDay * 5;
      const availableStockSG = stockSG + inTransit - committed;
      const targetStockSG = safetyStock + demandPerDay * 7;
      const suggestedQuantity = Math.round(
        Math.max(0, targetStockSG - availableStockSG),
      );

      let alert: 'DARK_RED' | 'RED' | 'YELLOW' | 'GREEN' = 'GREEN';
      let alertLabel = 'Đủ hàng';
      let alertReason = 'Đủ hàng';

      if (confirmedOrders > availableStockSG) {
        alert = 'DARK_RED';
        alertLabel = 'CHUYỂN GẤP';
        alertReason = 'Đơn hàng xác nhận > tồn khả dụng';
      } else if (availableStockSG <= transferPoint && suggestedQuantity > 0) {
        alert = 'RED';
        alertLabel = 'Cần điều chuyển';
        alertReason = 'Tồn khả dụng ≤ điểm điều chuyển';
      } else if (availableStockSG <= targetStockSG && suggestedQuantity > 0) {
        alert = 'YELLOW';
        alertLabel = 'Cần xem xét';
        alertReason = 'Cần xem xét';
      } else {
        alert = 'GREEN';
        alertLabel = 'Đủ hàng';
        alertReason = 'Đủ hàng';
      }

      return {
        id: p.id,
        sku: p.code,
        name: p.name,
        unit: p.unit || 'Cái',
        packSize: (() => {
          const cv = Number(p.conversionValue);
          return Number.isInteger(cv) && cv > 0 ? cv : 1;
        })(),
        parentName: p.parentName,
        middleName: p.middleName,
        childName: p.childName,
        cargoType: p.cargoType,
        trademarkId: p.tradeMarkId,
        trademarkName: p.tradeMark?.name,
        stockHN,
        stockSG,
        inTransit,
        pendingTransfer,
        committed,
        confirmedOrders,
        sales5,
        sales30,
        sales90,
        computed: {
          avg5PerDay,
          avg30PerDay,
          avg90PerDay,
          demandPerDay,
          safetyStock,
          transferPoint,
          availableStockSG,
          targetStockSG,
          suggestedQuantity,
          alert,
          alertLabel,
          alertReason,
        },
      };
    });

    // 10. Lọc Client/Filter bổ sung (quickFilter & alertFilter)
    let filtered = allCalculatedItems;

    if (quickFilter && quickFilter !== 'ALL') {
      switch (quickFilter) {
        case 'NEED_TRANSFER':
          filtered = filtered.filter((i) => i.computed.suggestedQuantity > 0);
          break;
        case 'NO_TRANSFER':
          filtered = filtered.filter(
            (i) => i.computed.suggestedQuantity === 0,
          );
          break;
        case 'HAS_CONFIRMED_ORDERS':
          filtered = filtered.filter((i) => i.confirmedOrders > 0);
          break;
      }
    }

    if (alertFilter && alertFilter !== 'ALL') {
      filtered = filtered.filter((i) => i.computed.alert === alertFilter);
    }

    // 11. Sắp xếp (Sorting)
    const dir = sortDirection === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      let valA: any = (a as any)[sortBy];
      let valB: any = (b as any)[sortBy];

      if (valA === undefined) valA = (a.computed as any)[sortBy];
      if (valB === undefined) valB = (b.computed as any)[sortBy];

      if (typeof valA === 'string') {
        return dir * valA.localeCompare(valB ?? '', 'vi');
      }
      return dir * ((Number(valA) || 0) - (Number(valB) || 0));
    });

    // 12. Tính Summary
    const totalSku = allCalculatedItems.length;
    const needTransferSku = allCalculatedItems.filter(
      (i) => i.computed.suggestedQuantity > 0,
    ).length;
    const warningSku = allCalculatedItems.filter(
      (i) => i.computed.alert === 'RED' || i.computed.alert === 'DARK_RED',
    ).length;
    const totalSuggestedQuantity = allCalculatedItems.reduce(
      (sum, i) => sum + i.computed.suggestedQuantity,
      0,
    );

    // 13. Phân trang (Pagination)
    const startIndex = (page - 1) * limit;
    const paginatedData = filtered.slice(startIndex, startIndex + limit);

    return {
      data: paginatedData,
      total: filtered.length,
      page,
      limit,
      summary: {
        totalSku,
        needTransferSku,
        warningSku,
        totalSuggestedQuantity,
      },
    };
  }

  /**
   * Trả về danh sách các phiếu chuyển kho nội bộ HN → SG cho một sản phẩm,
   * phân loại theo trạng thái. Reuse cùng business rule với getPlanningSummary
   * để đảm bảo SUM(quantity) khớp chính xác item.inTransit / item.pendingTransfer.
   *
   * @param productId id sản phẩm
   * @param status 1 = Phiếu tạm, 2 = Đang chuyển (gồm cả Đã nhận một phần)
   */
  async getTransfersByProductForPlanning(productId: number, status: number) {
    const branchHNId = 6;
    const branchSGId = 1;

    const STATUS_LABEL: Record<number, string> = {
      1: 'Phiếu tạm',
      2: 'Đang chuyển',
      3: 'Đã nhận',
      4: 'Đã hủy',
    };

    // status = 2 (Đang chuyển) bao gồm cả phiếu status = 3 (Đã nhận) còn thiếu
    // hàng (partial receiving) — khớp logic getPlanningSummary.
    const statuses = status === 2 ? [2, 3] : [status];

    const details = await this.prisma.transferDetail.findMany({
      where: {
        productId,
        transfer: {
          fromBranchId: branchHNId,
          toBranchId: branchSGId,
          status: { in: statuses },
        },
      },
      select: {
        sendQuantity: true,
        receivedQuantity: true,
        transfer: {
          select: {
            id: true,
            code: true,
            fromBranchName: true,
            toBranchName: true,
            transferredDate: true,
            createdAt: true,
            status: true,
          },
        },
      },
      orderBy: {
        transfer: { createdAt: 'desc' },
      },
    });

    const data = details.map((d) => {
      const sendQty = Number(d.sendQuantity || 0);
      const recvQty = Number(d.receivedQuantity || 0);
      // Cùng logic getPlanningSummary:
      //   status = 3 (Đã nhận) → phần còn thiếu = max(0, send − received)
      //   status = 1/2        → toàn bộ SL gửi (chưa nhận / đang trên đường)
      const quantity =
        d.transfer.status === 3
          ? Math.max(0, sendQty - recvQty)
          : Math.max(0, sendQty);
      return {
        transferId: d.transfer.id,
        code: d.transfer.code,
        fromBranchName: d.transfer.fromBranchName,
        toBranchName: d.transfer.toBranchName,
        transferredDate: d.transfer.transferredDate?.toISOString() ?? null,
        createdAt: d.transfer.createdAt.toISOString(),
        sendQuantity: sendQty,
        receivedQuantity: recvQty,
        quantity,
        status: d.transfer.status,
        statusLabel: STATUS_LABEL[d.transfer.status] || 'Không xác định',
      };
    });

    const sumQuantity = data.reduce((sum, r) => sum + r.quantity, 0);

    return { data, total: data.length, sumQuantity };
  }
}
