import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockConditionTransferDto } from './dto/create-stock-condition-transfer.dto';
import { StockConditionTransferQueryDto } from './dto/stock-condition-transfer-query.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import {
  recalcConditionBuckets,
  computeBucketTotals,
  BUCKET_NEAR_EXPIRY,
} from '../common/stock-condition-onhand.util';

// Trạng thái phiếu: 1=Chờ duyệt, 2=Đã duyệt, 3=Đã hủy
export const CLT_STATUS = {
  PENDING: 1,
  APPROVED: 2,
  CANCELLED: 3,
} as const;

const BUCKET_LABEL: Record<string, string> = {
  DAMAGED: 'Bục rách (loại B)',
  NEAR_EXPIRY: 'Cận date',
  PROMO: 'Khuyến mãi',
};

const INCLUDE_FULL = {
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  details: {
    include: {
      product: { select: { id: true, code: true, name: true, unit: true } },
    },
  },
};

@Injectable()
export class StockConditionTransfersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  private statusLabel(s: number): string {
    if (s === CLT_STATUS.CANCELLED) return 'Đã hủy';
    if (s === CLT_STATUS.APPROVED) return 'Đã duyệt';
    return 'Chờ duyệt';
  }

  private buildSnapshot(t: any) {
    return {
      code: t.code,
      branchName: t.branchName || t.branch?.name || null,
      transferDate: t.transferDate,
      status: this.statusLabel(t.status),
      note: t.note,
      createdByName: t.createdByName || t.creator?.name || null,
      approvedByName: t.approvedByName || t.approver?.name || null,
      details: (t.details || []).map((d: any) => ({
        productCode: d.productCode || d.product?.code,
        productName: d.productName || d.product?.name,
        toBucket: d.toBucket,
        quantity: Number(d.quantity ?? 0),
        expiryDate: d.expiryDate,
      })),
    };
  }

  private buildWhere(query: StockConditionTransferQueryDto): any {
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

    if (query.status) where.status = +query.status;
    if (query.creatorId) where.createdById = +query.creatorId;

    if (query.toBucket || query.productId) {
      where.details = { some: {} };
      if (query.toBucket) where.details.some.toBucket = query.toBucket;
      if (query.productId) where.details.some.productId = +query.productId;
    }

    if (query.fromDate || query.toDate) {
      where.transferDate = {};
      if (query.fromDate) where.transferDate.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.transferDate.lte = to;
      }
    }

    return where;
  }

  async findAll(query: StockConditionTransferQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;
    const where = this.buildWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.stockConditionTransfer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: INCLUDE_FULL,
      }),
      this.prisma.stockConditionTransfer.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const record = await this.prisma.stockConditionTransfer.findUnique({
      where: { id },
      include: INCLUDE_FULL,
    });
    if (!record) throw new NotFoundException('Phiếu chuyển loại tồn không tồn tại');
    return record;
  }

  async create(dto: CreateStockConditionTransferDto, userId: number) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Phiếu phải có ít nhất 1 sản phẩm');
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

    // Validate từng dòng: NEAR_EXPIRY bắt buộc có expiryDate.
    for (const item of dto.items) {
      if (item.toBucket === BUCKET_NEAR_EXPIRY && !item.expiryDate) {
        throw new BadRequestException(
          'Hàng cận date phải khai báo hạn dùng (expiryDate)',
        );
      }
      if (item.quantity <= 0) {
        throw new BadRequestException('Số lượng chuyển phải lớn hơn 0');
      }
    }

    const uniqueIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, code: true, name: true, unit: true },
    });
    if (products.length !== uniqueIds.length) {
      throw new BadRequestException('Một số sản phẩm không tồn tại');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const inventories = await this.prisma.inventory.findMany({
      where: { productId: { in: uniqueIds }, branchId: dto.branchId },
    });
    const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

    // Validate: tổng SL chuyển vào bucket cho mỗi sản phẩm không vượt "hàng tốt"
    // hiện có = onHand − (damaged + nearExpiry + promo). Chỉ chuyển từ hàng tốt.
    const totalToBucketByProduct = new Map<number, number>();
    for (const item of dto.items) {
      totalToBucketByProduct.set(
        item.productId,
        (totalToBucketByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
    for (const [productId, totalMove] of totalToBucketByProduct.entries()) {
      const inv = invMap.get(productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const usedBuckets = inv
        ? Number(inv.damagedQuantity) +
          Number(inv.nearExpiryQuantity) +
          Number(inv.promoQuantity)
        : 0;
      const available = onHand - usedBuckets;
      if (totalMove > available) {
        const p = productMap.get(productId);
        throw new BadRequestException(
          `${p?.name}: Số lượng chuyển (${totalMove}) vượt quá hàng tốt khả dụng (${available}). Tồn tổng ${onHand}, đã phân loại ${usedBuckets}.`,
        );
      }
    }

    const code = await this.generateCode();
    const transferDate = dto.transferDate
      ? new Date(dto.transferDate)
      : new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockConditionTransfer.create({
        data: {
          code,
          branchId: branch.id,
          branchName: branch.name,
          status: CLT_STATUS.PENDING,
          transferDate,
          note: dto.note || null,
          createdById: user.id,
          createdByName: user.name,
          details: {
            createMany: {
              data: dto.items.map((item) => {
                const p = productMap.get(item.productId)!;
                const inv = invMap.get(item.productId);
                return {
                  productId: item.productId,
                  productCode: p.code,
                  productName: p.name,
                  unit: p.unit || null,
                  toBucket: item.toBucket,
                  quantity: item.quantity,
                  expiryDate: item.expiryDate
                    ? new Date(item.expiryDate)
                    : null,
                  currentOnHand: inv ? Number(inv.onHand) : 0,
                  costAtTransfer: inv ? Number(inv.cost) : 0,
                  note: item.note || null,
                };
              }),
            },
          },
        },
      });

      return tx.stockConditionTransfer.findUnique({
        where: { id: transfer.id },
        include: INCLUDE_FULL,
      });
    });

    if (created) {
      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'STOCK_CONDITION_TRANSFER_CREATE',
        entityType: 'stock_condition_transfers',
        entityId: created.id.toString(),
        entityCode: created.code,
        category: getCategoryFromActionCode('STOCK_CONDITION_TRANSFER_CREATE'),
        severity: getSeverityFromActionCode('STOCK_CONDITION_TRANSFER_CREATE'),
        snapshot: this.buildSnapshot(created),
        message: renderAuditMessage('STOCK_CONDITION_TRANSFER_CREATE', {
          code: created.code,
          branchName: branch.name,
          productCount: dto.items.length,
        }),
        messageTemplate: 'STOCK_CONDITION_TRANSFER_CREATE',
        userId: user.id,
        userName: user.name,
        branchId: branch.id,
      });
    }

    return created;
  }

  // Duyệt phiếu (Chờ duyệt → Đã duyệt): ghi sổ cái CLT_IN + recalc bucket cache.
  async approve(id: number, userId: number) {
    const transfer = await this.prisma.stockConditionTransfer.findUnique({
      where: { id },
      include: { details: true },
    });
    if (!transfer) throw new NotFoundException('Phiếu không tồn tại');
    if (transfer.status === CLT_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã bị hủy, không thể duyệt');
    }
    if (transfer.status === CLT_STATUS.APPROVED) {
      throw new BadRequestException('Phiếu đã được duyệt trước đó');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });

    // Re-validate tại thời điểm duyệt: tổng bucket sau khi cộng thêm không vượt onHand.
    const productIds = [...new Set(transfer.details.map((d) => d.productId))];
    const inventories = await this.prisma.inventory.findMany({
      where: { productId: { in: productIds }, branchId: transfer.branchId },
    });
    const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

    const addByProduct = new Map<number, number>();
    for (const d of transfer.details) {
      addByProduct.set(
        d.productId,
        (addByProduct.get(d.productId) ?? 0) + Number(d.quantity),
      );
    }
    for (const [productId, add] of addByProduct.entries()) {
      const inv = invMap.get(productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const usedBuckets = inv
        ? Number(inv.damagedQuantity) +
          Number(inv.nearExpiryQuantity) +
          Number(inv.promoQuantity)
        : 0;
      if (usedBuckets + add > onHand) {
        const d = transfer.details.find((x) => x.productId === productId);
        throw new BadRequestException(
          `${d?.productName}: Không đủ hàng tốt để duyệt. Tồn tổng ${onHand}, đã phân loại ${usedBuckets}, cần thêm ${add}.`,
        );
      }
    }

    const approved = await this.prisma.$transaction(async (tx) => {
      const transactionDate = transfer.transferDate ?? new Date();

      for (const detail of transfer.details) {
        await tx.stockConditionLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.branchId,
            branchName: transfer.branchName,
            bucket: detail.toBucket,
            transactionType: 'CLT_IN',
            refCode: transfer.code,
            refType: 'clt',
            refId: transfer.id,
            quantity: Number(detail.quantity), // + vào bucket
            expiryDate: detail.expiryDate,
            costPrice: Number(detail.costAtTransfer),
            transactionDate,
            note: `Chuyển sang ${BUCKET_LABEL[detail.toBucket] || detail.toBucket}`,
            createdByName: user?.name || transfer.createdByName,
          },
        });

        await recalcConditionBuckets(tx, detail.productId, transfer.branchId);
      }

      await tx.stockConditionTransfer.update({
        where: { id },
        data: {
          status: CLT_STATUS.APPROVED,
          approvedById: userId,
          approvedByName: user?.name || null,
          approvedAt: new Date(),
        },
      });

      return tx.stockConditionTransfer.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'STOCK_CONDITION_TRANSFER_APPROVE',
      entityType: 'stock_condition_transfers',
      entityId: id.toString(),
      entityCode: transfer.code,
      category: getCategoryFromActionCode('STOCK_CONDITION_TRANSFER_APPROVE'),
      severity: getSeverityFromActionCode('STOCK_CONDITION_TRANSFER_APPROVE'),
      snapshot: this.buildSnapshot(approved),
      message: renderAuditMessage('STOCK_CONDITION_TRANSFER_APPROVE', {
        code: transfer.code,
      }),
      messageTemplate: 'STOCK_CONDITION_TRANSFER_APPROVE',
      userId: userId || transfer.createdById || 1,
      userName: user?.name || transfer.createdByName || 'System',
      branchId: transfer.branchId,
    });

    return approved;
  }

  // Hủy phiếu. Nếu đã duyệt: đổi status=3 (sổ cái tự loại các log của phiếu này
  // qua active-finder 'clt' vì chỉ status=2 mới active) rồi recalc bucket cache.
  async cancel(id: number, userId?: number) {
    const transfer = await this.prisma.stockConditionTransfer.findUnique({
      where: { id },
      include: { details: true },
    });
    if (!transfer) throw new NotFoundException('Phiếu không tồn tại');
    if (transfer.status === CLT_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã bị hủy trước đó');
    }

    const wasApproved = transfer.status === CLT_STATUS.APPROVED;

    const cancelled = await this.prisma.$transaction(async (tx) => {
      // Đổi status TRƯỚC để active-finder loại toàn bộ log CLT_IN của phiếu này.
      await tx.stockConditionTransfer.update({
        where: { id },
        data: { status: CLT_STATUS.CANCELLED },
      });

      if (wasApproved) {
        // Ghi dòng đảo để lưu vết trên thẻ kho (không ảnh hưởng tổng vì log gốc
        // đã bị loại), sau đó recalc cache. Validate không âm.
        const transactionDate = new Date();
        for (const detail of transfer.details) {
          await tx.stockConditionLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.branchId,
              branchName: transfer.branchName,
              bucket: detail.toBucket,
              transactionType: 'CLT_CANCEL',
              refCode: transfer.code,
              refType: 'clt',
              refId: transfer.id,
              quantity: -Number(detail.quantity),
              expiryDate: detail.expiryDate,
              costPrice: Number(detail.costAtTransfer),
              transactionDate,
              note: `Hủy chuyển ${BUCKET_LABEL[detail.toBucket] || detail.toBucket}`,
              createdByName: transfer.createdByName,
            },
          });

          const totals = await computeBucketTotals(
            tx,
            detail.productId,
            transfer.branchId,
          );
          if (
            totals.damaged < 0 ||
            totals.nearExpiry < 0 ||
            totals.promo < 0
          ) {
            throw new BadRequestException(
              `Không thể hủy: ${detail.productName} đã được bán/xuất từ loại tồn này sau khi duyệt. Hủy sẽ làm tồn loại tồn âm.`,
            );
          }
          await recalcConditionBuckets(tx, detail.productId, transfer.branchId);
        }
      }

      return tx.stockConditionTransfer.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });

    if (!cancelled) throw new NotFoundException('Phiếu không tồn tại');

    const actor = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, email: true },
        })
      : null;

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'STOCK_CONDITION_TRANSFER_CANCEL',
      entityType: 'stock_condition_transfers',
      entityId: id.toString(),
      entityCode: cancelled.code,
      category: getCategoryFromActionCode('STOCK_CONDITION_TRANSFER_CANCEL'),
      severity: getSeverityFromActionCode('STOCK_CONDITION_TRANSFER_CANCEL'),
      snapshot: this.buildSnapshot(cancelled),
      message: renderAuditMessage('STOCK_CONDITION_TRANSFER_CANCEL', {
        code: cancelled.code,
      }),
      messageTemplate: 'STOCK_CONDITION_TRANSFER_CANCEL',
      userId: userId || transfer.createdById || 1,
      userName: actor?.name || actor?.email || transfer.createdByName || 'System',
      branchId: transfer.branchId,
    });

    return cancelled;
  }

  async exportTransfers(
    query: StockConditionTransferQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildWhere(query);
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chuyển loại tồn');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Người duyệt', key: 'approvedBy', width: 20 },
      { header: 'Ngày', key: 'transferDate', width: 20 },
      { header: 'Số sản phẩm', key: 'totalGoods', width: 12 },
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
      const batch = await this.prisma.stockConditionTransfer.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          approver: { select: { name: true } },
          details: { select: { id: true } },
        },
      });
      if (batch.length === 0) break;
      for (const t of batch) {
        const row = sheet.addRow({
          code: t.code,
          branch: t.branchName || t.branch?.name || '',
          createdBy: t.createdByName || t.creator?.name || '',
          approvedBy: t.approvedByName || t.approver?.name || '',
          transferDate: fmtDateTime(t.transferDate),
          totalGoods: t.details.length,
          note: t.note || '',
          status: this.statusLabel(t.status),
        });
        row.commit();
      }
      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  private async generateCode(): Promise<string> {
    const prefix = 'CLT';
    const last = await this.prisma.stockConditionTransfer.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let nextId = last
      ? parseInt(last.code.replace(prefix, ''), 10) + 1
      : 1;
    let code = `${prefix}${String(nextId).padStart(6, '0')}`;
    // Đảm bảo không đụng mã đã tồn tại (an toàn trước dữ liệu lệch).
    while (
      await this.prisma.stockConditionTransfer.findUnique({ where: { code } })
    ) {
      nextId += 1;
      code = `${prefix}${String(nextId).padStart(6, '0')}`;
    }
    return code;
  }
}
