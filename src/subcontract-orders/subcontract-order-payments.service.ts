import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import {
  recomputeSubcontractOrderTotals,
  SUBCONTRACT_ACTIVE_STATUSES,
} from '../common/subcontract-order.util';
import { CreateSubcontractPaymentDto } from './dto';

type Tx = Prisma.TransactionClient;

// Nhóm thu chi "trả tiền NCC" — cùng id cố định mà thanh toán phiếu nhập dùng
// (purchase-order-payments.service.ts).
const SUPPLIER_PAYMENT_CASHFLOW_GROUP_ID = 9;

/**
 * Thanh toán cho nhà máy theo từng lệnh gia công. Đối xứng
 * PurchaseOrderPaymentsService: mỗi lần trả = 1 CashFlow chi (partnerType 'S')
 * + 1 SubcontractOrderPayment cùng mã. Công nợ NCC giảm qua CashFlow
 * (Formula B), còn `paidAmount` của lệnh chỉ là cache hiển thị.
 */
@Injectable()
export class SubcontractOrderPaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(
    orderId: number,
    dto: CreateSubcontractPaymentDto,
    userId: number,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.subcontractOrder.findUnique({
        where: { id: orderId },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
            },
          },
        },
      });
      if (!order) throw new NotFoundException('Không tìm thấy lệnh gia công');
      if (!SUBCONTRACT_ACTIVE_STATUSES.includes(order.status)) {
        throw new BadRequestException(
          'Chỉ thanh toán cho lệnh đã gửi nguyên liệu và chưa hủy',
        );
      }

      const isCNY = order.currency === 'CNY';
      if (isCNY) {
        if (
          dto.exchangeRate == null ||
          Number(dto.exchangeRate) <= 0 ||
          dto.foreignAmount == null ||
          Number(dto.foreignAmount) <= 0
        ) {
          throw new BadRequestException(
            'Lệnh dùng CNY, vui lòng nhập đủ tỉ giá và số tiền CNY',
          );
        }
        if (
          Math.round(Number(dto.foreignAmount) * Number(dto.exchangeRate)) !==
          dto.amount
        ) {
          throw new BadRequestException(
            'Số tiền CNY quy đổi không khớp số tiền VND',
          );
        }
      } else if (dto.exchangeRate != null || dto.foreignAmount != null) {
        throw new BadRequestException(
          'Lệnh dùng VND, không được gửi số tiền CNY',
        );
      }

      // Trả vượt số còn nợ là hợp lệ (đặt cọc trước khi nhận hàng) nhưng phải
      // do người dùng chủ động xác nhận, tránh gõ nhầm số.
      const remaining = Math.max(
        Number(order.payableAmount) - Number(order.paidAmount),
        0,
      );
      if (dto.amount > remaining && !dto.confirmExceed) {
        throw new ConflictException({
          code: 'EXCEED_PAYABLE',
          remaining,
          message: `Số tiền trả vượt số còn nợ của lệnh (${remaining.toLocaleString('vi-VN')}đ)`,
        });
      }

      const code = await this.generatePaymentCode(tx);
      const paymentDate = dto.paymentDate
        ? new Date(dto.paymentDate)
        : new Date();
      const method = ['transfer', 'card'].includes(dto.paymentMethod || '')
        ? (dto.paymentMethod as string)
        : 'cash';

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: order.branchId,
          cashFlowGroupId: SUPPLIER_PAYMENT_CASHFLOW_GROUP_ID,
          isReceipt: false,
          amount: dto.amount,
          currency: isCNY ? 'CNY' : 'VND',
          exchangeRate: isCNY ? Number(dto.exchangeRate) : 1,
          foreignAmount: isCNY ? Number(dto.foreignAmount) : null,
          transDate: paymentDate,
          method,
          accountId: dto.accountId,
          partnerType: 'S',
          partnerId: order.supplierId,
          partnerName: order.supplier?.name,
          contactNumber: order.supplier?.contactNumber,
          address: order.supplier?.address,
          description: dto.notes || `Chi tiền gia công ${order.code}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          supplierDebtSnapshot: null,
        },
      });

      const payment = await tx.subcontractOrderPayment.create({
        data: {
          code,
          orderId,
          paymentDate,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description: dto.notes || `Trả tiền gia công ${order.code}`,
          status: 1,
          statusValue: 'Đã thanh toán',
          cashFlowId: cashFlow.id,
          exchangeRate: isCNY ? Number(dto.exchangeRate) : null,
          foreignAmount: isCNY ? Number(dto.foreignAmount) : null,
        },
      });

      await recomputeSubcontractOrderTotals(tx, orderId);
      const debt = await recalcSupplierDebt(tx, order.supplierId);
      await tx.cashFlow.update({
        where: { id: cashFlow.id },
        data: { supplierDebtSnapshot: debt },
      });

      return { order, payment, cashFlow };
    });

    await this.audit(
      'SUBCONTRACT_ORDER_PAYMENT_CREATE',
      'POST',
      result.order,
      result.payment,
      userId,
      { amount: Number(result.payment.amount) },
    );
    return { payment: result.payment, cashFlow: result.cashFlow };
  }

  /** Hủy mềm phiếu chi + thanh toán (giữ vết), rồi tính lại nợ. */
  async remove(orderId: number, paymentId: number, userId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.subcontractOrderPayment.findFirst({
        where: { id: paymentId, orderId },
        include: { order: true },
      });
      if (!payment) throw new NotFoundException('Không tìm thấy thanh toán');
      if (payment.status === 2) {
        throw new BadRequestException('Thanh toán này đã hủy');
      }

      const or: Prisma.CashFlowWhereInput[] = [{ code: payment.code }];
      if (payment.cashFlowId != null) or.push({ id: payment.cashFlowId });
      await tx.cashFlow.updateMany({
        where: {
          OR: or,
          partnerType: 'S',
          partnerId: payment.order.supplierId,
          status: { not: 2 },
        },
        data: { status: 2, statusValue: 'Đã hủy' },
      });
      await tx.subcontractOrderPayment.update({
        where: { id: paymentId },
        data: { status: 2, statusValue: 'Đã hủy' },
      });

      await recomputeSubcontractOrderTotals(tx, orderId);
      await recalcSupplierDebt(tx, payment.order.supplierId);
      return { order: payment.order, payment };
    });

    await this.audit(
      'SUBCONTRACT_ORDER_PAYMENT_DELETE',
      'DELETE',
      result.order,
      result.payment,
      userId,
    );
    return { message: 'Hủy thanh toán thành công' };
  }

  /**
   * Mã PCGC######. Mã dùng chung cho CashFlow (code @unique) nên phải kiểm
   * tra trùng ở CẢ hai bảng. Tiền tố không trùng `PCTUPN` (bị Formula B loại)
   * và không khớp mẫu `PC\d{6}` của phiếu chi gộp.
   */
  private async generatePaymentCode(tx: Tx): Promise<string> {
    const prefix = 'PCGC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    const existing = await tx.subcontractOrderPayment.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
      orderBy: { id: 'desc' },
      take: 50,
    });
    let next =
      existing
        .map((p) => p.code)
        .filter((c) => regex.test(c))
        .reduce(
          (max, c) => Math.max(max, parseInt(c.slice(prefix.length), 10)),
          0,
        ) + 1;

    for (let i = 0; i < 20; i++, next++) {
      const code = `${prefix}${String(next).padStart(6, '0')}`;
      const [payment, cashFlow] = await Promise.all([
        tx.subcontractOrderPayment.findFirst({ where: { code } }),
        tx.cashFlow.findUnique({ where: { code } }),
      ]);
      if (!payment && !cashFlow) return code;
    }
    throw new BadRequestException('Không thể tạo mã thanh toán duy nhất');
  }

  private async audit(
    actionCode: string,
    actionType: string,
    order: { id: number; code: string; branchId: number },
    payment: { id: number; code: string; amount: any },
    userId: number,
    params: Record<string, any> = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    await this.auditLogsService.create({
      actionType,
      actionCode,
      entityType: 'subcontract_order_payment',
      entityId: payment.id.toString(),
      entityCode: payment.code,
      category: getCategoryFromActionCode(actionCode),
      severity: getSeverityFromActionCode(actionCode),
      snapshot: {
        code: payment.code,
        amount: Number(payment.amount),
        orderCode: order.code,
      },
      message: renderAuditMessage(actionCode, {
        orderCode: order.code,
        paymentCode: payment.code,
        ...params,
      }),
      messageTemplate: actionCode,
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: order.branchId,
    });
  }
}
