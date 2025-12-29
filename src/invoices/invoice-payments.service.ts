import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoicePaymentDto } from './dto';
import { INVOICE_STATUS, getStatusLabel } from './dto/invoice-status.constants';

@Injectable()
export class InvoicePaymentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInvoicePaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode();

      const payment = await tx.invoicePayment.create({
        data: {
          code,
          invoiceId: dto.invoiceId,
          paymentDate: dto.paymentDate || new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          description: dto.notes,
        },
      });

      await this.calculateInvoiceTotals(dto.invoiceId, tx);

      const invoice = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
      });
      if (invoice && invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);
      }

      return tx.invoicePayment.findUnique({
        where: { id: payment.id },
        include: { invoice: true },
      });
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

  private async generateCode(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.invoicePayment.count({
      where: {
        createdAt: {
          gte: new Date(today.setHours(0, 0, 0, 0)),
        },
      },
    });
    return `PTHD-${dateStr}-${String(count + 1).padStart(4, '0')}`;
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

    let status = INVOICE_STATUS.PROCESSING;
    if (debtAmount <= 0) {
      status = INVOICE_STATUS.COMPLETED;
    } else if (invoice.status === INVOICE_STATUS.CANCELLED) {
      status = INVOICE_STATUS.CANCELLED;
    } else if (invoice.status === INVOICE_STATUS.FAILED_DELIVERY) {
      status = INVOICE_STATUS.FAILED_DELIVERY;
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
        status: { notIn: [INVOICE_STATUS.CANCELLED] },
      },
    });

    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );
    const totalDebt = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.debtAmount),
      0,
    );

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }
}
