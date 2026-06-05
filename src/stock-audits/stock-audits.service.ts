import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockAuditDto } from './dto/create-stock-audit.dto';
import { UpdateStockAuditDto } from './dto/update-stock-audit.dto';
import { StockAuditQueryDto } from './dto/stock-audit-query.dto';
import { recalcStockAuditChain } from '../common/inventory-onhand.util';

const STOCK_AUDIT_STATUS = {
  DRAFT: 1,
  COMPLETED: 2,
  CANCELLED: 3,
};

const INCLUDE_FULL = {
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
  details: {
    include: {
      product: {
        select: { id: true, code: true, name: true, unit: true },
      },
    },
  },
};

@Injectable()
export class StockAuditsService {
  constructor(private prisma: PrismaService) {}

  // ─── Lọc bỏ log thuộc các phiếu kiểm ĐÃ HỦY ────────────────────
  // Log STOCK_AUDIT/STOCK_AUDIT_CANCEL của phiếu có status = CANCELLED không
  // được tính vào tồn (thẻ kho cũng ẩn chúng). Cặp +delta/−delta của 1 phiếu
  // hủy có thể lệch transactionDate nên KHÔNG tự triệt tiêu khi cộng theo mốc
  // thời gian — phải loại hẳn theo refId của phiếu đã hủy.
  private async filterOutCancelledAuditLogs(
    tx: any,
    logs: { refType?: string | null; refId?: number | null; quantity: any }[],
  ): Promise<{ quantity: any }[]> {
    const auditIds = [
      ...new Set(
        logs
          .filter((l) => l.refType === 'stock_audit' && l.refId)
          .map((l) => l.refId as number),
      ),
    ];
    if (auditIds.length === 0) return logs;
    const cancelled = await tx.stockAudit.findMany({
      where: { id: { in: auditIds }, status: STOCK_AUDIT_STATUS.CANCELLED },
      select: { id: true },
    });
    const cancelledSet = new Set(cancelled.map((a: any) => a.id));
    return logs.filter(
      (l) => l.refType !== 'stock_audit' || !cancelledSet.has(l.refId),
    );
  }

  // ─── Tồn kho tại thời điểm kiểm (point-in-time, LOG-BASED) ──────
  // Tồn ngay TRƯỚC thời điểm `checkDate` = TỔNG các giao dịch THẬT (InventoryLog)
  // có transactionDate < checkDate. Chỉ tính những gì đã ghi vào thẻ kho:
  //   stockBefore(T) = Σ quantity(log.transactionDate < T)
  // → Nếu trước thời điểm kiểm KHÔNG có giao dịch nào thì tồn = 0 (không tính
  //   "tồn ảo" khởi tạo sản phẩm chưa từng ghi log). Khớp đúng với thẻ kho.
  // Loại bỏ: (a) log của phiếu kiểm đang xử lý (`excludeAuditId`), (b) log của
  // mọi phiếu kiểm ĐÃ HỦY.
  private async getStockBeforeDate(
    tx: any,
    productId: number,
    branchId: number,
    checkDate: Date,
    excludeAuditId?: number,
  ): Promise<number> {
    const earlierLogs = await tx.inventoryLog.findMany({
      where: {
        productId,
        branchId,
        transactionDate: { lt: checkDate },
        ...(excludeAuditId
          ? { NOT: { refType: 'stock_audit', refId: excludeAuditId } }
          : {}),
      },
      select: { quantity: true, refType: true, refId: true },
    });
    const active = await this.filterOutCancelledAuditLogs(tx, earlierLogs);
    return active.reduce((s: number, l: any) => s + Number(l.quantity), 0);
  }

  // ─── Tổng toàn bộ giao dịch (Σ log) của 1 sản phẩm tại 1 chi nhánh ──
  // Dùng để set lại onHand = Σ log sau khi kiểm — giữ onHand luôn khớp với
  // thẻ kho (loại bỏ tồn ảo không có log + log phiếu kiểm đã hủy).
  private async getTotalLogSum(
    tx: any,
    productId: number,
    branchId: number,
    excludeAuditId?: number,
  ): Promise<number> {
    const logs = await tx.inventoryLog.findMany({
      where: {
        productId,
        branchId,
        ...(excludeAuditId
          ? { NOT: { refType: 'stock_audit', refId: excludeAuditId } }
          : {}),
      },
      select: { quantity: true, refType: true, refId: true },
    });
    const active = await this.filterOutCancelledAuditLogs(tx, logs);
    return active.reduce((s: number, l: any) => s + Number(l.quantity), 0);
  }

  // ─── Preview tồn tại thời điểm cho nhiều sản phẩm (phục vụ UI form) ──
  // Trả về { productId: stockAtMoment } để form hiển thị cột "Tồn kho" đúng
  // theo checkDate trước khi lưu — khớp với cách `complete` tính difference.
  async previewStockAtDate(
    branchId: number,
    productIds: number[],
    checkDate: string,
  ): Promise<Record<number, number>> {
    const date = checkDate ? new Date(checkDate) : new Date();
    const unique = [...new Set(productIds)].filter((id) => !!id);
    const result: Record<number, number> = {};
    for (const pid of unique) {
      result[pid] = await this.getStockBeforeDate(
        this.prisma,
        pid,
        branchId,
        date,
      );
    }
    return result;
  }

  // ─── Generate code KK000001 ─────────────────────────────────────
  private async generateCode(): Promise<string> {
    const last = await this.prisma.stockAudit.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    if (!last) return 'KK000001';

    const num = parseInt(last.code.replace('KK', ''), 10) + 1;
    return `KK${String(num).padStart(6, '0')}`;
  }

  // ─── Find All ───────────────────────────────────────────────────
  async findAll(query: StockAuditQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;

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
    } else if (query.branchId) {
      where.branchId = +query.branchId;
    }
    if (query.status) where.status = +query.status;
    if (query.creatorId) where.createdById = +query.creatorId;

    if (query.fromDate || query.toDate) {
      where.checkDate = {};
      if (query.fromDate) where.checkDate.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.checkDate.lte = to;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.stockAudit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: INCLUDE_FULL,
      }),
      this.prisma.stockAudit.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  // ─── Find One ───────────────────────────────────────────────────
  async findOne(id: number) {
    const record = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: INCLUDE_FULL,
    });
    if (!record) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    return record;
  }

  // ─── Create (DRAFT) ────────────────────────────────────────────
  async create(dto: CreateStockAuditDto, userId: number) {
    if (!dto.items?.length) {
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

    // Validate unique products
    const productIds = dto.items.map((i) => i.productId);
    const uniqueIds = [...new Set(productIds)];
    if (uniqueIds.length !== productIds.length) {
      throw new BadRequestException('Sản phẩm bị trùng trong phiếu kiểm');
    }

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

    const code = await this.generateCode();
    const checkDate = dto.checkDate ? new Date(dto.checkDate) : new Date();

    // Tồn tại thời điểm kiểm cho từng sản phẩm (neo ngược từ onHand hiện tại).
    const systemQtyMap = new Map<number, number>();
    for (const id of uniqueIds) {
      systemQtyMap.set(
        id,
        await this.getStockBeforeDate(this.prisma, id, dto.branchId, checkDate),
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.create({
        data: {
          code,
          branchId: branch.id,
          branchName: branch.name,
          checkDate,
          note: dto.note || null,
          status: STOCK_AUDIT_STATUS.DRAFT,
          createdById: user.id,
          createdByName: user.name,
          details: {
            createMany: {
              data: dto.items.map((item) => {
                const product = productMap.get(item.productId)!;
                const inv = invMap.get(item.productId);
                const systemQty = systemQtyMap.get(item.productId) ?? 0;
                const cost = inv ? Number(inv.cost) : 0;
                const difference = item.actualQuantity - systemQty;

                return {
                  productId: item.productId,
                  productCode: product.code,
                  productName: product.name,
                  unit: product.unit || null,
                  systemQuantity: systemQty,
                  actualQuantity: item.actualQuantity,
                  difference,
                  costAtCheck: cost,
                  differenceValue: difference * cost,
                  note: item.note || null,
                };
              }),
            },
          },
        },
      });

      return tx.stockAudit.findUnique({
        where: { id: audit.id },
        include: INCLUDE_FULL,
      });
    });
  }

  // ─── Update (chỉ DRAFT) ────────────────────────────────────────
  async update(id: number, dto: UpdateStockAuditDto) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status !== STOCK_AUDIT_STATUS.DRAFT) {
      throw new BadRequestException(
        'Chỉ được sửa phiếu ở trạng thái Phiếu tạm',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Update note + checkDate
      const headerData: any = {};
      if (dto.note !== undefined) headerData.note = dto.note || null;
      if (dto.checkDate !== undefined) {
        headerData.checkDate = dto.checkDate
          ? new Date(dto.checkDate)
          : new Date();
      }
      if (Object.keys(headerData).length > 0) {
        await tx.stockAudit.update({ where: { id }, data: headerData });
      }

      // checkDate hiệu lực để tính tồn thời điểm (mới nếu có, không thì giữ cũ)
      const effectiveCheckDate: Date =
        headerData.checkDate ?? audit.checkDate;

      // Update items
      if (dto.items?.length) {
        const productIds = dto.items.map((i) => i.productId);
        const uniqueIds = [...new Set(productIds)];
        if (uniqueIds.length !== productIds.length) {
          throw new BadRequestException('Sản phẩm bị trùng');
        }

        const products = await tx.product.findMany({
          where: { id: { in: uniqueIds } },
          select: { id: true, code: true, name: true, unit: true },
        });
        const productMap = new Map(products.map((p) => [p.id, p]));

        const inventories = await tx.inventory.findMany({
          where: { productId: { in: uniqueIds }, branchId: audit.branchId },
        });
        const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

        // Tồn tại thời điểm kiểm cho từng sản phẩm.
        const systemQtyMap = new Map<number, number>();
        for (const pid of uniqueIds) {
          systemQtyMap.set(
            pid,
            await this.getStockBeforeDate(
              tx,
              pid,
              audit.branchId,
              effectiveCheckDate,
            ),
          );
        }

        // Xóa details cũ, tạo mới
        await tx.stockAuditDetail.deleteMany({
          where: { stockAuditId: id },
        });

        await tx.stockAuditDetail.createMany({
          data: dto.items.map((item) => {
            const product = productMap.get(item.productId)!;
            const inv = invMap.get(item.productId);
            const systemQty = systemQtyMap.get(item.productId) ?? 0;
            const cost = inv ? Number(inv.cost) : 0;
            const difference = item.actualQuantity - systemQty;

            return {
              stockAuditId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              unit: product.unit || null,
              systemQuantity: systemQty,
              actualQuantity: item.actualQuantity,
              difference,
              costAtCheck: cost,
              differenceValue: difference * cost,
              note: item.note || null,
            };
          }),
        });
      }

      return tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });
  }

  // ─── Complete (DRAFT → COMPLETED) ──────────────────────────────
  async complete(id: number, userId: number) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status !== STOCK_AUDIT_STATUS.DRAFT) {
      throw new BadRequestException(
        'Chỉ hoàn thành phiếu ở trạng thái Phiếu tạm',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const checkDate: Date = audit.checkDate ?? new Date();

      for (const detail of audit.details) {
        const inv = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: audit.branchId,
            },
          },
          include: {
            product: { select: { weight: true, weightUnit: true } },
          },
        });

        if (!inv) continue;

        // Tính lại tồn TẠI THỜI ĐIỂM kiểm theo LOG (Σ giao dịch thật trước
        // checkDate) ngay lúc Hoàn thành. difference = thực tế − tồn-log-trước.
        const systemQty = await this.getStockBeforeDate(
          tx,
          detail.productId,
          audit.branchId,
          checkDate,
          audit.id,
        );
        const delta = Number(detail.actualQuantity) - systemQty;
        const cost = Number(detail.costAtCheck);

        // Cập nhật lại snapshot trên detail cho khớp với giá trị áp dụng.
        await tx.stockAuditDetail.update({
          where: { id: detail.id },
          data: {
            systemQuantity: systemQty,
            difference: delta,
            differenceValue: delta * cost,
          },
        });

        // LUÔN ghi InventoryLog (kể cả delta = 0) — dòng này là MỐC NEO tuyệt
        // đối của phiếu kiểm trên thẻ kho. recalcStockAuditChain sẽ tính lại
        // delta đúng theo timeline (kể cả khi có phiếu/đơn lùi ngày chèn vào).
        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: audit.branchId,
            branchName: audit.branchName,
            transactionType: 'STOCK_AUDIT',
            refCode: audit.code,
            refType: 'stock_audit',
            refId: audit.id,
            quantity: delta,
            costPrice: cost,
            transactionDate: checkDate,
            note: `Kiểm kho: ${detail.productName} (HT: ${systemQty} → TT: ${detail.actualQuantity})`,
            createdByName: user?.name || audit.createdByName,
          },
        });

        // RE-ANCHOR: tính lại chuỗi phiếu kiểm + onHand theo timeline mới.
        await recalcStockAuditChain(tx, detail.productId, audit.branchId);
      }

      // Cập nhật status
      await tx.stockAudit.update({
        where: { id },
        data: {
          status: STOCK_AUDIT_STATUS.COMPLETED,
          completedById: userId,
          completedByName: user?.name || null,
          completedAt: new Date(),
        },
      });

      return tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });
  }

  // ─── Cancel (COMPLETED → CANCELLED) ────────────────────────────
  async cancel(id: number) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status === STOCK_AUDIT_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã bị hủy trước đó');
    }

    return this.prisma.$transaction(async (tx) => {
      // Đổi status → CANCELLED TRƯỚC để nguồn chân lý loại toàn bộ log của
      // phiếu này (status=3) khỏi chuỗi tính tồn.
      await tx.stockAudit.update({
        where: { id },
        data: { status: STOCK_AUDIT_STATUS.CANCELLED },
      });

      // Nếu đã COMPLETED → rollback inventory về đúng thẻ kho
      if (audit.status === STOCK_AUDIT_STATUS.COMPLETED) {
        for (const detail of audit.details) {
          // delta đã áp dụng lúc Hoàn thành (đã lưu trên detail) — dùng cho log
          // đối ứng để giữ vết lịch sử.
          const delta = Number(detail.difference);

          // Ghi InventoryLog đối ứng (giữ vết; cũng bị loại khỏi tính toán do
          // phiếu đã CANCELLED).
          if (delta !== 0) {
            await tx.inventoryLog.create({
              data: {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: detail.productName,
                branchId: audit.branchId,
                branchName: audit.branchName,
                transactionType: 'STOCK_AUDIT_CANCEL',
                refCode: audit.code,
                refType: 'stock_audit',
                refId: audit.id,
                quantity: -delta,
                costPrice: Number(detail.costAtCheck),
                transactionDate: audit.checkDate ?? new Date(),
                note: `Hủy kiểm kho: ${detail.productName}`,
                createdByName: audit.createdByName,
              },
            });
          }

          // RE-ANCHOR: phiếu này đã bị loại → tính lại delta các phiếu kiểm
          // CÒN LẠI (đứng sau nó) + onHand theo timeline mới.
          await recalcStockAuditChain(tx, detail.productId, audit.branchId);
        }
      }

      return tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });
  }
}
