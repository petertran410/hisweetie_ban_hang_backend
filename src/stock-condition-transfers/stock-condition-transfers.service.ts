import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockConditionTransferDto } from './dto/create-stock-condition-transfer.dto';
import { UpdateStockConditionTransferDto } from './dto/update-stock-condition-transfer.dto';
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
  computeBucketTotalsBatch,
  computeNearExpiryLots,
  BUCKET_NEAR_EXPIRY,
  BUCKET_DAMAGED,
} from '../common/stock-condition-onhand.util';
import { getActiveLogKeys, isLogActive } from '../common/inventory-onhand.util';

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
    if (!record)
      throw new NotFoundException('Phiếu chuyển loại tồn không tồn tại');
    return record;
  }

  async previewBalances(
    branchId: number,
    transferDate: string,
    items: Array<{
      productId: number;
      toBucket: string;
      expiryDate?: string | null;
    }>,
  ) {
    const at = new Date(transferDate);
    if (!branchId || Number.isNaN(at.getTime())) {
      throw new BadRequestException(
        'Chi nhánh hoặc thời điểm điều chỉnh không hợp lệ',
      );
    }

    const uniqueProductIds = [...new Set(items.map((item) => item.productId))];
    if (uniqueProductIds.length === 0) return {};

    // Chỉ cộng log của chứng từ còn hiệu lực phát sinh TRƯỚC thời điểm chọn.
    // Đây là "Tồn cuối trước thời điểm"; giao dịch đúng bằng thời điểm phiếu
    // mới sẽ được ghi sau số dư này.
    const logs = await this.prisma.stockConditionLog.findMany({
      where: {
        branchId,
        productId: { in: uniqueProductIds },
        transactionDate: { lt: at },
      },
      select: {
        productId: true,
        bucket: true,
        quantity: true,
        expiryDate: true,
        refType: true,
        refId: true,
      },
    });
    const activeKeys = await getActiveLogKeys(this.prisma, logs);

    const results: Record<string, number> = {};
    for (const item of items) {
      const key = `${item.productId}|${item.toBucket}|${
        item.expiryDate ? this.lotKey(item.expiryDate) : ''
      }`;
      results[key] = 0;
    }

    for (const log of logs) {
      if (!isLogActive(log, activeKeys)) continue;
      for (const item of items) {
        if (log.productId !== item.productId || log.bucket !== item.toBucket) {
          continue;
        }
        if (item.toBucket === BUCKET_NEAR_EXPIRY) {
          const expectedLot = item.expiryDate
            ? this.lotKey(item.expiryDate)
            : null;
          const logLot = log.expiryDate ? this.lotKey(log.expiryDate) : null;
          if (expectedLot !== logLot) continue;
        }
        const key = `${item.productId}|${item.toBucket}|${
          item.expiryDate ? this.lotKey(item.expiryDate) : ''
        }`;
        results[key] = (results[key] || 0) + Number(log.quantity);
      }
    }

    return results;
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

    // Validate từng dòng.
    //
    // NSX (expiryDate) chỉ BẮT BUỘC với chiều OUT: điều chỉnh giảm phải trừ vào
    // đúng lô đang có tồn, không có lô thì không biết trừ ở đâu.
    //
    // Chiều IN cho phép để trống NSX → dòng vào "lô chưa xác định NSX"
    // (expiryDate = null). Cần thiết cho trường hợp khai báo tồn cũ chưa biết
    // NSX; sau đó dùng chức năng sửa phiếu (update) để điền NSX đúng.
    for (const item of dto.items) {
      const direction = item.direction === 'OUT' ? 'OUT' : 'IN';
      if (
        item.toBucket === BUCKET_NEAR_EXPIRY &&
        direction === 'OUT' &&
        !item.expiryDate
      ) {
        throw new BadRequestException(
          'Điều chỉnh giảm hàng cận date phải chọn đúng lô (ngày sản xuất)',
        );
      }
      if (item.quantity <= 0) {
        throw new BadRequestException('Số lượng phải lớn hơn 0');
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

    // Tồn 3 bucket lấy TỪ SỔ CÁI (nguồn chân lý), không dùng cache trên
    // Inventory vì cache có thể trôi khỏi sổ cái (các module cũ còn ghi trực
    // tiếp vào cột cache mà không ghi sổ).
    const bucketMap = await computeBucketTotalsBatch(
      this.prisma,
      uniqueIds,
      dto.branchId,
    );

    // Validate chiều IN: tổng SL chuyển vào các bucket cho mỗi sản phẩm không
    // vượt "hàng tốt" hiện có = onHand − (damaged + nearExpiry + promo).
    const inByProduct = new Map<number, number>();
    for (const item of dto.items) {
      if ((item.direction === 'OUT' ? 'OUT' : 'IN') !== 'IN') continue;
      inByProduct.set(
        item.productId,
        (inByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
    for (const [productId, totalIn] of inByProduct.entries()) {
      const inv = invMap.get(productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const totals = bucketMap[productId];
      const usedBuckets = totals
        ? totals.damaged + totals.nearExpiry + totals.promo
        : 0;
      const available = onHand - usedBuckets;
      if (totalIn > available) {
        const p = productMap.get(productId);
        throw new BadRequestException(
          `${p?.name}: Số lượng chuyển vào loại tồn (${totalIn}) vượt quá hàng tốt khả dụng (${available}). Tồn tổng ${onHand}, đã phân loại ${usedBuckets}.`,
        );
      }
    }

    // Validate chiều OUT: SL điều chỉnh giảm không vượt tồn hiện có của bucket
    // (với cận date là tồn của đúng lô expiryDate).
    for (const item of dto.items) {
      if ((item.direction === 'OUT' ? 'OUT' : 'IN') !== 'OUT') continue;
      const p = productMap.get(item.productId);
      if (item.toBucket === BUCKET_NEAR_EXPIRY) {
        const lots = await computeNearExpiryLots(
          this.prisma,
          item.productId,
          dto.branchId,
        );
        const key = item.expiryDate
          ? new Date(item.expiryDate).toISOString().slice(0, 10)
          : null;
        const lot = lots.find((l) => l.expiryDate === key);
        const lotQty = lot ? lot.quantity : 0;
        if (item.quantity > lotQty) {
          throw new BadRequestException(
            `${p?.name}: Điều chỉnh giảm cận date lô ${key || 'chưa xác định'} (${item.quantity}) vượt quá tồn lô hiện có (${lotQty}).`,
          );
        }
      } else {
        const totals = bucketMap[item.productId];
        const current =
          item.toBucket === BUCKET_DAMAGED
            ? (totals?.damaged ?? 0)
            : (totals?.promo ?? 0);
        if (item.quantity > current) {
          const label =
            item.toBucket === BUCKET_DAMAGED ? 'bục rách' : 'khuyến mãi';
          throw new BadRequestException(
            `${p?.name}: Điều chỉnh giảm ${label} (${item.quantity}) vượt quá tồn hiện có (${current}).`,
          );
        }
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
                  direction: item.direction === 'OUT' ? 'OUT' : 'IN',
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

    // Re-validate tại thời điểm duyệt.
    const productIds = [...new Set(transfer.details.map((d) => d.productId))];
    const inventories = await this.prisma.inventory.findMany({
      where: { productId: { in: productIds }, branchId: transfer.branchId },
    });
    const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

    // Tồn 3 bucket lấy TỪ SỔ CÁI (nguồn chân lý), không dùng cache Inventory.
    const bucketMap = await computeBucketTotalsBatch(
      this.prisma,
      productIds,
      transfer.branchId,
    );

    // Chiều IN: tổng cộng thêm vào các bucket không vượt hàng tốt còn lại.
    const addByProduct = new Map<number, number>();
    for (const d of transfer.details) {
      if ((d as any).direction === 'OUT') continue;
      addByProduct.set(
        d.productId,
        (addByProduct.get(d.productId) ?? 0) + Number(d.quantity),
      );
    }
    for (const [productId, add] of addByProduct.entries()) {
      const inv = invMap.get(productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const totals = bucketMap[productId];
      const usedBuckets = totals
        ? totals.damaged + totals.nearExpiry + totals.promo
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

      // Ghi sổ cái cho mọi dòng trước.
      for (const detail of transfer.details) {
        const isOut = (detail as any).direction === 'OUT';
        const signedQty = isOut
          ? -Number(detail.quantity) // OUT: loại tồn -> hàng tốt (trừ bucket)
          : Number(detail.quantity); // IN: hàng tốt -> loại tồn (cộng bucket)
        await tx.stockConditionLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.branchId,
            branchName: transfer.branchName,
            bucket: detail.toBucket,
            transactionType: isOut ? 'CLT_OUT' : 'CLT_IN',
            refCode: transfer.code,
            refType: 'clt',
            refId: transfer.id,
            quantity: signedQty,
            expiryDate: detail.expiryDate,
            costPrice: Number(detail.costAtTransfer),
            transactionDate,
            note: isOut
              ? `Điều chỉnh giảm ${BUCKET_LABEL[detail.toBucket] || detail.toBucket}`
              : `Chuyển sang ${BUCKET_LABEL[detail.toBucket] || detail.toBucket}`,
            createdByName: user?.name || transfer.createdByName,
          },
        });
      }

      // Set status = APPROVED TRƯỚC khi recalc/validate: active-finder 'clt' chỉ
      // tính log của phiếu status=2. Nếu recalc khi phiếu còn status=1 (Chờ duyệt),
      // toàn bộ log CLT_IN/CLT_OUT của chính phiếu này bị loại → cache bucket sai
      // (thiếu phần vừa duyệt). Phải active hóa phiếu trước.
      await tx.stockConditionTransfer.update({
        where: { id },
        data: {
          status: CLT_STATUS.APPROVED,
          approvedById: userId,
          approvedByName: user?.name || null,
          approvedAt: new Date(),
        },
      });

      // Sau khi phiếu đã active: validate chống âm (OUT) + recalc cache bucket.
      const seenPairs = new Set<number>();
      for (const detail of transfer.details) {
        const isOut = (detail as any).direction === 'OUT';
        if (isOut) {
          const totals = await computeBucketTotals(
            tx,
            detail.productId,
            transfer.branchId,
          );
          if (totals.damaged < 0 || totals.nearExpiry < 0 || totals.promo < 0) {
            throw new BadRequestException(
              `${detail.productName}: Điều chỉnh giảm làm tồn loại tồn âm. Vui lòng kiểm tra lại tồn thực tế.`,
            );
          }
        }
        if (!seenPairs.has(detail.productId)) {
          seenPairs.add(detail.productId);
          await recalcConditionBuckets(tx, detail.productId, transfer.branchId);
        }
      }

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

  /**
   * Chuẩn hóa NSX về mốc THÁNG: luôn lấy ngày 01 của tháng đó.
   * NSX chỉ có ý nghĩa tới tháng/năm, nên mọi lô mới đều neo vào ngày 01 để hai
   * lần nhập cùng tháng không tạo ra 2 lô khác nhau.
   */
  private normalizeExpiry(v?: string | Date | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0),
    );
  }

  private lotKey(v?: string | Date | null): string | null {
    const d = this.normalizeExpiry(v);
    return d ? d.toISOString().slice(0, 10) : null;
  }

  /**
   * Các dòng hóa đơn ĐÃ BÁN từ một lô cận date cụ thể (product + branch + lô).
   *
   * Dựa vào sổ cái: log SALE_OUT của bucket NEAR_EXPIRY mang refType='invoice',
   * refId = id hóa đơn và expiryDate = lô đã bán. Từ đó truy ngược ra đúng dòng
   * hóa đơn để biết việc đổi NSX sẽ ảnh hưởng tới hóa đơn nào.
   *
   * Chỉ tính hóa đơn CÒN HIỆU LỰC (status != 2) — hóa đơn đã hủy không còn trừ
   * vào lô nên đổi NSX không ảnh hưởng gì.
   */
  private async findInvoiceLinesForLot(
    tx: any,
    productId: number,
    branchId: number,
    lot: string | null,
  ): Promise<
    Array<{
      invoiceId: number;
      invoiceCode: string;
      purchaseDate: Date | null;
      quantity: number;
      detailIds: number[];
    }>
  > {
    const logs = await tx.stockConditionLog.findMany({
      where: {
        productId,
        branchId,
        bucket: BUCKET_NEAR_EXPIRY,
        transactionType: 'SALE_OUT',
        refType: 'invoice',
      },
      select: { refId: true, refCode: true, quantity: true, expiryDate: true },
    });

    const matched = logs.filter((l: any) => this.lotKey(l.expiryDate) === lot);
    if (matched.length === 0) return [];

    const invoiceIds = [
      ...new Set(matched.map((l: any) => l.refId)),
    ] as number[];
    const invoices = await tx.invoice.findMany({
      where: { id: { in: invoiceIds }, status: { not: 2 } },
      select: { id: true, code: true, purchaseDate: true },
    });
    const aliveIds = new Set(invoices.map((i: any) => i.id));
    const invMap = new Map(invoices.map((i: any) => [i.id, i]));

    // Đúng những dòng hóa đơn của lô này (khớp cả productId và soldExpiryDate).
    const details = await tx.invoiceDetail.findMany({
      where: { invoiceId: { in: [...aliveIds] }, productId },
      select: {
        id: true,
        invoiceId: true,
        quantity: true,
        soldExpiryDate: true,
      },
    });

    const out = new Map<
      number,
      {
        invoiceId: number;
        invoiceCode: string;
        purchaseDate: Date | null;
        quantity: number;
        detailIds: number[];
      }
    >();
    for (const d of details) {
      if (this.lotKey(d.soldExpiryDate) !== lot) continue;
      const inv: any = invMap.get(d.invoiceId);
      if (!inv) continue;
      const cur = out.get(d.invoiceId) || {
        invoiceId: d.invoiceId,
        invoiceCode: inv.code,
        purchaseDate: inv.purchaseDate,
        quantity: 0,
        detailIds: [] as number[],
      };
      cur.quantity += Number(d.quantity);
      cur.detailIds.push(d.id);
      out.set(d.invoiceId, cur);
    }
    return [...out.values()];
  }

  /**
   * XEM TRƯỚC ảnh hưởng khi sửa phiếu: với mỗi dòng cận date của phiếu, liệt kê
   * các hóa đơn đã bán từ lô hiện tại của dòng đó. FE dùng để cảnh báo trước khi
   * người dùng bấm lưu.
   */
  async getEditImpact(id: number) {
    const transfer = await this.prisma.stockConditionTransfer.findUnique({
      where: { id },
      include: { details: true },
    });
    if (!transfer) throw new NotFoundException('Phiếu không tồn tại');

    const rows: any[] = [];
    for (const d of transfer.details) {
      if (d.toBucket !== BUCKET_NEAR_EXPIRY) continue;
      const lot = this.lotKey(d.expiryDate);
      const invoices = await this.findInvoiceLinesForLot(
        this.prisma,
        d.productId,
        transfer.branchId,
        lot,
      );
      rows.push({
        detailId: d.id,
        productCode: d.productCode,
        productName: d.productName,
        currentExpiryDate: d.expiryDate,
        soldQuantity: invoices.reduce((s, i) => s + i.quantity, 0),
        invoices: invoices.map((i) => ({
          invoiceId: i.invoiceId,
          invoiceCode: i.invoiceCode,
          purchaseDate: i.purchaseDate,
          quantity: i.quantity,
        })),
      });
    }
    return { transferId: id, code: transfer.code, details: rows };
  }

  /**
   * SỬA PHIẾU — cho phép cả khi phiếu ĐÃ DUYỆT.
   *
   * Phạm vi: NSX (expiryDate), số lượng (quantity), ghi chú (note) của từng dòng
   * và ghi chú cấp phiếu. KHÔNG đổi sản phẩm / loại tồn / chiều.
   *
   * Cách ghi sổ: XÓA toàn bộ log của phiếu rồi ghi lại theo dữ liệu mới (cùng
   * cách purchase-orders đang làm), sau đó recalc cache. Nhờ vậy không phải tính
   * log bù trừ và tổng luôn bằng Σ log active.
   *
   * Đổi NSX của dòng cận date mà lô cũ ĐÃ BÁN: mặc định CHẶN và trả về danh sách
   * hóa đơn ảnh hưởng. Nếu cascadeInvoices=true thì cập nhật soldExpiryDate của
   * đúng các dòng hóa đơn đó (kèm log SALE_OUT) sang lô mới.
   */
  async update(
    id: number,
    dto: UpdateStockConditionTransferDto,
    userId?: number,
  ) {
    const transfer = await this.prisma.stockConditionTransfer.findUnique({
      where: { id },
      include: { details: true },
    });
    if (!transfer) throw new NotFoundException('Phiếu không tồn tại');
    if (transfer.status === CLT_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã hủy, không thể sửa');
    }

    const items = dto.items ?? [];
    const detailMap = new Map(transfer.details.map((d) => [d.id, d]));
    for (const it of items) {
      if (!detailMap.has(it.detailId)) {
        throw new BadRequestException(
          `Dòng #${it.detailId} không thuộc phiếu ${transfer.code}`,
        );
      }
      // Khi SỬA phiếu, quantity = 0 có nghĩa là toàn bộ số của dòng đã nhập dư
      // và cần loại hết tác động khỏi sổ cái. Dòng chi tiết vẫn được giữ với số
      // 0 để bảo toàn lịch sử phiếu; chỉ không tạo log CLT cho dòng đó.
      if (it.quantity != null && it.quantity < 0) {
        throw new BadRequestException('Số lượng không được âm');
      }
      if (it.quantity != null) {
        const original = detailMap.get(it.detailId);
        if (original && it.quantity > Number(original.quantity)) {
          throw new BadRequestException(
            `${original.productName}: Số lượng sửa (${it.quantity}) vượt quá số đã ghi ban đầu (${Number(original.quantity)}). Chỉ được sửa giảm.`,
          );
        }
      }
    }

    const isApproved = transfer.status === CLT_STATUS.APPROVED;

    // Gom các dòng cận date bị ĐỔI LÔ để xử lý lan sang hóa đơn.
    const lotChanges: Array<{
      detail: any;
      oldLot: string | null;
      newLot: string | null;
      newDate: Date | null;
    }> = [];
    for (const it of items) {
      const d = detailMap.get(it.detailId)!;
      if (d.toBucket !== BUCKET_NEAR_EXPIRY) continue;
      if (!('expiryDate' in it)) continue;
      const oldLot = this.lotKey(d.expiryDate);
      const newDate = this.normalizeExpiry(it.expiryDate ?? null);
      const newLot = newDate ? newDate.toISOString().slice(0, 10) : null;
      if (oldLot === newLot) continue;
      lotChanges.push({ detail: d, oldLot, newLot, newDate });
    }

    // Phiếu đã duyệt + đổi lô: kiểm tra hóa đơn đã bán từ lô cũ.
    const impacted: Array<{
      productCode: string;
      oldLot: string | null;
      newLot: string | null;
      invoices: Array<{ invoiceCode: string; quantity: number }>;
      detailIds: number[];
    }> = [];
    if (isApproved && lotChanges.length > 0) {
      for (const ch of lotChanges) {
        const lines = await this.findInvoiceLinesForLot(
          this.prisma,
          ch.detail.productId,
          transfer.branchId,
          ch.oldLot,
        );
        if (lines.length === 0) continue;
        impacted.push({
          productCode: ch.detail.productCode,
          oldLot: ch.oldLot,
          newLot: ch.newLot,
          invoices: lines.map((l) => ({
            invoiceCode: l.invoiceCode,
            quantity: l.quantity,
          })),
          detailIds: lines.flatMap((l) => l.detailIds),
        });
      }

      if (impacted.length > 0 && !dto.cascadeInvoices) {
        const desc = impacted
          .map(
            (i) =>
              `${i.productCode} (lô ${i.oldLot || 'chưa xác định'}): ${i.invoices
                .map((v) => `${v.invoiceCode} ${v.quantity}`)
                .join(', ')}`,
          )
          .join('; ');
        throw new BadRequestException(
          `Lô đang sửa đã phát sinh bán nên không thể đổi NSX trực tiếp. Hóa đơn ảnh hưởng: ${desc}. Xác nhận cập nhật cả hóa đơn để tiếp tục.`,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Cập nhật từng dòng chi tiết.
      for (const it of items) {
        const data: any = {};
        if (it.quantity != null) data.quantity = it.quantity;
        if ('note' in it) data.note = it.note || null;
        if ('expiryDate' in it) {
          const d = detailMap.get(it.detailId)!;
          data.expiryDate =
            d.toBucket === BUCKET_NEAR_EXPIRY
              ? this.normalizeExpiry(it.expiryDate ?? null)
              : null;
        }
        if (Object.keys(data).length === 0) continue;
        await tx.stockConditionTransferDetail.update({
          where: { id: it.detailId },
          data,
        });
      }

      if (dto.note !== undefined) {
        await tx.stockConditionTransfer.update({
          where: { id },
          data: { note: dto.note || null },
        });
      }

      // 2. Lan sang hóa đơn (chỉ khi người dùng đã xác nhận).
      if (isApproved && dto.cascadeInvoices && impacted.length > 0) {
        for (const imp of impacted) {
          const newDate = imp.newLot
            ? new Date(`${imp.newLot}T00:00:00.000Z`)
            : null;
          await tx.invoiceDetail.updateMany({
            where: { id: { in: imp.detailIds } },
            data: { soldExpiryDate: newDate },
          });
          // Log SALE_OUT của lô cũ phải trỏ sang lô mới, nếu không lô cũ âm.
          const codes = imp.invoices.map((v) => v.invoiceCode);
          const logsToMove = await tx.stockConditionLog.findMany({
            where: {
              branchId: transfer.branchId,
              bucket: BUCKET_NEAR_EXPIRY,
              transactionType: 'SALE_OUT',
              refType: 'invoice',
              refCode: { in: codes },
            },
            select: { id: true, expiryDate: true },
          });
          const ids = logsToMove
            .filter((l: any) => this.lotKey(l.expiryDate) === imp.oldLot)
            .map((l: any) => l.id);
          if (ids.length > 0) {
            await tx.stockConditionLog.updateMany({
              where: { id: { in: ids } },
              data: { expiryDate: newDate },
            });
          }
        }
      }

      // 3. Ghi lại sổ cái của phiếu (chỉ phiếu đã duyệt mới có log).
      if (isApproved) {
        await tx.stockConditionLog.deleteMany({
          where: { refType: 'clt', refId: id },
        });

        const fresh = await tx.stockConditionTransferDetail.findMany({
          where: { transferId: id },
        });
        const transactionDate = transfer.transferDate ?? new Date();
        for (const d of fresh) {
          // Dòng được sửa về 0 vẫn nằm trên phiếu để lưu vết, nhưng không còn
          // tác động tới tồn nên không ghi StockConditionLog.
          if (Number(d.quantity) === 0) continue;
          const isOut = (d as any).direction === 'OUT';
          await tx.stockConditionLog.create({
            data: {
              productId: d.productId,
              productCode: d.productCode,
              productName: d.productName,
              branchId: transfer.branchId,
              branchName: transfer.branchName,
              bucket: d.toBucket,
              transactionType: isOut ? 'CLT_OUT' : 'CLT_IN',
              refCode: transfer.code,
              refType: 'clt',
              refId: id,
              quantity: isOut ? -Number(d.quantity) : Number(d.quantity),
              expiryDate: d.expiryDate,
              costPrice: Number(d.costAtTransfer),
              transactionDate,
              note: isOut
                ? `Điều chỉnh giảm ${BUCKET_LABEL[d.toBucket] || d.toBucket}`
                : `Chuyển sang ${BUCKET_LABEL[d.toBucket] || d.toBucket}`,
              createdByName: transfer.createdByName,
            },
          });
        }

        // 4. Validate sau khi ghi: bucket không âm, lô không âm, không vượt hàng tốt.
        const productIds = [...new Set(fresh.map((d) => d.productId))];
        for (const productId of productIds) {
          const totals = await computeBucketTotals(
            tx,
            productId,
            transfer.branchId,
          );
          if (totals.damaged < 0 || totals.nearExpiry < 0 || totals.promo < 0) {
            const d = fresh.find((x) => x.productId === productId);
            throw new BadRequestException(
              `${d?.productName}: Sửa phiếu làm tồn loại tồn âm. Kiểm tra lại số lượng.`,
            );
          }

          const inv = await tx.inventory.findUnique({
            where: {
              productId_branchId: { productId, branchId: transfer.branchId },
            },
            select: { onHand: true },
          });
          const onHand = inv ? Number(inv.onHand) : 0;
          const used = totals.damaged + totals.nearExpiry + totals.promo;
          if (used > onHand) {
            const d = fresh.find((x) => x.productId === productId);
            throw new BadRequestException(
              `${d?.productName}: Tổng đã phân loại (${used}) vượt tồn tổng (${onHand}). Giảm số lượng lại.`,
            );
          }

          // Kiểm tra âm PHẢI tự gom theo lô: computeNearExpiryLots đã lọc bỏ
          // lô <= 0 nên không dùng được để phát hiện lô âm.
          const rawLots = await tx.stockConditionLog.findMany({
            where: {
              productId,
              branchId: transfer.branchId,
              bucket: BUCKET_NEAR_EXPIRY,
            },
            select: {
              quantity: true,
              expiryDate: true,
              refType: true,
              refId: true,
            },
          });
          const byLot = new Map<string, number>();
          const activeKeys = await getActiveLogKeys(tx, rawLots);
          for (const l of rawLots) {
            if (!isLogActive(l, activeKeys)) continue;
            const k = this.lotKey(l.expiryDate) || '';
            byLot.set(k, (byLot.get(k) ?? 0) + Number(l.quantity));
          }
          for (const [k, qty] of byLot.entries()) {
            if (qty < 0) {
              const d = fresh.find((x) => x.productId === productId);
              throw new BadRequestException(
                `${d?.productName}: Lô cận date ${k || 'chưa xác định NSX'} bị âm (${qty}) sau khi sửa. Cần xác nhận cập nhật cả hóa đơn hoặc chọn lại NSX.`,
              );
            }
          }

          await recalcConditionBuckets(tx, productId, transfer.branchId);
        }
      }

      return tx.stockConditionTransfer.findUnique({
        where: { id },
        include: INCLUDE_FULL,
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
      actionCode: 'STOCK_CONDITION_TRANSFER_UPDATE',
      entityType: 'stock_condition_transfers',
      entityId: id.toString(),
      entityCode: transfer.code,
      category: getCategoryFromActionCode('STOCK_CONDITION_TRANSFER_UPDATE'),
      severity: getSeverityFromActionCode('STOCK_CONDITION_TRANSFER_UPDATE'),
      snapshot: this.buildSnapshot(updated),
      message: renderAuditMessage('STOCK_CONDITION_TRANSFER_UPDATE', {
        code: transfer.code,
      }),
      messageTemplate: 'STOCK_CONDITION_TRANSFER_UPDATE',
      userId: userId || transfer.createdById || 1,
      userName:
        actor?.name || actor?.email || transfer.createdByName || 'System',
      branchId: transfer.branchId,
    });

    return updated;
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
          const isOut = (detail as any).direction === 'OUT';
          // Dòng đảo: ngược dấu với dòng gốc (IN gốc +qty → đảo -qty; OUT gốc
          // -qty → đảo +qty). Chỉ để lưu vết; recalc bỏ qua toàn bộ log phiếu này.
          const reverseQty = isOut
            ? Number(detail.quantity)
            : -Number(detail.quantity);
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
              quantity: reverseQty,
              expiryDate: detail.expiryDate,
              costPrice: Number(detail.costAtTransfer),
              transactionDate,
              note: `Hủy ${isOut ? 'điều chỉnh giảm' : 'chuyển'} ${BUCKET_LABEL[detail.toBucket] || detail.toBucket}`,
              createdByName: transfer.createdByName,
            },
          });

          const totals = await computeBucketTotals(
            tx,
            detail.productId,
            transfer.branchId,
          );
          if (totals.damaged < 0 || totals.nearExpiry < 0 || totals.promo < 0) {
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
      userName:
        actor?.name || actor?.email || transfer.createdByName || 'System',
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
    let nextId = last ? parseInt(last.code.replace(prefix, ''), 10) + 1 : 1;
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
