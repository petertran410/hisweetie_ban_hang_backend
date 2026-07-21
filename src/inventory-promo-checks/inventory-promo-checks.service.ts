import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInventoryPromoCheckDto } from './dto/create-inventory-promo-check.dto';
import { InventoryPromoCheckQueryDto } from './dto/inventory-promo-check-query.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class InventoryPromoChecksService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  private buildSnapshot(check: any) {
    return {
      code: check.code,
      branchName: check.branchName || check.branch?.name || null,
      checkDate: check.checkDate,
      status: check.status === 2 ? 'Đã hủy' : 'Hoàn thành',
      note: check.note,
      createdByName: check.createdByName || check.creator?.name || null,
      details: (check.details || []).map((d: any) => ({
        productCode: d.productCode || d.product?.code,
        productName: d.productName || d.product?.name,
        currentOnHand: Number(d.currentOnHand ?? 0),
        previousPromoQuantity: Number(d.previousPromoQuantity ?? 0),
        promoQuantity: Number(d.promoQuantity ?? 0),
      })),
    };
  }

  private buildWhere(query: InventoryPromoCheckQueryDto): any {
    const branchId = query.branchId ? +query.branchId : undefined;
    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { createdByName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.branchIds) {
      const ids = query.branchIds
        .split(',')
        .map((id) => +id)
        .filter(Boolean);
      if (ids.length > 0) where.branchId = { in: ids };
    } else if (branchId) {
      where.branchId = branchId;
    }

    if (query.creatorId) {
      where.createdById = +query.creatorId;
    }
    if (query.productId) {
      where.details = { some: { productId: +query.productId } };
    }

    if (query.fromDate || query.toDate) {
      where.checkDate = {};
      if (query.fromDate) where.checkDate.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.checkDate.lte = to;
      }
    }

    return where;
  }

  async findAll(query: InventoryPromoCheckQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;
    const where = this.buildWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: { id: true, code: true, name: true, unit: true },
              },
            },
          },
        },
      }),
      this.prisma.inventoryPromoCheck.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async exportInventoryPromoChecks(
    query: InventoryPromoCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildWhere(query);
    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Kiểm hàng khuyến mãi');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Số sản phẩm', key: 'totalGoods', width: 12 },
      { header: 'Tổng SL KM', key: 'totalPromo', width: 14 },
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
      const batch = await this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: { select: { promoQuantity: true } },
        },
      });
      if (batch.length === 0) break;

      for (const c of batch) {
        const totalPromo = c.details.reduce(
          (s, d) => s + Number(d.promoQuantity),
          0,
        );
        sheet
          .addRow({
            code: c.code,
            branch: c.branchName || c.branch?.name || '',
            createdBy: c.createdByName || c.creator?.name || '',
            checkDate: fmtDateTime(c.checkDate),
            createdAt: fmtDateTime(c.createdAt),
            totalGoods: c.details.length,
            totalPromo,
            note: c.note || '',
            status: statusLabel(c.status),
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async exportInventoryPromoChecksDetail(
    query: InventoryPromoCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildWhere(query);
    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết kiểm hàng KM');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'Tồn hiện tại', key: 'currentOnHand', width: 14 },
      { header: 'Loại B', key: 'currentDamaged', width: 12 },
      { header: 'Cận date', key: 'currentNearExpiry', width: 12 },
      { header: 'KM trước', key: 'previousPromoQuantity', width: 12 },
      { header: 'SL KM', key: 'promoQuantity', width: 12 },
      { header: 'Ghi chú', key: 'note', width: 30 },
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
      const batch = await this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });
      if (batch.length === 0) break;

      for (const c of batch) {
        const base = {
          code: c.code,
          branch: c.branchName || c.branch?.name || '',
          createdBy: c.createdByName || c.creator?.name || '',
          checkDate: fmtDateTime(c.checkDate),
          status: statusLabel(c.status),
        };

        if (!c.details.length) {
          sheet
            .addRow({
              ...base,
              productCode: '',
              productName: '',
              currentOnHand: 0,
              currentDamaged: 0,
              currentNearExpiry: 0,
              previousPromoQuantity: 0,
              promoQuantity: 0,
              note: '',
            })
            .commit();
          continue;
        }

        for (const d of c.details) {
          sheet
            .addRow({
              ...base,
              productCode: d.productCode || '',
              productName: d.productName || '',
              currentOnHand: Number(d.currentOnHand) || 0,
              currentDamaged: Number(d.currentDamaged) || 0,
              currentNearExpiry: Number(d.currentNearExpiry) || 0,
              previousPromoQuantity: Number(d.previousPromoQuantity) || 0,
              promoQuantity: Number(d.promoQuantity) || 0,
              note: d.note || '',
            })
            .commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const record = await this.prisma.inventoryPromoCheck.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        details: {
          include: {
            product: {
              select: { id: true, code: true, name: true, unit: true },
            },
          },
        },
      },
    });

    if (!record) throw new NotFoundException('Phiếu kiểm KM không tồn tại');
    return record;
  }

  async create(dto: CreateInventoryPromoCheckDto, userId: number) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Phiếu kiểm phải có ít nhất 1 sản phẩm');
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true, name: true },
    });
    if (!branch) throw new BadRequestException('Chi nhánh không tồn tại');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    const productIds = dto.items.map((i) => i.productId);
    const uniqueIds = [...new Set(productIds)];
    if (uniqueIds.length !== productIds.length) {
      throw new BadRequestException('Sản phẩm bị trùng trong phiếu kiểm');
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, code: true, name: true },
    });
    if (products.length !== uniqueIds.length) {
      throw new BadRequestException('Một số sản phẩm không tồn tại');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const inventories = await this.prisma.inventory.findMany({
      where: { productId: { in: uniqueIds }, branchId: dto.branchId },
    });
    const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

    // Validate: promoQuantity <= onHand - damaged - nearExpiry
    for (const item of dto.items) {
      const inv = invMap.get(item.productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const damaged = inv ? Number(inv.damagedQuantity || 0) : 0;
      const nearExpiry = inv ? Number(inv.nearExpiryQuantity || 0) : 0;
      const available = onHand - damaged - nearExpiry;
      if (item.promoQuantity > available) {
        const product = productMap.get(item.productId);
        throw new BadRequestException(
          `${product?.name}: SL khuyến mãi (${item.promoQuantity}) vượt quá hàng khả dụng (${available} = tồn ${onHand} − loại B ${damaged} − cận date ${nearExpiry})`,
        );
      }
    }

    const code = await this.generateCode();

    const created = await this.prisma.$transaction(async (tx) => {
      const check = await tx.inventoryPromoCheck.create({
        data: {
          code,
          branchId: branch.id,
          branchName: branch.name,
          checkDate: new Date(),
          note: dto.note || null,
          createdById: user.id,
          createdByName: user.name,
          details: {
            createMany: {
              data: dto.items.map((item) => {
                const product = productMap.get(item.productId)!;
                const inv = invMap.get(item.productId);
                return {
                  productId: item.productId,
                  productCode: product.code,
                  productName: product.name,
                  currentOnHand: inv ? Number(inv.onHand) : 0,
                  currentDamaged: inv ? Number(inv.damagedQuantity || 0) : 0,
                  currentNearExpiry: inv
                    ? Number(inv.nearExpiryQuantity || 0)
                    : 0,
                  previousPromoQuantity: inv
                    ? Number(inv.promoQuantity || 0)
                    : 0,
                  promoQuantity: item.promoQuantity,
                  note: item.note || null,
                };
              }),
            },
          },
        },
      });

      for (const item of dto.items) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: dto.branchId },
          data: { promoQuantity: item.promoQuantity },
        });
      }

      return tx.inventoryPromoCheck.findUnique({
        where: { id: check.id },
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: { id: true, code: true, name: true, unit: true },
              },
            },
          },
        },
      });
    });

    if (created) {
      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVENTORY_PROMO_CHECK_CREATE',
        entityType: 'inventory_promo_checks',
        entityId: created.id.toString(),
        entityCode: created.code,
        category: getCategoryFromActionCode('INVENTORY_PROMO_CHECK_CREATE'),
        severity: getSeverityFromActionCode('INVENTORY_PROMO_CHECK_CREATE'),
        snapshot: this.buildSnapshot(created),
        message: renderAuditMessage('INVENTORY_PROMO_CHECK_CREATE', {
          checkCode: created.code,
          branchName: branch.name,
          productCount: dto.items.length,
        }),
        messageTemplate: 'INVENTORY_PROMO_CHECK_CREATE',
        userId: user.id,
        userName: user.name,
        branchId: branch.id,
      });
    }

    return created;
  }

  async cancel(id: number, userId?: number) {
    const check = await this.prisma.inventoryPromoCheck.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!check) throw new NotFoundException('Phiếu kiểm KM không tồn tại');
    if (check.status === 2) {
      throw new BadRequestException('Phiếu kiểm đã bị hủy trước đó');
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      for (const detail of check.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: check.branchId,
            },
          },
        });
        if (!inventory) continue;

        // Rollback theo delta; cho phép âm (xuất vượt vẫn hợp lệ)
        const delta =
          Number(detail.promoQuantity) - Number(detail.previousPromoQuantity);
        const newPromo = Number(inventory.promoQuantity || 0) - delta;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: check.branchId,
            },
          },
          data: { promoQuantity: newPromo },
        });
      }

      return tx.inventoryPromoCheck.update({
        where: { id },
        data: { status: 2 },
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: { id: true, code: true, name: true, unit: true },
              },
            },
          },
        },
      });
    });

    const actor = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, email: true },
        })
      : null;

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INVENTORY_PROMO_CHECK_CANCEL',
      entityType: 'inventory_promo_checks',
      entityId: id.toString(),
      entityCode: cancelled.code,
      category: getCategoryFromActionCode('INVENTORY_PROMO_CHECK_CANCEL'),
      severity: getSeverityFromActionCode('INVENTORY_PROMO_CHECK_CANCEL'),
      snapshot: this.buildSnapshot(cancelled),
      message: renderAuditMessage('INVENTORY_PROMO_CHECK_CANCEL', {
        checkCode: cancelled.code,
      }),
      messageTemplate: 'INVENTORY_PROMO_CHECK_CANCEL',
      userId: userId || check.createdById || 1,
      userName: actor?.name || actor?.email || check.createdByName || 'System',
      branchId: check.branchId,
    });

    return cancelled;
  }

  private async generateCode(): Promise<string> {
    const last = await this.prisma.inventoryPromoCheck.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });
    const nextId = last ? parseInt(last.code.replace('KKM', ''), 10) + 1 : 1;
    return `KKM${String(nextId).padStart(6, '0')}`;
  }
}
