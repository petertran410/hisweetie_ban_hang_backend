import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserBankAccountDto } from './dto';

@Injectable()
export class UserBankAccountsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.userBankAccount.findMany({
      include: {
        user: { select: { id: true, name: true, email: true } },
        bankAccount: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByUser(userId: number) {
    return this.prisma.userBankAccount.findUnique({
      where: { userId },
      include: { bankAccount: true },
    });
  }

  async upsert(dto: CreateUserBankAccountDto) {
    // Vì userId @unique → upsert by userId.
    // Logic: nếu sale chưa có TK → tạo mới. Nếu đã có → đổi sang TK mới.
    return this.prisma.userBankAccount.upsert({
      where: { userId: dto.userId },
      update: { bankAccountId: dto.bankAccountId },
      create: { userId: dto.userId, bankAccountId: dto.bankAccountId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        bankAccount: true,
      },
    });
  }

  async remove(id: number) {
    const mapping = await this.prisma.userBankAccount.findUnique({
      where: { id },
    });
    if (!mapping) throw new NotFoundException('Mapping không tồn tại');
    await this.prisma.userBankAccount.delete({ where: { id } });
    return { message: 'Đã xóa mapping' };
  }
}
