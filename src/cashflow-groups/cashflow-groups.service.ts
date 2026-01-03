import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CashFlowGroupsService {
  constructor(private prisma: PrismaService) {}

  async findAll(isReceipt?: boolean) {
    const where: any = {};
    if (isReceipt !== undefined) {
      where.isReceipt = isReceipt;
    }

    return this.prisma.cashFlowGroup.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  async create(data: {
    name: string;
    description?: string;
    isReceipt: boolean;
  }) {
    return this.prisma.cashFlowGroup.create({
      data: {
        name: data.name,
        description: data.description,
        isReceipt: data.isReceipt,
        isDefault: false,
      },
    });
  }
}
