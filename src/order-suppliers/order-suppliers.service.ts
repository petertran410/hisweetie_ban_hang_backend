import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CancelOrderSupplierDto,
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
import { buildChanges, buildItemChanges } from '../audit-logs/audit-diff.utils';

/**
 * Bảng nhãn status của OrderSupplier (PDN). Đối xứng `getStatusLabel` của
 * `OrderSupplier` ở frontend (`pos-hisweetie/lib/types/order-supplier.ts`).
 *
 *   0 DRAFT     - Phiếu tạm
 *   1 CONFIRMED - Đã xác nhận NCC
 *   2 PARTIAL   - Nhập một phần
 *   3 COMPLETED - Hoàn thành
 *   4 CANCELLED - Đã hủy
 */
function getOrderSupplierStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Phiếu tạm';
    case 1:
      return 'Đã xác nhận NCC';
    case 2:
      return 'Nhập một phần';
    case 3:
      return 'Hoàn thành';
    case 4:
      return 'Đã hủy';
    default:
      return 'Không xác định';
  }
}

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
        { supplier: { code: { contains: search, mode: 'insensitive' } } },
        {
          items: {
            some: {
              OR: [
                { productCode: { contains: search, mode: 'insensitive' } },
                { productName: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
        {
          purchaseOrders: {
            some: {
              code: { contains: search, mode: 'insensitive' },
            },
          },
        },
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
        vehicleShipmentItems: {
          where: { vehicleShipment: { status: { not: 3 } } },
          select: {
            productId: true,
            quantity: true,
            vehicleShipmentId: true,
            postImportStatus: true,
            vehicleShipment: { select: { status: true } },
          },
        },
      },
    });

    if (!orderSupplier) {
      throw new NotFoundException('Order supplier not found');
    }

    // ── Tính các mốc số lượng per sản phẩm ───────────────────────────────────
    // received: tổng SL đã nhập qua PN active (isDraft=false, status≠2)
    // shippedTotal: tổng SL ghép xe (mọi xe chưa hủy) — dùng cho cột "Ghép xe"
    // reserved: phần ghép xe đang GIỮ CHỖ (đối xứng getQuantityMap):
    //   • xe chưa nhập (status 0/1): giữ full SL ghép
    //   • xe đã nhập (status 2): chỉ giữ phần THIẾU = max(ghép − nhận của xe đó,0)
    //     khi postImportStatus ∈ {pending,kept}; 'returned' → 0
    // remaining (Còn lại) = max(ordered − received − reserved, 0)
    const receivedByProduct: Record<number, number> = {};
    const receivedByVehicleProduct = new Map<string, number>(); // `${vehId}:${pId}`
    for (const po of orderSupplier.purchaseOrders) {
      const active = !(po as any).isDraft && (po as any).status !== 2;
      if (!active) continue;
      const vehId = (po as any).vehicleShipmentId as number | null;
      for (const it of po.items) {
        receivedByProduct[it.productId] =
          (receivedByProduct[it.productId] || 0) + Number(it.quantity);
        if (vehId != null) {
          const vk = `${vehId}:${it.productId}`;
          receivedByVehicleProduct.set(
            vk,
            (receivedByVehicleProduct.get(vk) || 0) + Number(it.quantity),
          );
        }
      }
    }

    const shippedTotalByProduct: Record<number, number> = {};
    const reservedByProduct: Record<number, number> = {};
    for (const vi of orderSupplier.vehicleShipmentItems as any[]) {
      const shipQty = Number(vi.quantity);
      shippedTotalByProduct[vi.productId] =
        (shippedTotalByProduct[vi.productId] || 0) + shipQty;

      const vehStatus = vi.vehicleShipment?.status ?? 0;
      let reserved: number;
      if (vehStatus === 2) {
        if (vi.postImportStatus === 'returned') {
          reserved = 0;
        } else {
          const recv =
            receivedByVehicleProduct.get(
              `${vi.vehicleShipmentId}:${vi.productId}`,
            ) || 0;
          reserved = Math.max(shipQty - recv, 0);
        }
      } else {
        reserved = shipQty;
      }
      reservedByProduct[vi.productId] =
        (reservedByProduct[vi.productId] || 0) + reserved;
    }

    const itemsEnriched = (orderSupplier.items as any[]).map((item) => {
      const ordered = Number(item.quantity);
      const received = receivedByProduct[item.productId] || 0;
      const reserved = reservedByProduct[item.productId] || 0;
      return {
        ...item,
        receivedQty: received,
        shippedQty: shippedTotalByProduct[item.productId] || 0,
        reservedQty: reserved,
        remainingQty: Math.max(ordered - received - reserved, 0),
      };
    });

    return { ...orderSupplier, items: itemsEnriched };
  }

  async create(dto: CreateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      // Cho phép user tự điền mã (đối xứng `productions.service.ts:141`).
      // Trim + check duplicate; nếu trống/không hợp lệ thì auto-generate.
      const code = await this.resolveOrderSupplierCode(tx, dto.code);

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
          statusValue: getOrderSupplierStatusLabel(dto.status || 0),
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
        // Đối xứng `purchase-orders.service.ts`: bắt buộc PDN phải có chi nhánh
        // khi tạo CashFlow để tránh fallback `?? 1` ghi sai chi nhánh tiền chi.
        if (!orderSupplier.branchId) {
          throw new NotFoundException(
            'Phiếu đặt hàng nhập chưa có chi nhánh. Vui lòng chọn chi nhánh trước khi thanh toán.',
          );
        }

        const paymentCode = await this.generatePaymentCode(tx);

        let cashFlowMethod = 'cash';
        if (dto.paymentMethod === 'transfer') {
          cashFlowMethod = 'transfer';
        } else if (dto.paymentMethod === 'card') {
          cashFlowMethod = 'card';
        }

        // Tạo CashFlow TRƯỚC để có id gán vào OrderSupplierPayment.cashFlowId.
        // Đối xứng pattern phía bán.
        const cashFlow = await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: orderSupplier.branchId,
            cashFlowGroupId: 9,
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
            supplierDebtSnapshot: null,
          },
        });

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
            cashFlowId: cashFlow.id,
          },
        });

        await this.updateSupplierDebt(dto.supplierId, tx);

        // Snapshot supplier debt sau recalc.
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
        include: {
          items: { include: { product: { select: { name: true } } } },
          supplier: true,
        },
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

      // Đối xứng `Order.update` phía bán: KHÔNG tạo payment + cashflow trực
      // tiếp trong update. Mỗi lần save form sẽ tạo MỚI một CashFlow → user
      // dễ vô tình nhân đôi/nhân ba khoản chi. Ép user dùng endpoint riêng
      // `POST /api/order-suppliers/:id/payments` cho thanh toán bổ sung.
      if (dto.paymentAmount && dto.paymentAmount > 0) {
        throw new BadRequestException(
          'Không thể thanh toán trực tiếp khi cập nhật phiếu đặt hàng nhập. Vui lòng dùng chức năng thanh toán riêng.',
        );
      }

      // Recompute paidAmount từ active payments (mirror Order.calculateTotals)
      // — single source of truth là OrderSupplierPayment ACTIVE.
      const activePayments = await tx.orderSupplierPayment.findMany({
        where: { orderSupplierId: id, status: { not: 2 } },
        select: { amount: true },
      });
      currentPaidAmount = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );

      // Cho phép user đổi mã PDN khi update — đối xứng `productions.service.ts`.
      // `dto.code === undefined`: giữ nguyên `existing.code`.
      // `dto.code` có giá trị: trim + check duplicate (loại trừ chính phiếu này).
      const nextCode =
        dto.code === undefined
          ? existing.code
          : await this.resolveOrderSupplierCode(tx, dto.code, id);

      const updatedOrderSupplier = await tx.orderSupplier.update({
        where: { id },
        data: {
          code: nextCode,
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
          items: { include: { product: { select: { name: true } } } },
          payments: true,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      // Build fieldChanges + itemChanges đối xứng `Order.update` phía bán
      // (orders.service.ts:476-513). Audit trail PDN giờ có đủ thông tin
      // "đổi gì" thay vì chỉ snapshot mới.
      const fieldChanges = buildChanges(
        'order_suppliers',
        {
          code: existing.code,
          statusValue: existing.statusValue,
          subTotal: Number(existing.subTotal),
          discount: Number(existing.discount || 0),
          discountRatio: Number(existing.discountRatio || 0),
          description: existing.description,
          supplierId: existing.supplierId,
        },
        {
          code: updatedOrderSupplier.code,
          statusValue: updatedOrderSupplier.statusValue,
          subTotal: Number(updatedOrderSupplier.subTotal),
          discount: Number(updatedOrderSupplier.discount || 0),
          discountRatio: Number(updatedOrderSupplier.discountRatio || 0),
          description: updatedOrderSupplier.description,
          supplierId: updatedOrderSupplier.supplierId,
        },
      );

      const itemChanges = buildItemChanges(
        existing.items.map((i: any) => ({
          productId: i.productId,
          productName: i.product?.name || i.productName,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
        updatedOrderSupplier.items.map((i: any) => ({
          productId: i.productId,
          productName: i.product?.name || i.productName,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
      );

      const allChanges = [...fieldChanges, ...itemChanges];

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_UPDATE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: updatedOrderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_UPDATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_UPDATE'),
        snapshot: this.buildOrderSupplierSnapshot(updatedOrderSupplier),
        changes: allChanges.length > 0 ? allChanges : null,
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

  /**
   * Hủy mềm phiếu đặt hàng nhập (PDN). Mirror chính xác `OrdersService.cancelOrder`
   * của phía bán:
   *   - Block khi đã CANCELLED hoặc khi đã có PurchaseOrder con (active).
   *   - dto.cancelPayments=true: soft cancel mọi OrderSupplierPayment + CashFlow
   *     PCPDN match theo code, set paidAmount=0, supplierDebt=0.
   *   - dto.cancelPayments=false: vẫn cho hủy nhưng KHÔNG đụng payment — user phải
   *     xóa từng payment trước. Đối xứng pattern phía bán.
   *   - Recalc Supplier.debt qua Formula B sau cùng.
   */
  async cancelOrderSupplier(
    id: number,
    dto: CancelOrderSupplierDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id },
        include: {
          items: true,
          purchaseOrders: {
            where: { status: { not: 2 } },
            select: { id: true, code: true, isDraft: true },
          },
          payments: { where: { status: { not: 2 } } },
          supplier: {
            select: { id: true, code: true, name: true, debt: true },
          },
          creator: { select: { id: true, name: true } },
        },
      });

      if (!orderSupplier) {
        throw new NotFoundException('Không tìm thấy phiếu đặt hàng nhập');
      }

      // Status 4 = CANCELLED (đối xứng ORDER_STATUS.CANCELLED phía bán)
      if (orderSupplier.status === 4) {
        throw new BadRequestException(
          'Phiếu đặt hàng nhập đã được hủy trước đó',
        );
      }

      // Block khi còn PN active — đối xứng "Đơn hàng có hóa đơn" phía bán
      const hasActivePurchaseOrders =
        orderSupplier.purchaseOrders && orderSupplier.purchaseOrders.length > 0;
      if (hasActivePurchaseOrders) {
        throw new BadRequestException(
          'Phiếu đặt hàng nhập đã có phiếu nhập. Vui lòng hủy tất cả phiếu nhập trước khi hủy phiếu đặt hàng nhập',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      if (dto.cancelPayments && orderSupplier.payments.length > 0) {
        const paymentIds = orderSupplier.payments.map((p: any) => p.id);
        const paymentCodes = orderSupplier.payments
          .map((p: any) => p.code)
          .filter((c: any): c is string => !!c);
        const explicitCashFlowIds = orderSupplier.payments
          .map((p: any) => p.cashFlowId)
          .filter((id: any): id is number => typeof id === 'number');

        // Soft-cancel OrderSupplierPayment (giữ audit, không hard-delete)
        await tx.orderSupplierPayment.updateMany({
          where: { id: { in: paymentIds } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });

        // Soft-cancel CashFlow PCPDN: ưu tiên match qua FK cashFlowId,
        // fallback `code` (đối xứng `invoice-payments.service.ts:191-208`).
        const orConditions: any[] = [];
        if (explicitCashFlowIds.length > 0) {
          orConditions.push({ id: { in: explicitCashFlowIds } });
        }
        if (paymentCodes.length > 0) {
          orConditions.push({ code: { in: paymentCodes } });
        }
        if (orConditions.length > 0) {
          await tx.cashFlow.updateMany({
            where: {
              OR: orConditions,
              partnerType: 'S',
              partnerId: orderSupplier.supplierId,
              status: { not: 2 },
            },
            data: { status: 2, statusValue: 'Đã hủy' },
          });
        }

        // Audit log từng payment (đối xứng phía bán log ORDER_PAYMENT_DELETE)
        for (const payment of orderSupplier.payments) {
          await this.auditLogsService.create({
            actionType: 'DELETE',
            actionCode: 'ORDER_SUPPLIER_PAYMENT_DELETE',
            entityType: 'order_supplier_payment',
            entityId: payment.id.toString(),
            entityCode: payment.code,
            category: getCategoryFromActionCode(
              'ORDER_SUPPLIER_PAYMENT_DELETE',
            ),
            severity: getSeverityFromActionCode(
              'ORDER_SUPPLIER_PAYMENT_DELETE',
            ),
            snapshot: {
              code: payment.code,
              amount: Number(payment.amount),
              paymentMethod: payment.paymentMethod,
              orderSupplier: {
                code: orderSupplier.code,
                supplier: orderSupplier.supplier,
              },
            },
            message: renderAuditMessage('ORDER_SUPPLIER_PAYMENT_DELETE', {
              paymentCode: payment.code,
              orderSupplierCode: orderSupplier.code,
            }),
            messageTemplate: 'ORDER_SUPPLIER_PAYMENT_DELETE',
            userId,
            userName: user?.name || 'System',
            branchId: orderSupplier.branchId || undefined,
          });
        }
      } else if (orderSupplier.payments.length > 0 && !dto.cancelPayments) {
        // Đối xứng pattern phía bán: nếu user không gửi cancelPayments=true mà
        // còn payment active, vẫn cho hủy nhưng payment giữ nguyên. Tuy nhiên
        // điều này dẫn tới supplierDebt không đồng bộ — block để user buộc
        // phải quyết định rõ.
        throw new BadRequestException(
          'Phiếu đặt hàng nhập có thanh toán. Hãy hủy thanh toán trước hoặc gửi cancelPayments=true để hủy luôn thanh toán',
        );
      }

      // Update PDN sang CANCELLED — đối xứng `Order.status=CANCELLED`
      await tx.orderSupplier.update({
        where: { id },
        data: {
          status: 4,
          statusValue: 'Đã hủy',
          ...(dto.cancelPayments && orderSupplier.payments.length > 0
            ? { paidAmount: 0, supplierDebt: 0 }
            : { supplierDebt: 0 }),
        },
      });

      // Recalc Supplier.debt qua Formula B (filter status≠2 tự loại records vừa hủy)
      await this.updateSupplierDebt(orderSupplier.supplierId, tx);

      // Audit ORDER_SUPPLIER_CANCEL
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_CANCEL',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_CANCEL'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_CANCEL'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_CANCEL', {
          orderSupplierCode: orderSupplier.code,
          supplierName: orderSupplier.supplier?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_SUPPLIER_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: orderSupplier.branchId || undefined,
      });

      return { message: 'Hủy phiếu đặt hàng nhập thành công' };
    });
  }

  /**
   * Chốt hoàn thành PDN thủ công khi NCC không giao nốt phần còn thiếu
   * (vd 100 đặt / 99 nhập). Set status=3 + toComplete=true để
   * `updateOrderSupplierStatus` (phía PN) không hạ cấp về "Nhập một phần".
   */
  async completeOrderSupplier(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id },
        include: { supplier: { select: { id: true, name: true } } },
      });
      if (!orderSupplier) {
        throw new NotFoundException('Không tìm thấy phiếu đặt hàng nhập');
      }
      if (orderSupplier.status === 4) {
        throw new BadRequestException('Phiếu đặt hàng nhập đã hủy');
      }
      if (orderSupplier.status === 3 && orderSupplier.toComplete) {
        throw new BadRequestException('Phiếu đặt hàng nhập đã hoàn thành');
      }

      const updated = await tx.orderSupplier.update({
        where: { id },
        data: { status: 3, statusValue: 'Hoàn thành', toComplete: true },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_COMPLETE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_COMPLETE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_COMPLETE'),
        message: renderAuditMessage('ORDER_SUPPLIER_COMPLETE', {
          orderSupplierCode: orderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_COMPLETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });

      return updated;
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

  /**
   * Tổng số lượng "Đặt NCC" cho từng productId.
   * Đặt NCC = số lượng CÒN LẠI cần nhập = sum(SL đặt − SL đã nhập) cho từng
   * sản phẩm, tính trên các phiếu OrderSupplier có status thuộc
   * { Đã xác nhận NCC (1), Nhập một phần (2) }.
   *
   * "Đã nhập" = tổng SL của sản phẩm đó trên các PurchaseOrder ACTIVE của phiếu
   * (không phải Phiếu tạm: isDraft=false, không bị hủy: status≠2) — đối xứng
   * `PurchaseOrdersService.createFromOrderSupplier` (receivedQuantities).
   *
   * Chỉ cộng phần còn lại > 0: sản phẩm đã nhập đủ trên 1 phiếu thì phiếu đó
   * không còn đóng góp vào "Đặt NCC" của sản phẩm (dù phiếu vẫn ở trạng thái
   * Nhập một phần vì sản phẩm khác chưa nhập xong).
   *
   * Nếu truyền branchId thì chỉ đếm phiếu thuộc chi nhánh đó.
   * Đối xứng `OrdersService.getPendingSummary` của phía bán.
   */
  async getConfirmedSummary(productIds: number[], branchId?: number) {
    if (!productIds || productIds.length === 0) {
      return {} as Record<number, number>;
    }

    const orderSupplierWhere: any = {
      status: { in: [1, 2] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      // Lấy cả phiếu không gắn chi nhánh (branchId = null) — áp dụng cho mọi CN
      orderSupplierWhere.OR = [{ branchId }, { branchId: null }];
    }

    const items = await this.prisma.orderSupplierItem.findMany({
      where: {
        productId: { in: productIds },
        orderSupplier: orderSupplierWhere,
      },
      select: {
        productId: true,
        quantity: true,
        orderSupplier: {
          select: {
            purchaseOrders: {
              where: { isDraft: false, status: { not: 2 } },
              select: {
                items: {
                  where: { productId: { in: productIds } },
                  select: { productId: true, quantity: true },
                },
              },
            },
          },
        },
      },
    });

    const result: Record<number, number> = {};
    for (const id of productIds) result[id] = 0;

    for (const item of items) {
      // SL đã nhập của riêng sản phẩm này trong phiếu (qua các PN active).
      let received = 0;
      for (const po of item.orderSupplier?.purchaseOrders || []) {
        for (const poItem of po.items) {
          if (poItem.productId === item.productId) {
            received += Number(poItem.quantity);
          }
        }
      }
      const remaining = Number(item.quantity) - received;
      if (remaining > 0) {
        result[item.productId] += remaining;
      }
    }
    return result;
  }

  /**
   * Lấy danh sách phiếu đặt hàng nhập (OrderSupplier) có chứa productId
   * đang ở trạng thái Đã xác nhận NCC (1) hoặc Nhập một phần (2).
   * Nếu truyền branchId thì lọc theo chi nhánh, không truyền thì lấy mọi chi nhánh.
   * Trả về thông tin tối thiểu cho modal: mã phiếu, ngày tạo, nhà cung cấp,
   * người tạo, tổng tiền, trạng thái, số lượng CÒN LẠI cần nhập của sản phẩm.
   *
   * `quantity` trả về = SL đặt − SL đã nhập (qua các PN active). Phiếu đã nhập
   * đủ sản phẩm này (còn lại ≤ 0) bị ẩn — khớp với cách tính `getConfirmedSummary`
   * và `createFromOrderSupplier`.
   *
   * Đối xứng `OrdersService.getPendingByProduct` của phía bán.
   */
  async getConfirmedByProduct(productId: number, branchId?: number) {
    if (!productId || Number.isNaN(productId)) return [];

    const orderSupplierWhere: any = {
      status: { in: [1, 2] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      // Lấy cả phiếu không gắn chi nhánh (branchId = null) — áp dụng cho mọi CN
      orderSupplierWhere.OR = [{ branchId }, { branchId: null }];
    }

    const items = await this.prisma.orderSupplierItem.findMany({
      where: {
        productId,
        orderSupplier: orderSupplierWhere,
      },
      select: {
        quantity: true,
        orderSupplier: {
          select: {
            id: true,
            code: true,
            orderDate: true,
            createdAt: true,
            total: true,
            status: true,
            statusValue: true,
            supplier: { select: { id: true, code: true, name: true } },
            creator: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            purchaseOrders: {
              where: { isDraft: false, status: { not: 2 } },
              select: {
                items: {
                  where: { productId },
                  select: { quantity: true },
                },
              },
            },
          },
        },
      },
      orderBy: { orderSupplier: { createdAt: 'desc' } },
    });

    // Schema có @@unique([orderSupplierId, productId]) → thực tế 1 dòng/phiếu,
    // nhưng vẫn gộp theo orderSupplierId cho an toàn.
    const map = new Map<
      number,
      {
        orderSupplierId: number;
        code: string;
        createdAt: Date;
        orderDate: Date;
        total: number;
        status: number;
        statusValue: string;
        supplier: { id: number; code: string | null; name: string } | null;
        creator: { id: number; name: string | null } | null;
        branch: { id: number; name: string } | null;
        quantity: number;
      }
    >();

    for (const it of items) {
      const o = it.orderSupplier;
      // SL đã nhập của sản phẩm này trong phiếu (qua các PN active).
      const received = (o.purchaseOrders || []).reduce(
        (sum, po) =>
          sum + po.items.reduce((s, poItem) => s + Number(poItem.quantity), 0),
        0,
      );
      const remaining = Number(it.quantity) - received;
      const existing = map.get(o.id);
      if (existing) {
        existing.quantity += remaining;
      } else {
        map.set(o.id, {
          orderSupplierId: o.id,
          code: o.code,
          createdAt: o.createdAt,
          orderDate: o.orderDate,
          total: Number(o.total),
          status: o.status,
          // Luôn map từ status (number) → label tiếng Việt; không dùng
          // statusValue thô vì DB lưu không nhất quán.
          statusValue: getOrderSupplierStatusLabel(o.status),
          supplier: o.supplier,
          creator: o.creator,
          branch: o.branch,
          quantity: remaining,
        });
      }
    }

    // Ẩn phiếu đã nhập đủ sản phẩm này (còn lại ≤ 0).
    return Array.from(map.values())
      .filter((row) => row.quantity > 0)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Resolve mã PDN cho create/update:
   *   - Có `userCode` (sau trim, khác rỗng): kiểm duplicate trên
   *     `OrderSupplier.code`. `excludeId` để bỏ qua chính phiếu đang update.
   *   - Không có / rỗng: auto-generate qua `generateSafeOrderSupplierCode`.
   *
   * Dùng chung cho cả `create` và `update` để logic nhập mã thủ công đối xứng,
   * tránh fail im lặng khi user gửi mã trùng.
   */
  private async resolveOrderSupplierCode(
    tx: any,
    userCode?: string,
    excludeId?: number,
  ): Promise<string> {
    const trimmed = (userCode || '').trim();
    if (!trimmed) {
      return this.generateSafeOrderSupplierCode(tx);
    }

    const duplicate = await tx.orderSupplier.findFirst({
      where: {
        code: trimmed,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new BadRequestException(
        `Mã phiếu đặt hàng nhập "${trimmed}" đã tồn tại. Vui lòng nhập mã khác hoặc để trống để hệ thống tự sinh.`,
      );
    }

    return trimmed;
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

  /**
   * Recompute cached fields trên OrderSupplier từ source of truth (items +
   * active payments). Mirror chính xác `OrdersService.calculateTotals` của
   * phía bán nhưng đối xứng:
   *   - KH: paymentStatus 'Draft'/'partial'/'paid' từ paidAmount vs grandTotal
   *   - NCC: dùng cùng logic, ghi vào `OrderSupplier` (paidAmount/supplierDebt)
   *
   * Phía bán có field `Order.paymentStatus` riêng. Phía mua không có field
   * tương đương trong schema OrderSupplier — bỏ qua. Cache còn lại đầy đủ.
   */
  private async calculateTotals(orderSupplierId: number, tx: any) {
    const items = await tx.orderSupplierItem.findMany({
      where: { orderSupplierId },
    });
    const payments = await tx.orderSupplierPayment.findMany({
      where: { orderSupplierId, status: { not: 2 } },
    });

    const total = items.reduce(
      (sum: number, item: any) => sum + Number(item.subTotal),
      0,
    );

    const orderSupplier = await tx.orderSupplier.findUnique({
      where: { id: orderSupplierId },
    });
    if (!orderSupplier) return;

    const discountAmount = Number(orderSupplier.discount) || 0;
    const discountFromRatio =
      (total * (Number(orderSupplier.discountRatio) || 0)) / 100;
    const subTotal = total - discountAmount - discountFromRatio;

    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const supplierDebt = subTotal - paidAmount;

    const totalQuantity = items.reduce(
      (sum: number, item: any) => sum + Number(item.quantity),
      0,
    );

    await tx.orderSupplier.update({
      where: { id: orderSupplierId },
      data: {
        total,
        subTotal,
        totalAmt: subTotal,
        totalQty: totalQuantity,
        totalQuantity,
        productQty: items.length,
        paidAmount,
        supplierDebt,
      },
    });
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
