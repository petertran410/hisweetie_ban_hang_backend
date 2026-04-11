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

      const invoiceCustomer = invoice.customerId
        ? await tx.customer.findUnique({
            where: { id: invoice.customerId },
            select: { id: true, parentId: true },
          })
        : null;

      const debtHolderId = invoiceCustomer?.parentId || invoice.customerId;
      const updatedDebtHolder = debtHolderId
        ? await tx.customer.findUnique({
            where: { id: debtHolderId },
            select: { totalDebt: true },
          })
        : null;

      const customerDebtSnapshot = updatedDebtHolder
        ? Number(updatedDebtHolder.totalDebt)
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
    const currentStatus = invoice.status;

    let newStatus = currentStatus;

    if (debtAmount <= 0) {
      if (
        currentStatus === INVOICE_STATUS.PROCESSING ||
        currentStatus === INVOICE_STATUS.DELIVERED
      ) {
        newStatus = INVOICE_STATUS.COMPLETED;
      }
    } else {
      if (currentStatus === INVOICE_STATUS.COMPLETED) {
        newStatus = INVOICE_STATUS.PROCESSING;
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
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true, parentId: true },
    });

    if (!customer) return;

    const targetCustomerId = customer.parentId || customerId;

    const childIds = await tx.customer.findMany({
      where: { parentId: targetCustomerId },
      select: { id: true },
    });

    const allCustomerIds = [
      targetCustomerId,
      ...childIds.map((c: any) => c.id),
    ];

    const invoices = await tx.invoice.findMany({
      where: {
        customerId: { in: allCustomerIds },
        status: { notIn: [2] },
      },
      select: { grandTotal: true },
    });
    const totalGrandTotal = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );

    const cashFlowsReceipt = await tx.cashFlow.findMany({
      where: {
        partnerId: { in: allCustomerIds },
        partnerType: 'C',
        isReceipt: true,
        status: { not: 2 },
        code: { not: { startsWith: 'TTTUHD' } },
      },
      select: { amount: true },
    });
    const totalCashFlowReceived = cashFlowsReceipt.reduce(
      (sum: number, cf: any) => sum + Number(cf.amount),
      0,
    );

    const cashFlowsPayment = await tx.cashFlow.findMany({
      where: {
        partnerId: { in: allCustomerIds },
        partnerType: 'C',
        isReceipt: false,
        status: { not: 2 },
      },
      select: { amount: true },
    });
    const totalCashFlowPaidOut = cashFlowsPayment.reduce(
      (sum: number, cf: any) => sum + Number(cf.amount),
      0,
    );

    // - status=2 (STOCK_RECEIVED): confirmStockReceived đã trực tiếp giảm totalDebt
    // - status=4 + debt_offset: đã hoàn thành, cấn trừ vĩnh viễn
    // - status=4 + cash_refund: Bước 2 đã trừ nguyên refundAmount; Bước 3 chỉ cộng lại
    //   effectiveRefundAmount qua CHI-TH (nằm trong totalCashFlowPaidOut).
    const debtOffsets = await tx.returnOrder.findMany({
      where: {
        customerId: { in: allCustomerIds },
        OR: [
          { status: 2 }, // STOCK_RECEIVED
          { status: 4, refundType: 'debt_offset' }, // COMPLETED debt_offset
          { status: 4, refundType: 'cash_refund' }, // COMPLETED cash_refund
        ],
      },
      select: { refundAmount: true },
    });
    const totalDebtOffsets = debtOffsets.reduce(
      (sum: number, ro: any) => sum + Number(ro.refundAmount),
      0,
    );

    const totalDebt =
      totalGrandTotal -
      totalCashFlowReceived +
      totalCashFlowPaidOut -
      totalDebtOffsets;

    await tx.customer.update({
      where: { id: targetCustomerId },
      data: { totalDebt },
    });

    if (childIds.length > 0) {
      await tx.customer.updateMany({
        where: { id: { in: childIds.map((c: any) => c.id) } },
        data: { totalDebt: 0 },
      });
    }
  }
}
