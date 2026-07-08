import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePurchaseOrderDto,
  CreatePurchaseOrderFromOrderSupplierDto,
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  CancelPurchaseOrderDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  async create(dto: CreatePurchaseOrderDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      // Cho phép user tự điền mã PN. Trim + check duplicate; nếu trống fallback
      // auto-generate (đối xứng `order-suppliers.service.resolveOrderSupplierCode`).
      const code = await this.resolvePurchaseOrderCode(tx, dto.code);

      const itemsData = await Promise.all(
        dto.items.map(async (item, index) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product)
            throw new NotFoundException(`Product ${item.productId} not found`);

          // FE có thể gửi sẵn `totalPrice` (số nguyên đã chốt) khi user nhập
          // trực tiếp ô Thành tiền. Khi đó lưu thẳng để tránh sai lệch do đơn
          // giá có 3 số thập phân (vd 333.333 * 3 = 999.999). Nếu không gửi,
          // fallback công thức (price - discount) * quantity.
          const totalPrice =
            item.totalPrice !== undefined && item.totalPrice !== null
              ? Number(item.totalPrice)
              : (Number(item.price) - (Number(item.discount) || 0)) *
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
            // Số thứ tự dòng (1, 2, 3...). Ưu tiên FE gửi sẵn (vd khi sửa
            // PN đã có), fallback generate theo index — đảm bảo unique key
            // (purchaseOrderId, lineNumber) luôn khác nhau trong cùng phiếu.
            lineNumber: item.lineNumber ?? index + 1,
            // Phân loại hàng: "normal" (mặc định) hoặc "damaged" (loại B).
            conditionType: item.conditionType || 'normal',
            factoryPrice: item.factoryPrice != null ? Number(item.factoryPrice) : null,
            factorySubTotal: item.factorySubTotal != null ? Number(item.factorySubTotal) : null,
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

      // Đối xứng `invoices.service.ts:583`: nếu có thanh toán mà chưa chọn
      // chi nhánh, throw thẳng. Tránh case PurchaseOrderPayment được tạo
      // nhưng CashFlow bỏ qua → recalcSupplierDebt sai.
      if (paidAmount > 0 && !dto.isDraft && !dto.branchId) {
        throw new BadRequestException(
          'Vui lòng chọn chi nhánh khi có thanh toán',
        );
      }

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
          // Mặc định VND + rate=1 khi tạo PN trực tiếp (không qua PDN).
          // Currency/exchangeRate chỉ được kế thừa khi tạo từ PDN có set.
          currency: dto.currency || 'VND',
          exchangeRate: dto.exchangeRate != null ? Number(dto.exchangeRate) : 1,
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

      // Semantic mới: chỉ "Hoàn thành" mới đụng tồn kho. PN tạo dạng "Phiếu
      // tạm" (isDraft=true) KHÔNG cộng tồn — chờ user chuyển sang Hoàn thành
      // qua màn edit thì mới cộng. Đối xứng `createFromOrderSupplier` đã có
      // sẵn check `!dto.isDraft` ở dưới.
      if (dto.branchId && !dto.isDraft) {
        const touched = await this.updateInventory(purchaseOrder.id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      // Đối xứng Invoice.create: paidAmount > 0 → tạo PurchaseOrderPayment
      // + CashFlow PCPN. Formula B đối xứng triệt để KH: cashflow là single
      // source cho mọi tiền, KHÔNG dùng po.paidAmount trong công thức.
      const cashFlowIdsToUpdate: number[] = [];
      if (paidAmount > 0 && !dto.isDraft && dto.branchId) {
        const paymentCode = await this.generatePCPNCode(tx);

        // Tạo CashFlow TRƯỚC để có id gán vào PurchaseOrderPayment.cashFlowId
        // (đối xứng pattern `invoice-payments.service.ts:78-99`).
        const cashFlow = await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: dto.branchId,
            cashFlowGroupId: 9,
            isReceipt: false,
            amount: paidAmount,
            transDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : new Date(),
            method: dto.paymentMethod || 'cash',
            accountId: dto.paymentAccountId ?? null,
            partnerType: 'S',
            partnerId: dto.supplierId,
            partnerName: supplier?.name,
            description: `Chi tiền nhập hàng ${purchaseOrder.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            supplierDebtSnapshot: null,
          },
        });
        cashFlowIdsToUpdate.push(cashFlow.id);

        await tx.purchaseOrderPayment.create({
          data: {
            code: paymentCode,
            purchaseOrderId: purchaseOrder.id,
            paymentDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : new Date(),
            amount: paidAmount,
            paymentMethod: dto.paymentMethod || 'cash',
            accountId: dto.paymentAccountId ?? null,
            description: `Trả tiền nhập hàng ${purchaseOrder.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
            cashFlowId: cashFlow.id,
            exchangeRate: dto.paymentExchangeRate != null ? Number(dto.paymentExchangeRate) : null,
            foreignAmount: dto.paymentForeignAmount != null ? Number(dto.paymentForeignAmount) : null,
          },
        });
      }

      await this.updateSupplierDebt(dto.supplierId, tx);

      // Update supplierDebtSnapshot trên cashflow vừa tạo, đối xứng
      // `invoices.service.ts:1845-1854` (cashFlow.updateMany sau recalc).
      if (cashFlowIdsToUpdate.length > 0) {
        const updatedSupplier = await tx.supplier.findUnique({
          where: { id: dto.supplierId },
          select: { debt: true },
        });
        await tx.cashFlow.updateMany({
          where: { id: { in: cashFlowIdsToUpdate } },
          data: {
            supplierDebtSnapshot: updatedSupplier
              ? Number(updatedSupplier.debt)
              : null,
          },
        });
      }

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

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
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
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction((tx) =>
      this.createOneFromOrderSupplierTx(
        tx,
        orderSupplierId,
        dto,
        userId,
        undefined,
        touchedProductIds,
      ),
    );

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  /**
   * Lõi tạo 1 PN từ PDN, nhận sẵn `tx` để gọi lặp trong cùng một transaction
   * (phục vụ luồng ghép xe: 1 xe → N PN). Hành vi giữ nguyên 100% so với bản
   * cũ — `createFromOrderSupplier` giờ chỉ là wrapper mở transaction.
   *
   * `vehicleShipmentId` (optional): gắn PN về phiếu ghép xe nguồn (Đường 2).
   * Đường 1 (gọi trực tiếp) truyền undefined → PN.vehicleShipmentId = null.
   */
  async createOneFromOrderSupplierTx(
    tx: any,
    orderSupplierId: number,
    dto: CreatePurchaseOrderFromOrderSupplierDto,
    userId: number,
    vehicleShipmentId?: number,
    touchedProductIds?: Set<number>,
  ) {
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

    const branchId = dto.branchId ?? orderSupplier.branchId ?? undefined;
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
    const remainingDiscount = Number(orderSupplier.discount) - usedDiscount;
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

    // Map productId → OrderSupplierItem để lookup factoryPrice/factorySubTotal
    // khi tạo PurchaseOrderItem từ PDN (kế thừa tỉ giá).
    const osItemByProductId = new Map<number, any>();
    for (const it of orderSupplier.items as any[]) {
      osItemByProductId.set(it.productId, it);
    }

    // Items: dùng dto.items nếu có, ngược lại fallback remainingItems.
    const itemsToReceive = (
      dto.items && dto.items.length > 0
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
            // Kế thừa factoryPrice/factorySubTotal từ OrderSupplierItem
            // tương ứng (nếu có). Khi dto.items không gửi thì BE vẫn có thể
            // điền từ remainingItems (đã spread factory* từ orderSupplier.items).
            factoryPrice:
              item.factoryPrice != null ? Number(item.factoryPrice) : null,
            factorySubTotal:
              item.factorySubTotal != null
                ? Number(item.factorySubTotal)
                : null,
          }))
    ) as any[];

    const itemsData = await Promise.all(
      itemsToReceive.map(async (item, index) => {
        // dto.items có sẵn productCode/productName, fallback nếu không có.
        let productCode = item.productCode;
        let productName = item.productName;
        if (!productCode || !productName) {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product) {
            throw new NotFoundException(`Product ${item.productId} not found`);
          }
          productCode = productCode || product.code;
          productName = productName || product.name;
        }
        const totalPrice =
          item.totalPrice !== undefined
            ? Number(item.totalPrice)
            : (Number(item.price) - (Number(item.discount) || 0)) *
              Number(item.quantity);

        // Kế thừa factoryPrice/factorySubTotal. Ưu tiên giá trị dto gửi
        // (nếu có), fallback lookup từ orderSupplier.items theo productId.
        // Nếu cả 2 đều không có → null (PN tạo trực tiếp).
        const osItem = osItemByProductId.get(item.productId);
        const factoryPrice =
          item.factoryPrice != null
            ? Number(item.factoryPrice)
            : osItem && osItem.factoryPrice != null
              ? Number(osItem.factoryPrice)
              : null;
        const factorySubTotal =
          item.factorySubTotal != null
            ? Number(item.factorySubTotal)
            : osItem && osItem.factorySubTotal != null
              ? Number(osItem.factorySubTotal)
              : null;

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
          // Tương tự create(): lineNumber ưu tiên FE gửi, fallback index+1.
          // Khi tạo PN từ PDN, items thường không gửi lineNumber nên BE tự
          // generate tuần tự 1, 2, 3...
          lineNumber: item.lineNumber ?? index + 1,
          // PDN không có phân loại hàng → mặc định "normal". Nếu FE muốn
          // đánh dấu hàng nào là loại B khi tạo từ PDN, gửi conditionType
          // trong dto.items[]. Hiện form FE chưa expose → luôn "normal".
          conditionType: item.conditionType || 'normal',
          // Kế thừa tỉ giá từ OrderSupplierItem.
          factoryPrice,
          factorySubTotal,
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

    // User được phép tự nhập mã PN khi tạo từ PDN (fromOSPayload.code).
    const code = await this.resolvePurchaseOrderCode(tx, dto.code);

    const purchaseOrder = await tx.purchaseOrder.create({
      data: {
        code,
        orderSupplierId: orderSupplier.id,
        supplierId: orderSupplier.supplierId,
        branchId,
        vehicleShipmentId: vehicleShipmentId ?? null,
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
        // Kế thừa currency/exchangeRate từ OrderSupplier (snapshot). PDN
        // có CNY thì PN sẽ giữ nguyên — không re-quy đổi.
        currency: orderSupplier.currency || 'VND',
        exchangeRate:
          orderSupplier.exchangeRate != null
            ? Number(orderSupplier.exchangeRate)
            : 1,
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
      const touched = await this.updateInventory(purchaseOrder.id, tx);
      if (touchedProductIds) {
        for (const productId of touched) touchedProductIds.add(productId);
      }
    }

    // CLONE OrderSupplierPayment → PurchaseOrderPayment + CashFlow `PCTUPN`
    // (đối xứng phía bán: OrderPayment → InvoicePayment + CashFlow `TTTU`).
    // CashFlow gốc `PCPDN######` của PDN GIỮ NGUYÊN — `recalcSupplierDebt`
    // dùng filter `NOT startsWith 'PCTUPN'` để tránh trừ đôi.
    const cashFlowIdsToUpdate: number[] = [];
    let cloneSeq = 0;
    if (isFirstPN && totalPaidFromOrderSupplier > 0 && !dto.isDraft) {
      for (const osPayment of orderSupplier.payments) {
        cloneSeq++;
        const paymentCode = `PCTU${purchaseOrder.code}-${cloneSeq}`;

        const cashFlow = await tx.cashFlow.create({
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
            supplierDebtSnapshot: null,
          },
        });
        cashFlowIdsToUpdate.push(cashFlow.id);

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
            cashFlowId: cashFlow.id,
            exchangeRate: osPayment.exchangeRate ?? null,
            foreignAmount: osPayment.foreignAmount ?? null,
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

        const cashFlow = await tx.cashFlow.create({
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
            accountId: payment.accountId ?? null,
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
            supplierDebtSnapshot: null,
          },
        });
        cashFlowIdsToUpdate.push(cashFlow.id);

        await tx.purchaseOrderPayment.create({
          data: {
            code: paymentCode,
            purchaseOrderId: purchaseOrder.id,
            amount,
            paymentDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : new Date(),
            paymentMethod: payment.method || 'cash',
            accountId: payment.accountId ?? null,
            description: `Trả tiền nhập hàng ${purchaseOrder.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
            cashFlowId: cashFlow.id,
            exchangeRate: payment.exchangeRate != null ? Number(payment.exchangeRate) : null,
            foreignAmount: payment.foreignAmount != null ? Number(payment.foreignAmount) : null,
          },
        });
      }
    }

    await this.updateSupplierDebt(orderSupplier.supplierId, tx);
    await this.updateOrderSupplierStatus(orderSupplier.id, tx);

    // Sau recalc, snapshot supplier debt vào các CashFlow vừa tạo (PCTUPN
    // clone + PCPN additional). Đối xứng `invoices.service.ts:1845-1854`.
    if (cashFlowIdsToUpdate.length > 0) {
      const updatedSupplier = await tx.supplier.findUnique({
        where: { id: orderSupplier.supplierId },
        select: { debt: true },
      });
      await tx.cashFlow.updateMany({
        where: { id: { in: cashFlowIdsToUpdate } },
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
  }

  /**
   * Dựng điều kiện `where` cho phiếu nhập hàng. Tách riêng để dùng chung giữa
   * findAll (danh sách) và export/export-detail, đảm bảo bộ lọc xuất file khớp
   * hoàn toàn với bộ lọc đang hiển thị.
   */
  private buildPurchaseOrderWhere(
    query: PurchaseOrderQueryDto,
    supplierScope?: number | null,
  ): any {
    const {
      search,
      supplierId,
      supplierIds,
      branchId,
      branchIds,
      createdById,
      purchaseById,
      createdDateFrom,
      createdDateTo,
      status,
    } = query;

    const where: any = {};

    if (search) {
      // Tìm theo mã phiếu, mã/đặt hàng nhập, tên/mã nhà cung cấp,
      // và tên/mã sản phẩm trong các dòng phiếu.
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { orderSupplier: { code: { contains: search, mode: 'insensitive' } } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
        { supplier: { code: { contains: search, mode: 'insensitive' } } },
        {
          items: {
            some: {
              OR: [
                { productName: { contains: search, mode: 'insensitive' } },
                { productCode: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }
    if (supplierIds && supplierIds.length > 0) {
      where.supplierId = { in: supplierIds };
    } else if (supplierId) {
      where.supplierId = supplierId;
    }
    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }
    if (createdById) where.createdBy = createdById;
    if (purchaseById) where.purchaseById = purchaseById;
    if (status !== undefined) where.status = status;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) where.createdAt.gte = new Date(createdDateFrom);
      if (createdDateTo) where.createdAt.lte = new Date(createdDateTo);
    }

    // Scope NCC: ép theo nhà cung cấp của user (ghi đè mọi supplierId từ query).
    if (supplierScope != null) where.supplierId = supplierScope;

    return where;
  }

  async findAll(query: PurchaseOrderQueryDto, supplierScope?: number | null) {
    const { pageSize = 15, currentItem = 0 } = query;

    const where = this.buildPurchaseOrderWhere(query, supplierScope);

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
          // Cần payments (chỉ bản ghi active status≠2) để FE quy đổi "Đã trả
          // NCC (CNY)" theo foreignAmount thật đã snapshot lúc thanh toán,
          // thay vì chia paidAmount(VND)/exchangeRate gốc của phiếu → lệch khi
          // tỉ giá thanh toán khác tỉ giá phiếu.
          payments: { where: { status: { not: 2 } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { data, total, pageSize, currentItem };
  }

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu nhập hàng = 1 dòng Excel. Bộ lọc dùng chung
   * buildPurchaseOrderWhere với danh sách.
   */
  async exportPurchaseOrders(
    query: PurchaseOrderQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildPurchaseOrderWhere(query, supplierScope);

    const STATUS_LABEL: Record<number, string> = {
      0: 'Phiếu tạm',
      1: 'Đã nhập hàng',
      2: 'Đã hủy',
    };

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Nhập hàng');

    sheet.columns = [
      { header: 'Mã nhập hàng', key: 'code', width: 18 },
      { header: 'Mã đặt hàng nhập', key: 'orderSupplierCode', width: 18 },
      { header: 'Thời gian', key: 'purchaseDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Nhà cung cấp', key: 'supplier', width: 24 },
      { header: 'Mã NCC', key: 'supplierCode', width: 14 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người nhập', key: 'purchaseBy', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Tổng số lượng', key: 'totalQuantity', width: 14 },
      { header: 'Số mặt hàng', key: 'totalGoods', width: 12 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Chi phí nhập trả NCC', key: 'totalAmount', width: 20 },
      { header: 'Đã trả NCC', key: 'paidAmount', width: 16 },
      { header: 'Cần trả NCC', key: 'debtAmount', width: 16 },
      { header: 'Trạng thái', key: 'status', width: 14 },
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

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.purchaseOrder.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          orderSupplier: { select: { code: true } },
          supplier: { select: { code: true, name: true } },
          branch: { select: { name: true } },
          purchaseBy: { select: { name: true } },
          creator: { select: { name: true } },
          items: { select: { quantity: true } },
        },
      });

      if (batch.length === 0) break;

      for (const po of batch) {
        const totalQuantity = po.items.reduce(
          (s, it) => s + Number(it.quantity),
          0,
        );
        const row = sheet.addRow({
          code: po.code,
          orderSupplierCode: po.orderSupplier?.code || '',
          purchaseDate: fmtDateTime(po.purchaseDate),
          createdAt: fmtDateTime(po.createdAt),
          supplier: po.supplier?.name || '',
          supplierCode: po.supplier?.code || '',
          branch: po.branch?.name || '',
          purchaseBy: po.purchaseBy?.name || '',
          createdBy: po.creator?.name || '',
          totalQuantity,
          totalGoods: po.items.length,
          discount: Number(po.discount) || 0,
          totalAmount: Number(po.totalAmount) || 0,
          paidAmount: Number(po.paidAmount) || 0,
          debtAmount: Number(po.debtAmount) || 0,
          status: STATUS_LABEL[po.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm
   * thông tin phiếu. Bộ lọc dùng chung buildPurchaseOrderWhere với export tổng
   * quan.
   */
  async exportPurchaseOrdersDetail(
    query: PurchaseOrderQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildPurchaseOrderWhere(query, supplierScope);

    const STATUS_LABEL: Record<number, string> = {
      0: 'Phiếu tạm',
      1: 'Đã nhập hàng',
      2: 'Đã hủy',
    };

    const CONDITION_LABEL: Record<string, string> = {
      normal: 'Hàng thường',
      damaged: 'Loại B',
    };

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết nhập hàng');

    sheet.columns = [
      { header: 'Mã nhập hàng', key: 'code', width: 18 },
      { header: 'Mã đặt hàng nhập', key: 'orderSupplierCode', width: 18 },
      { header: 'Thời gian', key: 'purchaseDate', width: 20 },
      { header: 'Nhà cung cấp', key: 'supplier', width: 24 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'Loại hàng', key: 'conditionType', width: 14 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Thành tiền', key: 'totalPrice', width: 16 },
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

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.purchaseOrder.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          orderSupplier: { select: { code: true } },
          supplier: { select: { name: true } },
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          items: { orderBy: { lineNumber: 'asc' } },
        },
      });

      if (batch.length === 0) break;

      for (const po of batch) {
        const base = {
          code: po.code,
          orderSupplierCode: po.orderSupplier?.code || '',
          purchaseDate: fmtDateTime(po.purchaseDate),
          supplier: po.supplier?.name || '',
          branch: po.branch?.name || '',
          createdBy: po.creator?.name || '',
          status: STATUS_LABEL[po.status] || '',
        };

        if (!po.items.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            conditionType: '',
            quantity: 0,
            price: 0,
            discount: 0,
            totalPrice: 0,
          });
          row.commit();
          continue;
        }

        for (const it of po.items) {
          const row = sheet.addRow({
            ...base,
            productCode: it.productCode || '',
            productName: it.productName || '',
            conditionType: CONDITION_LABEL[it.conditionType] || '',
            quantity: Number(it.quantity) || 0,
            price: Number(it.price) || 0,
            discount: Number(it.discount) || 0,
            totalPrice: Number(it.totalPrice) || 0,
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number, supplierScope?: number | null) {
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

    // Scope NCC: chặn nhân viên NCC xem phiếu của nhà cung cấp khác.
    if (supplierScope != null && purchaseOrder.supplierId !== supplierScope) {
      throw new ForbiddenException(
        'Không có quyền xem dữ liệu của nhà cung cấp khác',
      );
    }

    return purchaseOrder;
  }

  async update(id: number, dto: UpdatePurchaseOrderDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true, payments: true },
      });

      if (!existing) {
        throw new NotFoundException('Purchase order not found');
      }

      // ─── Đổi nhà cung cấp ───────────────────────────────────────────────
      // Khi user đổi NCC trên PN đã hoàn thành: PN trước đó đã phát sinh nợ
      // (subTotal) và có thể đã có CashFlow chi tiền cho NCC cũ. Để kế toán
      // đúng, phải: (1) ghi supplierId mới, (2) re-point mọi CashFlow + thông
      // tin partner sang NCC mới, (3) recalc nợ cả 2 NCC. Theo Formula B
      // (supplier-debt.util.ts), nợ phát sinh bám theo PO.supplierId còn tiền
      // đã trả bám theo cashFlow.partnerId — nên phải đồng bộ cả hai.
      //
      // Một số trường hợp bị CHẶN để tránh phá vỡ đối soát kế toán:
      //   - PN tạo từ phiếu đặt hàng nhập (orderSupplierId != null): tiền tạm
      //     ứng nằm ở CashFlow gốc của PDN (vẫn thuộc NCC của PDN). Đổi NCC
      //     riêng cho PN sẽ làm lệch PDN ↔ PN.
      //   - PN có phiếu trả hàng NCC active: SupplierReturn giữ supplierId
      //     riêng, đổi NCC của PN sẽ phá vỡ đối soát trả hàng.
      const SUPPLIER_RETURN_CANCELLED = 4;
      const supplierChanged =
        dto.supplierId !== undefined && dto.supplierId !== existing.supplierId;

      let newSupplier: {
        id: number;
        name: string | null;
        contactNumber: string | null;
        address: string | null;
        debt: any;
      } | null = null;

      if (supplierChanged) {
        if (existing.orderSupplierId) {
          throw new BadRequestException(
            'Phiếu nhập này được tạo từ phiếu đặt hàng nhập nên không thể đổi nhà cung cấp. Vui lòng hủy phiếu và tạo lại từ đúng nhà cung cấp.',
          );
        }

        const activeSupplierReturns = await tx.supplierReturn.count({
          where: {
            purchaseOrderId: id,
            status: { not: SUPPLIER_RETURN_CANCELLED },
          },
        });
        if (activeSupplierReturns > 0) {
          throw new BadRequestException(
            'Phiếu nhập này đã có phiếu trả hàng nhà cung cấp nên không thể đổi nhà cung cấp. Vui lòng xử lý/hủy các phiếu trả hàng liên quan trước.',
          );
        }

        newSupplier = await tx.supplier.findUnique({
          where: { id: dto.supplierId },
          select: {
            id: true,
            name: true,
            contactNumber: true,
            address: true,
            debt: true,
          },
        });
        if (!newSupplier) {
          throw new NotFoundException(
            `Nhà cung cấp ${dto.supplierId} không tồn tại`,
          );
        }
      }

      // ─── Semantic tồn kho theo isDraft ──────────────────────────────────
      // wasDraft  willBeDraft  hành vi tồn kho
      // ────────  ───────────  ──────────────────────────────────────────
      // true      true         giữ nguyên (tồn chưa bao giờ cộng)
      // true      false        cộng tồn theo SL mới (newQty)
      // false     true         rút SL cũ khỏi tồn — pre-check đủ tồn
      // false     false        delta = newQty - oldQty — pre-check phần giảm
      //
      // Với phân loại hàng (loại B = damaged): onHand chỉ chứa phần "normal";
      // phần "damaged" đi vào damagedQuantity. Khi user sửa:
      //   - Đổi 1 dòng từ "damaged" SL=5 sang "normal" SL=5:
      //     onHand phải đủ chỗ cho +5 (trừ đi 5 damagedQuantity cũ trước).
      //   - Đổi từ "normal" SL=5 sang "damaged" SL=5:
      //     onHand phải đủ chỗ để giảm -5; damagedQuantity phải đủ chỗ để cộng.
      //
      // Mọi pre-check đều xảy ra TRƯỚC khi thực thi. Nếu không pass, throw để
      // rollback transaction, tồn kho và DB không bị đụng vào.
      const wasDraft = existing.isDraft;
      const willBeDraft = dto.isDraft ?? existing.isDraft;
      const branchUnchanged =
        dto.branchId === undefined || dto.branchId === existing.branchId;

      // Helper: build map productId → { goodQty, damagedQty } từ list items.
      // Mỗi SP có thể xuất hiện nhiều dòng (cùng productId khác lineNumber);
      // cộng dồn từng dòng vào bucket tương ứng theo conditionType.
      const buildQtyMap = (items: any[]) => {
        const m = new Map<number, { goodQty: number; damagedQty: number }>();
        for (const it of items) {
          const existing2 = m.get(it.productId) || {
            goodQty: 0,
            damagedQty: 0,
          };
          const qty = Number(it.quantity) || 0;
          if (it.conditionType === 'damaged') {
            existing2.damagedQty += qty;
          } else {
            existing2.goodQty += qty;
          }
          m.set(it.productId, existing2);
        }
        return m;
      };

      const oldQtyMap = buildQtyMap(existing.items);

      // newQty tại existing.branchId: nếu user giữ branch thì lấy từ dto.items
      // (hoặc giữ nguyên existing nếu dto không gửi items); nếu đổi branch thì
      // tại branch cũ = 0 cho mọi product.
      const newQtyMap = (() => {
        if (!branchUnchanged)
          return new Map<number, { goodQty: number; damagedQty: number }>();
        if (dto.items) return buildQtyMap(dto.items);
        return oldQtyMap; // không gửi items, giữ nguyên
      })();

      // Tính danh sách (productId, decreaseOnHand, decreaseDamaged) cần pre-check tồn:
      //   - wasDraft=false, willBeDraft=true: rút toàn bộ oldQty (cả good + damaged).
      //   - wasDraft=false, willBeDraft=false: chỉ check phần giảm (delta âm)
      //     cho từng bucket riêng biệt.
      //   - wasDraft=true: tồn chưa cộng từ trước → không cần check.
      const productsToCheck: {
        productId: number;
        decreaseOnHand: number;
        decreaseDamaged: number;
      }[] = [];
      if (!wasDraft && existing.branchId) {
        const productIds = new Set<number>([
          ...oldQtyMap.keys(),
          ...newQtyMap.keys(),
        ]);
        for (const productId of productIds) {
          const oldQ = oldQtyMap.get(productId) || {
            goodQty: 0,
            damagedQty: 0,
          };
          const newQ = newQtyMap.get(productId) || {
            goodQty: 0,
            damagedQty: 0,
          };
          let decreaseOnHand = 0;
          let decreaseDamaged = 0;
          if (willBeDraft) {
            // Rút toàn bộ tồn cũ (cả 2 bucket).
            decreaseOnHand = oldQ.goodQty;
            decreaseDamaged = oldQ.damagedQty;
          } else {
            // Chỉ check phần giảm (delta âm) cho từng bucket.
            const deltaGood = newQ.goodQty - oldQ.goodQty;
            const deltaDamaged = newQ.damagedQty - oldQ.damagedQty;
            if (deltaGood < 0) decreaseOnHand = -deltaGood;
            if (deltaDamaged < 0) decreaseDamaged = -deltaDamaged;
          }
          if (decreaseOnHand > 0 || decreaseDamaged > 0) {
            productsToCheck.push({
              productId,
              decreaseOnHand,
              decreaseDamaged,
            });
          }
        }
      }

      if (productsToCheck.length > 0 && existing.branchId) {
        const inventories = await tx.inventory.findMany({
          where: {
            branchId: existing.branchId,
            productId: { in: productsToCheck.map((p) => p.productId) },
          },
          include: { product: { select: { code: true, name: true } } },
        });
        const invMap = new Map<number, any>();
        inventories.forEach((inv: any) => invMap.set(inv.productId, inv));

        const branch = await tx.branch.findUnique({
          where: { id: existing.branchId },
          select: { name: true },
        });

        for (const {
          productId,
          decreaseOnHand,
          decreaseDamaged,
        } of productsToCheck) {
          const inv = invMap.get(productId);
          const onHand = inv ? Number(inv.onHand) : 0;
          const damagedQuantity = inv ? Number(inv.damagedQuantity || 0) : 0;
          const productLabel = inv?.product
            ? `${inv.product.code} - ${inv.product.name}`
            : `productId=${productId}`;

          // Check bucket onHand riêng (không tính damaged vì bucket này là
          // phần "hàng thường" theo semantic mới — damaged đi vào bucket
          // riêng damagedQuantity).
          if (onHand < decreaseOnHand) {
            throw new BadRequestException(
              `Không thể giảm số lượng "${productLabel}" trong phiếu nhập: tồn kho hàng thường tại chi nhánh "${branch?.name || existing.branchId}" chỉ còn ${onHand}, không đủ để giảm ${decreaseOnHand}. Vui lòng xử lý các phiếu xuất/bán/chuyển kho liên quan trước.`,
            );
          }
          // Check bucket damagedQuantity riêng (nếu có giảm phần loại B).
          if (decreaseDamaged > 0 && damagedQuantity < decreaseDamaged) {
            throw new BadRequestException(
              `Không thể giảm số lượng loại B "${productLabel}" trong phiếu nhập: tồn kho loại B tại chi nhánh "${branch?.name || existing.branchId}" chỉ còn ${damagedQuantity}, không đủ để giảm ${decreaseDamaged}.`,
            );
          }
        }
      }

      // Restore tồn cũ chỉ khi PN trước đó đã cộng (wasDraft=false). Nếu
      // wasDraft=true thì tồn chưa từng cộng → bỏ qua restore.
      if (!wasDraft && existing.branchId) {
        const touched = await this.restoreInventory(id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
        // restoreInventory CHỈ hoàn lại onHand, KHÔNG xóa InventoryLog. Phải xóa
        // các log PURCHASE cũ của phiếu này trước khi updateInventory() ghi log
        // mới — nếu không thẻ kho sẽ cộng dồn log cũ + mới cùng refCode (vd sửa
        // phiếu đã hoàn thành làm số lượng hiển thị bị nhân đôi).
        await tx.inventoryLog.deleteMany({
          where: {
            refType: 'purchase_order',
            transactionType: 'PURCHASE',
            refId: id,
          },
        });
      }

      if (dto.items) {
        await tx.purchaseOrderItem.deleteMany({
          where: { purchaseOrderId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item, index) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new NotFoundException(
                `Product ${item.productId} not found`,
              );

            // Đối xứng create(): ưu tiên `totalPrice` FE gửi sẵn (số nguyên),
            // fallback công thức (price - discount) * quantity nếu không có.
            const totalPrice =
              item.totalPrice !== undefined && item.totalPrice !== null
                ? Number(item.totalPrice)
                : (Number(item.price) - (Number(item.discount) || 0)) *
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
              // Số thứ tự dòng (1, 2, 3...) — ưu tiên FE gửi sẵn, fallback
              // theo index. Đảm bảo unique key (purchaseOrderId, lineNumber)
              // không trùng trong cùng phiếu.
              lineNumber: item.lineNumber ?? index + 1,
              // Phân loại hàng: "normal" (mặc định) hoặc "damaged" (loại B).
              conditionType: item.conditionType || 'normal',
              factoryPrice: item.factoryPrice != null ? Number(item.factoryPrice) : null,
              factorySubTotal: item.factorySubTotal != null ? Number(item.factorySubTotal) : null,
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

      // Đối xứng `Order.calculateTotals` phía bán: KHÔNG trust `dto.paidAmount`.
      // Recompute từ active PurchaseOrderPayment (status≠2). Cache `paidAmount`
      // và `debtAmount` luôn khớp với CashFlow thực — single source of truth.
      const activePayments = await tx.purchaseOrderPayment.findMany({
        where: { purchaseOrderId: id, status: { not: 2 } },
        select: { amount: true },
      });
      const paidAmount = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );
      const debtAmount = subTotal - paidAmount;

      const updateData: any = {
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        total,
        totalAmount: total,
        discount: dto.discount,
        discountRatio: dto.discountRatio,
        paidAmount,
        debtAmount,
        subTotal,
        supplierDebt: debtAmount,
        partnerType: dto.partnerType,
        description: dto.description,
        purchaseById: dto.purchaseById,
        currency: dto.currency,
        exchangeRate: dto.exchangeRate != null ? Number(dto.exchangeRate) : undefined,
      };

      // Đổi NCC: ghi supplierId mới + cập nhật lại snapshot nợ đầu kỳ
      // (supplierOldDebt) theo nợ hiện tại của NCC mới TRƯỚC khi PN này được
      // cộng vào. Bug cũ: updateData thiếu hẳn supplierId nên dù FE gửi NCC
      // mới, DB vẫn giữ NCC cũ → recalc nợ vô nghĩa.
      if (supplierChanged && newSupplier) {
        updateData.supplierId = newSupplier.id;
        updateData.supplierOldDebt = Number(newSupplier.debt || 0);
      }

      // Cho phép user đổi mã PN khi update — đối xứng PDN/SX.
      // `dto.code === undefined`: giữ nguyên. Có giá trị: trim + check duplicate
      // (loại trừ chính phiếu này).
      if (dto.code !== undefined) {
        updateData.code = await this.resolvePurchaseOrderCode(tx, dto.code, id);
      }

      if (dto.isDraft !== undefined) {
        updateData.isDraft = dto.isDraft;
        updateData.status = dto.isDraft ? 0 : 1;
        updateData.statusValue = dto.isDraft ? 'Phiếu tạm' : 'Đã nhập hàng';
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: updateData,
      });

      // ─── Re-point CashFlow chi tiền sang NCC mới ────────────────────────
      // Các CashFlow (PCPN######, PCTU...) của PN này đang mang partnerId =
      // NCC cũ. Theo Formula B, tiền đã trả bám theo cashFlow.partnerId. Nếu
      // không chuyển, NCC cũ sẽ dư có (đã trả nhưng mất đơn mua) còn NCC mới
      // nợ phồng đúng phần đã trả. Re-point để nợ NCC mới = subTotal − đã_trả.
      const repointedCashFlowIds: number[] = [];
      if (supplierChanged && newSupplier) {
        const paymentCodes = (existing.payments || [])
          .map((p: any) => p.code)
          .filter((c: any): c is string => !!c);
        const explicitCashFlowIds = (existing.payments || [])
          .map((p: any) => p.cashFlowId)
          .filter((cid: any): cid is number => typeof cid === 'number');

        const orConditions: any[] = [];
        if (explicitCashFlowIds.length > 0) {
          orConditions.push({ id: { in: explicitCashFlowIds } });
        }
        if (paymentCodes.length > 0) {
          orConditions.push({ code: { in: paymentCodes } });
        }

        if (orConditions.length > 0) {
          const relatedCashFlows = await tx.cashFlow.findMany({
            where: {
              OR: orConditions,
              partnerType: 'S',
              partnerId: existing.supplierId,
            },
            select: { id: true },
          });
          const cashFlowIds = relatedCashFlows.map((cf: any) => cf.id);
          if (cashFlowIds.length > 0) {
            await tx.cashFlow.updateMany({
              where: { id: { in: cashFlowIds } },
              data: {
                partnerId: newSupplier.id,
                partnerName: newSupplier.name,
                contactNumber: newSupplier.contactNumber,
                address: newSupplier.address,
              },
            });
            repointedCashFlowIds.push(...cashFlowIds);
          }
        }
      }

      const branchId = dto.branchId || existing.branchId;
      // Apply tồn theo SL mới chỉ khi PN sau update là Hoàn thành (!willBeDraft).
      // PN chuyển sang/giữ Phiếu tạm → tồn không cộng (đã restore SL cũ ở trên
      // nếu wasDraft=false).
      if (branchId && !willBeDraft) {
        const touched = await this.updateInventory(id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      await this.updateSupplierDebt(dto.supplierId || existing.supplierId, tx);
      if (dto.supplierId && dto.supplierId !== existing.supplierId) {
        await this.updateSupplierDebt(existing.supplierId, tx);
      }

      // Sau khi đổi NCC: cập nhật snapshot nợ NCC mới lên các CashFlow vừa
      // re-point (để timeline NCC mới hiển thị đúng) và chuyển partner trên
      // thẻ kho (InventoryLog) sang NCC mới. Số lượng tồn KHÔNG đổi vì sản
      // phẩm và chi nhánh không thay đổi — chỉ đổi nhãn nhà cung cấp.
      if (supplierChanged && newSupplier) {
        if (repointedCashFlowIds.length > 0) {
          const updatedNewSupplier = await tx.supplier.findUnique({
            where: { id: newSupplier.id },
            select: { debt: true },
          });
          await tx.cashFlow.updateMany({
            where: { id: { in: repointedCashFlowIds } },
            data: {
              supplierDebtSnapshot: updatedNewSupplier
                ? Number(updatedNewSupplier.debt)
                : null,
            },
          });
        }

        await tx.inventoryLog.updateMany({
          where: {
            refType: 'purchase_order',
            transactionType: 'PURCHASE',
            refId: id,
          },
          data: {
            partnerId: newSupplier.id,
            partnerName: newSupplier.name,
          },
        });
      }

      // NGUỒN CHÂN LÝ: recalc onHand cho MỌI cặp (product, branch) bị đụng —
      // gồm sản phẩm cũ (có thể bị gỡ khỏi phiếu → log đã xóa) lẫn sản phẩm
      // mới, ở cả branch cũ lẫn branch mới (trường hợp đổi chi nhánh).
      // updateInventory() chỉ recalc item mới nên cần phủ thêm tại đây.
      {
        const affectedProductIds = new Set<number>([
          ...existing.items.map((it: any) => it.productId),
          ...(dto.items?.map((it) => it.productId) ?? []),
        ]);
        const affectedBranchIds = new Set<number>();
        if (existing.branchId) affectedBranchIds.add(existing.branchId);
        if (branchId) affectedBranchIds.add(branchId);

        const pairs: Array<{ productId: number; branchId: number }> = [];
        for (const bId of affectedBranchIds) {
          for (const pId of affectedProductIds) {
            pairs.push({ productId: pId, branchId: bId });
          }
        }
        await recalcOnHandForPairs(tx, pairs);
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

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async remove(id: number, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          items: true,
          payments: true,
          branch: { select: { id: true, name: true } },
        },
      });

      if (!purchaseOrder) {
        throw new NotFoundException('Purchase order not found');
      }

      // PN ở trạng thái Phiếu tạm (isDraft=true) chưa từng cộng tồn — không
      // cần rút khi xoá. Đối xứng `cancelPurchaseOrder` semantic mới.
      if (!purchaseOrder.isDraft && purchaseOrder.branchId) {
        const touched = await this.restoreInventory(id, tx);
        for (const productId of touched) touchedProductIds.add(productId);
      }

      // Soft-cancel mọi CashFlow liên quan tới PN này (PCPN######, PCTUPN...).
      // CashFlow KHÔNG có FK tới PurchaseOrder — chỉ link qua `code` hoặc qua
      // `PurchaseOrderPayment.cashFlowId` (sau Wave 2). Phải soft-cancel
      // CashFlow TRƯỚC khi delete PN (cascade sẽ xoá PurchaseOrderPayment).
      // Đối xứng `invoice-payments.service.ts:191-208`: ưu tiên match theo
      // FK `cashFlowId`, fallback `code`.
      const paymentCodes = (purchaseOrder.payments || [])
        .map((p: any) => p.code)
        .filter(Boolean);
      const explicitCashFlowIds = (purchaseOrder.payments || [])
        .map((p: any) => p.cashFlowId)
        .filter((id: any): id is number => typeof id === 'number');

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
            partnerId: purchaseOrder.supplierId,
            status: { not: 2 },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      const orderSupplierId = purchaseOrder.orderSupplierId;

      await tx.purchaseOrder.delete({ where: { id } });

      // NGUỒN CHÂN LÝ: sau khi xóa cứng PN, log PURCHASE trỏ refId này thành
      // inactive (PO không còn) → recalc đưa onHand về Σ log active.
      if (!purchaseOrder.isDraft && purchaseOrder.branchId) {
        await recalcOnHandForPairs(
          tx,
          purchaseOrder.items.map((item: any) => ({
            productId: item.productId,
            branchId: purchaseOrder.branchId,
          })),
        );
      }

      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      // Cập nhật trạng thái PDN nếu PN này thuộc PDN — đối xứng `update()` và
      // `create()` đều gọi `updateOrderSupplierStatus`. Đây là bước phía bán
      // gọi `updateOrderStatusByInvoices` khi cancel Invoice.
      if (orderSupplierId) {
        await this.updateOrderSupplierStatus(orderSupplierId, tx);
      }

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

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async cancelPurchaseOrder(
    id: number,
    dto: CancelPurchaseOrderDto,
    userId: number,
  ) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          items: true,
          payments: { where: { status: { not: 2 } } },
          supplier: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!purchaseOrder) {
        throw new NotFoundException('Không tìm thấy phiếu nhập hàng');
      }

      // status = 2 → đã hủy (đối xứng PURCHASE_ORDER_STATUS.CANCELLED)
      if (purchaseOrder.status === 2) {
        throw new BadRequestException('Phiếu nhập hàng đã được hủy trước đó');
      }

      // Khi PN có thanh toán active mà user KHÔNG xác nhận hủy thanh toán
      // → buộc user quyết định rõ (đối xứng cancelOrderSupplier).
      if (purchaseOrder.payments.length > 0 && !dto.cancelPayments) {
        throw new BadRequestException(
          'Phiếu nhập hàng có thanh toán. Hãy hủy thanh toán trước hoặc gửi cancelPayments=true để hủy luôn thanh toán',
        );
      }

      // ─── Hoàn nguyên kho an toàn ────────────────────────────────────────
      // KHÔNG dùng `decrement` blind: phải kiểm tra `onHand` và
      // `damagedQuantity` hiện tại của chi nhánh để không bao giờ làm tồn
      // kho âm. Nếu hàng đã được bán/ chuyển/hủy đi rồi thì không thể hủy
      // PN này được nữa — yêu cầu user xử lý các phiếu hậu kỳ trước.
      //
      // Với phân loại hàng (loại B = damaged): rollback đúng bucket theo
      // conditionType. onHand cho hàng thường, damagedQuantity cho hàng
      // bục rách. damagedQuantity ≤ onHand luôn được giữ vì khi tăng cả 2
      // đồng thời lúc tạo, lúc giảm cũng đồng thời theo cùng tỉ lệ.
      //
      // Lưu ý: PN ở trạng thái Phiếu tạm (isDraft=true) chưa từng cộng tồn
      // (semantic mới của create/update) → khi hủy không cần rút tồn ra.
      if (
        !purchaseOrder.isDraft &&
        purchaseOrder.branchId &&
        purchaseOrder.items.length > 0
      ) {
        const productIds = purchaseOrder.items.map((it: any) => it.productId);
        const inventories = await tx.inventory.findMany({
          where: {
            branchId: purchaseOrder.branchId,
            productId: { in: productIds },
          },
          include: { product: { select: { code: true, name: true } } },
        });
        const invMap = new Map<number, any>();
        inventories.forEach((inv: any) => invMap.set(inv.productId, inv));

        // Pre-check: tổng giảm tồn (cả 2 bucket) cho mỗi product phải đủ.
        // Cộng dồn vì 1 product có thể xuất hiện nhiều dòng (khác
        // conditionType) trong cùng phiếu.
        const totalDecrease = new Map<
          number,
          { onHand: number; damaged: number }
        >();
        for (const item of purchaseOrder.items) {
          const cur = totalDecrease.get(item.productId) || {
            onHand: 0,
            damaged: 0,
          };
          if (item.conditionType === 'damaged') {
            cur.damaged += Number(item.quantity);
          } else {
            cur.onHand += Number(item.quantity);
          }
          totalDecrease.set(item.productId, cur);
        }

        for (const [productId, decrease] of totalDecrease.entries()) {
          const inv = invMap.get(productId);
          const onHand = inv ? Number(inv.onHand) : 0;
          const damagedQuantity = inv ? Number(inv.damagedQuantity || 0) : 0;
          if (onHand < decrease.onHand) {
            const productLabel = inv?.product
              ? `${inv.product.code} - ${inv.product.name}`
              : `productId=${productId}`;
            throw new BadRequestException(
              `Không thể hủy phiếu nhập: tồn kho hàng thường của "${productLabel}" tại chi nhánh "${purchaseOrder.branch?.name || purchaseOrder.branchId}" chỉ còn ${onHand}, nhỏ hơn số đã nhập (${decrease.onHand}). Vui lòng xử lý các phiếu xuất/chuyển kho liên quan trước.`,
            );
          }
          if (decrease.damaged > 0 && damagedQuantity < decrease.damaged) {
            const productLabel = inv?.product
              ? `${inv.product.code} - ${inv.product.name}`
              : `productId=${productId}`;
            throw new BadRequestException(
              `Không thể hủy phiếu nhập: tồn kho loại B của "${productLabel}" tại chi nhánh "${purchaseOrder.branch?.name || purchaseOrder.branchId}" chỉ còn ${damagedQuantity}, nhỏ hơn số đã nhập (${decrease.damaged}).`,
            );
          }
        }

        // Apply: rollback đúng bucket theo từng dòng. Vì 1 product có thể có
        // nhiều dòng (cùng productId khác conditionType), dùng update nhiều
        // lần theo từng dòng cho khớp với logic cũ. Alternative: gộp
        // thành 1 updateMany với decrement theo tổng decrease — giữ vòng
        // lặp để dễ đọc và đối xứng với logic updateInventory.
        for (const item of purchaseOrder.items) {
          const inv = invMap.get(item.productId);
          if (!inv) continue;
          const qty = Number(item.quantity);
          if (item.conditionType === 'damaged') {
            await tx.inventory.update({
              where: { id: inv.id },
              data: { damagedQuantity: { decrement: qty } },
            });
          } else {
            await tx.inventory.update({
              where: { id: inv.id },
              data: { onHand: { decrement: qty } },
            });
            touchedProductIds.add(item.productId);
          }
        }
      }

      // ─── Soft-cancel payments + cashflow ───────────────────────────────
      if (dto.cancelPayments && purchaseOrder.payments.length > 0) {
        const paymentIds = purchaseOrder.payments.map((p: any) => p.id);
        const paymentCodes = purchaseOrder.payments
          .map((p: any) => p.code)
          .filter((c: any): c is string => !!c);
        const explicitCashFlowIds = purchaseOrder.payments
          .map((p: any) => p.cashFlowId)
          .filter((cid: any): cid is number => typeof cid === 'number');

        await tx.purchaseOrderPayment.updateMany({
          where: { id: { in: paymentIds } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });

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
              partnerId: purchaseOrder.supplierId,
              status: { not: 2 },
            },
            data: { status: 2, statusValue: 'Đã hủy' },
          });
        }
      }

      // ─── Update PN sang CANCELLED ──────────────────────────────────────
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: 2,
          statusValue: 'Đã hủy',
          isDraft: false,
          ...(dto.cancelPayments
            ? { paidAmount: 0, debtAmount: 0, supplierDebt: 0 }
            : { supplierDebt: 0 }),
        },
      });

      // Recalc Supplier.debt — filter status≠2 tự loại PN/payment vừa hủy.
      await this.updateSupplierDebt(purchaseOrder.supplierId, tx);

      // NGUỒN CHÂN LÝ: PN status=2 → log PURCHASE rớt khỏi Σ active. Recalc
      // onHand cho mọi sản phẩm của phiếu (chỉ khi PN từng cộng tồn).
      if (!purchaseOrder.isDraft && purchaseOrder.branchId) {
        await recalcOnHandForPairs(
          tx,
          purchaseOrder.items.map((item: any) => ({
            productId: item.productId,
            branchId: purchaseOrder.branchId,
          })),
        );
      }

      // Cập nhật trạng thái PDN nếu PN này thuộc PDN.
      if (purchaseOrder.orderSupplierId) {
        await this.updateOrderSupplierStatus(purchaseOrder.orderSupplierId, tx);
      }

      // Nếu PN sinh từ phiếu ghép xe: khi xe không còn PN active nào → đưa xe
      // về "Đã xác nhận giao" (1) để có thể tạo lại phiếu nhập.
      if (purchaseOrder.vehicleShipmentId) {
        const remainingActivePOs = await tx.purchaseOrder.count({
          where: {
            vehicleShipmentId: purchaseOrder.vehicleShipmentId,
            status: { not: 2 },
          },
        });
        if (remainingActivePOs === 0) {
          const shipment = await tx.vehicleShipment.findUnique({
            where: { id: purchaseOrder.vehicleShipmentId },
            select: { status: true },
          });
          if (shipment && shipment.status === 2) {
            await tx.vehicleShipment.update({
              where: { id: purchaseOrder.vehicleShipmentId },
              data: { status: 1, statusValue: 'Đã xác nhận giao' },
            });
          }
        }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'PURCHASE_ORDER_CANCEL',
        entityType: 'purchase_orders',
        entityId: id.toString(),
        entityCode: purchaseOrder.code,
        category: getCategoryFromActionCode('PURCHASE_ORDER_CANCEL'),
        severity: getSeverityFromActionCode('PURCHASE_ORDER_CANCEL'),
        snapshot: this.buildPurchaseOrderSnapshot(
          purchaseOrder,
          purchaseOrder.supplier?.name,
          purchaseOrder.branch?.name,
        ),
        message: renderAuditMessage('PURCHASE_ORDER_CANCEL', {
          purchaseOrderCode: purchaseOrder.code,
          supplierName: purchaseOrder.supplier?.name || 'N/A',
        }),
        messageTemplate: 'PURCHASE_ORDER_CANCEL',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: purchaseOrder.branchId || user?.branchId || undefined,
      });

      return { message: 'Hủy phiếu nhập hàng thành công' };
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  private async updateOrderSupplierStatus(orderSupplierId: number, tx: any) {
    const orderSupplier = await tx.orderSupplier.findUnique({
      where: { id: orderSupplierId },
      include: { items: true },
    });

    if (!orderSupplier) return;

    // PDN đã được chốt Hoàn thành thủ công (toComplete=true) hoặc đã ở trạng
    // thái Hoàn thành (3): KHÔNG hạ cấp về "Nhập một phần" khi có PN mới/bị hủy.
    if (orderSupplier.toComplete || orderSupplier.status === 3) {
      return;
    }

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

  private async updateInventory(
    purchaseOrderId: number,
    tx: any,
  ): Promise<Set<number>> {
    const touched = new Set<number>();
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        items: true,
        branch: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return touched;

    for (const item of purchaseOrder.items) {
      const qty = Number(item.quantity);
      // Phân chia quantity theo conditionType:
      //   - "normal" → goodQty cộng vào Inventory.onHand
      //   - "damaged" (loại B) → damagedQty cộng vào Inventory.damagedQuantity
      // Phần damaged vẫn nằm trong tổng tồn (onHand tăng đúng qty), nhưng
      // damagedQuantity là bucket phụ đánh dấu bao nhiêu trong tổng là
      // bục rách. Quy ước: damagedQuantity ≤ onHand luôn được validate ở
      // inventories.service.ts:226-230 và ở pre-check update() phía trên.
      const isDamaged = item.conditionType === 'damaged';
      const goodQty = isDamaged ? 0 : qty;
      const damagedQty = isDamaged ? qty : 0;

      const invSnapshot = await tx.inventory.findFirst({
        where: { productId: item.productId, branchId: purchaseOrder.branchId },
      });

      // TỒN KHO: cộng goodQty vào onHand, cộng damagedQty vào damagedQuantity.
      // Nếu damagedQty = 0, conditional spread bỏ qua field damagedQuantity
      // (giữ nguyên giá trị cũ). Tương tự cho onHand.
      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          ...(goodQty > 0 && { onHand: { increment: goodQty } }),
          ...(damagedQty > 0 && {
            damagedQuantity: { increment: damagedQty },
          }),
        },
      });
      if (goodQty > 0) touched.add(item.productId);

      // THẺ KHO: giữ convention 1 row = 1 log, ghi tổng quantity (cả good +
      // damaged) như cũ. Nếu là dòng loại B, gắn tag note để truy vết khi
      // xem thẻ kho.
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
          quantity: qty,
          costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
          transactionPrice: Number(item.price),
          partnerId: purchaseOrder.supplierId,
          partnerName: purchaseOrder.supplier?.name || null,
          // Neo thẻ kho theo ngày nhập hàng (purchaseDate), KHÔNG để default
          // now(). Nếu không, mỗi lần sửa/nhận lại phiếu sẽ tạo log mới mang
          // thời điểm hiện tại → thẻ kho hiển thị sai timeline (vd phiếu lùi
          // ngày bị nhảy lên ngày sửa).
          transactionDate: purchaseOrder.purchaseDate,
          note: isDamaged ? 'Hàng loại B' : null,
        },
      });
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active sau khi đã ghi log PURCHASE.
    await recalcOnHandForPairs(
      tx,
      purchaseOrder.items.map((item: any) => ({
        productId: item.productId,
        branchId: purchaseOrder.branchId,
      })),
    );
    return touched;
  }

  private async restoreInventory(
    purchaseOrderId: number,
    tx: any,
  ): Promise<Set<number>> {
    const touched = new Set<number>();
    const purchaseOrder = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });

    if (!purchaseOrder || !purchaseOrder.branchId) return touched;

    for (const item of purchaseOrder.items) {
      const qty = Number(item.quantity);
      // Rollback đúng bucket theo conditionType:
      //   - "damaged" (loại B) → giảm damagedQuantity
      //   - "normal" → giảm onHand
      // Tương ứng với logic updateInventory() phía trên để revert chính xác.
      const isDamaged = item.conditionType === 'damaged';

      await tx.inventory.updateMany({
        where: {
          productId: item.productId,
          branchId: purchaseOrder.branchId,
        },
        data: {
          ...(isDamaged
            ? { damagedQuantity: { decrement: qty } }
            : { onHand: { decrement: qty } }),
        },
      });
      if (!isDamaged) touched.add(item.productId);
    }
    // LƯU Ý: KHÔNG recalc ở đây. restoreInventory được gọi khi log PURCHASE
    // CÒN active (update flow xóa log SAU; cancel set status=2 SAU). Recalc tại
    // đây sẽ cộng lại quantity sai. Recalc được đặt ở từng call site, SAU khi
    // log đã xóa / PN đã status=2.
    return touched;
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

  /**
   * Resolve mã PN cho create / createFromOrderSupplier / update:
   *   - Có `userCode` (sau trim, khác rỗng): kiểm duplicate trên
   *     `PurchaseOrder.code`. `excludeId` để bỏ qua chính phiếu đang update.
   *   - Không có / rỗng: auto-generate qua `generateSafePurchaseOrderCode`.
   *
   * Đối xứng `OrderSuppliersService.resolveOrderSupplierCode`. Dùng chung cho
   * cả 3 path tạo/sửa PN để logic nhập mã thủ công nhất quán.
   */
  private async resolvePurchaseOrderCode(
    tx: any,
    userCode?: string,
    excludeId?: number,
  ): Promise<string> {
    const trimmed = (userCode || '').trim();
    if (!trimmed) {
      return this.generateSafePurchaseOrderCode(tx);
    }

    const duplicate = await tx.purchaseOrder.findFirst({
      where: {
        code: trimmed,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new BadRequestException(
        `Mã phiếu nhập hàng "${trimmed}" đã tồn tại. Vui lòng nhập mã khác hoặc để trống để hệ thống tự sinh.`,
      );
    }

    return trimmed;
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
        // Thêm 2 field mới để audit log hiển thị rõ dòng nào là loại B
        // và số thứ tự dòng. Khi mở rộng truy vết kế toán, có thể filter
        // theo conditionType để thống kê tổng hàng loại B theo thời gian.
        lineNumber: item.lineNumber ?? null,
        conditionType: item.conditionType || 'normal',
      })),
    };
  }
}
