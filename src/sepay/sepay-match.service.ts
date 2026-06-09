import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashFlowsService } from '../cashflows/cashflows.service';
import { AssignCustomersDto, ConfirmReceiptDto } from './dto/sepay-match.dto';

/**
 * Trạng thái đối soát của 1 giao dịch Sepay (suy ra on-read, KHÔNG lưu cột status):
 *   - processing: chưa gán khách, chưa có phiếu thu (đang xử lý)
 *   - assigned:   đã gán khách, chưa tạo phiếu thu (đã xác nhận khách)
 *   - completed:  đã tạo phiếu thu (thủ công) HOẶC trùng sepayId với webhook
 */
export type SepayMatchStatus = 'processing' | 'assigned' | 'completed';

export interface SepayMatchCustomer {
  id: number;
  code: string | null;
  name: string;
  amount?: number; // số tiền phân bổ (nếu đã có)
  note?: string | null;
  cashFlow?: { id: number; code: string } | null;
}

export interface SepayMatchInfo {
  status: SepayMatchStatus;
  // Nguồn hoàn thành: 'webhook' (tự động) | 'manual' (kế toán tạo) | null
  completedSource: 'webhook' | 'manual' | null;
  // Danh sách khách gắn với giao dịch (webhook: 1 khách; thủ công: 1..n khách)
  customers: SepayMatchCustomer[];
  // Mã hóa đơn/đơn hàng (nếu hoàn thành qua webhook)
  refCode: string | null;
}

interface TxLite {
  id: number;
  sepayId: string;
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
   * Logic:
   *   1) Webhook: tồn tại InvoicePayment/OrderPayment có sepayTransactionId == sepayId
   *      (status != hủy) -> completed/webhook, lấy customer từ invoice/order.
   *   2) Thủ công: dựa trên SepayAllocation của giao dịch:
   *      - có allocation với cashFlow chưa hủy -> completed/manual
   *      - có allocation nhưng chưa có phiếu (hoặc phiếu đã hủy) -> assigned
   *      - không có allocation -> processing
   */
  async buildMatchInfo(
    transactions: TxLite[],
  ): Promise<Map<string, SepayMatchInfo>> {
    const result = new Map<string, SepayMatchInfo>();
    if (transactions.length === 0) return result;

    const sepayIds = transactions.map((t) => t.sepayId);
    const txIds = transactions.map((t) => t.id);

    // ── 1. Webhook payments theo sepayTransactionId (cả invoice + order) ──
    const [invPays, ordPays, allocations] = await Promise.all([
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
      this.prisma.sepayAllocation.findMany({
        where: { sepayTransactionId: { in: txIds } },
        orderBy: { id: 'asc' },
      }),
    ]);

    const webhookMap = new Map<
      string,
      {
        customer: { id: number; code: string | null; name: string } | null;
        refCode: string | null;
      }
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

    // ── 2. Allocations theo txId ──
    const allocByTx = new Map<number, typeof allocations>();
    for (const a of allocations) {
      const arr = allocByTx.get(a.sepayTransactionId) || [];
      arr.push(a);
      allocByTx.set(a.sepayTransactionId, arr);
    }

    // ── 3. Resolve customer code + cashflow code (batch) ──
    const allCustomerIds = new Set<number>();
    const allCashFlowIds = new Set<number>();
    for (const a of allocations) {
      allCustomerIds.add(a.customerId);
      if (a.cashFlowId) allCashFlowIds.add(a.cashFlowId);
    }

    const [customers, cashFlows] = await Promise.all([
      allCustomerIds.size
        ? this.prisma.customer.findMany({
            where: { id: { in: Array.from(allCustomerIds) } },
            select: { id: true, code: true, name: true },
          })
        : Promise.resolve([]),
      allCashFlowIds.size
        ? this.prisma.cashFlow.findMany({
            where: { id: { in: Array.from(allCashFlowIds) } },
            select: { id: true, code: true, status: true },
          })
        : Promise.resolve([]),
    ]);
    const customerMap = new Map(customers.map((c) => [c.id, c] as const));
    const cashFlowMap = new Map(cashFlows.map((cf) => [cf.id, cf] as const));

    // ── 4. Tổng hợp trạng thái cho từng giao dịch ──
    for (const tx of transactions) {
      const webhook = webhookMap.get(tx.sepayId);
      if (webhook) {
        result.set(tx.sepayId, {
          status: 'completed',
          completedSource: 'webhook',
          customers: webhook.customer
            ? [
                {
                  id: webhook.customer.id,
                  code: webhook.customer.code,
                  name: webhook.customer.name,
                },
              ]
            : [],
          refCode: webhook.refCode,
        });
        continue;
      }

      const allocs = allocByTx.get(tx.id) || [];
      if (allocs.length === 0) {
        result.set(tx.sepayId, {
          status: 'processing',
          completedSource: null,
          customers: [],
          refCode: null,
        });
        continue;
      }

      // Có ít nhất 1 phiếu thu còn hiệu lực → completed
      const anyActiveCf = allocs.some((a) => {
        const cf = a.cashFlowId ? cashFlowMap.get(a.cashFlowId) : null;
        return cf && cf.status !== 2;
      });

      const matchCustomers: SepayMatchCustomer[] = allocs.map((a) => {
        const c = customerMap.get(a.customerId);
        const cf = a.cashFlowId ? cashFlowMap.get(a.cashFlowId) : null;
        return {
          id: a.customerId,
          code: c?.code ?? null,
          name: c?.name ?? a.customerName ?? '',
          amount: Number(a.amount),
          note: a.note,
          cashFlow: cf && cf.status !== 2 ? { id: cf.id, code: cf.code } : null,
        };
      });

      result.set(tx.sepayId, {
        status: anyActiveCf ? 'completed' : 'assigned',
        completedSource: anyActiveCf ? 'manual' : null,
        customers: matchCustomers,
        refCode: null,
      });
    }

    return result;
  }

  /** Lấy 1 giao dịch + allocations + match info (dùng nội bộ cho assign/confirm guard). */
  private async getTxWithMatch(id: number) {
    const tx = await this.prisma.sepayTransaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Không tìm thấy giao dịch Sepay');
    const matchMap = await this.buildMatchInfo([
      { id: tx.id, sepayId: tx.sepayId },
    ]);
    return { tx, match: matchMap.get(tx.sepayId)! };
  }

  /**
   * Sale gán 1 hoặc nhiều khách hàng cho giao dịch (chỉ khi chưa completed).
   * Ghi đè danh sách allocation (reset về danh sách khách mới, amount=0).
   * Cho phép đổi/bổ sung khách khi chưa tạo phiếu thu.
   */
  async assignCustomers(id: number, dto: AssignCustomersDto, userId: number) {
    const { tx, match } = await this.getTxWithMatch(id);

    if (match.status === 'completed') {
      throw new ConflictException(
        'Giao dịch đã hoàn thành, không thể gán lại khách hàng',
      );
    }

    const uniqueIds = Array.from(new Set(dto.customerIds));
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, code: true, name: true },
    });
    if (customers.length !== uniqueIds.length) {
      throw new NotFoundException('Một số khách hàng không tồn tại');
    }

    await this.prisma.$transaction(async (txc) => {
      // Reset allocations cũ (chỉ khi chưa có phiếu thu - đã đảm bảo ở trên).
      await txc.sepayAllocation.deleteMany({
        where: { sepayTransactionId: tx.id },
      });
      await txc.sepayAllocation.createMany({
        data: customers.map((c) => ({
          sepayTransactionId: tx.id,
          customerId: c.id,
          customerName: c.name,
          amount: 0,
          createdById: userId,
        })),
      });
      // Cập nhật cột legacy (khách đầu tiên) để tương thích hiển thị cũ + assignedAt.
      await txc.sepayTransaction.update({
        where: { id: tx.id },
        data: {
          assignedCustomerId: customers[0].id,
          assignedCustomerName: customers[0].name,
          assignedById: userId,
          assignedAt: new Date(),
        },
      });
    });

    return { success: true, customers };
  }

  /**
   * Bỏ gán toàn bộ khách (chỉ khi chưa tạo phiếu thu).
   */
  async unassignCustomer(id: number) {
    const { tx, match } = await this.getTxWithMatch(id);
    if (match.status === 'completed') {
      throw new ConflictException(
        'Giao dịch đã hoàn thành, không thể bỏ gán khách hàng',
      );
    }
    await this.prisma.$transaction(async (txc) => {
      await txc.sepayAllocation.deleteMany({
        where: { sepayTransactionId: tx.id },
      });
      await txc.sepayTransaction.update({
        where: { id: tx.id },
        data: {
          assignedCustomerId: null,
          assignedCustomerName: null,
          assignedById: null,
          assignedAt: null,
        },
      });
    });
    return { success: true };
  }

  /**
   * Kế toán xác nhận & tạo phiếu thu trừ công nợ theo phân bổ.
   * Mỗi khách trong allocations → 1 phiếu thu riêng (CashFlowsService.createCustomerPayment).
   * Tổng số tiền phân bổ phải = amountIn của giao dịch.
   */
  async confirmReceipt(id: number, dto: ConfirmReceiptDto, userId: number) {
    const { tx, match } = await this.getTxWithMatch(id);

    if (match.status === 'completed') {
      throw new ConflictException('Giao dịch đã có phiếu thu / đã hoàn thành');
    }

    const amountIn = Number(tx.amountIn);
    if (!(amountIn > 0)) {
      throw new BadRequestException(
        'Giao dịch không phải tiền vào, không thể tạo phiếu thu',
      );
    }

    const allocations = dto.allocations || [];
    if (allocations.length === 0) {
      throw new BadRequestException('Chưa có phân bổ khách hàng');
    }

    // Validate tổng tiền = amountIn (làm tròn 2 chữ số để tránh lệch float).
    const sum = allocations.reduce((s, a) => s + Number(a.amount || 0), 0);
    if (Math.round(sum * 100) !== Math.round(amountIn * 100)) {
      throw new BadRequestException(
        `Tổng phân bổ (${sum}) phải bằng số tiền giao dịch (${amountIn})`,
      );
    }
    if (allocations.some((a) => !(Number(a.amount) > 0))) {
      throw new BadRequestException('Mỗi khách phải được phân bổ số tiền > 0');
    }

    // Validate khách tồn tại
    const customerIds = allocations.map((a) => a.customerId);
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, name: true },
    });
    const customerById = new Map(customers.map((c) => [c.id, c] as const));
    if (customers.length !== new Set(customerIds).size) {
      throw new NotFoundException('Một số khách hàng không tồn tại');
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

    const transDate = tx.transactionDate
      ? tx.transactionDate.toISOString()
      : new Date().toISOString();

    const createdCashFlows: { customerId: number; cashFlow: any }[] = [];

    // Tạo phiếu thu cho từng khách (mỗi khách 1 phiếu).
    for (const a of allocations) {
      const note =
        a.note ||
        `Sepay đối soát: ${tx.transactionContent || ''}`.trim();
      const result = await this.cashFlowsService.createCustomerPayment(
        {
          customerId: a.customerId,
          totalAmount: Number(a.amount),
          branchId: dto.branchId,
          transDate,
          method: 'transfer',
          accountId,
          collectorUserId: dto.collectorUserId || userId,
          description: note,
        } as any,
        userId,
      );
      createdCashFlows.push({
        customerId: a.customerId,
        cashFlow: (result as any)?.cashFlow ?? null,
      });
    }

    // Ghi lại allocations (amount + note + cashFlowId) — reset rồi tạo mới.
    await this.prisma.$transaction(async (txc) => {
      await txc.sepayAllocation.deleteMany({
        where: { sepayTransactionId: tx.id },
      });
      await txc.sepayAllocation.createMany({
        data: allocations.map((a) => {
          const cf = createdCashFlows.find((x) => x.customerId === a.customerId);
          return {
            sepayTransactionId: tx.id,
            customerId: a.customerId,
            customerName: customerById.get(a.customerId)?.name ?? null,
            amount: Number(a.amount),
            note: a.note || null,
            cashFlowId: cf?.cashFlow?.id ?? null,
            createdById: userId,
            confirmedById: userId,
            confirmedAt: new Date(),
          };
        }),
      });
      // Cột legacy: trỏ cashFlowId vào phiếu đầu tiên để tương thích.
      await txc.sepayTransaction.update({
        where: { id: tx.id },
        data: {
          cashFlowId: createdCashFlows[0]?.cashFlow?.id ?? null,
          confirmedById: userId,
          confirmedAt: new Date(),
        },
      });
    });

    return {
      success: true,
      cashFlows: createdCashFlows.map((x) => x.cashFlow).filter(Boolean),
    };
  }
}
