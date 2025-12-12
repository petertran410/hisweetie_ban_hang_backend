import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TrademarksService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.tradeMark.findMany({
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.tradeMark.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async create(data: { name: string; description?: string }) {
    return this.prisma.tradeMark.create({
      data,
    });
  }

  async update(id: number, data: { name?: string; description?: string }) {
    return this.prisma.tradeMark.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    return this.prisma.tradeMark.delete({ where: { id } });
  }
}
