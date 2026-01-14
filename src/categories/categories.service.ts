import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CategoryType = 'parent' | 'middle' | 'child';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.category.findMany({
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async findByType(type: CategoryType) {
    return this.prisma.category.findMany({
      where: { type },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.category.findUnique({
      where: { id },
    });
  }

  async create(data: { name: string; type: CategoryType }) {
    return this.prisma.category.create({
      data,
    });
  }

  async update(id: number, data: { name?: string; type?: CategoryType }) {
    return this.prisma.category.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    return this.prisma.category.delete({ where: { id } });
  }

  async getProductCountByCategory(type: CategoryType, name: string) {
    const field =
      type === 'parent'
        ? 'parentName'
        : type === 'middle'
          ? 'middleName'
          : 'childName';
    return this.prisma.product.count({
      where: { [field]: name },
    });
  }
}
