import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePurchaseOrderDto,
  CreatePurchaseOrderFromOrderSupplierDto,
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreatePurchaseOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateSafePurchaseOrderCode(tx);

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product)
            throw new NotFoundException(`Product ${item.productId} not found`);

          const totalPrice =
            (Number(item.price) - (Number(item.discount) || 0)) *
            Number(item.quantity);

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            discountRatio: item.discountRatio || 0,
            totalPrice,
            description: item.description,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );

      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : Number(dto.discount || 0);

      if (dto.orderSupplierId) {
        const linkedOrderSupplier = await tx.orderSupplier.findUnique({
          where: { id: dto.orderSupplierId },
          select: { discount: true },
        });
        if (linkedOrderSupplier) {
          const existingPOs = await tx.purchaseOrder.findMany({
            where: { orderSupplierId: dto.orderSupplierId },
            select: { discount: true },
          });
          const usedDiscount = existingPOs.reduce(
            (sum, po) => sum + Number(po.discount),
            0,
          );
          const maxDiscount = Number(linkedOrderSupplier.discount);
          if (usedDiscount + discountAmount > maxDiscount) {
            throw new BadRequestException(
              `Giảm giá vượt quá giới hạn. Còn có thể dùng: ${maxDiscount - usedDiscount}`,
            );
          }
        }
      }

      const subTotal = total - discountAmount;
      const paidAmount = Number(dto.paidAmount || 0);
      const debtAmount = subTotal - paidAmount;

      const supplier = await tx.supplier.findUnique({
        where: { id: dto.supplierId },
        select: { debt: true, name: true, code: true },
      });
      const supplierOldDebt = Number(supplier?.debt || 0);

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          orderSupplierId: dto.orderSupplierId,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          total,
          totalAmount: total,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          subTotal,
          paidAmount,
          debtAmount,
          status: dto.isDraft ? 0 : 1,
          statusValue: dto.isDraft ? 'Phiếu tạm' : 'Đã nhập hàng',
          supplierOldDebt,
          supplierDebt: debtAmount,
          isDraft: dto.isDraft || false,
          partnerType: dto.partnerType,
          description: dto.description,
          purchaseById: dto.purchaseById,
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
        },
      });

      if (dto.branchId) {
        await this.updateInventory(purchaseOrder.id, tx);
      }

      // Đối xứng Invoice.create: paidAmount > 0 → tạo PurchaseOrderPayment
      // + CashFlow PCPN. Formula B đối xứng triệt để KH: cashflow là single
      // source cho mọi tiền, KHÔNG dùng po.paidAmount trong công thức.
      if (paidAmount > 0 && !dto.isDraft) {
        const paymentCode = await this.generatePCPNCode(tx);

        await tx.purchaseOrderPayment.create({
          data: {
            code: paymentCode,
            purchaseOrderId: purchaseOrder.id,
            paymentDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : new Date(),
            amount: paidAmount,
            paymentMethod: 'cash',
            description: `Trả tiền nhập hàng ${purchaseOrder.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
          },
        });

        if (dto.branchId) {
          await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: dto.branchId,
              cashFlowGroupId: 9,
              isReceipt: false,
              amount: paidAmount,
              transDate: dto.purchaseDate
                ? new Date(dto.purchaseDate)
                : new Date(),
              method: 'cash',
              partnerType: 'S',
              partnerId: dto.supplierId,
              partnerName: supplier?.name,
              description: `Chi tiền nhập hàng ${purchaseOrder.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
            },
          });
        }
      }

      await this.updateSupplierDebt(dto.supplierId, tx);

      if (dto.orderSupplierId) {
        await this.updateOrderSupplierStatus(dto.orderSupplierId, tx);
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const branch = await tx.branch.findUnique({
        where: { id: dto.branchId },
        select: { name: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PURCHASE_ORDER_CREATE',
        entityType: 'purchase_orders',
        entityId: purchaseOrder.id.toString(),
        entityCode: purchaseOrder.code,
        category: getCategoryFromActionCode('PURCHASE_ORDER_CREATE'),
        severity: getSeverityFromActionCode('PURCHASE_ORDER_CREATE'),
        snapshot: this.buildPurchaseOrderSnapshot(
          purchaseOrder,
          supplier?.name,
          branch?.name,
        ),
        message: renderAuditMessage('PURCHASE_ORDER_CREATE', {
          purchaseOrderCode: purchaseOrder.code,
          supplierName: supplier?.name || 'N/A',
        }),
        messageTemplate: 'PURCHASE_ORDER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: purchaseOrder.branchId || user?.branchId || undefined,
      });

      return tx.purchaseOrder.findUnique({
        where: { id: purchaseOrder.id },
        include: {
          orderSupplier: true,
          supplier: true,
          branch: true,
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          surcharges: true,
        },
      });
    });
  }

  /**
   * Tạo PurchaseOrder (PN) từ OrderSupplier (PDN).
   *
   * Mirror chính xác `invoices.service.ts:createFromOrder` ở phía bán:
   *   - Nếu là PN ĐẦU TIÊN của PDN: kế thừa toàn bộ tiền đã trả ở PDN
   *     (sum `OrderSupplierPayment.amount`) làm `paidAmount` của PN, đồng thời
   *     CLONE từng OrderSupplierPayment → PurchaseOrderPayment + tạo CashFlow
   *     MỚI prefix `PCTUPN{poCode}-N` (PC=chi, TU=tạm ứng).
   *   - CashFlow gốc của PDN (`PCPDN######`) GIỮ NGUYÊN làm single source.
   *     `recalcSupplierDebt` filter `NOT startsWith 'PCTUPN'` để tránh trừ đôi.
   *   - `additionalPayment` + `dto.payments[]`: tiền user trả THÊM khi tạo PN
   *     → tạo PurchaseOrderPayment + CashFlow prefix `PCPN######` (như flow
   *     create() bình thường).
   */
  async createFromOrderSupplier(
    orderSupplierId: number,
    dto: CreatePurchaseOrderFromOrderSupplierDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id: orderSupplierId },
        include: {
          items: true,
          payments: { where: { status: { not: 2 } } },
          purchaseOrders: {
            include: { items: true },
          },
          supplier: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
              address: true,
              debt: true,
            },
          },
        },
      });

      if (!orderSupplier) {
        throw new NotFoundException('Phiếu đặt hàng nhập không tồn tại');
      }
      if (orderSupplier.status === 4) {
        throw new BadRequestException(
          'Không thể tạo phiếu nhập từ phiếu đặt hàng đã hủy',
        );
      }
      if (orderSupplier.status === 3) {
        throw new BadRequestException('Phiếu đặt hàng đã hoàn thành');
      }

      const branchId =
        dto.branchId ?? orderSupplier.branchId ?? undefined;
      if (!branchId) {
        throw new BadRequestException(
          'Phiếu đặt hàng nhập không có thông tin chi nhánh',
        );
      }

      // Tính số đã nhận theo từng product qua các PN active (không phải DRAFT,
      // không phải CANCELLED) — đối xứng `invoicedQuantities` phía bán.
      const activePOs = orderSupplier.purchaseOrders.filter(
        (po: any) => !po.isDraft && po.status !== 2,
      );
      const receivedQuantities: Record<number, number> = {};
      activePOs.forEach((po: any) => {
        po.items.forEach((d: any) => {
          if (d.productId != null) {
            receivedQuantities[d.productId] =
              (receivedQuantities[d.productId] || 0) + Number(d.quantity);
          }
        });
      });

      const remainingItems = orderSupplier.items
        .map((item: any) => {
          const received = receivedQuantities[item.productId] || 0;
          const remaining = Number(item.quantity) - received;
          return { ...item, remainingQuantity: remaining };
        })
        .filter((item: any) => item.remainingQuantity > 0);

      if (remainingItems.length === 0) {
        throw new BadRequestException(
          'Tất cả sản phẩm trong phiếu đặt hàng đã được nhập',
        );
      }

      // Discount còn lại: PDN.discount − Σ PN.discount đã dùng (đối xứng
      // `remainingDiscount` phía bán). DTO có thể override nếu user nhập tay.
      const usedDiscount = activePOs.reduce(
        (sum: number, po: any) => sum + Number(po.discount),
        0,
      );
      const remainingDiscount =
        Number(orderSupplier.discount) - usedDiscount;
      const fallbackDiscount = remainingDiscount > 0 ? remainingDiscount : 0;

      const isFirstPN = activePOs.length === 0;

      // Tổng tiền đã trả ở PDN — chỉ kế thừa khi đây là PN ĐẦU TIÊN
      // (đối xứng `isFirstInvoice` phía bán).
      const totalPaidFromOrderSupplier = isFirstPN
        ? orderSupplier.payments.reduce(
            (sum: number, p: any) => sum + Number(p.amount),
            0,
          )
        : 0;

      // Đối xứng `invoices.service.ts:1541-1542`: `additionalPayment` là tổng
      // tiền user trả THÊM khi tạo PN (cached). `dto.payments` chỉ là metadata
      // chia phương thức để tạo PurchaseOrderPayment + CashFlow records — TỔNG
      // các phần tử trong `dto.payments` PHẢI BẰNG `additionalPayment` (FE
      // responsibility). Nếu user chỉ gửi 1 trong 2, tự suy ra cái còn lại.
      const additionalFromField = Number(dto.additionalPayment || 0);
      const additionalFromList = (dto.payments || []).reduce(
        (sum: number, p: any) => sum + Number(p.amount || 0),
        0,
      );
      const additionalPayment =
        additionalFromField > 0 ? additionalFromField : additionalFromList;
      const totalPaid = totalPaidFromOrderSupplier + additionalPayment;

      // Items: dùng dto.items nếu có, ngược lại fallback remainingItems.
      const itemsToReceive = (dto.items && dto.items.length > 0
        ? dto.items
        : remainingItems.map((item: any) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: item.productName,
            quantity: item.remainingQuantity,
            price: Number(item.price),
            discount: Number(item.discount) || 0,
            discountRatio: 0,
            totalPrice:
              (Number(item.price) - (Number(item.discount) || 0)) *
              item.remainingQuantity,
            description: item.description,
          }))) as any[];

      const itemsData = await Promise.all(
        itemsToReceive.map(async (item) => {
          // dto.items có sẵn productCode/productName, fallback nếu không có.
          let productCode = item.productCode;
          let productName = item.productName;
          if (!productCode || !productName) {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product) {
              throw new NotFoundException(
                `Product ${item.productId} not found`,
              );
            }
            productCode = productCode || product.code;
            productName = productName || product.name;
          }
          const totalPrice =
            item.totalPrice !== undefined
              ? Number(item.totalPrice)
              : (Number(item.price) - (Number(item.discount) || 0)) *
                Number(item.quantity);

          return {
            productId: item.productId,
            productCode,
            productName,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            discountRatio: item.discountRatio || 0,
            totalPrice,
            description: item.description,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );

      const dtoDiscountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : dto.discount !== undefined
          ? Number(dto.discount)
          : null;

      const discountAmount =
        dtoDiscountAmount !== null ? dtoDiscountAmount : fallbackDiscount;

      // Validate trùng với check trong create(): tổng discount của các PN của
      // PDN không được vượt PDN.discount.
      if (usedDiscount + discountAmount > Number(orderSupplier.discount)) {
        const available = Number(orderSupplier.discount) - usedDiscount;
        throw new BadRequestException(
          `Giảm giá vượt quá giới hạn. Còn có thể dùng: ${available}`,
        );
      }

      const subTotal = total - discountAmount;
      const debtAmount = subTotal - totalPaid;

      const supplierOldDebt = Number(orderSupplier.supplier?.debt || 0);

      const code = await this.generateSafePurchaseOrderCode(tx);

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          code,
          orderSupplierId: orderSupplier.id,
          supplierId: orderSupplier.supplierId,
          branchId,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          total,
          totalAmount: total,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          subTotal,
          paidAmount: totalPaid,
          debtAmount,
          status: dto.isDraft ? 0 : 1,
          statusValue: dto.isDraft ? 'Phiếu tạm' : 'Đã nhập hàng',
          supplierOldDebt,
          supplierDebt: debtAmount,
          isDraft: dto.isDraft || false,
          partnerType: dto.partnerType,
          description: dto.description,
          purchaseById: dto.purchaseById ?? orderSupplier.userId ?? undefined,
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          items: true,
        },
      });

      if (!dto.isDraft) {
        await this.updateInventory(purchaseOrder.id, tx);
      }

      // CLONE OrderSupplierPayment → PurchaseOrderPayment + CashFlow `PCTUPN`
      // (đối xứng phía bán: OrderPayment → InvoicePayment + CashFlow `TTTU`).
      // CashFlow gốc `PCPDN######` của PDN GIỮ NGUYÊN — `recalcSupplierDebt`
      // dùng filter `NOT startsWith 'PCTUPN'` để tránh trừ đôi.
      let cloneSeq = 0;
      if (
        isFirstPN &&
        totalPaidFromOrderSupplier > 0 &&
        !dto.isDraft
      ) {
        for (const osPayment of orderSupplier.payments) {
          cloneSeq++;
          const paymentCode = `PCTU${purchaseOrder.code}-${cloneSeq}`;

          await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId,
              cashFlowGroupId: 9,
              isReceipt: false,
              amount: osPayment.amount,
              transDate: osPayment.paymentDate,
              method: osPayment.paymentMethod || 'cash',
              accountId: osPayment.accountId ?? null,
              partnerType: 'S',
              partnerId: orderSupplier.supplierId,
              partnerName: orderSupplier.supplier?.name,
              contactNumber: orderSupplier.supplier?.contactNumber,
              address: orderSupplier.supplier?.address,
              description: `Chi tiền tạm ứng từ phiếu đặt hàng nhập ${orderSupplier.code} sang phiếu nhập ${purchaseOrder.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
            },
          });

          await tx.purchaseOrderPayment.create({
            data: {
              code: paymentCode,
              purchaseOrderId: purchaseOrder.id,
              amount: osPayment.amount,
              paymentDate: osPayment.paymentDate,
              paymentMethod: osPayment.paymentMethod || 'cash',
              accountId: osPayment.accountId ?? null,
              description: `Thanh toán từ phiếu đặt hàng nhập ${orderSupplier.code}`,
              status: 1,
              statusValue: 'Đã thanh toán',
            },
          });
        }
      }

      // Thanh toán THÊM khi tạo PN — tạo CashFlow + PurchaseOrderPayment với
      // prefix `PCPN######` chuẩn (đối xứng `TT{invoice.code}-N` phía bán).
      if (additionalPayment > 0 && !dto.isDraft) {
        const additionalPayments =
          dto.payments && dto.payments.length > 0
            ? dto.payments
            : [{ method: 'cash', amount: additionalPayment } as any];

        for (const payment of additionalPayments) {
          const amount = Number(payment.amount || 0);
          if (amount <= 0) continue;

          const paymentCode = await this.generatePCPNCode(tx);

          await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId,
              cashFlowGroupId: 9,
              isReceipt: false,
              amount,
              transDate: dto.purchaseDate
                ? new Date(dto.purchaseDate)
                : new Date(),
              method: payment.method || 'cash',
              accountId: (payment as any).accountId ?? null,
              partnerType: 'S',
              partnerId: orderSupplier.supplierId,
              partnerName: orderSupplier.supplier?.name,
              contactNumber: orderSupplier.supplier?.contactNumber,
              address: orderSupplier.supplier?.address,
              description: `Chi tiền nhập hàng ${purchaseOrder.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
            },
          });

          await tx.purchaseOrderPayment.create({
            data: {
              code: paymentCode,
              purchaseOrderId: purchaseOrder.id,
              amount,
              paymentDate: dto.purchaseDate
                ? new Date(dto.purchaseDate)
                : new Date(),
              paymentMethod: payment.method || 'cash',
              accountId: (payment as any).accountId ?? null,
              description: `Trả tiền nhập hàng ${purchaseOrder.code}`,
              status: 1,
              statusValue: 'Đã thanh toán',
            },
          });
        }
      }

      await this.updateSupplierDebt(orderSupplier.supplierId, tx);
      await this.updateOrderSupplierStatus(orderSupplier.id, tx);

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { name: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PURCHASE_ORDER_CREATE',
        entityType: 'purchase_orders',
        entityId: purchaseOrder.id.toString(),
        entityCode: purchaseOrder.code,
        category: getCategoryFromActionCode('PURCHASE_ORDER_CREATE'),
        severity: getSeverityFromActionCode('PURCHASE_ORDER_CREATE'),
        snapshot: this.buildPurchaseOrderSnapshot(
          purchaseOrder,
          orderSupplier.supplier?.name,
          branch?.name,
        ),
        message: renderAuditMessage('PURCHASE_ORDER_CREATE', {
          purchaseOrderCode: purchaseOrder.code,
          supplierName: orderSupplier.supplier?.name || 'N/A',
        }),
        messageTemplate: 'PURCHASE_ORDER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: purchaseOrder.branchId || user?.branchId || undefined,
      });

      return tx.purchaseOrder.findUnique({
        where: { id: purchaseOrder.id },
        include: {
          orderSupplier: true,
          supplier: true,
          branch: true,
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          surcharges: true,
        },
      });
    });
  }

  async findAll(query: PurchaseOrderQueryDto) {
    const {
      pageSize = 15,
      currentItem = 0,
      search,
      supplierId,
      branchId,
      createdById,
      purchaseById,
      createdDateFrom,
      createdDateTo,
      status,
    } = query;

    const where: any = {};

    if (search) {
      where.OR = [{ code: { contains: search, mode: 'insensitive' } }];
    }
    if (supplierId) where.supplierId = supplierId;
    if (branchId) where.branchId = branchId;
    if (createdById) where.createdBy = createdById;
    if (purchaseById) where.purchaseById = purchaseById;
    if (status !== undefined) where.status = status;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) where.createdAt.gte = new Date(createdDateFrom);
      if (createdDateTo) where.createdAt.lte = new Date(createdDateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          supplier: {
            select: { id: true, code: true, name: true, contactNumber: true },
          },
          orderSupplier: {
            select: {
              id: true,
              code: true,
            },
          },
          branch: { select: { id: true, name: true } },
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { data, total, pageSize, currentItem };
  }

  async findOne(id: number) {
    const purchaseOrder = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        orderSupplier: {
          select: {
            id: true,
            code: true,
          },
        },
        supplier: true,
        branch: true,
        purchaseBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: { include: { product: true } },
        payments: true,
        surcharges: true,
      },
    });

    if (!purchaseOrder) {
      throw new NotFoundException('Purchase order not found');
    }

    return purchaseOrder;
  }

  async update(id: number, dto: UpdatePurchaseOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!existing) {
        throw new NotFoundException('Purchase order not found');
      }

      if (existing.branchId) {
        await this.restoreInventory(id, tx);
      }

      if (dto.items) {
        await tx.purchaseOrderItem.deleteMany({
          where: { purchaseOrderId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new NotFoundException(
                `Product ${item.productId} not found`,
              );

            const totalPrice =
              (Number(item.price) - (Number(item.discount) || 0)) *
              Number(item.quantity);

            return {
              purchaseOrderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount || 0,
              discountRatio: item.discountRatio || 0,
              totalPrice,
              description: item.description,
            };
          }),
        );

        await tx.purchaseOrderItem.createMany({
          data: itemsData,
        });
      }

      const items = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: id },
      });

      const total = items.reduce(
        (sum, item) => sum + Number(item.totalPrice),
        0,
      );

      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : Number(dto.discount || 0);

      if (existing.orderSupplierId) {
        const linkedOrderSupplier = await tx.orderSupplier.findUnique({
          where: { id: existing.orderSupplierId },
          select: { discount: true },
        });
        if (linkedOrderSupplier) {
          const existingPOs = await tx.purchaseOrder.findMany({
            where: {
              orderSupplierId: existing.orderSupplierId,
              id: { not: id },
            },
            select: { discount: true },
          });
          const usedDiscount = existingPOs.reduce(
            (sum, po) => sum + Number(po.discount),
            0,
          );
          const maxDiscount = Number(linkedOrderSupplier.discount);
          if (usedDiscount + discountAmount > maxDiscount) {
            throw new BadRequestException(
              `Giảm giá vượt quá giới hạn. Còn có thể dùng: ${maxDiscount - usedDiscount}`,
            );
          }
        }
      }

      const subTotal = total - discountAmount;
      const paidAmount = Number(dto.paidAmount || existing.paidAmount);
      const debtAmount = subTotal - paidAmount;

      const updateData: any = {
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        total,
        discount: dto.discount,
        discountRatio: dto.discountRatio,
        paidAmount: dto.paidAmount,
        debtAmount,
        subTotal,
        partnerType: dto.partnerType,
        description: dto.description,
        purchaseById: dto.purchaseById,
      };

      if (dto.isDraft !== undefined) {
        updateData.isDraft = dto.isDraft;
        updateData.status = dto.isDraft ? 0 : 1;
        updateData.statusValue = dto.isDraft ? 'Phiếu tạm' : 'Đã nhập hàng';
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: updateData,
      });

      const branchId = dto.branchId || existing.branchId;
      if (branchId) {
        await this.updateInventory(id, tx);
      }

      await this.updateSupplierDebt(dto.supplierId || existing.supplierId, tx);
      if (dto.supplierId && dto.supplierId !== existing.supplierId) {
        await this.updateSupplierDebt(existing.supplierId, tx);
      }

      const orderSupplierId = existing.orderSupplierId;
      if (orderSupplierId) {
        await this.updateOrderSupplierStatus(orderSupplierId, tx);
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const supplierName = await tx.supplier.findUnique({
          where: { id: dto.supplierId },
          select: { name: true },
        });

        const updatedPO = await tx.purchaseOrder.findUnique({
          where: { id },
          include: {
            supplier: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } }, // THÊM
            items: true,
          },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PURCHASE_ORDER_UPDATE',
          entityType: 'purchase_orders',
          entityId: id.toString(),
          entityCode: updatedPO?.code || existing.code,
          category: getCategoryFromActionCode('PURCHASE_ORDER_UPDATE'),
          severity: getSeverityFromActionCode('PURCHASE_ORDER_UPDATE'),
          snapshot: this.buildPurchaseOrderSnapshot(
            updatedPO || existing,
            supplierName?.name,
            updatedPO?.branch?.name,
          ),
          message: renderAuditMessage('PURCHASE_ORDER_UPDATE', {
            purchaseOrderCode: updatedPO?.code || existing.code,
          }),
          messageTemplate: 'PURCHASE_ORDER_UPDATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId:
            updatedPO?.branchId ||
            existing.branchId ||
            user?.branchId ||
            undefined,
        });
      }

      return tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          orderSupplier: {
            select: {
              id: true,
              code: true,
            },
          },
          supplier: true,
          branch: true,
          purchaseBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          surcharges: true,
        },
      });
    });
  }

  async remove(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          items: true,
          branch: { select: { id: true, name: true } }, // THÊM
        },
      });

      if (!purchaseOrder) {
        throw new NotFoundException('Purchase order not found');
      }

      if (purchaseOrder.branchId) {
        await this.restoreInventory(id, tx);
      }

      await tx.purchaseOrder.delete({ where: { id } });
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        await this.auditLogsService.create({
          actionType: 'DELETE',
          actionCode: 'PURCHASE_ORDER_DELETE',
          entityType: 'purchase_orders',
          entityId: id.toString(),
          entityCode: purchaseOrder.code,
          category: getCategoryFromActionCode('PURCHASE_ORDER_DELETE'),
          severity: getSeverityFromActionCode('PURCHASE_ORDER_DELETE'),
          snapshot: this.buildPurchaseOrderSnapshot(
            purchaseOrder,
            undefined,
            purchaseOrder.branch?.name,
          ),
          message: renderAuditMessage('PURCHASE_ORDER_DELETE', {
            purchaseOrderCode: purchaseOrder.code,
          }),
          messageTemplate: 'PURCHASE_ORDER_DELETE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: purchaseOrder.branchId || user?.branchId || undefined,
        });
      }

      return { message: 'Xóa phiếu nhập hàng thành công' };
    });
  }

  private async updateOrderSupplierStatus(orderSupplierId: number, tx: any) {
    const orderSupplier = await tx.orderSupplier.findUnique({
      where: { id: orderSupplierId },
      include: { items: true },
    });

    if (!orderSupplier) return;

    const allPurchaseOrders = await tx.purchaseOrder.findMany({
      where: { orderSupplierId: orderSupplierId, isDraft: false },
      include: { items: true },
    });

    const receivedQuantities: { [productId: number]: number } = {};
    allPurchaseOrders.forEach((po) => {
      po.items.forEach((item) => {
        if (!receivedQuantities[item.productId]) {
          receivedQuantities[item.productId] = 0;
        }
        receivedQuantities[item.productId] += Number(item.quantity);
      });
    });

    let isFullyReceived = true;
    let hasPartialReceived = false;

    orderSupplier.items.forEach((orderItem) => {
      const receivedQty = receivedQuantities[orderItem.productId] || 0;
      const orderedQty = Number(orderItem.quantity);

      if (receivedQty < orderedQty) {
        isFullyReceived = false;
      }
      if (receivedQty > 0) {
        hasPartialReceived = true;
      }
    });

    if (!hasPartialReceived) return;

    let newStatus = orderSupplier.status;
    let newStatusValue = orderSupplier.statusValue;

    if (isFullyReceived) {
      newStatus = 3;
      newStatusValue = 'Hoàn thành';
    } else {
      newStatus = 2;
      newStatusValue = 'Nhập một phần';
    }

    await tx.orderSupplier.update({
      where: { id: orderSupplierId },
      data: {
        status: newStatus,
        statusValue: newStatusValue,
      },
    });
  }

  private async updateInventory(purchaseOrderId: number, tx: any) {
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        items: true,
        branch: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return;

    for (const item of purchaseOrder.items) {
      const invSnapshot = await tx.inventory.findFirst({
        where: { productId: item.productId, branchId: purchaseOrder.branchId },
      });

      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          onHand: { increment: Number(item.quantity) },
        },
      });

      await tx.inventoryLog.create({
        data: {
          productId: item.productId,
          productCode: item.productCode,
          productName: item.productName,
          branchId: purchaseOrder.branchId,
          branchName: purchaseOrder.branch?.name || '',
          transactionType: 'PURCHASE',
          refCode: purchaseOrder.code,
          refType: 'purchase_order',
          refId: purchaseOrder.id,
          quantity: Number(item.quantity),
          costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
          transactionPrice: Number(item.price),
          partnerId: purchaseOrder.supplierId,
          partnerName: purchaseOrder.supplier?.name || null,
        },
      });
    }
  }

  private async restoreInventory(purchaseOrderId: number, tx: any) {
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return;

    for (const item of purchaseOrder.items) {
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          onHand: { decrement: Number(item.quantity) },
        },
      });
    }
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }

  /**
   * Sinh mã PCPN###### duy nhất cho PurchaseOrderPayment + CashFlow đi kèm
   * khi PO được tạo với paidAmount > 0. Mirror với purchase-order-payments.service.
   */
  private async generatePCPNCode(tx: any): Promise<string> {
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

  private async generateSafePurchaseOrderCode(tx: any): Promise<string> {
    const prefix = 'PN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPurchaseOrders = await tx.purchaseOrder.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
      });

      const validCodes = allPurchaseOrders
        .map((po: any) => po.code)
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
      const exists = await tx.purchaseOrder.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu nhập hàng duy nhất');
  }

  private buildPurchaseOrderSnapshot(
    po: any,
    supplierName?: any,
    branchName?: string,
  ) {
    return {
      code: po.code,
      supplierId: po.supplierId,
      supplierName: supplierName,
      supplierDebt: po.supplierDebt,
      branchId: po.branchId,
      branchName: branchName || po.branch?.name, // THÊM
      total: Number(po.total || 0),
      discount: Number(po.discount || 0),
      paidAmount: Number(po.paidAmount || 0),
      isDraft: po.isDraft,
      orderSupplierId: po.orderSupplierId,
      items: (po.items || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        price: Number(item.price),
        discount: Number(item.discount || 0),
        totalPrice: Number(item.totalPrice),
      })),
    };
  }
}
