import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoicePaymentDto } from './dto';
import { INVOICE_STATUS, getStatusLabel } from './dto/invoice-status.constants';

@Injectable()
export class InvoicePaymentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInvoicePaymentDto, userId: number) {
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
              totalDebt: true,
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
      const code = `TT${invoice.code}-${paymentSequence}`;

      const payment = await tx.invoicePayment.create({
        data: {
          code,
          invoiceId: dto.invoiceId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.notes ||
            `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
        },
      });

      await this.calculateInvoiceTotals(dto.invoiceId, tx);

      if (invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);
      }

      const updatedCustomer = invoice.customerId
        ? await tx.customer.findUnique({
            where: { id: invoice.customerId },
            select: { totalDebt: true },
          })
        : null;

      const customerDebtSnapshot = updatedCustomer
        ? Number(updatedCustomer.totalDebt)
        : null;

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: invoice.branchId,
          isReceipt: true,
          amount: dto.amount,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: invoice.customerId,
          partnerName: invoice.customer?.name,
          contactNumber: invoice.customer?.contactNumber,
          address: invoice.customer?.address,
          description:
            dto.notes ||
            `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          customerDebtSnapshot,
        },
      });

      const paymentResult = await tx.invoicePayment.findUnique({
        where: { id: payment.id },
        include: { invoice: true },
      });

      return {
        payment: paymentResult,
        cashFlow,
      };
    });
  }

  async findAllByInvoice(invoiceId: number) {
    return this.prisma.invoicePayment.findMany({
      where: { invoiceId },
      orderBy: { paymentDate: 'desc' },
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.invoicePayment.findUnique({ where: { id } });
      if (!payment) {
        throw new Error('Payment not found');
      }

      await tx.cashFlow.deleteMany({
        where: { code: payment.code },
      });

      await tx.invoicePayment.delete({ where: { id } });
      await this.calculateInvoiceTotals(payment.invoiceId, tx);

      const invoice = await tx.invoice.findUnique({
        where: { id: payment.invoiceId },
      });
      if (invoice && invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);
      }
    });
  }

  private async calculateInvoiceTotals(invoiceId: number, tx: any) {
    const payments = await tx.invoicePayment.findMany({ where: { invoiceId } });
    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );

    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return;

    const debtAmount = Number(invoice.grandTotal) - paidAmount;
    let status: number = INVOICE_STATUS.PROCESSING;
    if (debtAmount <= 0) {
      status = INVOICE_STATUS.COMPLETED;
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount,
        debtAmount,
        status,
        statusValue: getStatusLabel(status),
      },
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: {
        customerId,
        status: {
          notIn: [2],
        },
      },
    });

    const totalDebt = invoices.reduce(
      (sum: number, invoice: any) => sum + Number(invoice.debtAmount),
      0,
    );

    await tx.customer.update({
      where: { id: customerId },
      data: { totalDebt },
    });
  }
}
