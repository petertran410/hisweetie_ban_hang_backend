// src/branches/branches.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BranchesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.branch.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findByUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: true,
      },
    });

    if (user?.branchId) {
      return [user.branch];
    }

    return this.findAll();
  }

  async findOne(id: number) {
    return this.prisma.branch.findUnique({
      where: { id },
    });
  }
}
