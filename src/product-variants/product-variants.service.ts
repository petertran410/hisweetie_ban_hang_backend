import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductVariantsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.productVariant.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.productVariant.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async create(data: { name: string; code: string; description?: string }) {
    return this.prisma.productVariant.create({
      data,
    });
  }

  async update(
    id: number,
    data: {
      name?: string;
      code?: string;
      description?: string;
      isActive?: boolean;
    },
  ) {
    return this.prisma.productVariant.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    return this.prisma.productVariant.delete({ where: { id } });
  }
}
