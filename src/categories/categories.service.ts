import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.category.findMany({
      include: {
        parent: true,
        children: true,
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findRoots() {
    return this.prisma.category.findMany({
      where: { parentId: null },
      include: {
        children: {
          include: {
            children: {
              include: {
                _count: { select: { products: true } },
              },
            },
            _count: { select: { products: true } },
          },
        },
        _count: { select: { products: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.category.findUnique({
      where: { id },
      include: {
        parent: true,
        products: {
          select: { id: true, code: true, name: true, basePrice: true },
        },
        _count: {
          select: { products: true, children: true },
        },
      },
    });
  }

  async create(data: {
    name: string;
    description?: string;
    parentId?: number;
  }) {
    const categoryData: any = {
      name: data.name,
      description: data.description || null,
      parentId: data.parentId || null,
      isActive: true,
      hasChild: false,
    };

    const created = await this.prisma.category.create({
      data: categoryData,
      include: {
        parent: true,
        _count: {
          select: { products: true },
        },
      },
    });

    if (data.parentId) {
      await this.prisma.category.update({
        where: { id: data.parentId },
        data: { hasChild: true },
      });
    }

    return created;
  }

  async update(
    id: number,
    data: {
      name?: string;
      description?: string;
      parentId?: number;
    },
  ) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new Error('Category not found');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.parentId !== undefined) updateData.parentId = data.parentId;

    const updated = await this.prisma.category.update({
      where: { id },
      data: updateData,
      include: {
        parent: true,
        children: true,
        _count: {
          select: { products: true },
        },
      },
    });

    if (data.parentId !== undefined && data.parentId !== existing.parentId) {
      if (existing.parentId) {
        const siblingCount = await this.prisma.category.count({
          where: { parentId: existing.parentId, id: { not: id } },
        });
        if (siblingCount === 0) {
          await this.prisma.category.update({
            where: { id: existing.parentId },
            data: { hasChild: false },
          });
        }
      }

      if (data.parentId) {
        await this.prisma.category.update({
          where: { id: data.parentId },
          data: { hasChild: true },
        });
      }
    }

    return updated;
  }

  async remove(id: number) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      include: { children: true },
    });

    if (!existing) {
      throw new Error('Category not found');
    }

    if (existing.children.length > 0) {
      throw new Error('Cannot delete category with children');
    }

    const deleted = await this.prisma.category.delete({ where: { id } });

    if (existing.parentId) {
      const siblingCount = await this.prisma.category.count({
        where: { parentId: existing.parentId },
      });
      if (siblingCount === 0) {
        await this.prisma.category.update({
          where: { id: existing.parentId },
          data: { hasChild: false },
        });
      }
    }

    return deleted;
  }

  async findChildren(parentId: number) {
    return this.prisma.category.findMany({
      where: { parentId },
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }
}
