import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DebtTicketsService } from './debt-tickets.service';
import {
  addCustomerChangedHook,
} from '../common/customer-debt.util';
import {
  DEBT_TICKET_OPEN_STATUSES,
} from '../debt-tracking/debt-tracking.constants';

/**
 * ĐỐI CHIẾU THANH TOÁN TỪ BIẾN ĐỘNG SỐ DƯ (Sepay).
 *
   * Nghiệp vụ: sale gắn khách trên giao dịch tiền về. Nếu chỉ có một khách,
   * toàn bộ amountIn được dùng làm xác nhận tạm để kiểm tra phiếu ngừng đi hàng;
   * đây chưa phải thanh toán kế toán. Nếu có nhiều khách, phải chờ kế toán phân
   * bổ tiền khi tạo phiếu thu.
 *
 * VÌ SAO ĐỐI CHIẾU THEO NHÓM, KHÔNG THEO TỪNG DÒNG:
 * Tại thời điểm gắn khách, hệ thống chưa biết số tiền của từng khách —
 * `SepayAllocation.amount` được ghi bằng 0 (xem sepay-match.service.ts,
 * bước assignCustomers), chỉ khi kế toán tạo phiếu thu mới có số chính xác.
 * Ngoài ra một khách ngoài đời có thể có nhiều mã KH trong hệ thống và
 * chuyển một cục tiền cho nhiều tài khoản cùng lúc.
 *
 * Vì vậy: lấy TỔNG số tiền cần thu của tất cả các dòng khớp trong cùng một
 * ticket, so với số tiền về. Đủ thì đóng cả nhóm; thiếu thì đánh dấu PARTIAL
 * (đã có tiền về, chờ phân bổ) chứ không tự đóng — tránh đóng nhầm.
 */
@Injectable()
export class DebtTicketAutoCloseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DebtTicketAutoCloseService.name);
  private readonly pendingTimers = new Map<number, NodeJS.Timeout>();
  private removeDebtHook?: () => void;

  constructor(
    private prisma: PrismaService,
    private ticketsService: DebtTicketsService,
  ) {}

  onModuleInit(): void {
    this.removeDebtHook = addCustomerChangedHook((customerId) => {
      const old = this.pendingTimers.get(customerId);
      if (old) clearTimeout(old);
      const timer = setTimeout(() => {
        this.pendingTimers.delete(customerId);
        void this.ticketsService
          .reconcileCustomerPayments(customerId)
          .catch((error) =>
            this.logger.warn(
              `Tự đối chiếu ticket công nợ cho KH#${customerId} thất bại: ${error?.message || error}`,
            ),
          );
      }, 1500);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingTimers.set(customerId, timer);
    });

    // Các giao dịch Sepay có thể được gắn khách trước khi ticket được tạo hoặc
    // trước khi backend triển khai logic này. Rà lại ticket đang mở khi khởi
    // động để đồng bộ trạng thái mà không yêu cầu sale gắn lại khách.
    void this.reconcileExistingOpenTickets();
  }

  onModuleDestroy(): void {
    this.removeDebtHook?.();
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private async reconcileExistingOpenTickets(): Promise<void> {
    try {
      const rows = await this.prisma.debtTicketCustomer.findMany({
        where: { ticket: { status: { in: DEBT_TICKET_OPEN_STATUSES } } },
        distinct: ['customerId'],
        select: { customerId: true },
      });
      for (const row of rows) {
        await this.ticketsService.reconcileCustomerPayments(row.customerId);
      }
      if (rows.length > 0) {
        this.logger.log(`Đã đối chiếu lại ${rows.length} khách trong ticket mở`);
      }
    } catch (error) {
      this.logger.warn(`Đối chiếu ticket khi khởi động thất bại: ${error}`);
    }
  }

  /**
   * Gọi SAU KHI gắn khách vào giao dịch Sepay thành công.
   * Không bao giờ throw ra ngoài: việc đối chiếu ticket không được phép làm
   * hỏng luồng gắn khách của kế toán.
   */
  async onSepayCustomersAssigned(
    _sepayTransactionId: number,
    customerIds: number[],
  ): Promise<void> {
    try {
      if (!customerIds?.length) return;

      for (const customerId of [...new Set(customerIds)]) {
        await this.ticketsService.reconcileCustomerPayments(customerId);
      }
    } catch (e) {
      // Nuốt lỗi có chủ đích — xem chú thích ở đầu class.
      this.logger.warn(
        `Đối chiếu ticket sau khi gắn khách Sepay#${_sepayTransactionId} thất bại: ${e}`,
      );
    }
  }


  /**
   * Gọi SAU KHI bỏ gán khách khỏi giao dịch Sepay.
   * Hoàn tác việc ghi nhận thanh toán và mở lại ticket nếu ticket đó đã được
   * đóng TỰ ĐỘNG. Thiếu bước này thì một lần bấm nhầm sẽ khóa ticket vĩnh viễn.
   */
  async onSepayCustomersUnassigned(
    sepayTransactionId: number,
    customerIds?: number[],
  ): Promise<void> {
    try {
      for (const customerId of customerIds ?? []) {
        await this.ticketsService.reconcileCustomerPayments(customerId);
      }

      this.logger.log(
        `Sepay#${sepayTransactionId}: đã đối chiếu lại ${customerIds?.length ?? 0} khách sau khi bỏ gán`,
      );
    } catch (e) {
      this.logger.warn(
        `Hoàn tác đối chiếu ticket cho Sepay#${sepayTransactionId} thất bại: ${e}`,
      );
    }
  }

  /**
   * Gọi sau khi kế toán đã tạo CashFlow thật cho giao dịch. Xóa xác nhận tạm
   * vì từ thời điểm này việc đối chiếu chỉ dựa trên phiếu thu đã hạch toán.
   */
  async onSepayReceiptConfirmed(
    sepayTransactionId: number,
    customerIds: number[],
  ): Promise<void> {
    if (!customerIds.length) return;
    await this.prisma.debtTicketCustomer.updateMany({
      where: {
        provisionalSepayTxId: sepayTransactionId,
        customerId: { in: customerIds },
      },
      data: {
        provisionalPaymentAmount: null,
        provisionalSepayTxId: null,
      },
    });
    for (const customerId of customerIds) {
      await this.ticketsService.reconcileCustomerPayments(customerId);
    }
  }
}
