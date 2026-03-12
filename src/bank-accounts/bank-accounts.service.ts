import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto';

@Injectable()
export class BankAccountsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.bankAccount.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const bankAccount = await this.prisma.bankAccount.findUnique({
      where: { id },
    });
    if (!bankAccount) throw new NotFoundException('Bank account not found');
    return bankAccount;
  }

  async create(dto: CreateBankAccountDto) {
    return this.prisma.bankAccount.create({
      data: dto,
    });
  }

  async update(id: number, dto: UpdateBankAccountDto) {
    await this.findOne(id);
    return this.prisma.bankAccount.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.bankAccount.delete({
      where: { id },
    });
  }
}
