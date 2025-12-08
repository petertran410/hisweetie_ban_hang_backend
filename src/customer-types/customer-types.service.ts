import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomerTypesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.customerType.findMany({
      include: {
        _count: {
          select: { customers: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.customerType.findUnique({
      where: { id },
      include: {
        customers: {
          where: { isActive: true },
          select: { id: true, code: true, name: true, phone: true },
        },
        _count: {
          select: { customers: true },
        },
      },
    });
  }

  async create(data: { name: string; description?: string }) {
    return this.prisma.customerType.create({
      data,
    });
  }

  async update(id: number, data: { name?: string; description?: string }) {
    return this.prisma.customerType.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    return this.prisma.customerType.delete({ where: { id } });
  }
}
