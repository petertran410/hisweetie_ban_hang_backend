import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoicePaymentDto } from './dto';
import { INVOICE_STATUS, getStatusLabel } from './dto/invoice-status.constants';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { request } from 'http';

@Injectable()
export class InvoicePaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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
          branch: true,
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
          status: 1,
        },
      });

      await this.calculateInvoiceTotals(dto.invoiceId, tx);

      if (invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);
      }

      if (!invoice.branch) {
        throw new Error('Hóa đơn chưa có chi nhánh');
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
          branchId: invoice.branch?.id,
          cashFlowGroupId: 3,
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

      const userName = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      const customer = await this.prisma.customer.findUnique({
        where: { id: invoice.customer?.id },
        select: { name: true, code: true },
      });

      const methodMap: Record<string, string> = {
        cash: 'Tiền mặt',
        transfer: 'Chuyển khoản',
        card: 'Thẻ',
        ewallet: 'Ví điện tử',
      };

      const formattedDate = new Date(payment.paymentDate).toLocaleString(
        'vi-VN',
        {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        },
      );

      const message = `Tạo phiếu thu: ${payment.code}, cho hóa đơn: ${invoice.code}, khách hàng ${invoice.customer?.id ? `${customer?.name}` : 'N/A'}, với giá trị: ${Number(payment.amount).toLocaleString('vi-VN')}, phương thức thanh toán: ${payment.paymentMethod ? methodMap[payment.paymentMethod] || payment.paymentMethod : 'Tiền mặt'}, thời gian: ${formattedDate}`;

      await this.auditLogsService.create({
        userId: userId,
        userName: userName?.name || 'Unknown',
        actionType: 'create',
        actionCode: 'INVOICE_PAYMENT_CREATE',
        entityType: 'invoice_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        newValues: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          invoice: {
            code: invoice.code,
            customer: {
              code: invoice.customer?.id ? `KH${invoice.customer.id}` : 'N/A',
            },
          },
        },
        message,
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
