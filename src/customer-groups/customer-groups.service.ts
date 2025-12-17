import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomerGroupsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.customerGroup.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            customerGroupDetails: true,
          },
        },
      },
    });
  }
}
