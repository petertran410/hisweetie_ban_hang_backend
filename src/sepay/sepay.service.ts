import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicePaymentsService } from '../invoices/invoice-payments.service';
import { OrderPaymentsService } from '../orders/order-payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationFanoutService } from '../notifications/notification-fanout.service';
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
    private notificationsService: NotificationsService,
    private notificationFanoutService: NotificationFanoutService,
  ) {}

  async handleWebhook(payload: SepayWebhookDto) {
    // 0. Ghi giao dịch thô vào sepay_transactions (real-time, gồm cả tiền ra
    //    và giao dịch không khớp mã). Lỗi ở bước này KHÔNG làm webhook fail.
    await this.recordRawTransaction(payload);

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
   * Nhận tin nhắn ngân hàng thô từ nguồn ngoài (MacroDroid gửi thẳng vào backend).
   * Body là object đầy đủ chứa field `body_message` (đoạn SMS ngân hàng).
   *
   * Parse `body_message` → tạo/cập nhật 1 record sepay_transactions.
   * Idempotent: sepayId = "ext_" + SHA256(body_message) nên gửi lại cùng tin nhắn
   * chỉ upsert đè, KHÔNG tạo trùng.
   *
   * CHỈ lưu lịch sử thô + fan-out thông báo (nếu tiền vào). KHÔNG tự match đơn/
   * hóa đơn, KHÔNG tạo phiếu thu — việc gán khách + tạo phiếu thu do người dùng
   * tự làm qua luồng đối soát thủ công hiện có.
   */
  async handleExternalMessage(body: any) {
    const message: string | undefined =
      typeof body?.body_message === 'string' ? body.body_message : undefined;

    if (!message || !message.trim()) {
      throw new BadRequestException('Thiếu body_message');
    }

    const parsed = this.parseBankMessage(message);

    // sepayId idempotent theo nội dung tin nhắn (chống tạo trùng khi retry).
    const sepayId =
      'ext_' + crypto.createHash('sha256').update(message).digest('hex');

    const data = {
      transactionDate: parsed.transactionDate ?? new Date(),
      accountNumber: parsed.accountNumber ?? undefined,
      subAccount: undefined,
      amountIn: parsed.amountIn,
      amountOut: parsed.amountOut,
      accumulated:
        parsed.accumulated !== undefined ? parsed.accumulated : undefined,
      code: undefined,
      transactionContent: parsed.transactionContent ?? message,
      referenceNumber: parsed.referenceNumber ?? undefined,
      bankBrandName: undefined,
      rawPayload: body as unknown as Prisma.InputJsonValue,
      syncedAt: new Date(),
    };

    const existing = await this.prisma.sepayTransaction.findUnique({
      where: { sepayId },
      select: { id: true },
    });

    const saved = await this.prisma.sepayTransaction.upsert({
      where: { sepayId },
      create: { sepayId, ...data },
      update: data,
    });

    // Fan-out thông báo cho user được phép thấy giao dịch (chỉ tiền vào).
    // Idempotent theo dedupeKey=sepayId → gửi lại không tạo thông báo lặp.
    if (parsed.amountIn > 0) {
      await this.fanoutSepayNotification(saved);
    }

    return {
      success: true,
      sepayId,
      isCreated: !existing,
      amountIn: parsed.amountIn,
      amountOut: parsed.amountOut,
    };
  }

  /**
   * Parse đoạn tin nhắn ngân hàng dạng:
   *   TK 19039846694018
   *   So tien GD:-1,463,400        (dấu - = tiền chi, dấu + = tiền vào)
   *   So du:298,359,688
   *   GD THE QUA POS ... NGAY 20/06/2026 ... TID 20981908
   *
   * Trả về các trường đã chuẩn hóa để map vào SepayTransaction.
   */
  private parseBankMessage(message: string): {
    accountNumber?: string;
    amountIn: number;
    amountOut: number;
    accumulated?: number;
    transactionContent?: string;
    referenceNumber?: string;
    transactionDate?: Date;
  } {
    const stripNumber = (s: string) => Number(s.replace(/[.,\s]/g, '')) || 0;

    // TK <số>
    const accountNumber = message.match(/TK\s*[:\s]?\s*(\d+)/i)?.[1];

    // So tien GD: dấu +/- + số (có dấu phẩy/chấm ngăn cách)
    const amountMatch = message.match(
      /So\s*tien\s*GD\s*[:\s]\s*([+-]?)\s*([\d.,]+)/i,
    );
    let amountIn = 0;
    let amountOut = 0;
    if (amountMatch) {
      const sign = amountMatch[1];
      const value = stripNumber(amountMatch[2]);
      if (sign === '-') {
        amountOut = value;
      } else {
        amountIn = value;
      }
    }

    // So du: <số>
    const balanceMatch = message.match(/So\s*du\s*[:\s]\s*([\d.,]+)/i);
    const accumulated = balanceMatch ? stripNumber(balanceMatch[1]) : undefined;

    // NGAY dd/mm/yyyy trong nội dung (giờ VN). Không có → để service fallback now().
    const dateMatch = message.match(/NGAY\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    let transactionDate: Date | undefined;
    if (dateMatch) {
      const [, dd, mm, yyyy] = dateMatch;
      const d = this.parseSepayDate(`${yyyy}-${mm}-${dd} 00:00:00`);
      if (d) transactionDate = d;
    }

    // TID <số> làm mã tham chiếu (nếu có).
    const referenceNumber = message.match(/TID\s*[:\s]?\s*(\w+)/i)?.[1];

    // Nội dung giao dịch = dòng mô tả (loại các dòng TK / So tien GD / So du).
    const transactionContent = message
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^TK\b/i.test(l) &&
          !/^So\s*tien\s*GD/i.test(l) &&
          !/^So\s*du/i.test(l),
      )
      .join(' ')
      .trim();

    return {
      accountNumber,
      amountIn,
      amountOut,
      accumulated,
      transactionContent: transactionContent || undefined,
      referenceNumber,
      transactionDate,
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

  /**
   * Ghi/cập nhật giao dịch thô vào sepay_transactions (real-time qua webhook).
   * Ghi MỌI giao dịch (cả 'in' lẫn 'out', kể cả không khớp mã đơn/hóa đơn).
   * Idempotent theo sepayId — chạy lại nhiều lần không tạo trùng, và KHÔNG
   * đụng các cột đối soát thủ công (assignedCustomerId/cashFlowId/...).
   * Lỗi ở đây chỉ log warning, KHÔNG làm webhook fail (tránh Sepay retry liên tục).
   */
  private async recordRawTransaction(payload: SepayWebhookDto) {
    try {
      const sepayId = String(payload.id);
      const isIn = payload.transferType === 'in';
      const amount = Number(payload.transferAmount) || 0;

      const data = {
        transactionDate: this.parseSepayDate(payload.transactionDate),
        accountNumber: payload.accountNumber ?? undefined,
        subAccount: payload.subAccount ?? undefined,
        amountIn: isIn ? amount : 0,
        amountOut: isIn ? 0 : amount,
        accumulated:
          payload.accumulated !== undefined && payload.accumulated !== null
            ? Number(payload.accumulated)
            : undefined,
        code: payload.code ?? undefined,
        transactionContent: payload.content ?? undefined,
        referenceNumber: payload.referenceCode ?? undefined,
        bankBrandName: payload.gateway ?? undefined,
        rawPayload: payload as unknown as Prisma.InputJsonValue,
        syncedAt: new Date(),
      };

      const saved = await this.prisma.sepayTransaction.upsert({
        where: { sepayId },
        create: { sepayId, ...data },
        update: data,
      });

      // Fan-out thông báo cho user được phép thấy giao dịch (chỉ tiền vào).
      // Idempotent theo dedupeKey=sepayId → Sepay retry không tạo thông báo lặp.
      if (isIn && amount > 0) {
        await this.fanoutSepayNotification(saved);
      }
    } catch (error) {
      // Không chặn luồng tạo phiếu thu nếu ghi lịch sử lỗi.
      this.logger.warn(
        `Sepay webhook: failed to record raw transaction (tx ${String(
          payload.id,
        )}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Tạo thông báo in-app cho các user được phép thấy giao dịch tiền vào.
   * Bọc try/catch riêng — lỗi fan-out không được làm hỏng luồng webhook.
   */
  private async fanoutSepayNotification(tx: {
    id: number;
    sepayId: string;
    amountIn: Prisma.Decimal | number;
    accountNumber: string | null;
    subAccount: string | null;
    bankBrandName: string | null;
    referenceNumber: string | null;
    transactionContent: string | null;
  }) {
    try {
      const recipients =
        await this.notificationFanoutService.resolveSepayRecipients({
          accountNumber: tx.accountNumber,
          subAccount: tx.subAccount,
        });
      if (recipients.length === 0) return;

      const amount = Number(tx.amountIn) || 0;
      const bankInfo = [tx.bankBrandName, tx.accountNumber]
        .filter(Boolean)
        .join(' - ');
      const key = tx.referenceNumber || tx.transactionContent || '';
      const link = key
        ? `/tai-chinh/bien-dong-so-du?search=${encodeURIComponent(key)}`
        : '/tai-chinh/bien-dong-so-du';

      await this.notificationsService.createForUsers(recipients, {
        type: 'sepay_transaction',
        title: 'Khách vừa chuyển khoản cần xử lý',
        body: bankInfo || null,
        link,
        dedupeKey: tx.sepayId,
        data: {
          txId: tx.id,
          sepayId: tx.sepayId,
          amountIn: String(amount),
          accountNumber: tx.accountNumber,
          bankBrandName: tx.bankBrandName,
          referenceNumber: tx.referenceNumber,
          transactionContent: tx.transactionContent,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Sepay webhook: fan-out notification failed (tx ${tx.sepayId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Parse ngày từ webhook. Sepay trả "yyyy-mm-dd HH:MM:SS" giờ Việt Nam (UTC+7).
   */
  private parseSepayDate(value?: string | null): Date | undefined {
    if (!value) return undefined;
    const normalized = value.replace(' ', 'T') + '+07:00';
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? undefined : d;
  }
}
