import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateOrderSupplierDto,
  UpdateOrderSupplierDto,
  OrderSupplierQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

@Injectable()
export class OrderSuppliersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: OrderSupplierQueryDto) {
    const {
      branchId,
      supplierId,
      status,
      createdById,
      userId,
      createdDateFrom,
      createdDateTo,
      pageSize = 15,
      currentItem = 0,
      search,
    } = query;

    const where: any = {};

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (branchId) where.branchId = branchId;
    if (supplierId) where.supplierId = supplierId;
    if (status !== undefined && status.length > 0) {
      where.status = status.length === 1 ? status[0] : { in: status };
    }
    if (createdById) where.createdBy = createdById;
    if (userId) where.userId = userId;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        where.createdAt.lte = new Date(createdDateTo);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.orderSupplier.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          supplier: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          items: true,
          expensesOthers: true,
          purchaseOrders: {
            select: {
              id: true,
              code: true,
            },
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.orderSupplier.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  async findOne(id: number) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: {
        supplier: {
          select: {
            id: true,
            code: true,
            name: true,
            contactNumber: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        expensesOthers: true,
        purchaseOrders: {
          include: {
            items: {
              select: {
                productId: true,
                quantity: true,
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
        payments: true,
      },
    });

    if (!orderSupplier) {
      throw new NotFoundException('Order supplier not found');
    }

    return orderSupplier;
  }

  async create(dto: CreateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateSafeOrderSupplierCode(tx);

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });

          if (!product) {
            throw new NotFoundException(
              `Product with id ${item.productId} not found`,
            );
          }

          const subTotal = (item.price - (item.discount || 0)) * item.quantity;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            subTotal,
            description: item.description,
            orderQuantity: item.quantity,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.subTotal),
        0,
      );
      const discount = dto.discount || 0;
      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : discount;
      const subTotal = total - discountAmount;
      const totalQuantity = itemsData.reduce(
        (sum, item) => sum + Number(item.quantity),
        0,
      );

      const paidAmount = Number(dto.paymentAmount || 0);

      const orderSupplier = await tx.orderSupplier.create({
        data: {
          code,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          userId: dto.userId,
          description: dto.description,
          status: dto.status || 0,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          total,
          subTotal,
          totalAmt: subTotal,
          totalQty: totalQuantity,
          totalQuantity,
          productQty: itemsData.length,
          paidAmount,
          supplierDebt: subTotal - paidAmount,
          toComplete: dto.toComplete || false,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: true,
        },
      });

      if (dto.paymentAmount && dto.paymentAmount > 0) {
        const paymentCode = await this.generatePaymentCode(tx);

        await tx.orderSupplierPayment.create({
          data: {
            code: paymentCode,
            orderSupplierId: orderSupplier.id,
            amount: dto.paymentAmount,
            paymentDate: new Date(),
            paymentMethod: dto.paymentMethod || 'cash',
            description: `Trả tiền đặt hàng nhập ${orderSupplier.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
          },
        });

        let cashFlowMethod = 'cash';
        if (dto.paymentMethod === 'transfer') {
          cashFlowMethod = 'transfer';
        } else if (dto.paymentMethod === 'card') {
          cashFlowMethod = 'card';
        }

        await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: orderSupplier.branchId ?? 1,
            cashFlowGroupId: 4,
            isReceipt: false,
            amount: dto.paymentAmount,
            transDate: new Date(),
            method: cashFlowMethod,
            partnerType: 'S',
            partnerId: orderSupplier.supplierId,
            partnerName: orderSupplier.supplier?.name,
            contactNumber: orderSupplier.supplier?.contactNumber,
            address: orderSupplier.supplier?.address,
            description: `Chi tiền đặt hàng nhập ${orderSupplier.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
          },
        });

        await this.updateSupplierDebt(dto.supplierId, tx);
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_SUPPLIER_CREATE',
        entityType: 'order_suppliers',
        entityId: orderSupplier.id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_CREATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_CREATE'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_CREATE', {
          orderSupplierCode: orderSupplier.code,
          supplierName: orderSupplier.supplier?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_SUPPLIER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });

      return orderSupplier;
    });
  }

  async update(id: number, dto: UpdateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.orderSupplier.findUnique({
        where: { id },
        include: { items: true, supplier: true },
      });

      if (!existing) {
        throw new NotFoundException(`OrderSupplier with id ${id} not found`);
      }

      let total = Number(existing.total);
      let discountAmount = Number(existing.discount);
      let subTotal = Number(existing.subTotal);
      let totalQuantity = Number(existing.totalQty);
      let currentPaidAmount = Number(existing.paidAmount);
      let productQty = Number(existing.productQty);

      if (dto.items) {
        await tx.orderSupplierItem.deleteMany({
          where: { orderSupplierId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!product) {
              throw new NotFoundException(
                `Product with id ${item.productId} not found`,
              );
            }

            const subTotal =
              (item.price - (item.discount || 0)) * item.quantity;

            return {
              orderSupplierId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount || 0,
              subTotal,
              description: item.description,
              orderQuantity: item.quantity,
            };
          }),
        );

        await tx.orderSupplierItem.createMany({
          data: itemsData,
        });

        total = itemsData.reduce((sum, item) => sum + Number(item.subTotal), 0);
        const discount = dto.discount || existing.discount;
        discountAmount = dto.discountRatio
          ? (total * dto.discountRatio) / 100
          : Number(discount);
        subTotal = total - discountAmount;
        totalQuantity = itemsData.reduce(
          (sum, item) => sum + Number(item.quantity),
          0,
        );
        productQty = itemsData.length;
      }

      if (dto.paymentAmount && dto.paymentAmount > 0) {
        const paymentCode = await this.generatePaymentCode(tx);

        await tx.orderSupplierPayment.create({
          data: {
            code: paymentCode,
            orderSupplierId: id,
            amount: dto.paymentAmount,
            paymentDate: new Date(),
            paymentMethod: dto.paymentMethod || 'cash',
            description: `Trả tiền đặt hàng nhập ${existing.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
          },
        });

        let cashFlowMethod = 'cash';
        if (dto.paymentMethod === 'transfer') {
          cashFlowMethod = 'transfer';
        } else if (dto.paymentMethod === 'card') {
          cashFlowMethod = 'card';
        }

        await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: existing.branchId ?? 1,
            cashFlowGroupId: 4,
            isReceipt: false,
            amount: dto.paymentAmount,
            transDate: new Date(),
            method: cashFlowMethod,
            partnerType: 'S',
            partnerId: existing.supplierId,
            partnerName: existing.supplier?.name,
            contactNumber: existing.supplier?.contactNumber,
            address: existing.supplier?.address,
            description: `Chi tiền đặt hàng nhập ${existing.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            collectorUserId: userId,
            usedForFinancialReporting: 1,
          },
        });

        const allPayments = await tx.orderSupplierPayment.findMany({
          where: { orderSupplierId: id },
        });
        currentPaidAmount = allPayments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );

        await this.updateSupplierDebt(existing.supplierId, tx);
      }

      const updatedOrderSupplier = await tx.orderSupplier.update({
        where: { id },
        data: {
          supplierId: dto.supplierId ?? existing.supplierId,
          branchId: dto.branchId ?? existing.branchId,
          userId: dto.userId ?? existing.userId,
          description: dto.description ?? existing.description,
          status: dto.status ?? existing.status,
          discount: discountAmount,
          discountRatio: dto.discountRatio ?? existing.discountRatio,
          total,
          subTotal,
          totalAmt: subTotal,
          totalQty: totalQuantity,
          totalQuantity,
          productQty,
          paidAmount: currentPaidAmount,
          supplierDebt: subTotal - currentPaidAmount,
          orderDate: dto.orderDate
            ? new Date(dto.orderDate)
            : existing.orderDate,
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: true,
          payments: true,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_UPDATE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: updatedOrderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_UPDATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_UPDATE'),
        snapshot: this.buildOrderSupplierSnapshot(updatedOrderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_UPDATE', {
          orderSupplierCode: updatedOrderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: updatedOrderSupplier.branchId || user?.branchId || undefined,
      });

      return updatedOrderSupplier;
    });
  }

  async remove(id: number, userId: number) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: { branch: { select: { name: true } } }, // THÊM
    });

    if (!orderSupplier) {
      throw new NotFoundException(`OrderSupplier with id ${id} not found`);
    }

    await this.prisma.orderSupplier.delete({
      where: { id },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'ORDER_SUPPLIER_DELETE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_DELETE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_DELETE'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_DELETE', {
          orderSupplierCode: orderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });
    }

    return { message: 'Xóa phiếu đặt hàng nhập thành công' };
  }

  private async generateSafeOrderSupplierCode(tx?: any): Promise<string> {
    const prefix = 'PDN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allOrderSuppliers = await tx.orderSupplier.findMany({
        where: {
          code: { startsWith: prefix },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allOrderSuppliers
        .map((sup: any) => sup.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
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

      const exists = await tx.orderSupplier.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu đặt hàng nhập duy nhất');
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PDNPC';
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

      const existsInPayment = await tx.orderSupplierPayment.findFirst({
        where: { code },
      });

      const existsInCashFlow = await tx.cashFlow.findFirst({
        where: { code },
      });

      if (!existsInPayment && !existsInCashFlow) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán duy nhất');
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }

  private buildOrderSupplierSnapshot(os: any) {
    return {
      code: os.code,
      supplierId: os.supplierId,
      supplierName: os.supplier?.name,
      supplierDebt: os.supplierDebt,
      branchId: os.branchId,
      branchName: os.branch?.name,
      status: os.status,
      statusValue: os.statusValue,
      total: Number(os.total || 0),
      discount: Number(os.discount || 0),
      paidAmount: Number(os.paidAmount || 0),
      items: (os.items || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        price: Number(item.price),
      })),
    };
  }
}
