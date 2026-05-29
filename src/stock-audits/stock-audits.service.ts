import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockAuditDto } from './dto/create-stock-audit.dto';
import { UpdateStockAuditDto } from './dto/update-stock-audit.dto';
import { StockAuditQueryDto } from './dto/stock-audit-query.dto';

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

    return this.prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.create({
        data: {
          code,
          branchId: branch.id,
          branchName: branch.name,
          checkDate: new Date(),
          note: dto.note || null,
          status: STOCK_AUDIT_STATUS.DRAFT,
          createdById: user.id,
          createdByName: user.name,
          details: {
            createMany: {
              data: dto.items.map((item) => {
                const product = productMap.get(item.productId)!;
                const inv = invMap.get(item.productId);
                const systemQty = inv ? Number(inv.onHand) : 0;
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
      // Update note
      if (dto.note !== undefined) {
        await tx.stockAudit.update({
          where: { id },
          data: { note: dto.note || null },
        });
      }

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

        // Xóa details cũ, tạo mới
        await tx.stockAuditDetail.deleteMany({
          where: { stockAuditId: id },
        });

        await tx.stockAuditDetail.createMany({
          data: dto.items.map((item) => {
            const product = productMap.get(item.productId)!;
            const inv = invMap.get(item.productId);
            const systemQty = inv ? Number(inv.onHand) : 0;
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

        // Tính delta: difference = actualQuantity - systemQuantity (lúc tạo phiếu)
        const delta =
          Number(detail.actualQuantity) - Number(detail.systemQuantity);
        const newOnHand = Number(inv.onHand) + delta;

        // Tính totalWeight mới
        const weight = inv.product?.weight ? Number(inv.product.weight) : 0;
        const totalWeight = weight * newOnHand;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: audit.branchId,
            },
          },
          data: {
            onHand: newOnHand,
            totalWeight,
          },
        });

        // Ghi InventoryLog
        if (delta !== 0) {
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
              costPrice: Number(detail.costAtCheck),
              note: `Kiểm kho: ${detail.productName} (HT: ${detail.systemQuantity} → TT: ${detail.actualQuantity})`,
              createdByName: user?.name || audit.createdByName,
            },
          });
        }
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
      // Nếu đã COMPLETED → rollback inventory
      if (audit.status === STOCK_AUDIT_STATUS.COMPLETED) {
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

          const delta =
            Number(detail.actualQuantity) - Number(detail.systemQuantity);
          const restoredOnHand = Number(inv.onHand) - delta;
          const weight = inv.product?.weight ? Number(inv.product.weight) : 0;

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: audit.branchId,
              },
            },
            data: {
              onHand: restoredOnHand,
              totalWeight: weight * restoredOnHand,
            },
          });

          // Ghi InventoryLog rollback
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
                note: `Hủy kiểm kho: ${detail.productName}`,
                createdByName: audit.createdByName,
              },
            });
          }
        }
      }

      await tx.stockAudit.update({
        where: { id },
        data: { status: STOCK_AUDIT_STATUS.CANCELLED },
      });

      return tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });
    });
  }
}
