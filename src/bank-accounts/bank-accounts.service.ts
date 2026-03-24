import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class BankAccountsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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

  async create(dto: CreateBankAccountDto, userId?: number) {
    const bankAccount = await this.prisma.bankAccount.create({
      data: dto,
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'BANK_ACCOUNT_CREATE',
        entityType: 'bank_accounts',
        entityId: bankAccount.id.toString(),
        category: getCategoryFromActionCode('BANK_ACCOUNT_CREATE'),
        severity: getSeverityFromActionCode('BANK_ACCOUNT_CREATE'),
        snapshot: {
          accountNumber: bankAccount.accountNumber,
          bankName: bankAccount.bankName,
          accountHolder: bankAccount.accountHolder,
          scope: bankAccount.scope,
        },
        message: renderAuditMessage('BANK_ACCOUNT_CREATE', {
          accountName: bankAccount.accountHolder,
          bankName: bankAccount.bankName,
        }),
        messageTemplate: 'BANK_ACCOUNT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return bankAccount;
  }

  async update(id: number, dto: UpdateBankAccountDto, userId?: number) {
    const existing = await this.findOne(id);
    const bankAccount = await this.prisma.bankAccount.update({
      where: { id },
      data: dto,
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'BANK_ACCOUNT_UPDATE',
        entityType: 'bank_accounts',
        entityId: id.toString(),
        category: getCategoryFromActionCode('BANK_ACCOUNT_UPDATE'),
        severity: getSeverityFromActionCode('BANK_ACCOUNT_UPDATE'),
        snapshot: {
          accountNumber: bankAccount.accountNumber,
          bankName: bankAccount.bankName,
          accountHolder: bankAccount.accountHolder,
          scope: bankAccount.scope,
        },
        message: renderAuditMessage('BANK_ACCOUNT_UPDATE', {
          accountName: bankAccount.accountHolder,
        }),
        messageTemplate: 'BANK_ACCOUNT_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return bankAccount;
  }

  async remove(id: number, userId?: number) {
    const bankAccount = await this.findOne(id);

    await this.prisma.bankAccount.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'BANK_ACCOUNT_DELETE',
        entityType: 'bank_accounts',
        entityId: id.toString(),
        category: getCategoryFromActionCode('BANK_ACCOUNT_DELETE'),
        severity: getSeverityFromActionCode('BANK_ACCOUNT_DELETE'),
        snapshot: {
          accountNumber: bankAccount.accountNumber,
          bankName: bankAccount.bankName,
          accountHolder: bankAccount.accountHolder,
        },
        message: renderAuditMessage('BANK_ACCOUNT_DELETE', {
          accountName: bankAccount.accountHolder,
        }),
        messageTemplate: 'BANK_ACCOUNT_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return { message: 'Xóa tài khoản ngân hàng thành công' };
  }
}
