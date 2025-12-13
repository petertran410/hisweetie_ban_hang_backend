import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private parseAttributes(
    attributesText: string | null,
  ): { name: string; value: string }[] {
    if (!attributesText) return [];
    return attributesText.split('|').map((attr) => {
      const [name, value] = attr.split(':');
      return { name: name?.trim() || '', value: value?.trim() || '' };
    });
  }

  private buildFullName(name: string, attributesText: string | null): string {
    if (!attributesText) return name;

    const attrs = this.parseAttributes(attributesText);
    if (attrs.length === 0) return name;

    const attrValues = attrs.map((attr) => attr.value).join(' - ');
    return `${name} - ${attrValues}`;
  }

  async findAll(query: ProductQueryDto) {
    const { page = 1, limit = 10, search, categoryId, isActive } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (categoryId) where.categoryId = categoryId;
    if (isActive !== undefined) where.isActive = isActive;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: { category: true, tradeMark: true, variant: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { category: true, variant: true, tradeMark: true, images: true },
    });
  }

  async create(dto: CreateProductDto) {
    const fullName =
      dto.fullName || this.buildFullName(dto.name, dto.attributesText || null);

    return this.prisma.product.create({
      data: {
        ...dto,
        fullName,
      },
      include: { category: true, variant: true, tradeMark: true },
    });
  }

  async update(id: number, dto: UpdateProductDto) {
    const currentProduct = await this.prisma.product.findUnique({
      where: { id },
    });

    if (!currentProduct) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    const name = dto.name || currentProduct.name;
    const attributesText =
      dto.attributesText !== undefined
        ? dto.attributesText
        : currentProduct.attributesText;

    let fullName = dto.fullName;
    if (!fullName || dto.attributesText !== undefined || dto.name) {
      fullName = this.buildFullName(name, attributesText);
    }

    if (dto.imageUrls !== undefined) {
      await this.prisma.productImage.deleteMany({
        where: { productId: id },
      });

      if (dto.imageUrls && dto.imageUrls.length > 0) {
        await this.prisma.productImage.createMany({
          data: dto.imageUrls.map((url) => ({
            productId: id,
            image: url,
          })),
        });
      }
    }

    return this.prisma.product.update({
      where: { id },
      data: {
        ...dto,
        fullName,
      },
      include: {
        category: true,
        variant: true,
        tradeMark: true,
        images: true, // THÊM DÒNG NÀY
      },
    });
  }

  async remove(id: number) {
    return this.prisma.product.delete({ where: { id } });
  }

  async updateStock(id: number, quantity: number) {
    return this.prisma.product.update({
      where: { id },
      data: { stockQuantity: { increment: quantity } },
    });
  }

  async checkLowStock() {
    return this.prisma.$queryRaw`
      SELECT * FROM products 
      WHERE "isActive" = true 
      AND "stockQuantity" <= "minStockAlert"
      ORDER BY "stockQuantity" ASC
    `;
  }
}
