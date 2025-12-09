import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.category.findMany({
      where: { isActive: true },
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
      where: { isActive: true, parentId: null },
      include: {
        children: {
          where: { isActive: true },
          include: {
            _count: {
              select: { products: true },
            },
          },
        },
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.category.findUnique({
      where: { id },
      include: {
        parent: true,
        children: {
          where: { isActive: true },
        },
        products: {
          where: { isActive: true },
          select: { id: true, code: true, name: true, retailPrice: true },
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
    return this.prisma.category.create({
      data,
      include: {
        parent: true,
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async update(
    id: number,
    data: {
      name?: string;
      description?: string;
      parentId?: number;
      isActive?: boolean;
    },
  ) {
    return this.prisma.category.update({
      where: { id },
      data,
      include: {
        parent: true,
        children: true,
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async remove(id: number) {
    return this.prisma.category.delete({ where: { id } });
  }

  async findChildren(parentId: number) {
    return this.prisma.category.findMany({
      where: { parentId, isActive: true },
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }
}
