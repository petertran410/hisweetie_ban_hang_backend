import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCashFlowDto,
  UpdateCashFlowDto,
  CashFlowQueryDto,
  CreatePaymentDto,
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import { recalcCustomerDebt as recalcCustomerDebtUtil } from 'src/common/customer-debt.util';
import { recalcSupplierDebt as recalcSupplierDebtUtil } from 'src/common/supplier-debt.util';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

@Injectable()
export class CashFlowsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreateCashFlowDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const method = dto.method || 'cash';
      const code = await this.generateManualCode(dto.isReceipt, method, tx);

      const statusValue = dto.isReceipt ? 'Đã thanh toán' : 'Đã chi';

      let customerDebtSnapshot: number | null = null;
      const createdCtnIds: number[] = [];
      const createdInvoicePaymentIds: number[] = [];

      if (dto.affectDebt && dto.partnerId && dto.partnerType === 'C') {
        const customer = await tx.customer.findUnique({
          where: { id: dto.partnerId },
          select: { id: true, totalDebt: true },
        });

        if (customer) {
          const debtHolderId = customer.id;
          const debtHolder = customer;

          const debtChange = dto.isReceipt ? -dto.amount : dto.amount;
          const newTotalDebt = Number(debtHolder?.totalDebt || 0) + debtChange;

          await tx.customer.update({
            where: { id: debtHolderId },
            data: { totalDebt: newTotalDebt },
          });

          customerDebtSnapshot = newTotalDebt;
        }

        if (
          dto.allocateToInvoices &&
          dto.invoiceAllocations &&
          dto.invoiceAllocations.length > 0
        ) {
          for (const allocation of dto.invoiceAllocations) {
            const invoice = await tx.invoice.findUnique({
              where: { id: allocation.invoiceId },
            });

            if (!invoice) {
              throw new Error(
                `Không tìm thấy hóa đơn ID ${allocation.invoiceId}`,
              );
            }

            const belongsToPartner =
              invoice.customerId === dto.partnerId ||
              invoice.parentCustomerId === dto.partnerId;

            if (!belongsToPartner) {
              throw new Error(
                `Hóa đơn ${invoice.code} không thuộc về khách hàng này`,
              );
            }

            const existingPayments = await tx.invoicePayment.findMany({
              where: { invoiceId: allocation.invoiceId },
            });
            const paymentSequence = existingPayments.length + 1;
            const paymentCode = `TT${invoice.code}-${paymentSequence}`;

            const invPayment = await tx.invoicePayment.create({
              data: {
                code: paymentCode,
                invoiceId: allocation.invoiceId,
                amount: allocation.amount,
                paymentDate: dto.transDate
                  ? new Date(dto.transDate)
                  : new Date(),
                paymentMethod: method,
                accountId: dto.accountId,
                description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
                status: 1,
              },
            });
            createdInvoicePaymentIds.push(invPayment.id);

            // Tổng invoicePayment còn active (loại đã hủy)
            const allPayments = await tx.invoicePayment.findMany({
              where: {
                invoiceId: allocation.invoiceId,
                status: { not: 2 },
              },
            });
            const sumPayments = allPayments.reduce(
              (sum: number, p: any) => sum + Number(p.amount),
              0,
            );

            // Tổng CTN còn active (manual_offset, status=4) — tránh ghi đè mất phần CTN
            const ctns = await tx.returnOrder.findMany({
              where: {
                invoiceId: allocation.invoiceId,
                refundType: 'manual_offset',
                status: 4,
              },
              select: { refundAmount: true },
            });
            const sumCtns = ctns.reduce(
              (sum: number, c: any) => sum + Number(c.refundAmount),
              0,
            );

            const paidAmount = sumPayments + sumCtns;

            const debtAmount = Number(invoice.grandTotal) - paidAmount;
            let status = 3;
            if (debtAmount <= 0) {
              status = 1;
            }

            await tx.invoice.update({
              where: { id: allocation.invoiceId },
              data: {
                paidAmount,
                debtAmount,
                status,
                statusValue: status === 1 ? 'Hoàn thành' : 'Đang xử lý',
              },
            });
          }
        }

        if (
          dto.allocateToInvoices &&
          dto.debtOffsets &&
          dto.debtOffsets.length > 0
        ) {
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: { name: true },
          });

          for (const debtOffset of dto.debtOffsets) {
            const invoiceData = await tx.invoice.findUnique({
              where: { id: debtOffset.invoiceId },
            });

            if (!invoiceData) {
              throw new Error(
                `Không tìm thấy hóa đơn ID ${debtOffset.invoiceId}`,
              );
            }

            const belongsToPartner =
              invoiceData.customerId === dto.partnerId ||
              invoiceData.parentCustomerId === dto.partnerId;

            if (!belongsToPartner) {
              throw new Error(`Hóa đơn không thuộc về khách hàng này`);
            }

            if (debtOffset.amount > Number(invoiceData.debtAmount)) {
              throw new Error(
                `Số tiền cấn trừ ${debtOffset.amount} vượt quá công nợ ${invoiceData.debtAmount} của hóa đơn ${invoiceData.code}`,
              );
            }

            const lastCtn = await tx.returnOrder.findFirst({
              where: { refundType: 'manual_offset' },
              orderBy: { id: 'desc' },
              select: { code: true },
            });
            let nextCtnNum = 1;
            if (lastCtn?.code?.startsWith('CTN')) {
              nextCtnNum = parseInt(lastCtn.code.slice(3)) + 1;
            }
            const ctnCode = `CTN${nextCtnNum.toString().padStart(6, '0')}`;

            const newPaidAmount =
              Number(invoiceData.paidAmount) + debtOffset.amount;
            const newDebtAmount = Math.max(
              0,
              Number(invoiceData.debtAmount) - debtOffset.amount,
            );
            const invoiceStatus = newDebtAmount <= 0 ? 1 : 3;

            await tx.invoice.update({
              where: { id: debtOffset.invoiceId },
              data: {
                paidAmount: newPaidAmount,
                debtAmount: newDebtAmount,
                status: invoiceStatus,
                statusValue: invoiceStatus === 1 ? 'Hoàn thành' : 'Đang xử lý',
              },
            });

            const ctn = await tx.returnOrder.create({
              // ← SỬA: thêm const ctn =
              data: {
                code: ctnCode,
                invoiceId: debtOffset.invoiceId,
                customerId: dto.partnerId,
                parentCustomerId: dto.partnerId,
                branchId: dto.branchId,
                status: 4,
                statusValue: 'Hoàn thành',
                totalReturnAmount: 0,
                refundAmount: debtOffset.amount,
                refundType: 'manual_offset',
                refundConfirmedBy: userId,
                refundConfirmedByName: user?.name || 'System',
                refundConfirmedAt: dto.transDate
                  ? new Date(dto.transDate)
                  : new Date(),
                customerDebtSnapshot: customerDebtSnapshot ?? 0,
                createdBy: userId,
                createdByName: user?.name || 'System',
              },
            });
            createdCtnIds.push(ctn.id); // ← THÊM
          }

          let creditToConsume = dto.debtOffsets.reduce(
            (sum: number, d: any) => sum + d.amount,
            0,
          );

          if (creditToConsume > 0) {
            const overpaidInvoices = await tx.invoice.findMany({
              where: {
                customerId: dto.partnerId,
                debtAmount: { lt: 0 },
                status: { not: 2 },
              },
              select: { id: true, debtAmount: true, status: true },
              orderBy: { purchaseDate: 'asc' },
            });

            for (const inv of overpaidInvoices) {
              if (creditToConsume <= 0) break;
              const available = Math.abs(Number(inv.debtAmount));
              const consume = Math.min(available, creditToConsume);
              await tx.invoice.update({
                where: { id: inv.id },
                data: {
                  debtAmount: Number(inv.debtAmount) + consume,
                  status: 1,
                  statusValue: 'Hoàn thành',
                },
              });
              creditToConsume -= consume;
            }
          }
        }
      }

      const cashFlow = await tx.cashFlow.create({
        data: {
          code,
          branchId: dto.branchId,
          cashFlowGroupId: dto.cashFlowGroupId,
          collectionBranchId: dto.collectionBranchId,
          isReceipt: dto.isReceipt,
          amount: dto.amount,
          transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
          method: method,
          accountId: dto.accountId,
          partnerType: dto.partnerType,
          partnerId: dto.partnerId,
          partnerName: dto.partnerName,
          contactNumber: dto.contactNumber,
          address: dto.address,
          wardName: dto.wardName,
          usedForFinancialReporting: dto.usedForFinancialReporting ?? 1,
          description: dto.description,
          status: 0,
          statusValue,
          createdBy: userId,
          collectorUserId: dto.collectorUserId || userId,
          customerDebtSnapshot,
        },
        include: {
          branch: { select: { id: true, name: true } },
          cashFlowGroup: { select: { id: true, name: true } },
          account: {
            select: { id: true, bankName: true, accountNumber: true },
          },
          creator: { select: { id: true, name: true } },
          collectionBranch: { select: { id: true, name: true } },
        },
      });

      // ── Link CTN → CashFlow ── ← THÊM
      if (createdCtnIds.length > 0) {
        await tx.returnOrder.updateMany({
          where: { id: { in: createdCtnIds } },
          data: { cashFlowId: cashFlow.id },
        });
      }

      if (createdInvoicePaymentIds.length > 0) {
        await tx.invoicePayment.updateMany({
          where: { id: { in: createdInvoicePaymentIds } },
          data: { cashFlowId: cashFlow.id },
        });
      }

      // [FIX-11] Recalc Supplier.debt khi tạo cashflow tự do partnerType='S'.
      // Sổ quỹ tự do chỉ ảnh hưởng debt qua cashflow. Formula B mới đối xứng KH:
      // cashflow là single source duy nhất nên gọi recalc sẽ tự đúng.
      // isReceipt=true → +amount (NCC ứng cho mình → mình nợ thêm),
      // isReceipt=false → -amount (mình bớt nợ).
      if (dto.affectDebt && dto.partnerId && dto.partnerType === 'S') {
        await this.recalcSupplierDebt(dto.partnerId, tx);

        // Snapshot supplier debt vào cashflow vừa tạo, đối xứng KH.
        const updatedSupplier = await tx.supplier.findUnique({
          where: { id: dto.partnerId },
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
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'CASHFLOW_CREATE',
        entityType: 'cashflows',
        entityId: cashFlow.id.toString(),
        entityCode: cashFlow.code,
        category: getCategoryFromActionCode('CASHFLOW_CREATE'),
        severity: getSeverityFromActionCode('CASHFLOW_CREATE'),
        snapshot: this.buildCashFlowSnapshot(cashFlow),
        message: renderAuditMessage('CASHFLOW_CREATE', {
          flowType: cashFlow.isReceipt ? 'Thu' : 'Chi',
          amount: Number(cashFlow.amount),
          description: cashFlow.description || '',
        }),
        messageTemplate: 'CASHFLOW_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: cashFlow.branchId,
      });

      return {
        ...cashFlow,
        branchName: cashFlow.branch?.name,
        cashFlowGroupName: cashFlow.cashFlowGroup?.name,
        collectionBranchName: cashFlow.collectionBranch?.name,
        creatorName: cashFlow.creator?.name,
      };
    });
  }

  async findAll(query: CashFlowQueryDto, currentUser?: any) {
    const {
      branchIds,
      code,
      search,
      userId,
      accountId,
      partnerType,
      method,
      cashFlowGroupId,
      usedForFinancialReporting,
      partnerName,
      contactNumber,
      isReceipt,
      startDate,
      endDate,
      status,
      ids,
      invoiceId,
      limit,
      pageSize = 20,
      currentItem = 0,
    } = query;

    const take = limit || pageSize;

    const where: any = {};

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    } else if (userId) {
      where.createdBy = userId;
    }

    if (!code?.length && branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (code && code.length > 0) {
      where.code = { in: code };
    } else if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { partnerName: { contains: search, mode: 'insensitive' } },
      ];
    } else {
      // Ẩn cashflow CLONE (TTTU* phía bán, PCTU* phía mua) khỏi list mặc định
      // — chúng chỉ phục vụ filter công nợ, không hiển thị riêng để tránh trùng.
      where.AND = [
        { code: { not: { startsWith: 'TTTU' } } },
        { code: { not: { startsWith: 'PCTU' } } },
      ];
    }

    if (accountId) {
      where.accountId = accountId;
    }

    if (partnerType && partnerType !== 'A') {
      where.partnerType = partnerType;
    }

    if (method && method.length > 0) {
      where.method = { in: method };
    }

    if (cashFlowGroupId && cashFlowGroupId.length > 0) {
      where.cashFlowGroupId = { in: cashFlowGroupId };
    }

    if (usedForFinancialReporting !== undefined) {
      where.usedForFinancialReporting = usedForFinancialReporting;
    }

    if (partnerName) {
      where.partnerName = { contains: partnerName, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.contactNumber = { contains: contactNumber };
    }

    if (isReceipt !== undefined) {
      where.isReceipt = isReceipt;
    }

    if (!code?.length && (startDate || endDate)) {
      where.transDate = {};
      if (startDate) {
        where.transDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.transDate.lte = new Date(endDate);
      }
    }

    if (status !== undefined) {
      where.status = status;
    }

    if (ids && ids.length > 0) {
      where.id = { in: ids };
    }

    if (invoiceId) {
      where.code = {
        contains: `TT`,
      };
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { code: true },
      });
      if (invoice) {
        where.code = {
          contains: invoice.code,
        };
      }
      where.invoicePayments = {
        some: {
          invoiceId: invoiceId,
        },
      };
    }

    const [cashFlows, total] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
          cashFlowGroup: { select: { id: true, name: true } },
          account: {
            select: { id: true, bankName: true, accountNumber: true },
          },
          creator: { select: { id: true, name: true } },
          collectionBranch: {
            select: { id: true, name: true },
          },
          returnOrders: {
            where: { refundType: 'manual_offset', status: { not: 5 } },
            select: { id: true, refundAmount: true, status: true },
          },
        },
        orderBy: { transDate: 'desc' },
        skip: currentItem,
        take: take,
      }),
      this.prisma.cashFlow.count({ where }),
    ]);

    const data = cashFlows.map((cashFlow) => ({
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      collectionBranchName: cashFlow.collectionBranch?.name,
      creatorName: cashFlow.creator?.name,
      debtOffsetTotal:
        cashFlow.returnOrders?.reduce(
          (sum: number, ro: any) => sum + Number(ro.refundAmount),
          0,
        ) || 0,
    }));

    return {
      total,
      pageSize: take,
      data,
    };
  }

  async findOne(id: number) {
    const cashFlow = await this.prisma.cashFlow.findUnique({
      where: { id },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        cashFlowGroup: {
          select: {
            id: true,
            name: true,
          },
        },
        account: {
          select: {
            id: true,
            bankName: true,
            bankCode: true,
            accountNumber: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!cashFlow) {
      return null;
    }

    let customer: any = null;
    if (cashFlow.partnerType === 'C' && cashFlow.partnerId) {
      customer = await this.prisma.customer.findUnique({
        where: { id: cashFlow.partnerId },
      });
    }

    let supplier: any = null;
    if (cashFlow.partnerType === 'S' && cashFlow.partnerId) {
      supplier = await this.prisma.supplier.findUnique({
        where: { id: cashFlow.partnerId },
        select: {
          id: true,
          code: true,
          name: true,
          contactNumber: true,
          address: true,
          debt: true,
        },
      });
    }

    return {
      ...cashFlow,
      branchName: cashFlow.branch?.name,
      cashFlowGroupName: cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creator?.name,
      customer,
      supplier,
    };
  }

  async update(id: number, dto: UpdateCashFlowDto, userId?: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const existingCashFlow = await tx.cashFlow.findUnique({
        where: { id },
      });

      if (!existingCashFlow) {
        throw new Error('Không tìm thấy phiếu thu/chi');
      }

      const cashFlow = await tx.cashFlow.update({
        where: { id },
        data: {
          branchId: dto.branchId,
          cashFlowGroupId: dto.cashFlowGroupId,
          amount: dto.amount,
          transDate: dto.transDate ? new Date(dto.transDate) : undefined,
          method: dto.method,
          accountId: dto.accountId,
          partnerType: dto.partnerType,
          partnerId: dto.partnerId,
          partnerName: dto.partnerName,
          contactNumber: dto.contactNumber,
          address: dto.address,
          wardName: dto.wardName,
          usedForFinancialReporting: dto.usedForFinancialReporting,
          description: dto.description,
          ...(dto.collectorId ? { createdBy: dto.collectorId } : {}),
        },
        include: {
          branch: { select: { id: true, name: true } },
          cashFlowGroup: { select: { id: true, name: true } },
          account: {
            select: { id: true, bankName: true, accountNumber: true },
          },
          creator: { select: { id: true, name: true } },
        },
      });

      // [Fix] Recalc customer.totalDebt cho cả OLD và NEW customer (nếu khác nhau)
      // Xử lý cả case đổi partnerId, đổi partnerType, hoặc giữ nguyên
      const customerIdsToRecalc = new Set<number>();
      if (existingCashFlow.partnerType === 'C' && existingCashFlow.partnerId) {
        customerIdsToRecalc.add(existingCashFlow.partnerId);
      }
      if (cashFlow.partnerType === 'C' && cashFlow.partnerId) {
        customerIdsToRecalc.add(cashFlow.partnerId);
      }
      for (const cid of customerIdsToRecalc) {
        await this.recalcCustomerDebt(cid, tx);
      }

      // [FIX-10a] Đối xứng KH: recalc supplier cho cả OLD và NEW supplier
      // (nếu khác nhau). Formula B mới dùng cashflow làm single source nên
      // recalc tự đồng bộ.
      const supplierIdsToRecalc = new Set<number>();
      if (existingCashFlow.partnerType === 'S' && existingCashFlow.partnerId) {
        supplierIdsToRecalc.add(existingCashFlow.partnerId);
      }
      if (cashFlow.partnerType === 'S' && cashFlow.partnerId) {
        supplierIdsToRecalc.add(cashFlow.partnerId);
      }
      for (const sid of supplierIdsToRecalc) {
        await this.recalcSupplierDebt(sid, tx);
      }

      return { existingCashFlow, cashFlow };
    });

    if (userId && result.existingCashFlow) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      const changes = buildChanges(
        'cashflows',
        {
          amount: Number(result.existingCashFlow.amount),
          description: result.existingCashFlow.description,
          status: result.existingCashFlow.status,
        },
        {
          amount: Number(result.cashFlow.amount),
          description: result.cashFlow.description,
          status: result.cashFlow.status,
        },
      );

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CASHFLOW_UPDATE',
        entityType: 'cashflows',
        entityId: id.toString(),
        entityCode: result.cashFlow.code,
        category: getCategoryFromActionCode('CASHFLOW_UPDATE'),
        severity: getSeverityFromActionCode('CASHFLOW_UPDATE'),
        snapshot: this.buildCashFlowSnapshot(result.cashFlow),
        changes: changes.length > 0 ? changes : null,
        message: renderAuditMessage('CASHFLOW_UPDATE', {
          flowType: result.cashFlow.isReceipt ? 'Thu' : 'Chi',
          cashflowCode: result.cashFlow.code,
        }),
        messageTemplate: 'CASHFLOW_UPDATE',
        userId,
        userName: user?.name || 'System',
        branchId: result.cashFlow.branchId,
      });
    }

    return {
      ...result.cashFlow,
      branchName: result.cashFlow.branch?.name,
      cashFlowGroupName: result.cashFlow.cashFlowGroup?.name,
      creatorName: result.cashFlow.creator?.name,
    };
  }

  async cancel(id: number, userId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const cashFlow = await tx.cashFlow.findUnique({
        where: { id },
        include: { branch: { select: { id: true, name: true } } },
      });

      if (!cashFlow) {
        throw new Error('Không tìm thấy phiếu thu/chi');
      }

      // ── 1. Tìm các entity liên quan TRƯỚC khi hủy
      const linkedInvoicePayments = await tx.invoicePayment.findMany({
        where: {
          OR: [{ cashFlowId: id }, { code: { startsWith: cashFlow.code } }],
          status: { not: 2 },
        },
        select: { id: true, invoiceId: true },
      });

      const linkedOrderPayments = await tx.orderPayment.findMany({
        where: {
          code: { startsWith: cashFlow.code },
          status: { not: 2 },
        },
        select: { id: true, orderId: true },
      });

      const linkedCtns = await tx.returnOrder.findMany({
        where: {
          cashFlowId: id,
          refundType: 'manual_offset',
          status: 4,
        },
        select: { id: true, invoiceId: true, customerId: true },
      });

      // [FIX-10] Tìm payments NCC liên quan: PCPN* (PurchaseOrderPayment)
      // và PCPDN* (OrderSupplierPayment) — ưu tiên match qua FK
      // `cashFlowId` (Wave 2), fallback theo `code`. Đối xứng pattern phía
      // bán đã có sẵn FK ở `InvoicePayment.cashFlowId`.
      const linkedPurchaseOrderPayments = await tx.purchaseOrderPayment.findMany(
        {
          where: {
            OR: [{ cashFlowId: id }, { code: cashFlow.code }],
            status: { not: 2 },
          },
          select: { id: true, purchaseOrderId: true },
        },
      );

      const linkedOrderSupplierPayments =
        await tx.orderSupplierPayment.findMany({
          where: {
            OR: [{ cashFlowId: id }, { code: cashFlow.code }],
            status: { not: 2 },
          },
          select: { id: true, orderSupplierId: true },
        });

      // ── 2. Hủy cashflow
      const updated = await tx.cashFlow.update({
        where: { id },
        data: { status: 2, statusValue: 'Đã hủy' },
      });

      // ── 3. Hủy invoicePayments liên quan
      if (linkedInvoicePayments.length > 0) {
        await tx.invoicePayment.updateMany({
          where: { id: { in: linkedInvoicePayments.map((p) => p.id) } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      // ── 4. Hủy orderPayments liên quan
      if (linkedOrderPayments.length > 0) {
        await tx.orderPayment.updateMany({
          where: { id: { in: linkedOrderPayments.map((p) => p.id) } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      // ── 5. Hủy CTN liên quan
      if (linkedCtns.length > 0) {
        await tx.returnOrder.updateMany({
          where: { id: { in: linkedCtns.map((c) => c.id) } },
          data: { status: 5, statusValue: 'Đã hủy' },
        });
      }

      // [FIX-10] Hủy PurchaseOrderPayment / OrderSupplierPayment liên quan
      if (linkedPurchaseOrderPayments.length > 0) {
        await tx.purchaseOrderPayment.updateMany({
          where: {
            id: { in: linkedPurchaseOrderPayments.map((p) => p.id) },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }
      if (linkedOrderSupplierPayments.length > 0) {
        await tx.orderSupplierPayment.updateMany({
          where: {
            id: { in: linkedOrderSupplierPayments.map((p) => p.id) },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      // ── 6. Recalc paidAmount/debtAmount/status cho từng invoice bị ảnh hưởng
      const affectedInvoiceIds = new Set<number>();
      linkedInvoicePayments.forEach((p) => {
        if (p.invoiceId) affectedInvoiceIds.add(p.invoiceId);
      });
      linkedCtns.forEach((c) => {
        if (c.invoiceId) affectedInvoiceIds.add(c.invoiceId);
      });

      for (const invId of affectedInvoiceIds) {
        const invoice = await tx.invoice.findUnique({
          where: { id: invId },
          select: { grandTotal: true, status: true },
        });
        if (!invoice) continue;

        const activePayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invId, status: { not: 2 } },
          select: { amount: true },
        });
        const sumPayments = activePayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );

        const activeCtns = await tx.returnOrder.findMany({
          where: {
            invoiceId: invId,
            refundType: 'manual_offset',
            status: 4,
          },
          select: { refundAmount: true },
        });
        const sumCtns = activeCtns.reduce(
          (sum: number, c: any) => sum + Number(c.refundAmount),
          0,
        );

        const newPaidAmount = sumPayments + sumCtns;
        const newDebtAmount = Math.max(
          0,
          Number(invoice.grandTotal) - newPaidAmount,
        );

        // Chỉ thay đổi status nếu invoice CHƯA bị hủy
        const updateInvoiceData: any = {
          paidAmount: newPaidAmount,
          debtAmount: newDebtAmount,
        };
        if (invoice.status !== 2) {
          const newStatus = newDebtAmount <= 0 ? 1 : 3;
          updateInvoiceData.status = newStatus;
          updateInvoiceData.statusValue =
            newStatus === 1 ? 'Hoàn thành' : 'Đang xử lý';
        }

        await tx.invoice.update({
          where: { id: invId },
          data: updateInvoiceData,
        });
      }

      // ── 7. Recalc paidAmount/debtAmount cho từng order bị ảnh hưởng
      const affectedOrderIds = new Set<number>();
      linkedOrderPayments.forEach((p) => {
        if (p.orderId) affectedOrderIds.add(p.orderId);
      });

      for (const orderId of affectedOrderIds) {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: { grandTotal: true },
        });
        if (!order) continue;

        const activeOrderPayments = await tx.orderPayment.findMany({
          where: { orderId, status: { not: 2 } },
          select: { amount: true },
        });
        const sumOrderPayments = activeOrderPayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );

        await tx.order.update({
          where: { id: orderId },
          data: {
            paidAmount: sumOrderPayments,
            depositAmount: sumOrderPayments,
            debtAmount: Math.max(
              0,
              Number(order.grandTotal) - sumOrderPayments,
            ),
          },
        });
      }

      // ── 8. Recalc customer.totalDebt (giữ logic cũ)
      if (cashFlow.partnerType === 'C' && cashFlow.partnerId) {
        await this.recalcCustomerDebt(cashFlow.partnerId, tx);
      }

      // ── 9. Recalc thêm customer của CTN nếu khác partnerId
      const ctnCustomerIds = new Set<number>();
      linkedCtns.forEach((c) => {
        if (c.customerId && c.customerId !== cashFlow.partnerId) {
          ctnCustomerIds.add(c.customerId);
        }
      });
      for (const cid of ctnCustomerIds) {
        await this.recalcCustomerDebt(cid, tx);
      }

      // [FIX-10] Recalc PurchaseOrder.paidAmount/debtAmount cho từng PO bị ảnh hưởng
      const affectedPurchaseOrderIds = new Set<number>();
      linkedPurchaseOrderPayments.forEach((p) => {
        if (p.purchaseOrderId)
          affectedPurchaseOrderIds.add(p.purchaseOrderId);
      });

      for (const poId of affectedPurchaseOrderIds) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          select: { total: true, discount: true },
        });
        if (!po) continue;

        const activePayments = await tx.purchaseOrderPayment.findMany({
          where: { purchaseOrderId: poId, status: { not: 2 } },
          select: { amount: true },
        });
        const sumPayments = activePayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );

        const subTotal = Number(po.total) - Number(po.discount);
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            paidAmount: sumPayments,
            debtAmount: Math.max(0, subTotal - sumPayments),
          },
        });
      }

      // [FIX-10] Recalc OrderSupplier.paidAmount cho từng OS bị ảnh hưởng
      const affectedOrderSupplierIds = new Set<number>();
      linkedOrderSupplierPayments.forEach((p) => {
        if (p.orderSupplierId)
          affectedOrderSupplierIds.add(p.orderSupplierId);
      });

      for (const osId of affectedOrderSupplierIds) {
        const os = await tx.orderSupplier.findUnique({
          where: { id: osId },
          select: { subTotal: true },
        });
        if (!os) continue;

        const activePayments = await tx.orderSupplierPayment.findMany({
          where: { orderSupplierId: osId, status: { not: 2 } },
          select: { amount: true },
        });
        const sumPayments = activePayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );

        await tx.orderSupplier.update({
          where: { id: osId },
          data: {
            paidAmount: sumPayments,
            supplierDebt: Number(os.subTotal) - sumPayments,
          },
        });
      }

      // [FIX-10] Recalc Supplier.debt
      if (cashFlow.partnerType === 'S' && cashFlow.partnerId) {
        await this.recalcSupplierDebt(cashFlow.partnerId, tx);
      }

      // Recalc cho supplier của PO/OS bị ảnh hưởng (nếu khác partnerId)
      const affectedSupplierIds = new Set<number>();
      for (const poId of affectedPurchaseOrderIds) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          select: { supplierId: true },
        });
        if (po?.supplierId && po.supplierId !== cashFlow.partnerId) {
          affectedSupplierIds.add(po.supplierId);
        }
      }
      for (const osId of affectedOrderSupplierIds) {
        const os = await tx.orderSupplier.findUnique({
          where: { id: osId },
          select: { supplierId: true },
        });
        if (os?.supplierId && os.supplierId !== cashFlow.partnerId) {
          affectedSupplierIds.add(os.supplierId);
        }
      }
      for (const sid of affectedSupplierIds) {
        await this.recalcSupplierDebt(sid, tx);
      }

      return { cashFlow, updated };
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'DELETE',
      actionCode: 'CASHFLOW_DELETE',
      entityType: 'cashflows',
      entityId: id.toString(),
      entityCode: result.cashFlow.code,
      category: getCategoryFromActionCode('CASHFLOW_DELETE'),
      severity: getSeverityFromActionCode('CASHFLOW_DELETE'),
      snapshot: this.buildCashFlowSnapshot(result.cashFlow),
      message: renderAuditMessage('CASHFLOW_DELETE', {
        flowType: result.cashFlow.isReceipt ? 'Thu' : 'Chi',
        cashflowCode: result.cashFlow.code,
      }),
      messageTemplate: 'CASHFLOW_DELETE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: result.cashFlow.branchId || undefined,
    });

    return result.updated;
  }

  async createPaymentFromInvoice(
    dto: CreatePaymentDto,
    userId: number,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
        },
      });

      if (!invoice) {
        throw new Error('Không tìm thấy hóa đơn');
      }

      if (!invoice.branchId) {
        throw new Error('Hóa đơn không có thông tin chi nhánh');
      }

      const existingPayments = await tx.invoicePayment.findMany({
        where: { invoiceId: dto.invoiceId },
      });
      const paymentSequence = existingPayments.length + 1;
      const cashFlowCode = `TT${invoice.code}-${paymentSequence}`;

      const cashFlow = await tx.cashFlow.create({
        data: {
          code: cashFlowCode,
          branchId: invoice.branchId,
          isReceipt: true,
          amount: dto.amount,
          transDate: new Date(),
          method: dto.method || 'cash',
          accountId: dto.accountId,
          partnerType: 'C',
          partnerId: invoice.customerId,
          partnerName: invoice.customer?.name,
          contactNumber: invoice.customer?.contactNumber,
          address: invoice.customer?.addresses?.[0]?.address || null,
          description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          status: 0,
          statusValue: 'Đã thanh toán',
          createdBy: userId,
          usedForFinancialReporting: 1,
        },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          cashFlowGroup: {
            select: {
              id: true,
              name: true,
            },
          },
          account: {
            select: {
              id: true,
              bankName: true,
              accountNumber: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const invoicePayment = await tx.invoicePayment.create({
        data: {
          code: cashFlowCode,
          invoiceId: dto.invoiceId,
          amount: dto.amount,
          paymentDate: new Date(),
          paymentMethod: dto.method || 'cash',
          accountId: dto.accountId,
          cashFlowId: cashFlow.id,
          description: `Thu tiền hóa đơn ${invoice.code}`,
          status: 1,
        },
      });

      // Tổng invoicePayment còn active (loại đã hủy)
      const payments = await tx.invoicePayment.findMany({
        where: { invoiceId: dto.invoiceId, status: { not: 2 } },
      });
      const sumPayments = payments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );

      // Tổng CTN còn active (manual_offset, status=4) — tránh ghi đè mất phần CTN
      const ctns = await tx.returnOrder.findMany({
        where: {
          invoiceId: dto.invoiceId,
          refundType: 'manual_offset',
          status: 4,
        },
        select: { refundAmount: true },
      });
      const sumCtns = ctns.reduce(
        (sum: number, c: any) => sum + Number(c.refundAmount),
        0,
      );

      const paidAmount = sumPayments + sumCtns;

      const debtAmount = Number(invoice.grandTotal) - paidAmount;
      let invoiceStatus = 3;
      if (debtAmount <= 0) {
        invoiceStatus = 1;
      }

      await tx.invoice.update({
        where: { id: dto.invoiceId },
        data: {
          paidAmount,
          debtAmount,
          status: invoiceStatus,
          statusValue: invoiceStatus === 1 ? 'Hoàn thành' : 'Đang xử lý',
        },
      });

      if (invoice.customerId) {
        // Recalc đúng chủ hóa đơn (per-customer). Trả con → trừ con; trả cha → trừ cha.
        await this.recalcCustomerDebt(invoice.customerId, tx);
      }

      return {
        invoicePayment,
        cashFlow: {
          ...cashFlow,
          branchName: cashFlow.branch?.name,
          cashFlowGroupName: cashFlow.cashFlowGroup?.name,
          creatorName: cashFlow.creator?.name,
        },
      };
    });
  }

  async getRelatedInvoicePayments(cashFlowId: number): Promise<any> {
    const cashFlow = await this.prisma.cashFlow.findUnique({
      where: { id: cashFlowId },
    });

    if (!cashFlow) {
      throw new Error('Cash flow not found');
    }

    const [invoicePayments, orderPayments, debtOffsets] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where: {
          OR: [
            { code: { startsWith: cashFlow.code } },
            { cashFlowId: cashFlowId },
          ],
        },
        include: {
          invoice: {
            select: {
              id: true,
              code: true,
              grandTotal: true,
              paidAmount: true,
              debtAmount: true,
              status: true,
            },
          },
        },
        orderBy: { paymentDate: 'desc' },
      }),
      this.prisma.orderPayment.findMany({
        where: { code: { startsWith: cashFlow.code } },
        include: {
          order: {
            select: {
              id: true,
              code: true,
              grandTotal: true,
              paidAmount: true,
              debtAmount: true,
              status: true,
              orderStatus: true,
            },
          },
        },
        orderBy: { paymentDate: 'desc' },
      }),
      this.prisma.returnOrder.findMany({
        where: {
          cashFlowId: cashFlowId,
          refundType: 'manual_offset',
        },
        select: {
          id: true,
          code: true,
          refundAmount: true,
          status: true,
          statusValue: true,
          refundConfirmedAt: true,
          invoice: {
            select: {
              id: true,
              code: true,
              grandTotal: true,
              paidAmount: true,
              debtAmount: true,
              status: true,
            },
          },
        },
        orderBy: { refundConfirmedAt: 'desc' },
      }),
    ]);

    return { invoicePayments, orderPayments, debtOffsets };
  }

  private async generateManualCode(
    isReceipt: boolean,
    method: string,
    tx: any,
  ): Promise<string> {
    let prefix = '';

    if (isReceipt) {
      if (method === 'cash') {
        prefix = 'TT';
      } else if (method === 'transfer') {
        prefix = 'TT';
      } else if (method === 'ewallet') {
        prefix = 'TT';
      } else {
        prefix = 'TT';
      }
    } else {
      if (method === 'cash') {
        prefix = 'PCM';
      } else if (method === 'transfer') {
        prefix = 'PCNH';
      } else if (method === 'ewallet') {
        prefix = 'PCVDT';
      } else {
        prefix = 'PC';
      }
    }

    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allCashFlows = await tx.cashFlow.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
          isReceipt,
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allCashFlows
        .map((cf: any) => cf.code)
        .filter((code: string) => regex.test(code));

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.cashFlow.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu thu/chi duy nhất');
  }

  async getOpeningBalance(filters: any) {
    const { startDate } = filters;

    if (!startDate) {
      return 0;
    }

    const receipts = await this.prisma.cashFlow.aggregate({
      where: {
        isReceipt: true,
        status: 0,
        transDate: {
          lt: new Date(startDate),
        },
      },
      _sum: {
        amount: true,
      },
    });

    const payments = await this.prisma.cashFlow.aggregate({
      where: {
        isReceipt: false,
        status: 0,
        transDate: {
          lt: new Date(startDate),
        },
      },
      _sum: {
        amount: true,
      },
    });

    return (
      Number(receipts._sum.amount || 0) - Number(payments._sum.amount || 0)
    );
  }

  async createCustomerPayment(dto: CreateCustomerPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: dto.customerId },
        select: {
          id: true,
          name: true,
          contactNumber: true,
          addresses: {
            where: { isDefault: true },
            take: 1,
            select: { address: true },
          },
          totalDebt: true,
        },
      });

      const childIds = await tx.customer.findMany({
        where: { parentId: dto.customerId },
        select: { id: true },
      });
      const allCustomerIds = [
        dto.customerId,
        ...childIds.map((c: any) => c.id),
      ];

      if (!customer) throw new Error('Không tìm thấy khách hàng');
      if (!dto.branchId) throw new Error('Vui lòng chọn chi nhánh');

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      // ── 1. Xử lý invoice allocations — CHƯA tạo cashflow ──
      const invoicePayments: any[] = [];
      const amountPerCustomer = new Map<number, number>();
      const paymentIdsByCustomer = new Map<number, number[]>();
      const ctnIdsByCustomer = new Map<number, number[]>();

      if (dto.allocateToInvoices && dto.invoices && dto.invoices.length > 0) {
        for (const invoice of dto.invoices) {
          const invoiceData = await tx.invoice.findUnique({
            where: { id: invoice.invoiceId },
            include: { payments: true },
          });

          if (!invoiceData) {
            throw new Error(`Không tìm thấy hóa đơn ID ${invoice.invoiceId}`);
          }

          // ← SỬA: dùng allCustomerIds
          const belongsToCustomer = allCustomerIds.includes(
            invoiceData.customerId!,
          );
          if (!belongsToCustomer) {
            throw new Error(
              `Hóa đơn ${invoiceData.code} không thuộc về khách hàng này`,
            );
          }

          const currentDebt = Number(invoiceData.debtAmount);
          if (invoice.amount > currentDebt) {
            throw new Error(
              `Số tiền thanh toán ${invoice.amount} vượt quá công nợ ${currentDebt} của hóa đơn ${invoiceData.code}`,
            );
          }

          const existingPayments = await tx.invoicePayment.findMany({
            where: { invoiceId: invoice.invoiceId },
          });
          const paymentSequence = existingPayments.length + 1;
          const paymentCode = `TT${invoiceData.code}-${paymentSequence}`;

          const payment = await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.invoiceId,
              amount: invoice.amount,
              paymentDate: dto.transDate ? new Date(dto.transDate) : new Date(),
              paymentMethod: dto.method,
              accountId: dto.accountId,
              description:
                dto.description ||
                `Thu tiền hóa đơn ${invoiceData.code} - Lần ${paymentSequence}`,
              status: 1,
              cashFlowId: null, // ← SỬA: gán sau khi tạo cashflow
            },
          });

          invoicePayments.push(payment);

          // ← THÊM: gom theo customer
          const invCustId = invoiceData.customerId!;
          amountPerCustomer.set(
            invCustId,
            (amountPerCustomer.get(invCustId) || 0) + invoice.amount,
          );
          const ids = paymentIdsByCustomer.get(invCustId) || [];
          ids.push(payment.id);
          paymentIdsByCustomer.set(invCustId, ids);

          // Update invoice (GIỮ NGUYÊN)
          const newPaidAmount = Number(invoiceData.paidAmount) + invoice.amount;
          const newDebtAmount = Math.max(
            0,
            Number(invoiceData.debtAmount) - invoice.amount,
          );

          await tx.invoice.update({
            where: { id: invoice.invoiceId },
            data: {
              paidAmount: newPaidAmount,
              debtAmount: newDebtAmount,
              status: newDebtAmount <= 0 ? 1 : 3,
              statusValue: newDebtAmount <= 0 ? 'Hoàn thành' : 'Đang xử lý',
            },
          });
        }
      }

      // ── 2. Xử lý debt offsets — GIỮ NGUYÊN logic, chỉ sửa belongsToCustomer + customerId trên CTN ──
      if (dto.debtOffsets && dto.debtOffsets.length > 0) {
        for (const debtOffset of dto.debtOffsets) {
          const invoiceData = await tx.invoice.findUnique({
            where: { id: debtOffset.invoiceId },
          });

          if (!invoiceData) {
            throw new Error(
              `Không tìm thấy hóa đơn ID ${debtOffset.invoiceId}`,
            );
          }

          // ← SỬA: dùng allCustomerIds
          const belongsToCustomer = allCustomerIds.includes(
            invoiceData.customerId!,
          );
          if (!belongsToCustomer) {
            throw new Error(`Hóa đơn không thuộc về khách hàng này`);
          }

          if (debtOffset.amount > Number(invoiceData.debtAmount)) {
            throw new Error(
              `Số tiền cấn trừ ${debtOffset.amount} vượt quá công nợ ${invoiceData.debtAmount} của hóa đơn ${invoiceData.code}`,
            );
          }

          const lastCtn = await tx.returnOrder.findFirst({
            where: { refundType: 'manual_offset' },
            orderBy: { id: 'desc' },
            select: { code: true },
          });
          let nextCtnNum = 1;
          if (lastCtn?.code?.startsWith('CTN')) {
            nextCtnNum = parseInt(lastCtn.code.slice(3)) + 1;
          }
          const ctnCode = `CTN${nextCtnNum.toString().padStart(6, '0')}`;

          const newPaidAmount =
            Number(invoiceData.paidAmount) + debtOffset.amount;
          const newDebtAmount = Math.max(
            0,
            Number(invoiceData.debtAmount) - debtOffset.amount,
          );
          const invoiceStatus = newDebtAmount <= 0 ? 1 : 3;

          await tx.invoice.update({
            where: { id: debtOffset.invoiceId },
            data: {
              paidAmount: newPaidAmount,
              debtAmount: newDebtAmount,
              status: invoiceStatus,
              statusValue: invoiceStatus === 1 ? 'Hoàn thành' : 'Đang xử lý',
            },
          });

          const createdCtn = await tx.returnOrder.create({
            data: {
              code: ctnCode,
              invoiceId: debtOffset.invoiceId,
              customerId: invoiceData.customerId!, // ← SỬA: dùng chủ hóa đơn, không phải dto.customerId
              parentCustomerId: dto.customerId,
              branchId: dto.branchId,
              status: 4,
              statusValue: 'Hoàn thành',
              totalReturnAmount: 0,
              refundAmount: debtOffset.amount,
              refundType: 'manual_offset',
              refundConfirmedBy: userId,
              refundConfirmedByName: user?.name || 'System',
              refundConfirmedAt: dto.transDate
                ? new Date(dto.transDate)
                : new Date(),
              customerDebtSnapshot: 0, // sẽ được cập nhật sau recalculate
              createdBy: userId,
              createdByName: user?.name || 'System',
            },
          });

          // ← THÊM: gom CTN id theo customer chủ hóa đơn để link sang cashflow sau
          const ctnCustId = invoiceData.customerId!;
          const existingCtnIds = ctnIdsByCustomer.get(ctnCustId) || [];
          existingCtnIds.push(createdCtn.id);
          ctnIdsByCustomer.set(ctnCustId, existingCtnIds);
        }

        // Consume overpaid invoices (GIỮ NGUYÊN logic)
        let creditToConsume = dto.debtOffsets.reduce(
          (sum: number, d: any) => sum + d.amount,
          0,
        );
        if (creditToConsume > 0) {
          const overpaidInvoices = await tx.invoice.findMany({
            where: {
              customerId: { in: allCustomerIds },
              debtAmount: { lt: 0 },
              status: { not: 2 },
            },
            select: { id: true, debtAmount: true, status: true },
            orderBy: { purchaseDate: 'asc' },
          });

          for (const inv of overpaidInvoices) {
            if (creditToConsume <= 0) break;
            const available = Math.abs(Number(inv.debtAmount));
            const consume = Math.min(available, creditToConsume);
            await tx.invoice.update({
              where: { id: inv.id },
              data: {
                debtAmount: Number(inv.debtAmount) + consume,
                status: 1,
                statusValue: 'Hoàn thành',
              },
            });
            creditToConsume -= consume;
          }
        }
      }

      // ── 3. Tạo cashflow(s) — TÁCH THEO CUSTOMER ──
      const cashFlows: any[] = [];

      if (dto.totalAmount > 0) {
        if (
          amountPerCustomer.size <= 1 &&
          (amountPerCustomer.size === 0 ||
            amountPerCustomer.has(dto.customerId))
        ) {
          // Case đơn giản: tất cả invoice thuộc 1 customer (hoặc không allocate) → 1 cashflow
          const code = await this.generateSafeCashFlowCode(true, tx);
          const cf = await tx.cashFlow.create({
            data: {
              code,
              branchId: dto.branchId,
              cashFlowGroupId: 1,
              isReceipt: true,
              amount: dto.totalAmount,
              transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
              method: dto.method || 'cash',
              accountId: dto.accountId,
              partnerType: 'C',
              partnerId: dto.customerId,
              partnerName: customer.name,
              contactNumber: customer.contactNumber,
              address: customer.addresses?.[0]?.address || null,
              description: dto.description || 'Thu tiền khách hàng',
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              collectorUserId: dto.collectorUserId || userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: 0,
            },
          });
          cashFlows.push(cf);

          // Link tất cả invoice payments vào cashflow này
          const allPaymentIds = invoicePayments.map((p: any) => p.id);
          if (allPaymentIds.length > 0) {
            await tx.invoicePayment.updateMany({
              where: { id: { in: allPaymentIds } },
              data: { cashFlowId: cf.id },
            });
          }

          // ← THÊM: link tất cả CTN debt-offset vào cashflow này
          const allCtnIds: number[] = [];
          for (const ids of ctnIdsByCustomer.values()) {
            allCtnIds.push(...ids);
          }
          if (allCtnIds.length > 0) {
            await tx.returnOrder.updateMany({
              where: { id: { in: allCtnIds } },
              data: { cashFlowId: cf.id },
            });
          }
        } else {
          // Case mixed: invoice thuộc nhiều customer → tách cashflow per customer
          for (const [custId, custAmount] of amountPerCustomer) {
            const custData =
              custId === dto.customerId
                ? customer
                : await tx.customer.findUnique({
                    where: { id: custId },
                    select: {
                      name: true,
                      contactNumber: true,
                      addresses: {
                        where: { isDefault: true },
                        take: 1,
                        select: { address: true },
                      },
                    },
                  });

            const code = await this.generateSafeCashFlowCode(true, tx);
            const cf = await tx.cashFlow.create({
              data: {
                code,
                branchId: dto.branchId,
                cashFlowGroupId: 1,
                isReceipt: true,
                amount: custAmount,
                transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
                method: dto.method || 'cash',
                accountId: dto.accountId,
                partnerType: 'C',
                partnerId: custId, // ← partnerId = chủ hóa đơn
                partnerName: custData?.name || customer.name,
                contactNumber: custData?.contactNumber || null,
                address: (custData as any)?.addresses?.[0]?.address || null,
                description: dto.description || `Thu tiền khách hàng`,
                status: 0,
                statusValue: 'Đã thanh toán',
                createdBy: userId,
                collectorUserId: dto.collectorUserId || userId,
                usedForFinancialReporting: 1,
                customerDebtSnapshot: 0,
              },
            });
            cashFlows.push(cf);

            // Link invoice payments of this customer to this cashflow
            const paymentIds = paymentIdsByCustomer.get(custId) || [];
            if (paymentIds.length > 0) {
              await tx.invoicePayment.updateMany({
                where: { id: { in: paymentIds } },
                data: { cashFlowId: cf.id },
              });
            }

            // ← THÊM: link CTN debt-offset của customer này vào cashflow của customer này
            const ctnIds = ctnIdsByCustomer.get(custId) || [];
            if (ctnIds.length > 0) {
              await tx.returnOrder.updateMany({
                where: { id: { in: ctnIds } },
                data: { cashFlowId: cf.id },
              });
            }
          }
        }
      }

      // ── 4. Recalculate debt cho tất cả customer bị ảnh hưởng ──
      const affectedCustomerIds = new Set<number>([dto.customerId]);
      for (const custId of amountPerCustomer.keys()) {
        affectedCustomerIds.add(custId);
      }
      if (dto.debtOffsets) {
        for (const offset of dto.debtOffsets) {
          const invData = await tx.invoice.findUnique({
            where: { id: offset.invoiceId },
            select: { customerId: true },
          });
          if (invData?.customerId) affectedCustomerIds.add(invData.customerId);
        }
      }

      for (const cid of affectedCustomerIds) {
        const newDebt = await this.recalcCustomerDebt(cid, tx);

        const cfForCust = cashFlows.find((cf: any) => cf.partnerId === cid);
        if (cfForCust) {
          await tx.cashFlow.update({
            where: { id: cfForCust.id },
            data: { customerDebtSnapshot: newDebt },
          });
        }
      }

      return {
        cashFlow: cashFlows[0] || null,
        invoicePayments,
      };
    });
  }

  /**
   * Trả tiền NCC bulk cho nhiều phiếu nhập (PN). Đối xứng
   * `createCustomerPayment`. Cụ thể đảo logic:
   *   - partnerType 'C' → 'S'
   *   - cashFlowGroupId 1 → 9 (chi NCC)
   *   - isReceipt true → false
   *   - Invoice → PurchaseOrder
   *   - InvoicePayment → PurchaseOrderPayment (PCPN)
   *   - allocateToInvoices → allocateToPurchaseOrders
   *   - debtOffsets cho NCC: tạo SupplierReturn `manual_offset` (chưa
   *     implement nhánh này — tương tự CTN của KH cần thêm logic riêng,
   *     hiện chỉ throw để FE biết)
   *
   * Đơn giản hóa so với KH: PurchaseOrder không có cha-con như Customer
   * (Customer có parentId), nên không cần split cashflow theo nhiều
   * partner — luôn 1 cashflow.
   */
  async createSupplierPayment(dto: CreateSupplierPaymentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: dto.supplierId },
        select: {
          id: true,
          name: true,
          contactNumber: true,
          address: true,
          debt: true,
        },
      });

      if (!supplier) throw new Error('Không tìm thấy nhà cung cấp');
      if (!dto.branchId) throw new Error('Vui lòng chọn chi nhánh');

      // ── 1. Allocate vào PurchaseOrder ──────────────────────────────────
      const createdPaymentIds: number[] = [];
      let allocatedTotal = 0;

      if (
        dto.allocateToPurchaseOrders &&
        dto.purchaseOrders &&
        dto.purchaseOrders.length > 0
      ) {
        for (const po of dto.purchaseOrders) {
          const poData = await tx.purchaseOrder.findUnique({
            where: { id: po.purchaseOrderId },
            include: { payments: { where: { status: { not: 2 } } } },
          });

          if (!poData) {
            throw new Error(
              `Không tìm thấy phiếu nhập ID ${po.purchaseOrderId}`,
            );
          }
          if (poData.supplierId !== dto.supplierId) {
            throw new Error(
              `Phiếu nhập ${poData.code} không thuộc về NCC này`,
            );
          }

          const currentDebt = Number(poData.debtAmount);
          if (po.amount > currentDebt) {
            throw new Error(
              `Số tiền thanh toán ${po.amount} vượt quá công nợ ${currentDebt} của phiếu nhập ${poData.code}`,
            );
          }

          // Generate code PCPN — đối xứng `TT{invoiceCode}-N` của KH
          const paymentCode = await this.generatePCPNCodeBulk(tx);

          const payment = await tx.purchaseOrderPayment.create({
            data: {
              code: paymentCode,
              purchaseOrderId: po.purchaseOrderId,
              amount: po.amount,
              paymentDate: dto.transDate ? new Date(dto.transDate) : new Date(),
              paymentMethod: dto.method,
              accountId: dto.accountId,
              description:
                dto.description || `Chi tiền nhập hàng ${poData.code}`,
              status: 1,
              statusValue: 'Đã thanh toán',
              cashFlowId: null,
            },
          });

          createdPaymentIds.push(payment.id);
          allocatedTotal += po.amount;

          // Recompute paidAmount + debtAmount của PN
          const allActivePayments = await tx.purchaseOrderPayment.findMany({
            where: { purchaseOrderId: po.purchaseOrderId, status: { not: 2 } },
            select: { amount: true },
          });
          const newPaidAmount = allActivePayments.reduce(
            (s: number, p: any) => s + Number(p.amount),
            0,
          );
          const newDebt = Number(poData.subTotal) - newPaidAmount;
          await tx.purchaseOrder.update({
            where: { id: po.purchaseOrderId },
            data: {
              paidAmount: newPaidAmount,
              debtAmount: newDebt,
              supplierDebt: newDebt,
            },
          });
        }
      }

      // Validate tổng allocate khớp với totalAmount nếu user dùng allocate
      if (
        dto.allocateToPurchaseOrders &&
        Math.abs(allocatedTotal - dto.totalAmount) > 0.01
      ) {
        // Cho phép NHỎ HƠN totalAmount (phần dư = "trả thừa" — thành credit
        // với NCC). Nếu LỚN HƠN thì lỗi rõ ràng.
        if (allocatedTotal > dto.totalAmount) {
          throw new Error(
            `Tổng phân bổ ${allocatedTotal} vượt quá số tiền thanh toán ${dto.totalAmount}`,
          );
        }
      }

      // ── 2. Tạo CashFlow chi NCC ─────────────────────────────────────────
      let cashFlow: any = null;
      if (dto.totalAmount > 0) {
        const code = await this.generateSafeCashFlowCode(false, tx);
        cashFlow = await tx.cashFlow.create({
          data: {
            code,
            branchId: dto.branchId,
            cashFlowGroupId: 9,
            isReceipt: false,
            amount: dto.totalAmount,
            transDate: dto.transDate ? new Date(dto.transDate) : new Date(),
            method: dto.method || 'cash',
            accountId: dto.accountId,
            partnerType: 'S',
            partnerId: dto.supplierId,
            partnerName: supplier.name,
            contactNumber: supplier.contactNumber,
            address: supplier.address,
            description: dto.description || 'Chi tiền nhà cung cấp',
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            supplierDebtSnapshot: null,
          },
        });

        // Link tất cả PurchaseOrderPayment vào cashflow vừa tạo
        if (createdPaymentIds.length > 0) {
          await tx.purchaseOrderPayment.updateMany({
            where: { id: { in: createdPaymentIds } },
            data: { cashFlowId: cashFlow.id },
          });
        }
      }

      // ── 3. Recalc Supplier.debt ─────────────────────────────────────────
      await this.recalcSupplierDebt(dto.supplierId, tx);

      // ── 4. Snapshot supplier debt vào cashflow ──────────────────────────
      if (cashFlow) {
        const updatedSupplier = await tx.supplier.findUnique({
          where: { id: dto.supplierId },
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
      }

      // ── 5. Audit log ────────────────────────────────────────────────────
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      if (cashFlow) {
        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'CASHFLOW_CREATE',
          entityType: 'cashflows',
          entityId: cashFlow.id.toString(),
          entityCode: cashFlow.code,
          category: getCategoryFromActionCode('CASHFLOW_CREATE'),
          severity: getSeverityFromActionCode('CASHFLOW_CREATE'),
          snapshot: {
            code: cashFlow.code,
            amount: Number(cashFlow.amount),
            partnerType: 'S',
            supplierId: dto.supplierId,
            supplierName: supplier.name,
            allocatedPayments: createdPaymentIds.length,
          },
          message: renderAuditMessage('CASHFLOW_CREATE', {
            flowType: 'Chi',
            amount: Number(cashFlow.amount),
            description: cashFlow.description || `Chi tiền NCC ${supplier.name}`,
          }),
          messageTemplate: 'CASHFLOW_CREATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: dto.branchId || user?.branchId || undefined,
        });
      }

      return { cashFlow, paymentCount: createdPaymentIds.length };
    });
  }

  /**
   * Tạo mã PCPN###### unique cho bulk supplier payment.
   * Đối xứng `purchase-orders.service.ts:generatePCPNCode` nhưng inline ở
   * cashflows.service để tránh circular import.
   */
  private async generatePCPNCodeBulk(tx: any): Promise<string> {
    const prefix = 'PCPN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPayments = await tx.purchaseOrderPayment.findMany({
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
      const exists = await tx.purchaseOrderPayment.findFirst({
        where: { code },
      });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán PCPN duy nhất');
  }

  private recalcCustomerDebt(customerId: number, tx: any) {
    return recalcCustomerDebtUtil(tx, customerId);
  }

  private recalcSupplierDebt(supplierId: number, tx: any) {
    return recalcSupplierDebtUtil(tx, supplierId);
  }

  private async generateSafeCashFlowCode(
    isReceipt: boolean,
    tx: any,
  ): Promise<string> {
    const prefix = isReceipt ? 'TT' : 'PC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);

    const allCashFlows = await tx.cashFlow.findMany({
      where: {
        code: { startsWith: prefix },
        isReceipt,
      },
      select: { code: true },
    });

    const numbers = allCashFlows
      .map((cf: any) => cf.code)
      .filter((code: string) => regex.test(code))
      .map((code: string) => parseInt(code.replace(prefix, ''), 10));

    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    const nextNumber = maxNumber + 1;
    const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

    // Safety check
    const exists = await tx.cashFlow.findFirst({ where: { code } });
    if (exists) {
      throw new Error('Không thể tạo mã phiếu thu/chi duy nhất');
    }

    return code;
  }

  private buildCashFlowSnapshot(cashFlow: any) {
    return {
      code: cashFlow.code,
      isReceipt: cashFlow.isReceipt,
      amount: Number(cashFlow.amount),
      transDate: cashFlow.transDate,
      method: cashFlow.method,
      status: cashFlow.status,
      statusValue: cashFlow.statusValue,
      description: cashFlow.description,
      partnerType: cashFlow.partnerType,
      partnerName: cashFlow.partnerName,
      branchName: cashFlow.branchName || cashFlow.branch?.name,
      cashFlowGroupName:
        cashFlow.cashFlowGroupName || cashFlow.cashFlowGroup?.name,
      creatorName: cashFlow.creatorName || cashFlow.creator?.name,
    };
  }

  // ─── BUILD WHERE ─────────────────────────────────────────────────────────
  private buildCashFlowExportWhere(query: CashFlowQueryDto): any {
    const {
      branchIds,
      code,
      search,
      userId,
      accountId,
      partnerType,
      method,
      cashFlowGroupId,
      usedForFinancialReporting,
      partnerName,
      contactNumber,
      isReceipt,
      startDate,
      endDate,
      status,
    } = query;

    const where: any = {};

    if (userId) {
      where.createdBy = userId;
    }

    if (!code?.length && branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (code && code.length > 0) {
      where.code = { in: code };
    } else if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { partnerName: { contains: search, mode: 'insensitive' } },
      ];
    } else {
      // Ẩn cashflow CLONE (TTTU*, PCTU*) khỏi export mặc định
      where.AND = [
        { code: { not: { startsWith: 'TTTU' } } },
        { code: { not: { startsWith: 'PCTU' } } },
      ];
    }

    if (accountId) where.accountId = accountId;
    if (partnerType && partnerType !== 'A') where.partnerType = partnerType;
    if (method && method.length > 0) where.method = { in: method };
    if (cashFlowGroupId && cashFlowGroupId.length > 0) {
      where.cashFlowGroupId = { in: cashFlowGroupId };
    }
    if (usedForFinancialReporting !== undefined) {
      where.usedForFinancialReporting = usedForFinancialReporting;
    }
    if (partnerName) {
      where.partnerName = { contains: partnerName, mode: 'insensitive' };
    }
    if (contactNumber) {
      where.contactNumber = { contains: contactNumber };
    }
    if (isReceipt !== undefined) where.isReceipt = isReceipt;

    if (!code?.length && (startDate || endDate)) {
      where.transDate = {};
      if (startDate) where.transDate.gte = new Date(startDate);
      if (endDate) where.transDate.lte = new Date(endDate);
    }

    if (status !== undefined) where.status = status;

    return where;
  }

  // ─── EXPORT: Sổ quỹ tổng quan (1 dòng/phiếu) ────────────────────────────
  async exportOverview(query: CashFlowQueryDto, res: Response): Promise<void> {
    const where = this.buildCashFlowExportWhere(query);
    const BATCH_SIZE = 500;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Sổ quỹ tổng quan');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã phiếu', key: 'code', width: 16 },
      { header: 'Thời gian GD', key: 'transDate', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 18 },
      { header: 'Loại', key: 'flowType', width: 10 },
      { header: 'Nhóm thu/chi', key: 'cashFlowGroupName', width: 20 },
      { header: 'Người nộp/nhận', key: 'partnerName', width: 22 },
      { header: 'Số điện thoại', key: 'contactNumber', width: 14 },
      { header: 'Giá trị', key: 'amount', width: 16 },
      { header: 'Hình thức TT', key: 'method', width: 14 },
      { header: 'Ghi chú', key: 'description', width: 28 },
      { header: 'Trạng thái', key: 'statusValue', width: 16 },
      { header: 'Người tạo', key: 'creatorName', width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.cashFlow.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { transDate: 'desc' },
        select: {
          id: true,
          code: true,
          transDate: true,
          createdAt: true,
          isReceipt: true,
          amount: true,
          method: true,
          partnerName: true,
          contactNumber: true,
          description: true,
          statusValue: true,
          branch: { select: { name: true } },
          cashFlowGroup: { select: { name: true } },
          creator: { select: { name: true } },
        },
      });

      if (batch.length === 0) break;

      for (const cf of batch) {
        stt++;
        sheet
          .addRow({
            stt,
            branchName: cf.branch?.name ?? '',
            code: cf.code,
            transDate: new Date(cf.transDate),
            createdAt: new Date(cf.createdAt),
            flowType: cf.isReceipt ? 'Thu' : 'Chi',
            cashFlowGroupName: cf.cashFlowGroup?.name ?? '',
            partnerName: cf.partnerName ?? '',
            contactNumber: cf.contactNumber ?? '',
            amount: Number(cf.amount),
            method: cf.method ?? '',
            description: cf.description ?? '',
            statusValue: cf.statusValue ?? '',
            creatorName: cf.creator?.name ?? '',
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }
}
