import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SaleChannelsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.saleChannel.findMany({
      where: { isActivate: true },
      orderBy: { position: 'asc' },
    });
  }
}
