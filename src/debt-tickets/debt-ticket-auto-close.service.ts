import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DebtTicketsService } from './debt-tickets.service';
import {
  DEBT_TICKET_OPEN_STATUSES,
  DEBT_TICKET_LINE_STATUS,
  MONEY_EPSILON,
} from '../debt-tracking/debt-tracking.constants';

/**
 * ĐỐI CHIẾU THANH TOÁN TỪ BIẾN ĐỘNG SỐ DƯ (Sepay).
 *
 * Nghiệp vụ: nhân viên vào trang Biến động số dư và GẮN KHÁCH HÀNG cho một
 * giao dịch tiền về ⇒ coi như khách đó đã thanh toán. Không cần chờ tạo phiếu thu.
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
export class DebtTicketAutoCloseService {
  private readonly logger = new Logger(DebtTicketAutoCloseService.name);

  constructor(
    private prisma: PrismaService,
    private ticketsService: DebtTicketsService,
  ) {}

  /**
   * Gọi SAU KHI gắn khách vào giao dịch Sepay thành công.
   * Không bao giờ throw ra ngoài: việc đối chiếu ticket không được phép làm
   * hỏng luồng gắn khách của kế toán.
   */
  async onSepayCustomersAssigned(
    sepayTransactionId: number,
    customerIds: number[],
  ): Promise<void> {
    try {
      if (!customerIds?.length) return;

      const tx = await this.prisma.sepayTransaction.findUnique({
        where: { id: sepayTransactionId },
        select: { id: true, amountIn: true },
      });
      if (!tx) return;

      const amountIn = Number(tx.amountIn ?? 0);
      if (amountIn <= MONEY_EPSILON) return;

      // Các dòng khách đang chờ thu, thuộc ticket còn mở.
      const lines = await this.prisma.debtTicketCustomer.findMany({
        where: {
          customerId: { in: customerIds },
          status: { not: DEBT_TICKET_LINE_STATUS.PAID },
          ticket: { status: { in: DEBT_TICKET_OPEN_STATUSES } },
        },
        include: { ticket: { select: { id: true, code: true } } },
      });

      if (lines.length === 0) {
        // Khách không nằm trong ticket nào: vẫn được ghi nhận là đã thanh toán
        // trên trang theo dõi công nợ (suy ra từ chính SepayAllocation), nên
        // ở đây không cần làm gì thêm.
        return;
      }

      // Gom theo ticket — mỗi ticket đối chiếu độc lập.
      const byTicket = new Map<number, typeof lines>();
      for (const l of lines) {
        const arr = byTicket.get(l.ticketId) ?? [];
        arr.push(l);
        byTicket.set(l.ticketId, arr);
      }

      for (const [ticketId, group] of byTicket) {
        // Mốc đối chiếu, theo thứ tự ưu tiên:
        //   1. Số tiền khách XÁC NHẬN sẽ trả (khách cam kết trả một phần)
        //   2. Số tiền TỐI THIỂU cần thu (hệ thống tính / kế toán chỉnh)
        //   3. Nợ đầu kì
        // Khách đã cam kết con số cụ thể thì lấy đúng con số đó làm chuẩn.
        const required = group.reduce((s, l) => {
          const target =
            l.confirmedAmount !== null
              ? l.confirmedAmount
              : l.minimumPayment !== null
                ? l.minimumPayment
                : l.debtAtCreate;
          return s + Number(target);
        }, 0);

        const enough = amountIn >= required - MONEY_EPSILON;
        const now = new Date();

        if (enough) {
          await this.prisma.debtTicketCustomer.updateMany({
            where: { id: { in: group.map((l) => l.id) } },
            data: {
              status: DEBT_TICKET_LINE_STATUS.PAID,
              paidAt: now,
              matchedSepayTxId: sepayTransactionId,
            },
          });

          // Ghi số tiền thực nhận cho từng dòng. Nhóm 1 khách thì ghi trọn số
          // tiền về; nhiều khách thì không suy đoán chia tiền — để null và chờ
          // phiếu thu của kế toán làm rõ.
          if (group.length === 1) {
            await this.prisma.debtTicketCustomer.update({
              where: { id: group[0].id },
              data: { paidAmount: amountIn },
            });
          }

          const closed = await this.ticketsService.tryAutoCloseTicket(
            this.prisma,
            ticketId,
          );
          this.logger.log(
            `Sepay#${sepayTransactionId}: ${group.length} khách đủ tiền ` +
              `(${amountIn} >= ${required}) ở ticket ${group[0].ticket.code}` +
              (closed ? ' → ticket tự đóng' : ''),
          );
        } else {
          await this.prisma.debtTicketCustomer.updateMany({
            where: { id: { in: group.map((l) => l.id) } },
            data: {
              status: DEBT_TICKET_LINE_STATUS.PARTIAL,
              matchedSepayTxId: sepayTransactionId,
            },
          });
          this.logger.log(
            `Sepay#${sepayTransactionId}: tiền về ${amountIn} < cần ${required} ` +
              `ở ticket ${group[0].ticket.code} → đánh dấu PARTIAL, chờ xử lý tay`,
          );
        }
      }
    } catch (e) {
      // Nuốt lỗi có chủ đích — xem chú thích ở đầu class.
      this.logger.warn(
        `Đối chiếu ticket sau khi gắn khách Sepay#${sepayTransactionId} thất bại: ${e}`,
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
      const where: any = { matchedSepayTxId: sepayTransactionId };
      if (customerIds?.length) where.customerId = { in: customerIds };

      const lines = await this.prisma.debtTicketCustomer.findMany({
        where,
        select: { id: true, ticketId: true },
      });
      if (lines.length === 0) return;

      await this.prisma.debtTicketCustomer.updateMany({
        where: { id: { in: lines.map((l) => l.id) } },
        data: {
          status: DEBT_TICKET_LINE_STATUS.PENDING,
          paidAt: null,
          paidAmount: null,
          matchedSepayTxId: null,
        },
      });

      const ticketIds = [...new Set(lines.map((l) => l.ticketId))];
      for (const ticketId of ticketIds) {
        await this.ticketsService.tryReopenTicket(this.prisma, ticketId);
      }

      this.logger.log(
        `Sepay#${sepayTransactionId}: gỡ thanh toán ${lines.length} dòng, ` +
          `xét mở lại ${ticketIds.length} ticket`,
      );
    } catch (e) {
      this.logger.warn(
        `Hoàn tác đối chiếu ticket cho Sepay#${sepayTransactionId} thất bại: ${e}`,
      );
    }
  }
}
