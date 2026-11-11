import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalTemplateDto, ManufacturerDto, ManufacturerMaterialDto, OwnMaterialDto } from './dto';
import { materialAmount, ownConversion } from './external-production.util';

@Injectable()
export class ManufacturersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    search = '', includeInactive = false, pageSize = 30, currentItem = 0, isActive?: boolean,
    filters: { hasInProgress?: boolean; hasDebt?: boolean } = {},
  ) {
    const take = Math.max(1, Math.min(Number(pageSize) || 30, 100));
    const and: Prisma.ManufacturerWhereInput[] = [];
    // Independent predicates may match different batches of the same manufacturer.
    if (filters.hasInProgress !== undefined) {
      and.push({ productions: {
        [filters.hasInProgress ? 'some' : 'none']: { isExternal: true, status: 4 },
      } });
    }
    if (filters.hasDebt !== undefined) {
      and.push({ productions: {
        [filters.hasDebt ? 'some' : 'none']: { isExternal: true, status: 2, debtAmount: { gt: 0.005 } },
      } });
    }
    const where: Prisma.ManufacturerWhereInput = {
      ...(isActive !== undefined ? { isActive } : includeInactive ? {} : { isActive: true }),
      ...(and.length ? { AND: and } : {}),
      ...(search.trim() ? { OR: [
        { name: { contains: search.trim(), mode: 'insensitive' as const } },
        { code: { contains: search.trim(), mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.manufacturer.findMany({ where, include: { supplier: { select: { id: true, code: true, name: true } } }, orderBy: { name: 'asc' }, take, skip: Math.max(0, Number(currentItem) || 0) }),
      this.prisma.manufacturer.count({ where }),
    ]);
    return { data, total, pageSize: take };
  }

  async get(id: number) {
    const row = await this.prisma.manufacturer.findUnique({
      where: { id }, include: { supplier: { select: { id: true, code: true, name: true } } },
    });
    if (!row) throw new NotFoundException('Không tìm thấy nhà sản xuất');
    return row;
  }

  async save(dto: ManufacturerDto, id?: number) {
    if (!dto.name.trim()) throw new BadRequestException('Vui lòng nhập tên nhà sản xuất');
    if (dto.supplierId && !await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } })) {
      throw new BadRequestException('Không tìm thấy nhà cung cấp');
    }
    const data = { ...dto, name: dto.name.trim(), supplierId: dto.supplierId ?? null };
    if (id) {
      await this.get(id);
      return this.prisma.manufacturer.update({ where: { id }, data });
    }
    return this.prisma.manufacturer.create({ data: { ...data, code: dto.code?.trim() || `NSX${randomUUID().slice(0, 8).toUpperCase()}` } });
  }

  async validateMaterials(db: any, own: OwnMaterialDto[], supplied: ManufacturerMaterialDto[]) {
    const ids = own.map((line) => line.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Hàng mình gửi không được trùng mã');
    const products = await db.product.findMany({
      where: { id: { in: [...new Set([...ids, ...supplied.flatMap((line) => line.productId ? [line.productId] : [])])] } },
    });
    const byId = new Map<number, any>(products.map((product: any) => [product.id, product]));
    for (const line of own) {
      const product = byId.get(line.productId);
      if (!product || ![2, 4].includes(product.type)) throw new BadRequestException('Hàng gửi phải là hàng hóa có quản lý tồn');
      ownConversion(product, line.unit);
    }
    for (const line of supplied) {
      if (line.productId && !byId.has(line.productId)) throw new BadRequestException('Không tìm thấy nguyên liệu NSX');
      materialAmount(line);
    }
    return byId;
  }

  async templates(manufacturerId?: number, productId?: number) {
    return this.prisma.externalProductionTemplate.findMany({
      where: { isActive: true, ...(manufacturerId ? { manufacturerId } : {}), ...(productId ? { productId } : {}) },
      include: { lines: { orderBy: { sortOrder: 'asc' } }, manufacturer: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async saveTemplate(dto: ExternalTemplateDto, id?: number) {
    if (!dto.name.trim()) throw new BadRequestException('Vui lòng nhập tên mẫu');
    if (!dto.ownMaterials.length && !dto.manufacturerMaterials.length) throw new BadRequestException('Mẫu cần ít nhất một nguyên liệu');
    return this.prisma.$transaction(async (tx) => {
      const manufacturer = await tx.manufacturer.findUnique({ where: { id: dto.manufacturerId } });
      const product = await tx.product.findUnique({ where: { id: dto.productId } });
      if (!manufacturer?.isActive || !product || ![2, 4].includes(product.type)) throw new BadRequestException('Nhà sản xuất hoặc thành phẩm không hợp lệ');
      const products = await this.validateMaterials(tx, dto.ownMaterials, dto.manufacturerMaterials);
      const data = {
        name: dto.name.trim(), manufacturerId: dto.manufacturerId, productId: dto.productId,
        baseQuantity: dto.baseQuantity, currency: dto.currency,
        processingFee: dto.processingFee ?? 0, exchangeRate: dto.exchangeRate ?? 1,
      };
      const lines = [
        ...dto.ownMaterials.map((line) => ({
          source: 'OWN', productId: line.productId, description: products.get(line.productId).name,
          quantity: line.quantity, unit: line.unit, pricingMode: 'UNIT_PRICE', unitPrice: 0, amount: 0,
        })),
        ...dto.manufacturerMaterials.map((line) => ({
          source: 'MANUFACTURER', productId: line.productId ?? null,
          description: line.description?.trim() || (line.productId ? products.get(line.productId).name : 'Nguyên liệu NSX bổ sung'),
          quantity: line.quantity ?? null, unit: line.unit ?? null, pricingMode: line.pricingMode,
          unitPrice: line.unitPrice ?? 0, amount: materialAmount(line),
        })),
      ].map((line, sortOrder) => ({ ...line, sortOrder }));
      if (id) {
        if (!await tx.externalProductionTemplate.findUnique({ where: { id } })) throw new NotFoundException('Không tìm thấy mẫu');
        return tx.externalProductionTemplate.update({
          where: { id }, data: { ...data, lines: { deleteMany: {}, create: lines } }, include: { lines: true },
        });
      }
      return tx.externalProductionTemplate.create({ data: { ...data, lines: { create: lines } }, include: { lines: true } });
    });
  }

  async deactivateTemplate(id: number) {
    return this.prisma.externalProductionTemplate.update({ where: { id }, data: { isActive: false } });
  }
}
