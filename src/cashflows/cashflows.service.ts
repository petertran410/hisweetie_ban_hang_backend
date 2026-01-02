import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
} from './dto';

@Injectable()
export class CashFlowsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCashFlowDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateManualCode(dto.isReceipt, tx);

      const statusValue = dto.isReceipt ? 'Đã thanh toán' : 'Đã chi';

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: dto.branchId,
          cashFlowGroupId: dto.cashFlowGroupId,
          isReceipt: dto.isReceipt,
          amount: dto.amount,
          transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
          method: dto.method || 'cash',
          accountId: dto.accountId,
          partnerType: dto.partnerType,
          partnerId: dto.partnerId,
          partnerName: dto.partnerName,
          contactNumber: dto.contactNumber,
          address: dto.address,
          wardName: dto.wardName,
          usedForFinancialReporting: dto.usedForFinancialReporting ?? 1,
          description: dto.description,
          status: 0,
          statusValue,
          createdBy: userId,
        },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          cashFlowGroup: {
            select: {
              id: true,
              name: true,
            },
          },
          account: {
            select: {
              id: true,
              bankName: true,
              accountNumber: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return cashFlow;
    });
  }

  async findAll(query: CashFlowQueryDto) {
    const {
      branchIds,
      code,
      userId,
      accountId,
      partnerType,
      method,
      cashFlowGroupId,
      usedForFinancialReporting,
      partnerName,
      contactNumber,
      isReceipt,
      startDate,
      endDate,
      status,
      ids,
      pageSize = 20,
      currentItem = 0,
    } = query;

    const where: any = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (code && code.length > 0) {
      where.code = { in: code };
    }

    if (userId) {
      where.createdBy = userId;
    }

    if (accountId) {
      where.accountId = accountId;
    }

    if (partnerType && partnerType !== 'A') {
      where.partnerType = partnerType;
    }

    if (method && method.length > 0) {
      where.method = { in: method };
    }

    if (cashFlowGroupId && cashFlowGroupId.length > 0) {
      where.cashFlowGroupId = { in: cashFlowGroupId };
    }

    if (usedForFinancialReporting !== undefined) {
      where.usedForFinancialReporting = usedForFinancialReporting;
    }

    if (partnerName) {
      where.partnerName = { contains: partnerName, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.contactNumber = { contains: contactNumber };
    }

    if (isReceipt !== undefined) {
      where.isReceipt = isReceipt;
    }

    if (startDate || endDate) {
      where.transDate = {};
      if (startDate) {
        where.transDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.transDate.lte = new Date(endDate);
      }
    }

    if (status !== undefined) {
      where.status = status;
    }

    if (ids && ids.length > 0) {
      where.id = { in: ids };
    }

    const [total, data] = await Promise.all([
      this.prisma.cashFlow.count({ where }),
      this.prisma.cashFlow.findMany({
        where,
        include: {
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          cashFlowGroup: {
            select: {
              id: true,
              name: true,
            },
          },
          account: {
            select: {
              id: true,
              bankName: true,
              accountNumber: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: {
          transDate: 'desc',
        },
        skip: currentItem,
        take: pageSize,
      }),
    ]);

    return {
      total,
      pageSize,
      data,
    };
  }

  async findOne(id: number) {
    return this.prisma.cashFlow.findUnique({
      where: { id },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        cashFlowGroup: {
          select: {
            id: true,
            name: true,
          },
        },
        account: {
          select: {
            id: true,
            bankName: true,
            accountNumber: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  async update(id: number, dto: UpdateCashFlowDto) {
    return this.prisma.cashFlow.update({
      where: { id },
      data: {
        branchId: dto.branchId,
        cashFlowGroupId: dto.cashFlowGroupId,
        amount: dto.amount,
        transDate: dto.transDate ? new Date(dto.transDate) : undefined,
        method: dto.method,
        accountId: dto.accountId,
        partnerType: dto.partnerType,
        partnerId: dto.partnerId,
        partnerName: dto.partnerName,
        contactNumber: dto.contactNumber,
        address: dto.address,
        wardName: dto.wardName,
        usedForFinancialReporting: dto.usedForFinancialReporting,
        description: dto.description,
      },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        cashFlowGroup: {
          select: {
            id: true,
            name: true,
          },
        },
        account: {
          select: {
            id: true,
            bankName: true,
            accountNumber: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  async cancel(id: number) {
    const cashFlow = await this.prisma.cashFlow.findUnique({ where: { id } });
    if (!cashFlow) {
      throw new Error('Không tìm thấy phiếu thu/chi');
    }

    return this.prisma.cashFlow.update({
      where: { id },
      data: {
        status: 1,
        statusValue: 'Đã hủy',
      },
    });
  }

  async createPaymentFromInvoice(dto: CreatePaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
            },
          },
        },
      });

      if (!invoice) {
        throw new Error('Không tìm thấy hóa đơn');
      }

      const existingPayments = await tx.invoicePayment.findMany({
        where: { invoiceId: dto.invoiceId },
      });
      const paymentSequence = existingPayments.length + 1;
      const cashFlowCode = `TT${invoice.code}-${paymentSequence}`;

      const invoicePayment = await tx.invoicePayment.create({
        data: {
          code: cashFlowCode,
          invoiceId: dto.invoiceId,
          amount: dto.amount,
          paymentDate: new Date(),
          paymentMethod: dto.method || 'cash',
          accountId: dto.accountId,
          description: `Thu tiền hóa đơn ${invoice.code}`,
        },
      });

      const cashFlow = await tx.cashFlow.create({
        data: {
          code: cashFlowCode,
          branchId: invoice.branchId,
          isReceipt: true,
          amount: dto.amount,
          transDate: new Date(),
          method: dto.method || 'cash',
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: invoice.customerId,
          partnerName: invoice.customer?.name,
          contactNumber: invoice.customer?.contactNumber,
          address: invoice.customer?.address,
          description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
        },
      });

      const payments = await tx.invoicePayment.findMany({
        where: { invoiceId: dto.invoiceId },
      });
      const paidAmount = payments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );

      const debtAmount = Number(invoice.grandTotal) - paidAmount;
      let invoiceStatus = 3;
      if (debtAmount <= 0) {
        invoiceStatus = 4;
      }

      await tx.invoice.update({
        where: { id: dto.invoiceId },
        data: {
          paidAmount,
          debtAmount,
          status: invoiceStatus,
          statusValue: invoiceStatus === 4 ? 'Hoàn thành' : 'Đang xử lý',
        },
      });

      if (invoice.customerId) {
        const invoices = await tx.invoice.findMany({
          where: { customerId: invoice.customerId },
        });
        const totalDebt = invoices.reduce(
          (sum: number, inv: any) => sum + Number(inv.debtAmount),
          0,
        );

        await tx.customer.update({
          where: { id: invoice.customerId },
          data: { totalDebt },
        });
      }

      return {
        invoicePayment,
        cashFlow,
      };
    });
  }

  private async generateManualCode(
    isReceipt: boolean,
    tx?: any,
  ): Promise<string> {
    const prisma = tx || this.prisma;
    const prefix = isReceipt ? 'TT' : 'PC';

    const lastCashFlow = await prisma.cashFlow.findFirst({
      where: {
        code: {
          startsWith: prefix,
        },
        isReceipt,
      },
      orderBy: {
        id: 'desc',
      },
    });

    let nextNumber = 1;
    if (lastCashFlow && lastCashFlow.code) {
      const match = lastCashFlow.code.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0]) + 1;
      }
    }

    return `${prefix}${String(nextNumber).padStart(6, '0')}`;
  }
}
