import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { calculateSupplierDebt, recalcSupplierDebt, SUPPLIER_DEBT_PO_WHERE } from '../common/supplier-debt.util';
import { PayablePaymentDto } from './dto';
import { money } from './external-production.util';
import { heldMaterialValueOf } from '../common/production-factory.util';

type AccountType = 'S' | 'M';
export interface PayableRow {
  targetType: 'purchase_order' | 'production';
  targetId: number;
  code: string;
  date: Date;
  manufacturerName?: string;
  total: number;
  paidAmount: number;
  debtAmount: number;
  currency: string;
  foreignDebt: number | null;
}

@Injectable()
export class PayablesService {
  constructor(private readonly prisma: PrismaService) {}

  supplierSummary(id: number) { return this.summary(this.prisma, 'S', id); }
  manufacturerSummary(id: number) { return this.summary(this.prisma, 'M', id); }

  async lock(tx: Prisma.TransactionClient, type: AccountType, id: number) {
    if (type === 'S') await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM manufacturers WHERE id = ${id} FOR UPDATE`;
  }

  async summary(db: any, type: AccountType, id: number) {
    const partner = type === 'S'
      ? await db.supplier.findUnique({ where: { id } })
      : await db.manufacturer.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('Không tìm thấy đối tác');
    const [orders, productions] = await Promise.all([
      type === 'S' ? db.purchaseOrder.findMany({
        where: { supplierId: id, ...SUPPLIER_DEBT_PO_WHERE },
        include: {
          payments: { where: { status: { not: 2 } } },
          supplierReturns: { where: { status: 3, refundType: 'manual_offset' } },
        },
      }) : [],
      db.production.findMany({
        // Nợ NSX ghi theo đợt nhận: Nhận một phần (5) + Hoàn thành (2).
        where: { isExternal: true, status: { in: [2, 5] }, manufacturerId: type === 'M' ? id : { not: null }, supplierId: type === 'S' ? id : null },
        include: {
          manufacturer: { select: { name: true } }, payableAllocations: { where: { status: 1 } },
          receipts: { where: { status: 1 }, select: { receivedDate: true }, orderBy: { receivedDate: 'desc' }, take: 1 },
        },
      }),
    ]);
    const rows: PayableRow[] = orders.map((po: any) => {
      const rate = Number(po.exchangeRate) || 1;
      const foreignPaid = [...po.payments.map((item: any) => item.foreignAmount == null ? Number(item.amount) / rate : Number(item.foreignAmount)),
        ...po.supplierReturns.map((item: any) => item.refundedForeignAmount == null ? Number(item.refundedAmount) / rate : Number(item.refundedForeignAmount))]
        .reduce((sum: number, value: number) => sum + value, 0);
      return {
        targetType: 'purchase_order', targetId: po.id, code: po.code, date: po.purchaseDate,
        total: Number(po.total) - Number(po.discount), paidAmount: Number(po.paidAmount),
        debtAmount: Math.max(0, Number(po.debtAmount)), currency: po.currency ?? 'VND',
        foreignDebt: po.currency === 'CNY' ? money(Math.max(0, Number(po.subTotal) / rate - foreignPaid)) : null,
      };
    });
    for (const row of productions) {
      rows.push({
        targetType: 'production', targetId: row.id, code: row.code,
        date: row.completedDate ?? row.receipts[0]?.receivedDate ?? row.updatedAt, manufacturerName: row.manufacturer?.name,
        total: Number(row.totalPayable), paidAmount: Number(row.paidAmount),
        debtAmount: Math.max(0, Number(row.debtAmount)), currency: row.feeCurrency,
        foreignDebt: row.feeCurrency === 'CNY'
          ? money(Math.max(0, Number(row.totalForeignPayable) - row.payableAllocations.reduce((sum: number, item: any) => sum + Number(item.foreignAmount ?? 0), 0))) : null,
      });
    }
    rows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.targetType.localeCompare(b.targetType) || a.targetId - b.targetId);
    const purchaseDebt = money(rows.filter((row) => row.targetType === 'purchase_order').reduce((sum, row) => sum + row.debtAmount, 0));
    const productionDebt = money(rows.filter((row) => row.targetType === 'production').reduce((sum, row) => sum + row.debtAmount, 0));
    let totalDebt: number;
    if (type === 'S') {
      totalDebt = (await calculateSupplierDebt(db, id)).totalDebt;
    } else {
      const [cash, adjustments] = await Promise.all([
        db.cashFlow.findMany({ where: { partnerType: 'M', partnerId: id, status: { not: 2 } }, select: { amount: true, isReceipt: true } }),
        db.payableAllocation.aggregate({ where: { status: 1, batch: { accountType: 'M', accountId: id, status: 1 } }, _sum: { fxAdjustment: true } }),
      ]);
      totalDebt = productions.reduce((sum: number, row: any) => sum + Number(row.totalPayable), 0)
        + cash.reduce((sum: number, row: any) => sum + Number(row.amount) * (row.isReceipt ? 1 : -1), 0)
        + Number(adjustments._sum.fxAdjustment ?? 0);
    }
    const unallocatedBalance = money(purchaseDebt + productionDebt - totalDebt);
    return {
      accountType: type, accountId: id, partnerName: partner.name,
      purchaseDebt, productionDebt, totalDebt: money(totalDebt),
      availableCredit: Math.max(0, unallocatedBalance), unallocatedBalance,
      data: rows.filter((row) => row.debtAmount > 0.005),
    };
  }

  async manufacturerAccounts(id: number) {
    const manufacturer = await this.prisma.manufacturer.findUnique({ where: { id } });
    if (!manufacturer) throw new NotFoundException('Không tìm thấy nhà sản xuất');
    const [productions, historical] = await Promise.all([
      this.prisma.production.findMany({ where: { manufacturerId: id }, include: { supplier: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.cashFlow.findMany({ where: { partnerType: 'M', partnerId: id, status: { not: 2 } }, select: { id: true }, take: 1 }),
    ]);
    const accounts = new Map<string, { type: AccountType; id: number }>();
    const current = { type: manufacturer.supplierId ? 'S' as const : 'M' as const, id: manufacturer.supplierId ?? id };
    accounts.set(`${current.type}:${current.id}`, current);
    for (const row of productions.filter((row) => row.status !== 1 && row.status !== 3)) {
      const account = { type: row.supplierId ? 'S' as const : 'M' as const, id: row.supplierId ?? id };
      accounts.set(`${account.type}:${account.id}`, account);
    }
    if (historical.length) accounts.set(`M:${id}`, { type: 'M', id });
    const groups = await Promise.all([...accounts.values()].map(async (account) => {
      const summary = await this.summary(this.prisma, account.type, account.id);
      const batches = await this.prisma.payablePaymentBatch.findMany({
        where: { accountType: account.type, accountId: account.id },
        include: { cashFlow: { select: { id: true, code: true } }, allocations: true },
        orderBy: { createdAt: 'desc' }, take: 100,
      });
      const own = productions.filter((row) => account.type === 'S' ? row.supplierId === account.id : row.supplierId == null);
      return {
        ...summary, batches,
        manufacturerProductionDebt: money(own.filter((row) => row.status === 2 || row.status === 5).reduce((sum, row) => sum + Number(row.debtAmount), 0)),
        heldMaterialValue: money(own.reduce((sum, row) => sum + heldMaterialValueOf(row), 0)),
      };
    }));
    return { manufacturer, productions, groups };
  }

  async pay(type: AccountType, id: number, dto: PayablePaymentDto, userId: number) {
    if (!Number.isFinite(dto.totalAmount) || dto.totalAmount < 0 || money(dto.totalAmount) !== dto.totalAmount) {
      throw new BadRequestException('Số tiền thực chi phải không âm và tối đa 2 số thập phân');
    }
    for (const line of dto.allocations) {
      for (const value of [line.amount, line.creditAmount, line.foreignAmount, line.creditForeignAmount]) {
        if (value != null && (!Number.isFinite(value) || value < 0 || money(value) !== value)) throw new BadRequestException('Số tiền phân bổ không âm và tối đa 2 số thập phân');
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ type, id, ...dto })).digest('hex');
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, type, id);
      const previous = await tx.payablePaymentBatch.findUnique({ where: { requestKey: dto.requestKey }, include: { cashFlow: true, allocations: true } });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ConflictException('Mã yêu cầu đã dùng cho nội dung khác');
        return previous;
      }
      if (!dto.requestKey.trim()) throw new BadRequestException('Thiếu mã yêu cầu thanh toán');
      if (dto.method === 'transfer' && !dto.accountId) throw new BadRequestException('Vui lòng chọn tài khoản ngân hàng');
      if (!await tx.branch.findUnique({ where: { id: dto.branchId } })) throw new BadRequestException('Chi nhánh không hợp lệ');
      const ids = dto.allocations.map((line) => `${line.targetType}:${line.targetId}`);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('Chứng từ phân bổ bị trùng');
      for (const line of [...dto.allocations].sort((a, b) => a.targetType.localeCompare(b.targetType) || a.targetId - b.targetId)) {
        if (line.targetType === 'production') await tx.$queryRaw`SELECT id FROM productions WHERE id = ${line.targetId} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${line.targetId} FOR UPDATE`;
      }
      const initial = await this.summary(tx, type, id);
      const totalCash = money(dto.allocations.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
      const totalCredit = money(dto.allocations.reduce((sum, line) => sum + Number(line.creditAmount ?? 0), 0));
      if (totalCash > dto.totalAmount + 0.005) throw new BadRequestException('Tổng phân bổ vượt số tiền thực chi');
      if (type === 'M') {
        const manufacturer = await tx.manufacturer.findUniqueOrThrow({ where: { id } });
        if (manufacturer.supplierId && dto.totalAmount - totalCash > 0.005) {
          throw new BadRequestException('NSX đã liên kết NCC mới; tiền ứng mới cần chi tại NCC đang liên kết');
        }
      }
      if (totalCredit > initial.availableCredit + 0.005) throw new BadRequestException('Số tiền cấn vượt ứng trước còn lại');
      if (!(dto.totalAmount > 0) && !(totalCredit > 0)) throw new BadRequestException('Vui lòng nhập tiền trả hoặc tiền cấn');
      const date = dto.transDate ? new Date(dto.transDate) : new Date();
      const batch = await tx.payablePaymentBatch.create({ data: {
        requestKey: dto.requestKey, fingerprint, accountType: type, accountId: id,
        totalAmount: dto.totalAmount, createdBy: userId, transDate: date,
      } });
      let cashFlowId: number | null = null;
      if (dto.totalAmount > 0) {
        const cash = await tx.cashFlow.create({ data: {
          code: `PCNSX${randomUUID().slice(0, 12).toUpperCase()}`,
          branchId: dto.branchId, cashFlowGroupId: 9, isReceipt: false, amount: dto.totalAmount,
          currency: 'VND', exchangeRate: 1, transDate: date, method: dto.method, accountId: dto.accountId,
          partnerType: type, partnerId: id, partnerName: initial.partnerName,
          description: dto.description || 'Thanh toán công nợ', status: 0, statusValue: 'Đã thanh toán',
          createdBy: userId, collectorUserId: dto.collectorUserId ?? userId, usedForFinancialReporting: 1,
        } });
        cashFlowId = cash.id;
        await tx.payablePaymentBatch.update({ where: { id: batch.id }, data: { cashFlowId } });
      }
      for (const line of [...dto.allocations].sort((a, b) => a.targetType.localeCompare(b.targetType) || a.targetId - b.targetId)) {
        const payable = initial.data.find((row) => row.targetType === line.targetType && row.targetId === line.targetId);
        if (!payable) throw new BadRequestException('Chứng từ không thuộc đối tác hoặc không còn nợ');
        let remaining = payable.debtAmount;
        let foreignRemaining = payable.foreignDebt ?? 0;
        for (const source of ['credit', 'cash'] as const) {
          const amount = money(source === 'cash' ? line.amount ?? 0 : line.creditAmount ?? 0);
          const foreign = source === 'cash' ? line.foreignAmount : line.creditForeignAmount;
          if (amount <= 0) {
            if (Number(foreign ?? 0) > 0) throw new BadRequestException('Số tiền ngoại tệ thiếu số tiền quy đổi');
            continue;
          }
          let settled = amount;
          if (payable.currency === 'CNY') {
            if (!(Number(foreign) > 0) || !(Number(line.exchangeRate) > 0)) throw new BadRequestException('Phiếu CNY cần số tiền ngoại tệ và tỷ giá');
            if (Math.abs(Math.round(Number(foreign) * Number(line.exchangeRate)) - amount) > 0.005) throw new BadRequestException('Số tiền CNY quy đổi không khớp');
            if (Number(foreign) > foreignRemaining + 0.005) throw new BadRequestException('Thanh toán vượt dư nợ CNY');
            settled = Number(foreign) >= foreignRemaining - 0.005 ? remaining : money(new Prisma.Decimal(remaining).mul(Number(foreign)).div(foreignRemaining));
            foreignRemaining = money(foreignRemaining - Number(foreign));
          } else if (foreign != null || line.exchangeRate != null) {
            throw new BadRequestException('Phiếu VND không nhận số tiền ngoại tệ');
          }
          if (settled > remaining + 0.005) throw new BadRequestException('Thanh toán vượt dư nợ chứng từ');
          remaining = money(remaining - settled);
          let paymentId: number | null = null;
          if (line.targetType === 'purchase_order') {
            const payment = await tx.purchaseOrderPayment.create({ data: {
              purchaseOrderId: line.targetId, code: `PCPB${batch.id}-${source}-${line.targetId}`,
              amount: settled, paymentDate: date, paymentMethod: dto.method, accountId: dto.accountId,
              cashFlowId: source === 'cash' ? cashFlowId : null, status: 1, statusValue: 'Đã thanh toán',
              foreignAmount: foreign ?? null, exchangeRate: line.exchangeRate ?? null,
              description: source === 'credit' ? 'Cấn ứng trước' : dto.description,
            } });
            paymentId = payment.id;
          }
          await tx.payableAllocation.create({ data: {
            batchId: batch.id, targetType: line.targetType, targetId: line.targetId, targetCode: payable.code,
            source, productionId: line.targetType === 'production' ? line.targetId : null,
            purchaseOrderPaymentId: paymentId, amount, settledAmount: settled,
            foreignAmount: foreign ?? null, exchangeRate: line.exchangeRate ?? null, fxAdjustment: money(amount - settled),
          } });
        }
        await this.recalcTarget(tx, line.targetType, line.targetId);
      }
      if (type === 'S') await recalcSupplierDebt(tx, id);
      await tx.auditLog.create({ data: {
        actionType: 'POST', actionCode: 'CASHFLOW_CREATE', entityType: 'payable_payments',
        entityId: String(batch.id), userId, userName: (await tx.user.findUnique({ where: { id: userId } }))?.name ?? 'System',
        branchId: dto.branchId, message: `Thanh toán ${initial.partnerName}: ${dto.totalAmount}; cấn ứng ${totalCredit}`,
        snapshot: JSON.parse(JSON.stringify(dto)),
      } });
      return tx.payablePaymentBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { cashFlow: true, allocations: true } });
    }, { timeout: 60000 });
  }

  private async recalcTarget(tx: Prisma.TransactionClient, type: string, id: number) {
    if (type === 'production') {
      const [row, paid] = await Promise.all([
        tx.production.findUniqueOrThrow({ where: { id } }),
        tx.payableAllocation.aggregate({ where: { productionId: id, status: 1 }, _sum: { settledAmount: true } }),
      ]);
      const paidAmount = Number(paid._sum.settledAmount ?? 0);
      await tx.production.update({ where: { id }, data: { paidAmount, debtAmount: money(Number(row.totalPayable) - paidAmount) } });
    } else {
      const [row, payments, offsets] = await Promise.all([
        tx.purchaseOrder.findUniqueOrThrow({ where: { id } }),
        tx.purchaseOrderPayment.aggregate({ where: { purchaseOrderId: id, status: { not: 2 } }, _sum: { amount: true } }),
        tx.supplierReturn.aggregate({ where: { purchaseOrderId: id, status: 3, refundType: 'manual_offset' }, _sum: { refundedAmount: true } }),
      ]);
      const paidAmount = Number(payments._sum.amount ?? 0) + Number(offsets._sum.refundedAmount ?? 0);
      const debtAmount = money(Number(row.total) - Number(row.discount) - paidAmount);
      await tx.purchaseOrder.update({ where: { id }, data: { paidAmount, debtAmount, supplierDebt: debtAmount } });
    }
  }

  async cancelBatchTx(tx: Prisma.TransactionClient, batchId: number, userId?: number) {
    const initial = await tx.payablePaymentBatch.findUnique({ where: { id: batchId } });
    if (!initial) throw new NotFoundException('Không tìm thấy lần phân bổ');
    await this.lock(tx, initial.accountType as AccountType, initial.accountId);
    const batch = await tx.payablePaymentBatch.findUniqueOrThrow({ where: { id: batchId }, include: { allocations: true, cashFlow: true } });
    if (batch.status === 2) return batch;
    await tx.payablePaymentBatch.update({ where: { id: batchId }, data: { status: 2, cancelledAt: new Date() } });
    await tx.payableAllocation.updateMany({ where: { batchId }, data: { status: 2 } });
    const paymentIds = batch.allocations.flatMap((row) => row.purchaseOrderPaymentId ? [row.purchaseOrderPaymentId] : []);
    if (paymentIds.length) await tx.purchaseOrderPayment.updateMany({ where: { id: { in: paymentIds } }, data: { status: 2, statusValue: 'Đã hủy' } });
    if (batch.cashFlowId) await tx.cashFlow.update({ where: { id: batch.cashFlowId }, data: { status: 2, statusValue: 'Đã hủy' } });
    for (const key of new Set(batch.allocations.map((row) => `${row.targetType}:${row.targetId}`))) {
      const [type, id] = key.split(':');
      await this.recalcTarget(tx, type, Number(id));
    }
    await this.assertCreditCoverage(tx, batch.accountType as AccountType, batch.accountId);
    if (batch.accountType === 'S') await recalcSupplierDebt(tx, batch.accountId);
    if (userId) await tx.auditLog.create({ data: {
      actionType: 'DELETE', actionCode: 'CASHFLOW_CANCEL', entityType: 'payable_payments',
      entityId: String(batchId), userId, userName: 'System', message: `Hủy phân bổ thanh toán ${batchId}`,
    } });
    return batch;
  }

  async assertCreditCoverage(tx: Prisma.TransactionClient, type: AccountType, id: number) {
    const used = await tx.payableAllocation.count({ where: { status: 1, source: 'credit', batch: { accountType: type, accountId: id, status: 1 } } });
    if (used && (await this.summary(tx, type, id)).unallocatedBalance < -0.01) {
      throw new BadRequestException('Tiền ứng đã được cấn ở lần khác; hãy hủy các lần cấn liên quan trước');
    }
  }

  async cancelBatch(id: number, userId: number) {
    return this.prisma.$transaction((tx) => this.cancelBatchTx(tx, id, userId), { timeout: 60000 });
  }
}
