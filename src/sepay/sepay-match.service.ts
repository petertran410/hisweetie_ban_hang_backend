import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashFlowsService } from '../cashflows/cashflows.service';
import { AssignCustomerDto, ConfirmReceiptDto } from './dto/sepay-match.dto';

/**
 * Trạng thái đối soát của 1 giao dịch Sepay (suy ra on-read, KHÔNG lưu cột status):
 *   - processing: chưa gán khách, chưa có phiếu thu (đang xử lý)
 *   - assigned:   đã gán khách, chưa tạo phiếu thu (đã xác nhận khách)
 *   - completed:  đã tạo phiếu thu (thủ công) HOẶC trùng sepayId với webhook
 */
export type SepayMatchStatus = 'processing' | 'assigned' | 'completed';

export interface SepayMatchInfo {
  status: SepayMatchStatus;
  // Nguồn hoàn thành: 'webhook' (tự động) | 'manual' (kế toán tạo) | null
  completedSource: 'webhook' | 'manual' | null;
  // Khách hàng gắn với giao dịch (từ webhook hoặc do sale gán)
  customer: { id: number; code: string | null; name: string } | null;
  // Phiếu thu liên quan (mã + id) nếu có
  cashFlow: { id: number; code: string } | null;
  // Mã hóa đơn/đơn hàng (nếu hoàn thành qua webhook)
  refCode: string | null;
}

@Injectable()
export class SepayMatchService {
  private readonly logger = new Logger(SepayMatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashFlowsService: CashFlowsService,
  ) {}

  /**
   * Đối chiếu on-read 1 loạt giao dịch Sepay với luồng webhook + luồng thủ công.
   * KHÔNG ghi gì vào DB. Trả map sepayId -> SepayMatchInfo.
   *
   * Logic completed:
   *   1) Webhook: tồn tại InvoicePayment/OrderPayment có sepayTransactionId == sepayId
   *      (status != hủy) -> completed/webhook, lấy customer từ invoice/order.
   *   2) Thủ công: transaction.cashFlowId trỏ tới CashFlow chưa hủy -> completed/manual.
   *      Nếu CashFlow đã hủy (status=2) -> "mở khóa": coi như chỉ assigned (hoặc processing).
   */
  async buildMatchInfo(
    transactions: { sepayId: string; assignedCustomerId: number | null; assignedCustomerName: string | null; cashFlowId: number | null }[],
  ): Promise<Map<string, SepayMatchInfo>> {
    const result = new Map<string, SepayMatchInfo>();
    if (transactions.length === 0) return result;

    const sepayIds = transactions.map((t) => t.sepayId);
    const cashFlowIds = transactions
      .map((t) => t.cashFlowId)
      .filter((v): v is number => v != null);
    const assignedCustomerIds = transactions
      .map((t) => t.assignedCustomerId)
      .filter((v): v is number => v != null);

    // ── 1. Webhook payments theo sepayTransactionId (cả invoice + order) ──
    const [invPays, ordPays] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where: { sepayTransactionId: { in: sepayIds }, status: { not: 2 } },
        select: {
          sepayTransactionId: true,
          invoice: {
            select: {
              code: true,
              customer: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.orderPayment.findMany({
        where: { sepayTransactionId: { in: sepayIds }, status: { not: 2 } },
        select: {
          sepayTransactionId: true,
          order: {
            select: {
              code: true,
              customer: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
    ]);

    const webhookMap = new Map<
      string,
      { customer: { id: number; code: string | null; name: string } | null; refCode: string | null }
    >();
    for (const p of invPays) {
      if (!p.sepayTransactionId) continue;
      webhookMap.set(p.sepayTransactionId, {
        customer: p.invoice?.customer ?? null,
        refCode: p.invoice?.code ?? null,
      });
    }
    for (const p of ordPays) {
      if (!p.sepayTransactionId) continue;
      if (webhookMap.has(p.sepayTransactionId)) continue;
      webhookMap.set(p.sepayTransactionId, {
        customer: p.order?.customer ?? null,
        refCode: p.order?.code ?? null,
      });
    }

    // ── 2. CashFlow thủ công (chỉ lấy chưa hủy để "mở khóa" khi hủy) ──
    const cashFlows = cashFlowIds.length
      ? await this.prisma.cashFlow.findMany({
          where: { id: { in: cashFlowIds } },
          select: { id: true, code: true, status: true },
        })
      : [];
    const cashFlowMap = new Map(cashFlows.map((cf) => [cf.id, cf]));

    // ── 3. Customer đã gán (để hiển thị code) ──
    const customers = assignedCustomerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: assignedCustomerIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    // ── 4. Tổng hợp trạng thái cho từng giao dịch ──
    for (const tx of transactions) {
      const webhook = webhookMap.get(tx.sepayId);
      if (webhook) {
        result.set(tx.sepayId, {
          status: 'completed',
          completedSource: 'webhook',
          customer: webhook.customer,
          cashFlow: null,
          refCode: webhook.refCode,
        });
        continue;
      }

      // Phiếu thu thủ công còn hiệu lực?
      const cf = tx.cashFlowId ? cashFlowMap.get(tx.cashFlowId) : null;
      const cfActive = cf && cf.status !== 2;

      if (cfActive) {
        result.set(tx.sepayId, {
          status: 'completed',
          completedSource: 'manual',
          customer: tx.assignedCustomerId
            ? customerMap.get(tx.assignedCustomerId) ??
              (tx.assignedCustomerName
                ? { id: tx.assignedCustomerId, code: '', name: tx.assignedCustomerName }
                : null)
            : null,
          cashFlow: { id: cf!.id, code: cf!.code },
          refCode: null,
        });
        continue;
      }

      // Chưa có phiếu thu hợp lệ → dựa vào việc đã gán khách chưa
      if (tx.assignedCustomerId) {
        result.set(tx.sepayId, {
          status: 'assigned',
          completedSource: null,
          customer:
            customerMap.get(tx.assignedCustomerId) ??
            (tx.assignedCustomerName
              ? { id: tx.assignedCustomerId, code: '', name: tx.assignedCustomerName }
              : null),
          cashFlow: null,
          refCode: null,
        });
        continue;
      }

      result.set(tx.sepayId, {
        status: 'processing',
        completedSource: null,
        customer: null,
        cashFlow: null,
        refCode: null,
      });
    }

    return result;
  }

  /** Lấy 1 giao dịch + match info (dùng nội bộ cho assign/confirm guard). */
  private async getTxWithMatch(id: number) {
    const tx = await this.prisma.sepayTransaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Không tìm thấy giao dịch Sepay');
    const matchMap = await this.buildMatchInfo([
      {
        sepayId: tx.sepayId,
        assignedCustomerId: tx.assignedCustomerId,
        assignedCustomerName: tx.assignedCustomerName,
        cashFlowId: tx.cashFlowId,
      },
    ]);
    return { tx, match: matchMap.get(tx.sepayId)! };
  }

  /**
   * Sale gán khách hàng cho giao dịch (chỉ khi chưa completed).
   * Cho phép đổi khách khi chưa tạo phiếu thu (đang processing/assigned).
   */
  async assignCustomer(id: number, dto: AssignCustomerDto, userId: number) {
    const { tx, match } = await this.getTxWithMatch(id);

    if (match.status === 'completed') {
      throw new ConflictException(
        'Giao dịch đã hoàn thành, không thể gán lại khách hàng',
      );
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, code: true, name: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    await this.prisma.sepayTransaction.update({
      where: { id: tx.id },
      data: {
        assignedCustomerId: customer.id,
        assignedCustomerName: customer.name,
        assignedById: userId,
        assignedAt: new Date(),
      },
    });

    return { success: true, customer };
  }

  /**
   * Bỏ gán khách (chỉ khi chưa tạo phiếu thu).
   */
  async unassignCustomer(id: number) {
    const { tx, match } = await this.getTxWithMatch(id);
    if (match.status === 'completed') {
      throw new ConflictException(
        'Giao dịch đã hoàn thành, không thể bỏ gán khách hàng',
      );
    }
    await this.prisma.sepayTransaction.update({
      where: { id: tx.id },
      data: {
        assignedCustomerId: null,
        assignedCustomerName: null,
        assignedById: null,
        assignedAt: null,
      },
    });
    return { success: true };
  }

  /**
   * Kế toán xác nhận & tạo phiếu thu trừ công nợ.
   * Tái dụng CashFlowsService.createCustomerPayment (KHÔNG sửa logic cũ).
   * Số tiền cố định = amountIn của giao dịch.
   */
  async confirmReceipt(id: number, dto: ConfirmReceiptDto, userId: number) {
    const { tx, match } = await this.getTxWithMatch(id);

    if (match.status === 'completed') {
      throw new ConflictException('Giao dịch đã có phiếu thu / đã hoàn thành');
    }
    if (!tx.assignedCustomerId) {
      throw new BadRequestException(
        'Chưa gán khách hàng cho giao dịch này',
      );
    }
    const amountIn = Number(tx.amountIn);
    if (!(amountIn > 0)) {
      throw new BadRequestException(
        'Giao dịch không phải tiền vào, không thể tạo phiếu thu',
      );
    }

    // Resolve accountId từ số tài khoản nhận của giao dịch (nếu khớp BankAccount)
    let accountId: number | undefined;
    if (tx.accountNumber) {
      const bank = await this.prisma.bankAccount.findFirst({
        where: { accountNumber: tx.accountNumber },
        select: { id: true },
      });
      accountId = bank?.id;
    }

    const note =
      dto.description ||
      `Sepay đối soát: ${tx.transactionContent || ''}`.trim();

    // Gọi đúng API tạo phiếu thu khách hàng có sẵn (không gắn hóa đơn).
    const result = await this.cashFlowsService.createCustomerPayment(
      {
        customerId: tx.assignedCustomerId,
        totalAmount: amountIn,
        branchId: dto.branchId,
        transDate: tx.transactionDate
          ? tx.transactionDate.toISOString()
          : new Date().toISOString(),
        method: 'transfer',
        accountId,
        collectorUserId: dto.collectorUserId || userId,
        description: note,
        // KHÔNG allocateToInvoices, KHÔNG debtOffsets → chỉ trừ công nợ tổng.
      } as any,
      userId,
    );

    const cashFlowId = (result as any)?.cashFlow?.id ?? null;
    if (cashFlowId) {
      await this.prisma.sepayTransaction.update({
        where: { id: tx.id },
        data: {
          cashFlowId,
          confirmedById: userId,
          confirmedAt: new Date(),
        },
      });
    }

    return {
      success: true,
      cashFlow: (result as any)?.cashFlow ?? null,
    };
  }
}
