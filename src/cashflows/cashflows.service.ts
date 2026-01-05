import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
  CreateCustomerPaymentDto,
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

      return {
        ...cashFlow,
        branchName: cashFlow.branch?.name,
        cashFlowGroupName: cashFlow.cashFlowGroup?.name,
        creatorName: cashFlow.creator?.name,
      };
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

    const [total, cashFlows] = await Promise.all([
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

    const data = cashFlows.map((cashFlow) => ({
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
    }));

    return {
      total,
      pageSize,
      data,
    };
  }

  async findOne(id: number) {
    const cashFlow = await this.prisma.cashFlow.findUnique({
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

    if (!cashFlow) {
      return null;
    }

    return {
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
    };
  }

  async update(id: number, dto: UpdateCashFlowDto) {
    const cashFlow = await this.prisma.cashFlow.update({
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

    return {
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
    };
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
        cashFlow: {
          ...cashFlow,
          branchName: cashFlow.branch?.name,
          cashFlowGroupName: cashFlow.cashFlowGroup?.name,
          creatorName: cashFlow.creator?.name,
        },
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

  async getOpeningBalance(filters: any) {
    const { startDate } = filters;

    if (!startDate) {
      return 0;
    }

    const receipts = await this.prisma.cashFlow.aggregate({
      where: {
        isReceipt: true,
        status: 0,
        transDate: {
          lt: new Date(startDate),
        },
      },
      _sum: {
        amount: true,
      },
    });

    const payments = await this.prisma.cashFlow.aggregate({
      where: {
        isReceipt: false,
        status: 0,
        transDate: {
          lt: new Date(startDate),
        },
      },
      _sum: {
        amount: true,
      },
    });

    return (
      Number(receipts._sum.amount || 0) - Number(payments._sum.amount || 0)
    );
  }

  async createCustomerPayment(dto: CreateCustomerPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: dto.customerId },
        select: {
          id: true,
          name: true,
          contactNumber: true,
          address: true,
        },
      });

      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const code = await this.generateManualCode(true, tx);

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          isReceipt: true,
          amount: dto.totalAmount,
          transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
          method: dto.method,
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: dto.customerId,
          partnerName: customer.name,
          contactNumber: customer.contactNumber,
          address: customer.address,
          description:
            dto.description || `Thu tiền khách hàng ${customer.name}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
        },
      });

      const invoicePayments: any[] = [];
      for (const invoice of dto.invoices) {
        const invoiceData = await tx.invoice.findUnique({
          where: { id: invoice.invoiceId },
          include: {
            payments: true,
          },
        });

        if (!invoiceData) {
          throw new Error(`Không tìm thấy hóa đơn ID ${invoice.invoiceId}`);
        }

        const existingPayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invoice.invoiceId },
        });
        const paymentSequence = existingPayments.length + 1;
        const paymentCode = `TT${invoiceData.code}-${paymentSequence}`;

        const payment = await tx.invoicePayment.create({
          data: {
            code: paymentCode,
            invoiceId: invoice.invoiceId,
            amount: invoice.amount,
            paymentDate: dto.transDate ? new Date(dto.transDate) : new Date(),
            paymentMethod: dto.method,
            accountId: dto.accountId,
            description:
              dto.description ||
              `Thu tiền hóa đơn ${invoiceData.code} - Lần ${paymentSequence}`,
          },
        });

        invoicePayments.push(payment);

        const allPayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invoice.invoiceId },
        });
        const paidAmount = allPayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );

        const debtAmount = Number(invoiceData.grandTotal) - paidAmount;
        let status = 3;
        if (debtAmount <= 0) {
          status = 4;
        }

        await tx.invoice.update({
          where: { id: invoice.invoiceId },
          data: {
            paidAmount,
            debtAmount,
            status,
            statusValue: status === 4 ? 'Hoàn thành' : 'Đang xử lý',
          },
        });
      }

      const invoices = await tx.invoice.findMany({
        where: { customerId: dto.customerId },
      });
      const totalDebt = invoices.reduce(
        (sum: number, inv: any) => sum + Number(inv.debtAmount),
        0,
      );

      await tx.customer.update({
        where: { id: dto.customerId },
        data: { totalDebt },
      });

      return {
        cashFlow,
        invoicePayments,
      };
    });
  }
}
