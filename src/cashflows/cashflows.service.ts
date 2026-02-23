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
      const method = dto.method || 'cash';
      const code = await this.generateManualCode(dto.isReceipt, method, tx);

      const statusValue = dto.isReceipt ? 'Đã thanh toán' : 'Đã chi';

      let customerDebtSnapshot: number | null = null;

      if (dto.affectDebt && dto.partnerId && dto.partnerType === 'C') {
        const customer = await tx.customer.findUnique({
          where: { id: dto.partnerId },
          select: { totalDebt: true },
        });

        if (customer) {
          const debtChange = dto.isReceipt ? -dto.amount : dto.amount;
          const newTotalDebt = Number(customer.totalDebt) + debtChange;

          await tx.customer.update({
            where: { id: dto.partnerId },
            data: { totalDebt: newTotalDebt },
          });

          customerDebtSnapshot = newTotalDebt;
        }

        if (
          dto.allocateToInvoices &&
          dto.invoiceAllocations &&
          dto.invoiceAllocations.length > 0
        ) {
          for (const allocation of dto.invoiceAllocations) {
            const invoice = await tx.invoice.findUnique({
              where: { id: allocation.invoiceId },
            });

            if (!invoice) {
              throw new Error(
                `Không tìm thấy hóa đơn ID ${allocation.invoiceId}`,
              );
            }

            if (invoice.customerId !== dto.partnerId) {
              throw new Error(
                `Hóa đơn ${invoice.code} không thuộc về khách hàng này`,
              );
            }

            const existingPayments = await tx.invoicePayment.findMany({
              where: { invoiceId: allocation.invoiceId },
            });
            const paymentSequence = existingPayments.length + 1;
            const paymentCode = `TT${invoice.code}-${paymentSequence}`;

            await tx.invoicePayment.create({
              data: {
                code: paymentCode,
                invoiceId: allocation.invoiceId,
                amount: allocation.amount,
                paymentDate: dto.transDate
                  ? new Date(dto.transDate)
                  : new Date(),
                paymentMethod: method,
                accountId: dto.accountId,
                description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
                status: 1,
              },
            });

            const allPayments = await tx.invoicePayment.findMany({
              where: { invoiceId: allocation.invoiceId },
            });
            const paidAmount = allPayments.reduce(
              (sum: number, p: any) => sum + Number(p.amount),
              0,
            );

            const debtAmount = Number(invoice.grandTotal) - paidAmount;
            let status = 3;
            if (debtAmount <= 0) {
              status = 1;
            }

            await tx.invoice.update({
              where: { id: allocation.invoiceId },
              data: {
                paidAmount,
                debtAmount,
                status,
                statusValue: status === 1 ? 'Hoàn thành' : 'Đang xử lý',
              },
            });
          }
        }
      }

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: dto.branchId,
          cashFlowGroupId: dto.cashFlowGroupId,
          isReceipt: dto.isReceipt,
          amount: dto.amount,
          transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
          method: method,
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
          collectorUserId: dto.collectorUserId || userId,
          customerDebtSnapshot,
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
      invoiceId,
      limit,
      pageSize = 20,
      currentItem = 0,
    } = query;

    const take = limit || pageSize;

    const where: any = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (code && code.length > 0) {
      where.code = { in: code };
    } else {
      where.code = {
        not: {
          startsWith: 'TTTU',
        },
      };
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

    if (invoiceId) {
      where.code = {
        contains: `TT`,
      };
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { code: true },
      });
      if (invoice) {
        where.code = {
          contains: invoice.code,
        };
      }
      where.invoicePayments = {
        some: {
          invoiceId: invoiceId,
        },
      };
    }

    const [cashFlows, total] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
          cashFlowGroup: { select: { id: true, name: true } },
          account: {
            select: { id: true, bankName: true, accountNumber: true },
          },
          creator: { select: { id: true, name: true } },
        },
        orderBy: { transDate: 'desc' },
        skip: currentItem,
        take: take,
      }),
      this.prisma.cashFlow.count({ where }),
    ]);

    const data = cashFlows.map((cashFlow) => ({
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
    }));

    return {
      total,
      pageSize: take,
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

    let customer: any = null;
    if (cashFlow.partnerType === 'C' && cashFlow.partnerId) {
      customer = await this.prisma.customer.findUnique({
        where: { id: cashFlow.partnerId },
      });
    }

    let supplier: any = null;
    if (cashFlow.partnerType === 'S' && cashFlow.partnerId) {
      supplier = await this.prisma.supplier.findUnique({
        where: { id: cashFlow.partnerId },
        select: {
          id: true,
          code: true,
          name: true,
          contactNumber: true,
          address: true,
          debt: true,
        },
      });
    }

    return {
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
      customer,
      supplier,
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

  async createPaymentFromInvoice(
    dto: CreatePaymentDto,
    userId: number,
  ): Promise<any> {
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

      if (!invoice.branchId) {
        throw new Error('Hóa đơn không có thông tin chi nhánh');
      }

      const existingPayments = await tx.invoicePayment.findMany({
        where: { invoiceId: dto.invoiceId },
      });
      const paymentSequence = existingPayments.length + 1;
      const cashFlowCode = `TT${invoice.code}-${paymentSequence}`;

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

      const invoicePayment = await tx.invoicePayment.create({
        data: {
          code: cashFlowCode,
          invoiceId: dto.invoiceId,
          amount: dto.amount,
          paymentDate: new Date(),
          paymentMethod: dto.method || 'cash',
          accountId: dto.accountId,
          cashFlowId: cashFlow.id,
          description: `Thu tiền hóa đơn ${invoice.code}`,
          status: 1,
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
        invoiceStatus = 1;
      }

      await tx.invoice.update({
        where: { id: dto.invoiceId },
        data: {
          paidAmount,
          debtAmount,
          status: invoiceStatus,
          statusValue: invoiceStatus === 1 ? 'Hoàn thành' : 'Đang xử lý',
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

  async getRelatedInvoicePayments(cashFlowId: number): Promise<any> {
    const cashFlow = await this.prisma.cashFlow.findUnique({
      where: { id: cashFlowId },
    });

    if (!cashFlow) {
      throw new Error('Cash flow not found');
    }

    const invoicePayments = await this.prisma.invoicePayment.findMany({
      where: {
        code: {
          startsWith: cashFlow.code,
        },
      },
      include: {
        invoice: {
          select: {
            id: true,
            code: true,
            grandTotal: true,
            paidAmount: true,
            debtAmount: true,
            status: true,
          },
        },
      },
      orderBy: {
        paymentDate: 'desc',
      },
    });

    return invoicePayments;
  }

  private async generateManualCode(
    isReceipt: boolean,
    method: string,
    tx: any,
  ): Promise<string> {
    let prefix = '';

    if (isReceipt) {
      if (method === 'cash') {
        prefix = 'TTM';
      } else if (method === 'transfer') {
        prefix = 'TTNH';
      } else if (method === 'ewallet') {
        prefix = 'TTVDT';
      } else {
        prefix = 'TT';
      }
    } else {
      if (method === 'cash') {
        prefix = 'PCM';
      } else if (method === 'transfer') {
        prefix = 'PCNH';
      } else if (method === 'ewallet') {
        prefix = 'PCVDT';
      } else {
        prefix = 'PC';
      }
    }

    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allCashFlows = await tx.cashFlow.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
          isReceipt,
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allCashFlows
        .map((cf: any) => cf.code)
        .filter((code: string) => regex.test(code));

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.cashFlow.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu thu/chi duy nhất');
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
          totalDebt: true,
        },
      });

      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      if (!dto.branchId) {
        throw new Error('Vui lòng chọn chi nhánh');
      }

      const currentCustomerDebt = Number(customer.totalDebt);
      const newTotalDebt = currentCustomerDebt - dto.totalAmount;

      await tx.customer.update({
        where: { id: dto.customerId },
        data: { totalDebt: newTotalDebt },
      });

      const customerDebtSnapshot = newTotalDebt;

      const code = await this.generateSafeCashFlowCode(true, tx);

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: dto.branchId,
          cashFlowGroupId: 1,
          isReceipt: true,
          amount: dto.totalAmount,
          transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
          method: dto.method || 'cash',
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: dto.customerId,
          partnerName: customer.name,
          contactNumber: customer.contactNumber,
          address: customer.address,
          description: dto.description || 'Thu tiền khách hàng',
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          collectorUserId: dto.collectorUserId || userId,
          usedForFinancialReporting: 1,
          customerDebtSnapshot,
        },
      });

      const invoicePayments: any[] = [];

      if (dto.allocateToInvoices && dto.invoices && dto.invoices.length > 0) {
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

          if (invoiceData.customerId !== dto.customerId) {
            throw new Error(
              `Hóa đơn ${invoiceData.code} không thuộc về khách hàng này`,
            );
          }

          const currentDebt = Number(invoiceData.debtAmount);
          if (invoice.amount > currentDebt) {
            throw new Error(
              `Số tiền thanh toán ${invoice.amount} vượt quá công nợ ${currentDebt} của hóa đơn ${invoiceData.code}`,
            );
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
              status: 1,
              cashFlowId: cashFlow.id,
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
            status = 1;
          }

          await tx.invoice.update({
            where: { id: invoice.invoiceId },
            data: {
              paidAmount,
              debtAmount,
              status,
              statusValue: status === 1 ? 'Hoàn thành' : 'Đang xử lý',
            },
          });
        }
      }

      return {
        cashFlow,
        invoicePayments,
      };
    });
  }

  private async generateSafeCashFlowCode(
    isReceipt: boolean,
    tx: any,
  ): Promise<string> {
    const prefix = isReceipt ? 'TT' : 'PC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allCashFlows = await tx.cashFlow.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
          isReceipt,
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allCashFlows
        .map((cf: any) => cf.code)
        .filter((code: string) => regex.test(code));

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.cashFlow.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu thu/chi duy nhất');
  }
}
