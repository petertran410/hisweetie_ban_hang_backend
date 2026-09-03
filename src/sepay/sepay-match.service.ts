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
import { isSepaySpecialAccount } from './utils/sepay-special-account';
import { DebtTicketAutoCloseService } from '../debt-tickets/debt-ticket-auto-close.service';

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
  // Số tiền CHƯA gắn vào khách nào (vd sau khi 1 phiếu thu bị hủy).
  // = amountIn - tổng tiền các phiếu thu còn hiệu lực.
  unassignedAmount?: number;
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
    private readonly debtTicketAutoClose: DebtTicketAutoCloseService,
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
    const [invPays, ordPays, allocations, txAmounts] = await Promise.all([
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
      this.prisma.sepayTransaction.findMany({
        where: { id: { in: txIds } },
        select: { id: true, amountIn: true },
      }),
    ]);

    const txAmountMap = new Map(
      txAmounts.map((t) => [t.id, Number(t.amountIn)] as const),
    );

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

      const amountIn = Number(txAmountMap.get(tx.id) ?? 0);

      // Phân loại allocation theo trạng thái phiếu thu:
      //   - cf hủy (status=2)  → BỎ khỏi danh sách khách; tiền quay về "chưa gắn".
      //   - cf còn hiệu lực     → khách hoàn thành, tiền đã thu hợp lệ.
      //   - chưa có cf (amount>0 hoặc =0) → khách đã gán, chờ tạo phiếu.
      const visibleAllocs = allocs.filter((a) => {
        if (!a.cashFlowId) return true; // chưa tạo phiếu → vẫn hiện
        const cf = cashFlowMap.get(a.cashFlowId);
        return cf ? cf.status !== 2 : false; // phiếu đã hủy → ẩn
      });

      // Tổng tiền các phiếu thu CÒN HIỆU LỰC (đã thu thật sự).
      const activeCollected = allocs.reduce((s, a) => {
        if (!a.cashFlowId) return s;
        const cf = cashFlowMap.get(a.cashFlowId);
        return cf && cf.status !== 2 ? s + Number(a.amount) : s;
      }, 0);

      const unassignedAmount =
        Math.round((amountIn - activeCollected) * 100) / 100;

      const hasActiveCf = allocs.some((a) => {
        const cf = a.cashFlowId ? cashFlowMap.get(a.cashFlowId) : null;
        return cf && cf.status !== 2;
      });

      const matchCustomers: SepayMatchCustomer[] = visibleAllocs.map((a) => {
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

      // completed: có phiếu thu hiệu lực VÀ không còn tiền chưa gắn.
      // assigned : còn tiền chưa gắn (vd 1 phiếu bị hủy) hoặc chưa tạo phiếu.
      // processing: toàn bộ allocation trước đó đều thuộc phiếu đã hủy,
      // không còn khách đang chờ và cũng không còn phiếu thu hiệu lực.
      const isCompleted = hasActiveCf && unassignedAmount <= 0;
      const isProcessing = !hasActiveCf && visibleAllocs.length === 0;

      result.set(tx.sepayId, {
        status: isProcessing
          ? 'processing'
          : isCompleted
            ? 'completed'
            : 'assigned',
        completedSource: isCompleted ? 'manual' : null,
        customers: matchCustomers,
        refCode: null,
        unassignedAmount: unassignedAmount > 0 ? unassignedAmount : 0,
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
   * GIỮ các allocation đã có phiếu thu còn hiệu lực; chỉ thay phần "đang chờ"
   * (allocation chưa có phiếu / phiếu đã hủy) bằng danh sách khách mới (amount=0).
   * Cho phép đổi/bổ sung khách khi chưa tạo phiếu thu cho phần đó.
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

    // Xác định allocation đã có phiếu thu còn hiệu lực (phải giữ lại).
    const existingAllocs = await this.prisma.sepayAllocation.findMany({
      where: { sepayTransactionId: tx.id },
    });
    const activeCashFlowIds = existingAllocs
      .map((a) => a.cashFlowId)
      .filter((v): v is number => v != null);
    const activeCashFlows = activeCashFlowIds.length
      ? await this.prisma.cashFlow.findMany({
          where: { id: { in: activeCashFlowIds }, status: { not: 2 } },
          select: { id: true },
        })
      : [];
    const activeCfIdSet = new Set(activeCashFlows.map((cf) => cf.id));
    const keptAllocs = existingAllocs.filter(
      (a) => a.cashFlowId && activeCfIdSet.has(a.cashFlowId),
    );

    await this.prisma.$transaction(async (txc) => {
      // Xóa toàn bộ rồi ghi lại: giữ allocation có phiếu hiệu lực + thêm khách mới (amount=0).
      await txc.sepayAllocation.deleteMany({
        where: { sepayTransactionId: tx.id },
      });

      const keptData = keptAllocs.map((a) => ({
        sepayTransactionId: tx.id,
        customerId: a.customerId,
        customerName: a.customerName,
        amount: a.amount,
        note: a.note,
        cashFlowId: a.cashFlowId,
        createdById: a.createdById,
        confirmedById: a.confirmedById,
        confirmedAt: a.confirmedAt,
      }));

      const newData = customers.map((c) => ({
        sepayTransactionId: tx.id,
        customerId: c.id,
        customerName: c.name,
        amount: 0,
        createdById: userId,
      }));

      await txc.sepayAllocation.createMany({ data: [...keptData, ...newData] });

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

    // Đối chiếu ticket đòi nợ: gắn khách = ghi nhận khách đã thanh toán.
    // Chạy NGOÀI transaction và tự nuốt lỗi bên trong service — việc đối chiếu
    // ticket không được phép làm hỏng thao tác gắn khách của kế toán.
    const affectedCustomerIds = [
      ...new Set([
        ...existingAllocs.map((allocation) => allocation.customerId),
        ...customers.map((customer) => customer.id),
      ]),
    ];
    await this.debtTicketAutoClose.onSepayCustomersAssigned(
      tx.id,
      affectedCustomerIds,
    );

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

    // Chỉ bỏ gán các allocation CHƯA có phiếu thu còn hiệu lực.
    // Khách đã lập phiếu (phiếu chưa hủy) phải GIỮ NGUYÊN.
    const existingAllocs = await this.prisma.sepayAllocation.findMany({
      where: { sepayTransactionId: tx.id },
    });
    const cashFlowIds = existingAllocs
      .map((a) => a.cashFlowId)
      .filter((v): v is number => v != null);
    const activeCashFlows = cashFlowIds.length
      ? await this.prisma.cashFlow.findMany({
          where: { id: { in: cashFlowIds }, status: { not: 2 } },
          select: { id: true },
        })
      : [];
    const activeCfIdSet = new Set(activeCashFlows.map((cf) => cf.id));

    // ID các allocation cần xóa = chưa có phiếu hoặc phiếu đã hủy.
    const removableIds = existingAllocs
      .filter((a) => !a.cashFlowId || !activeCfIdSet.has(a.cashFlowId))
      .map((a) => a.id);
    const keptAllocs = existingAllocs.filter(
      (a) => a.cashFlowId && activeCfIdSet.has(a.cashFlowId),
    );

    await this.prisma.$transaction(async (txc) => {
      if (removableIds.length > 0) {
        await txc.sepayAllocation.deleteMany({
          where: { id: { in: removableIds } },
        });
      }
      // Cập nhật cột legacy: nếu còn allocation giữ lại thì trỏ về khách đầu tiên,
      // ngược lại reset về null (không còn khách nào gán).
      await txc.sepayTransaction.update({
        where: { id: tx.id },
        data: keptAllocs.length
          ? {
              assignedCustomerId: keptAllocs[0].customerId,
              assignedCustomerName: keptAllocs[0].customerName,
            }
          : {
              assignedCustomerId: null,
              assignedCustomerName: null,
              assignedById: null,
              assignedAt: null,
            },
      });
    });

    // Gỡ ghi nhận thanh toán trên ticket cho các khách vừa bị bỏ gán, và mở
    // lại ticket nếu nó đã được đóng TỰ ĐỘNG. Không có bước này thì một lần
    // bấm nhầm sẽ khóa ticket vĩnh viễn.
    const unassignedCustomerIds = existingAllocs
      .filter((a) => removableIds.includes(a.id))
      .map((a) => a.customerId);
    if (unassignedCustomerIds.length > 0) {
      await this.debtTicketAutoClose.onSepayCustomersUnassigned(
        tx.id,
        unassignedCustomerIds,
      );
    }

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

    // Các allocation ĐÃ có phiếu thu còn hiệu lực → giữ nguyên, KHÔNG tạo lại.
    // Phần tiền cần tạo phiếu mới = amountIn - tổng tiền các phiếu còn hiệu lực.
    const existingAllocs = await this.prisma.sepayAllocation.findMany({
      where: { sepayTransactionId: tx.id },
    });
    const activeCashFlowIds = existingAllocs
      .map((a) => a.cashFlowId)
      .filter((v): v is number => v != null);
    const activeCashFlows = activeCashFlowIds.length
      ? await this.prisma.cashFlow.findMany({
          where: { id: { in: activeCashFlowIds }, status: { not: 2 } },
          select: { id: true },
        })
      : [];
    const activeCfIdSet = new Set(activeCashFlows.map((cf) => cf.id));
    const keptAllocs = existingAllocs.filter(
      (a) => a.cashFlowId && activeCfIdSet.has(a.cashFlowId),
    );
    const collected = keptAllocs.reduce((s, a) => s + Number(a.amount), 0);
    const remaining = Math.round((amountIn - collected) * 100) / 100;

    // Validate tổng phân bổ MỚI = phần tiền còn lại (chưa gắn).
    const sum = allocations.reduce((s, a) => s + Number(a.amount || 0), 0);
    if (Math.round(sum * 100) !== Math.round(remaining * 100)) {
      throw new BadRequestException(
        `Tổng phân bổ (${sum}) phải bằng số tiền chưa gắn (${remaining})`,
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

    // Validate phân bổ vào hóa đơn (nếu có): mỗi hóa đơn phải thuộc đúng khách
    // và tổng tiền gắn vào hóa đơn không vượt số tiền phân bổ cho khách đó.
    // Phần chênh lệch (amount - Σ invoices) sẽ ghi nhận thành credit của khách.
    const invoiceIds = allocations.flatMap((a) =>
      (a.invoices || []).map((inv) => inv.invoiceId),
    );
    if (invoiceIds.length > 0) {
      const invoices = await this.prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, code: true, customerId: true },
      });
      const invoiceById = new Map(invoices.map((i) => [i.id, i] as const));

      for (const a of allocations) {
        if (!a.invoices || a.invoices.length === 0) continue;

        let invSum = 0;
        for (const inv of a.invoices) {
          const found = invoiceById.get(inv.invoiceId);
          if (!found) {
            throw new NotFoundException(
              `Không tìm thấy hóa đơn ID ${inv.invoiceId}`,
            );
          }
          if (found.customerId !== a.customerId) {
            throw new BadRequestException(
              `Hóa đơn ${found.code} không thuộc về khách hàng được phân bổ`,
            );
          }
          if (!(Number(inv.amount) > 0)) {
            throw new BadRequestException(
              `Số tiền gắn vào hóa đơn ${found.code} phải > 0`,
            );
          }
          invSum += Number(inv.amount);
        }

        if (Math.round(invSum * 100) > Math.round(Number(a.amount) * 100)) {
          throw new BadRequestException(
            `Tổng tiền gắn vào hóa đơn (${invSum}) vượt số tiền thu của khách (${a.amount})`,
          );
        }
      }
    }

    // Resolve accountId từ số tài khoản nhận của giao dịch.
    // Ưu tiên subAccount (VA — VD BIDV 96460248888) trước, fallback accountNumber (TK chính).
    // Lý do: DB bank_accounts có thể lưu VA thay vì TK chính (BIDV). Trước đây chỉ check
    // accountNumber nên BIDV VA → accountId = null → phiếu thu không liên kết TK ngân hàng.
    let accountId: number | undefined;
    const candidates = [tx.subAccount, tx.accountNumber].filter(
      (v): v is string => !!v,
    );
    for (const acc of candidates) {
      const bank = await this.prisma.bankAccount.findFirst({
        where: { accountNumber: acc },
        select: { id: true },
      });
      if (bank?.id) {
        accountId = bank.id;
        break;
      }
    }

    const transDate = tx.transactionDate
      ? tx.transactionDate.toISOString()
      : new Date().toISOString();

    const createdCashFlows: { customerId: number; cashFlow: any }[] = [];

    // Tạo phiếu thu cho từng khách trong phần phân bổ MỚI (mỗi khách 1 phiếu).
    for (const a of allocations) {
      // Nội dung phiếu thu:
      //  - TK đặc biệt (env SEPAY_SPECIAL_ACCOUNT_NUMBERS): dùng transactionContent
      //    (nội dung gốc Sepay gửi về, ví dụ "Nguyen Van A chuyen khoan").
      //  - Ngân hàng khác: dùng referenceNumber (mã tham chiếu / mã đơn nếu quét QR).
      // FE không tự điền note (autoNote = ""), nên luôn vào nhánh fallback theo ngân hàng.
      const isSpecial = await isSepaySpecialAccount(
        this.prisma,
        tx.accountNumber,
        tx.subAccount,
      );
      const defaultNote = isSpecial
        ? (tx.transactionContent || '').trim()
        : (tx.referenceNumber || '').trim();
      const note = a.note && a.note.trim() ? a.note : defaultNote;
      // Nếu có phân bổ hóa đơn → tạo InvoicePayment trừ trực tiếp công nợ hóa đơn.
      // Phần dư (amount - Σ invoices) tự ghi nhận thành credit (Formula A xử lý).
      const invoiceAllocs = (a.invoices || []).filter(
        (inv) => Number(inv.amount) > 0,
      );
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
          sepayReferenceCode: tx.referenceNumber || undefined,
          ...(invoiceAllocs.length > 0
            ? {
                allocateToInvoices: true,
                invoices: invoiceAllocs.map((inv) => ({
                  invoiceId: inv.invoiceId,
                  amount: Number(inv.amount),
                })),
              }
            : {}),
        } as any,
        userId,
      );
      createdCashFlows.push({
        customerId: a.customerId,
        cashFlow: (result as any)?.cashFlow ?? null,
      });
    }

    // Ghi lại allocations: GIỮ các phiếu còn hiệu lực + thêm phiếu mới.
    await this.prisma.$transaction(async (txc) => {
      await txc.sepayAllocation.deleteMany({
        where: { sepayTransactionId: tx.id },
      });

      const keptData = keptAllocs.map((a) => ({
        sepayTransactionId: tx.id,
        customerId: a.customerId,
        customerName: a.customerName,
        amount: a.amount,
        note: a.note,
        cashFlowId: a.cashFlowId,
        createdById: a.createdById,
        confirmedById: a.confirmedById,
        confirmedAt: a.confirmedAt,
      }));

      const newData = allocations.map((a) => {
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
      });

      await txc.sepayAllocation.createMany({ data: [...keptData, ...newData] });

      // Cột legacy: trỏ cashFlowId vào phiếu đầu tiên (ưu tiên phiếu giữ lại).
      const legacyCashFlowId =
        keptAllocs[0]?.cashFlowId ?? createdCashFlows[0]?.cashFlow?.id ?? null;
      await txc.sepayTransaction.update({
        where: { id: tx.id },
        data: {
          cashFlowId: legacyCashFlowId,
          confirmedById: userId,
          confirmedAt: new Date(),
        },
      });
    });

    void this.debtTicketAutoClose.onSepayReceiptConfirmed(
      tx.id,
      allocations.map((a) => a.customerId),
    );

    return {
      success: true,
      cashFlows: createdCashFlows.map((x) => x.cashFlow).filter(Boolean),
    };
  }
}
