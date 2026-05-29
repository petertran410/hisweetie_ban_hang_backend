import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderSupplierPaymentDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

@Injectable()
export class OrderSupplierPaymentsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreateOrderSupplierPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id: dto.orderSupplierId },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
              debt: true,
            },
          },
        },
      });

      if (!orderSupplier) {
        throw new Error('Không tìm thấy phiếu đặt hàng nhập');
      }

      // Đối xứng `invoice-payments.service.ts:71-73`: bắt buộc PDN có chi
      // nhánh trước khi tạo CashFlow. Tránh fallback `branchId ?? 1` ghi sai.
      if (!orderSupplier.branchId) {
        throw new Error('Phiếu đặt hàng nhập chưa có chi nhánh');
      }

      // Generate payment code PCPDN
      const code = await this.generatePaymentCode(tx);

      // Map payment method to cashflow method
      let cashFlowMethod = 'cash';
      if (dto.paymentMethod === 'transfer') {
        cashFlowMethod = 'transfer';
      } else if (dto.paymentMethod === 'card') {
        cashFlowMethod = 'card';
      }

      // Tạo CashFlow TRƯỚC để có id gán vào OrderSupplierPayment.cashFlowId
      // (đối xứng `invoice-payments.service.ts:78-99`).
      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: orderSupplier.branchId,
          cashFlowGroupId: 9,
          isReceipt: false,
          amount: dto.amount,
          transDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          method: cashFlowMethod,
          accountId: dto.accountId,
          partnerType: 'S',
          partnerId: orderSupplier.supplierId,
          partnerName: orderSupplier.supplier?.name,
          contactNumber: orderSupplier.supplier?.contactNumber,
          address: orderSupplier.supplier?.address,
          description:
            dto.notes || `Chi tiền đặt hàng nhập ${orderSupplier.code} - PCPDN`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
          supplierDebtSnapshot: null,
        },
      });

      const payment = await tx.orderSupplierPayment.create({
        data: {
          code,
          orderSupplierId: dto.orderSupplierId,
          paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod || 'cash',
          accountId: dto.accountId,
          description:
            dto.notes || `Trả tiền đặt hàng nhập ${orderSupplier.code} - PCPDN`,
          status: 1,
          statusValue: 'Đã thanh toán',
          cashFlowId: cashFlow.id,
        },
      });

      // Recalc paidAmount + supplierDebt cache — chỉ tính payment ACTIVE
      // (status≠2). Đối xứng pattern phía bán: cache reflect đúng giá trị
      // của các record không hủy.
      const activePayments = await tx.orderSupplierPayment.findMany({
        where: {
          orderSupplierId: dto.orderSupplierId,
          status: { not: 2 },
        },
        select: { amount: true },
      });
      const paidAmount = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );
      const subTotal = Number(orderSupplier.subTotal || 0);

      await tx.orderSupplier.update({
        where: { id: dto.orderSupplierId },
        data: {
          paidAmount,
          supplierDebt: subTotal - paidAmount,
        },
      });

      // Update supplier debt: Trừ vào debt (NCC nợ mình nếu số âm)
      await this.updateSupplierDebt(orderSupplier.supplierId, tx);

      // Snapshot supplier debt sau recalc.
      const updatedSupplier = await tx.supplier.findUnique({
        where: { id: orderSupplier.supplierId },
        select: { debt: true },
      });
      await tx.cashFlow.update({
        where: { id: cashFlow.id },
        data: {
          supplierDebtSnapshot: updatedSupplier
            ? Number(updatedSupplier.debt)
            : null,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_SUPPLIER_PAYMENT_CREATE',
        entityType: 'order_supplier_payment',
        entityId: payment.id.toString(),
        entityCode: payment.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_PAYMENT_CREATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_PAYMENT_CREATE'),
        snapshot: {
          code: payment.code,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          orderSupplier: {
            code: orderSupplier.code,
            supplier: orderSupplier.supplier?.name,
          },
        },
        message: renderAuditMessage('ORDER_SUPPLIER_PAYMENT_CREATE', {
          paymentCode: payment.code,
          orderSupplierCode: orderSupplier.code,
          amount: Number(payment.amount),
        }),
        messageTemplate: 'ORDER_SUPPLIER_PAYMENT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || undefined,
      });

      return {
        payment,
        cashFlow,
      };
    });
  }

  async findAllByOrderSupplier(orderSupplierId: number) {
    // 1. Payments trực tiếp trên order supplier (PCPDN)
    const directPayments = await this.prisma.orderSupplierPayment.findMany({
      where: { orderSupplierId },
      orderBy: { paymentDate: 'desc' },
    });

    // 2. Payments từ các purchase order liên kết (PCPN)
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: { orderSupplierId },
      select: {
        id: true,
        code: true,
        payments: {
          select: {
            id: true,
            code: true,
            amount: true,
            paymentDate: true,
            paymentMethod: true,
            description: true,
            status: true,
            statusValue: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    // 3. Flatten payments từ purchase orders
    const purchaseOrderPayments = purchaseOrders.flatMap((po) =>
      po.payments.map((p) => ({
        ...p,
        orderSupplierId,
        accountId: null,
        source: 'purchase_order' as const,
        purchaseOrderCode: po.code,
      })),
    );

    // 4. Gộp + sort theo ngày giảm dần
    const allPayments = [
      ...directPayments.map((p) => ({
        ...p,
        source: 'order_supplier' as const,
        purchaseOrderCode: null,
      })),
      ...purchaseOrderPayments,
    ].sort(
      (a, b) =>
        new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime(),
    );

    return allPayments;
  }

  async remove(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderSupplierPayment.findUnique({
        where: { id },
        include: { orderSupplier: true },
      });

      if (!payment) {
        throw new Error('Không tìm thấy thanh toán');
      }

      // Đối xứng `invoice-payments.service.ts` và `order-payments.service.ts`:
      // SOFT-cancel CashFlow + Payment thay vì hard-delete. Giữ audit trail
      // và đảm bảo Formula B (recalcSupplierDebt) thấy đúng dữ liệu sau khi
      // hủy (filter status≠2 tự động loại các record này). Ưu tiên match qua
      // FK `cashFlowId`, fallback `code`.
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
            partnerType: 'S',
            partnerId: payment.orderSupplier.supplierId,
            status: { not: 2 },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      await tx.orderSupplierPayment.update({
        where: { id },
        data: { status: 2, statusValue: 'Đã hủy' },
      });

      // Recalc paidAmount + supplierDebt cache trên OrderSupplier — chỉ tính
      // payment ACTIVE (status≠2). Đối xứng `Order.calculateTotals` phía bán.
      const activePayments = await tx.orderSupplierPayment.findMany({
        where: {
          orderSupplierId: payment.orderSupplierId,
          status: { not: 2 },
        },
        select: { amount: true },
      });
      const paidAmount = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );
      const subTotal = Number(payment.orderSupplier.subTotal || 0);

      await tx.orderSupplier.update({
        where: { id: payment.orderSupplierId },
        data: {
          paidAmount,
          supplierDebt: subTotal - paidAmount,
        },
      });

      if (userId) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const supplierName = await this.prisma.supplier.findUnique({
          where: { id: payment.orderSupplier.supplierId },
          select: { name: true },
        });

        // FIX: actionCode đúng phải là ORDER_SUPPLIER_PAYMENT_DELETE
        // (trước đây sai thành ORDER_SUPPLIER_DELETE → log hiển thị
        // "xóa phiếu đặt hàng" cho hành động "xóa thanh toán").
        await this.auditLogsService.create({
          actionType: 'DELETE',
          actionCode: 'ORDER_SUPPLIER_PAYMENT_DELETE',
          entityType: 'order_supplier_payment',
          entityId: id.toString(),
          entityCode: payment.code,
          category: getCategoryFromActionCode('ORDER_SUPPLIER_PAYMENT_DELETE'),
          severity: getSeverityFromActionCode('ORDER_SUPPLIER_PAYMENT_DELETE'),
          snapshot: {
            code: payment.code,
            amount: Number(payment.amount),
            paymentMethod: payment.paymentMethod,
            paymentDate: payment.paymentDate,
            orderSupplier: {
              code: payment.orderSupplier.code,
              supplier: supplierName?.name
                ? {
                    name: supplierName?.name,
                  }
                : null,
            },
          },
          message: renderAuditMessage('ORDER_SUPPLIER_PAYMENT_DELETE', {
            paymentCode: payment.code,
            orderSupplierCode: payment.orderSupplier.code,
          }),
          messageTemplate: 'ORDER_SUPPLIER_PAYMENT_DELETE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId:
            payment.orderSupplier.branchId || user?.branchId || undefined,
        });
      }

      // Update supplier debt
      await this.updateSupplierDebt(payment.orderSupplier.supplierId, tx);

      return { message: 'Xóa thanh toán thành công' };
    });
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PCPDN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPayments = await tx.orderSupplierPayment.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
      });

      const validCodes = allPayments
        .map((p: any) => p.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;
      const exists = await tx.orderSupplierPayment.findFirst({
        where: { code },
      });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán duy nhất');
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }
}
