import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInventoryCheckDto } from './dto/create-inventory-check.dto';
import { InventoryCheckQueryDto } from './dto/inventory-check-query.dto';

@Injectable()
export class InventoryChecksService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: InventoryCheckQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;
    const branchId = query.branchId ? +query.branchId : undefined;

    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { createdByName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (query.creatorId) {
      where.createdById = +query.creatorId;
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

    const [data, total] = await Promise.all([
      this.prisma.inventoryCheck.findMany({
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
      this.prisma.inventoryCheck.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const record = await this.prisma.inventoryCheck.findUnique({
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

    if (!record) throw new NotFoundException('Phiếu kiểm không tồn tại');
    return record;
  }

  async create(dto: CreateInventoryCheckDto, userId: number) {
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

    // Validate: damaged + nearExpiry <= onHand
    for (const item of dto.items) {
      const inv = invMap.get(item.productId);
      const onHand = inv ? Number(inv.onHand) : 0;
      const total = item.damagedQuantity + item.nearExpiryQuantity;
      if (total > onHand) {
        const product = productMap.get(item.productId);
        throw new BadRequestException(
          `${product?.name}: Tổng hàng loại B (${item.damagedQuantity}) + cận date (${item.nearExpiryQuantity}) = ${total} vượt quá tồn kho (${onHand})`,
        );
      }
    }

    const code = await this.generateCode();

    return this.prisma.$transaction(async (tx) => {
      const check = await tx.inventoryCheck.create({
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
                  previousDamaged: inv ? Number(inv.damagedQuantity) : 0,
                  previousNearExpiry: inv ? Number(inv.nearExpiryQuantity) : 0,
                  damagedQuantity: item.damagedQuantity,
                  nearExpiryQuantity: item.nearExpiryQuantity,
                  note: item.note || null,
                };
              }),
            },
          },
        },
      });

      // Ghi đè giá trị mới vào Inventory
      for (const item of dto.items) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: dto.branchId },
          data: {
            damagedQuantity: item.damagedQuantity,
            nearExpiryQuantity: item.nearExpiryQuantity,
          },
        });
      }

      return tx.inventoryCheck.findUnique({
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
  }

  async remove(id: number) {
    const check = await this.prisma.inventoryCheck.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!check) throw new NotFoundException('Phiếu kiểm không tồn tại');

    // Rollback: khôi phục giá trị cũ vào Inventory
    await this.prisma.$transaction(async (tx) => {
      for (const detail of check.details) {
        await tx.inventory.updateMany({
          where: { productId: detail.productId, branchId: check.branchId },
          data: {
            damagedQuantity: Number(detail.previousDamaged),
            nearExpiryQuantity: Number(detail.previousNearExpiry),
          },
        });
      }

      await tx.inventoryCheck.delete({ where: { id } });
    });

    return { message: 'Xóa phiếu kiểm thành công' };
  }

  private async generateCode(): Promise<string> {
    const last = await this.prisma.inventoryCheck.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    const nextId = last ? parseInt(last.code.replace('KLB', ''), 10) + 1 : 1;

    return `KLB${String(nextId).padStart(6, '0')}`;
  }
}
