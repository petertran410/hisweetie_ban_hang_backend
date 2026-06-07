import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoicePaymentDto } from './dto';
import { INVOICE_STATUS, getStatusLabel } from './dto/invoice-status.constants';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { recalcCustomerDebt } from 'src/common/customer-debt.util';

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
              code: true,
              name: true,
              contactNumber: true,
              totalDebt: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
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
          sepayTransactionId: dto.sepayTransactionId,
          sepayReferenceCode: dto.sepayReferenceCode,
          status: 1,
        },
      });

      await this.calculateInvoiceTotals(dto.invoiceId, tx);

      if (!invoice.branch) {
        throw new Error('Hóa đơn chưa có chi nhánh');
      }

      // [Reorder fix] Tạo CashFlow TRƯỚC khi updateCustomerTotals
      // để Formula A query thấy cả payment vừa tạo.
      // Snapshot tạm null, sẽ update sau khi recalculate xong.
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
          address: invoice.customer?.addresses?.[0]?.address || null,
          description:
            dto.notes ||
            `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          customerDebtSnapshot: null,
          sepayReferenceCode: dto.sepayReferenceCode,
        },
      });

      if (invoice.customerId) {
        await this.updateCustomerTotals(invoice.customerId, tx);

        // Sau khi recalculate, đọc lại totalDebt và update snapshot cho CashFlow vừa tạo
        const updatedCustomer = await tx.customer.findUnique({
          where: { id: invoice.customerId },
          select: { totalDebt: true },
        });
        if (updatedCustomer) {
          await tx.cashFlow.update({
            where: { id: cashFlow.id },
            data: { customerDebtSnapshot: Number(updatedCustomer.totalDebt) },
          });
        }
      }

      const paymentResult = await tx.invoicePayment.findUnique({
        where: { id: payment.id },
        include: { invoice: true },
      });

      const userName = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVOICE_PAYMENT_CREATE',
        entityType: 'invoice_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('INVOICE_PAYMENT_CREATE'),
        severity: getSeverityFromActionCode('INVOICE_PAYMENT_CREATE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          invoice: {
            code: invoice.code,
            customer: invoice.customer
              ? { code: invoice.customer.code, name: invoice.customer.name }
              : null,
          },
          accountId: payment.accountId,
        },
        message: renderAuditMessage('INVOICE_PAYMENT_CREATE', {
          paymentCode: payment.code,
          invoiceCode: invoice.code,
          amount: Number(payment.amount),
        }),
        messageTemplate: 'INVOICE_PAYMENT_CREATE',
        userId,
        userName: userName?.name || 'Unknown',
        branchId: invoice.branch?.id || undefined,
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
      const payment = await tx.invoicePayment.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          invoiceId: true,
          cashFlowId: true,
        },
      });
      if (!payment) {
        throw new Error('Payment not found');
      }

      // Soft-cancel cashFlow tương ứng (ưu tiên cashFlowId, fallback theo code)
      const orConditions: any[] = [];
      if (payment.cashFlowId != null) {
        orConditions.push({ id: payment.cashFlowId });
      }
      if (payment.code) {
        orConditions.push({ code: payment.code });
      }

      if (orConditions.length > 0) {
        await tx.cashFlow.updateMany({
          where: {
            OR: orConditions,
            status: { not: 2 },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      // Soft-cancel invoicePayment (thay vì hard-delete)
      await tx.invoicePayment.update({
        where: { id },
        data: { status: 2, statusValue: 'Đã hủy' },
      });

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
    // Tổng invoicePayment active (loại đã hủy)
    const payments = await tx.invoicePayment.findMany({
      where: { invoiceId, status: { not: 2 } },
    });
    const sumPayments = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );

    // Tổng CTN active (manual_offset, status=4) — tránh ghi đè mất phần CTN
    const ctns = await tx.returnOrder.findMany({
      where: { invoiceId, refundType: 'manual_offset', status: 4 },
      select: { refundAmount: true },
    });
    const sumCtns = ctns.reduce(
      (sum: number, c: any) => sum + Number(c.refundAmount),
      0,
    );

    const paidAmount = sumPayments + sumCtns;

    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return;

    const debtAmount = Number(invoice.grandTotal) - paidAmount;
    const currentStatus = invoice.status;

    let newStatus = currentStatus;

    if (debtAmount <= 0) {
      // Chỉ chuyển sang COMPLETED khi đã giao thành công (DELIVERED)
      if (currentStatus === INVOICE_STATUS.DELIVERED) {
        newStatus = INVOICE_STATUS.COMPLETED;
      }
    } else {
      // Hoàn tác: COMPLETED → DELIVERED (vẫn giao thành công, nhưng chưa thanh toán đủ)
      if (currentStatus === INVOICE_STATUS.COMPLETED) {
        newStatus = INVOICE_STATUS.DELIVERED;
      }
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount,
        debtAmount,
        status: newStatus,
        statusValue: getStatusLabel(newStatus),
      },
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [INVOICE_STATUS.CANCELLED] } },
      select: { grandTotal: true },
    });
    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );
    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased },
    });
    await recalcCustomerDebt(tx, customerId);
  }
}
