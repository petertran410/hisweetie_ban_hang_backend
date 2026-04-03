import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CashFlowCollectionBranchesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.cashFlowCollectionBranch.findMany({
      orderBy: { name: 'desc' },
    });
  }

  async create(data: { name: string; description?: string }) {
    return this.prisma.cashFlowCollectionBranch.create({
      data: {
        name: data.name,
        description: data.description,
      },
    });
  }
}
