import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

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
        include: { category: true, variant: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { category: true, variant: true },
    });
  }

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: dto,
      include: { category: true, variant: true },
    });
  }

  async update(id: number, dto: UpdateProductDto) {
    return this.prisma.product.update({
      where: { id },
      data: dto,
      include: { category: true, variant: true },
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
      WHERE isActive = true 
      AND stock_quantity <= min_stock_alert
      ORDER BY stock_quantity ASC
    `;
  }
}
