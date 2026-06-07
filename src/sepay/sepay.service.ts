import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicePaymentsService } from '../invoices/invoice-payments.service';
import { OrderPaymentsService } from '../orders/order-payments.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';

@Injectable()
export class SepayService {
  private readonly logger = new Logger(SepayService.name);
  // Regex bắt cả HD049170 lẫn HD049170.01 (suffix sau khi sửa hóa đơn).
  // Case insensitive. Lấy match đầu tiên trong content.
  private readonly CODE_REGEX = /(HD|DH)\d+(?:\.\d+)?/i;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private invoicePaymentsService: InvoicePaymentsService,
    private orderPaymentsService: OrderPaymentsService,
  ) {}

  async handleWebhook(payload: SepayWebhookDto) {
    // 1. Chỉ xử lý tiền vào — bỏ qua "out"
    if (payload.transferType !== 'in') {
      return {
        success: true,
        message: 'Skipped: not an incoming transfer',
      };
    }

    const sepayTxId = String(payload.id);

    // 2. Idempotency — check cả 2 bảng song song
    const [existingInvPay, existingOrdPay] = await Promise.all([
      this.prisma.invoicePayment.findUnique({
        where: { sepayTransactionId: sepayTxId },
      }),
      this.prisma.orderPayment.findUnique({
        where: { sepayTransactionId: sepayTxId },
      }),
    ]);

    if (existingInvPay) {
      return {
        success: true,
        message: 'Already processed (invoice payment)',
        paymentId: existingInvPay.id,
      };
    }
    if (existingOrdPay) {
      return {
        success: true,
        message: 'Already processed (order payment)',
        paymentId: existingOrdPay.id,
      };
    }

    // 3. Regex tìm mã đơn trong content
    const content = payload.content || '';
    const match = content.match(this.CODE_REGEX);
    if (!match) {
      this.logger.warn(
        `Sepay webhook: no order/invoice code in content "${content}" (tx ${sepayTxId})`,
      );
      return {
        success: true,
        message: 'No order/invoice code found in content',
        content,
      };
    }

    const code = match[0].toUpperCase();
    const isInvoice = code.startsWith('HD');

    // 5. System user (cho field createdBy + audit log)
    const userId = Number(
      this.configService.get<string>('SEPAY_WEBHOOK_USER_ID') || 1,
    );

    // 6. Dispatch tới đúng service — reuse logic có sẵn
    //    (Payment + CashFlow + update paidAmount/debtAmount + customer.totalDebt
    //     đều được service xử lý cascade)
    if (isInvoice) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { code },
        select: { id: true, soldById: true },
      });
      if (!invoice) {
        this.logger.warn(
          `Sepay webhook: invoice ${code} not found (tx ${sepayTxId})`,
        );
        return { success: true, message: `Invoice ${code} not found` };
      }

      const accountId = await this.resolveAccountId(
        invoice.soldById,
        payload.accountNumber,
        sepayTxId,
      );

      const result = await this.invoicePaymentsService.create(
        {
          invoiceId: invoice.id,
          amount: payload.transferAmount,
          paymentMethod: 'transfer',
          accountId,
          sepayTransactionId: sepayTxId,
          sepayReferenceCode: payload.referenceCode,
          notes: `Sepay tự động: ${content}`,
        },
        userId,
      );

      return {
        success: true,
        message: 'Invoice payment created',
        paymentId: (result as any).payment?.id,
      };
    }

    // Order branch
    const order = await this.prisma.order.findUnique({
      where: { code },
      select: { id: true, soldById: true },
    });
    if (!order) {
      this.logger.warn(
        `Sepay webhook: order ${code} not found (tx ${sepayTxId})`,
      );
      return { success: true, message: `Order ${code} not found` };
    }

    const accountId = await this.resolveAccountId(
      order.soldById,
      payload.accountNumber,
      sepayTxId,
    );

    const result = await this.orderPaymentsService.create(
      {
        orderId: order.id,
        amount: payload.transferAmount,
        paymentMethod: 'transfer',
        accountId,
        sepayTransactionId: sepayTxId,
        sepayReferenceCode: payload.referenceCode,
        description: `Sepay tự động: ${content}`,
      },
      userId,
    );

    return {
      success: true,
      message: 'Order payment created',
      paymentId: (result as any).payment?.id,
    };
  }

  /**
   * Resolve accountId cho phiếu thu QR.
   * Ưu tiên tài khoản ngân hàng đã gán cho sale (soldById) — đây là tài khoản
   * dùng để sinh QR in trên phiếu, nên phiếu thu sẽ luôn khớp với QR.
   * Fallback: match theo số tài khoản thực nhận (payload.accountNumber).
   */
  private async resolveAccountId(
    soldById: number | null | undefined,
    accountNumber: string,
    sepayTxId: string,
  ): Promise<number | undefined> {
    if (soldById) {
      const mapping = await this.prisma.userBankAccount.findUnique({
        where: { userId: soldById },
      });
      if (mapping?.bankAccountId) {
        return mapping.bankAccountId;
      }
    }

    // Fallback: match theo số tài khoản thực nhận
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { accountNumber },
    });

    if (!bankAccount) {
      this.logger.warn(
        `Sepay webhook: no account resolved (sale ${soldById ?? 'none'}, accountNumber "${accountNumber}") (tx ${sepayTxId})`,
      );
    }

    return bankAccount?.id;
  }
}
