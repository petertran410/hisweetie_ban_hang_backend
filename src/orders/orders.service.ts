import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import { OrderItemDto, AppliedPromotionDto } from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
  ORDER_STATUS,
} from './dto/order-status.constants';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PriceBooksService } from '../price-books/price-books.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges, buildItemChanges } from '../audit-logs/audit-diff.utils';
import { INVOICE_STATUS } from 'src/invoices/dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { resolveDeliveryAddress } from '../common/address-resolver.util';
import { LarkOrderSyncService } from 'src/lark-sync/services/lark-order-sync.service';
import { LarkOrderNotificationService } from 'src/lark-sync/services/lark-order-notification.service';
import { recalcCustomerDebt } from 'src/common/customer-debt.util';
import { searchCustomerIds } from '../common/customer-search.util';
import { PromotionsService } from '../promotions/promotions.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private priceBooksService: PriceBooksService,
    private auditLogsService: AuditLogsService,
    private larkOrderSync: LarkOrderSyncService,
    private larkOrderNotification: LarkOrderNotificationService,
    private promotionsService: PromotionsService,
  ) {}

  /**
   * Re-validate khuyến mãi cho đơn hàng (mirror InvoicesService.processPromotions).
   * - Bỏ dòng gift do engine sinh (có promotionId), giữ gift thủ công.
   * - BE tự sinh lại dòng gift từ engine (authoritative), cộng discount dòng,
   *   validate discounted_buy, cộng extraDiscount cấp đơn.
   * Trả về { effectiveItems (shape OrderItemDto), extraDiscount, logs }.
   */
  /**
   * Dựng danh sách dòng quà từ lựa chọn thu ngân cho KM requiresChoice.
   * - Cộng dồn (choice.rewardSelections): phân bổ theo suất; tổng suất ≤ r.rewardTimes.
   * - Single choice (choice.giftProductId): 1 SP nhận toàn bộ rewardQuantity (legacy).
   * Mọi SP quà phải thuộc rewardOptions, cap theo opt.remaining.
   *
   * Đơn vị: qty tính theo đơn vị CT (gói với unit, thùng với carton). Trước khi
   * ghi dòng, quy về GÓI thực tế: carton → qty × opt.conversionValue (số gói/thùng
   * của SP quà) để lưu/kho đúng số lượng bán lẻ.
   */
  private resolveChoiceGiftLines(r: any, choice: any, perTime: number): any[] {
    if (!choice) return [];
    const optOf = (productId: number) =>
      (r.rewardOptions || []).find((o: any) => o.productId === productId);
    // carton: số thùng → số gói theo conversionValue của SP quà. unit: giữ gói.
    const isCarton = r.unitMode === 'carton';
    const toGoi = (qtyThung: number, opt: any) =>
      isCarton
        ? Math.round(qtyThung * Number(opt?.conversionValue || 1))
        : qtyThung;

    if (
      Array.isArray(choice.rewardSelections) &&
      choice.rewardSelections.length
    ) {
      const totalTimes = Number(r.rewardTimes || 0);
      const requestedTimes = choice.rewardSelections.reduce(
        (s: number, sel: any) => s + Number(sel.rewardTimes || 0),
        0,
      );
      if (requestedTimes > totalTimes) {
        throw new BadRequestException(
          `PROMOTION_CHANGED: số suất quà đã chọn (${requestedTimes}) vượt số suất đạt được (${totalTimes}) của chương trình "${r.name}"`,
        );
      }
      const lines: any[] = [];
      for (const sel of choice.rewardSelections) {
        const times = Number(sel.rewardTimes || 0);
        if (times <= 0) continue;
        const opt = optOf(sel.productId);
        if (!opt) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: sản phẩm tặng đã chọn không thuộc chương trình "${r.name}"`,
          );
        }
        let qty = times * perTime; // đơn vị CT (gói/thùng)
        if (opt.remaining != null) qty = Math.min(qty, Number(opt.remaining));
        // Quy về gói thực tế trước khi lưu dòng quà.
        const qtyGoi = toGoi(qty, opt);
        if (qtyGoi <= 0) continue;
        lines.push({
          productId: opt.productId,
          productName: opt.productName,
          quantity: qtyGoi,
          price: 0,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
        });
      }
      return lines;
    }

    if (choice.giftProductId) {
      const opt = optOf(choice.giftProductId);
      if (!opt) {
        throw new BadRequestException(
          `PROMOTION_CHANGED: sản phẩm tặng đã chọn không thuộc chương trình "${r.name}"`,
        );
      }
      let qty = Math.min(
        Number(choice.giftQuantity || r.rewardQuantity),
        Number(r.rewardQuantity),
      );
      if (opt.remaining != null) qty = Math.min(qty, Number(opt.remaining));
      const qtyGoi = toGoi(qty, opt);
      if (qtyGoi <= 0) return [];
      return [
        {
          productId: opt.productId,
          productName: opt.productName,
          quantity: qtyGoi,
          price: 0,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
        },
      ];
    }

    return [];
  }

  private async processOrderPromotions(
    tx: any,
    dto: { items: OrderItemDto[] } & {
      branchId?: number;
      customerId?: number;
      soldById?: number;
      orderDate?: string;
      skipPromotions?: boolean;
      appliedPromotions?: AppliedPromotionDto[];
      appliedPromotionIds?: number[];
    },
  ): Promise<{
    effectiveItems: OrderItemDto[];
    extraDiscount: number;
    logs: any[];
  }> {
    const baseItems: OrderItemDto[] = dto.items
      .filter(
        (it) => (it.lineType || 'normal') !== 'gift' || it.promotionId == null,
      )
      .map((it) => {
        const lineType = it.lineType || 'normal';
        const manualGift = lineType === 'gift' && it.promotionId == null;
        const derivedNormalStamp = lineType === 'normal';
        return {
          productId: it.productId,
          quantity: Number(it.quantity),
          unitPrice: manualGift ? 0 : Number(it.unitPrice),
          discount: manualGift ? 0 : Number(it.discount || 0),
          discountRatio: Number(it.discountRatio || 0),
          note: it.note,
          serialNumbers: it.serialNumbers,
          conditionType: it.conditionType || 'normal',
          soldExpiryDate: it.soldExpiryDate ?? null,
          lineType: manualGift ? 'gift' : it.lineType || 'normal',
          isGift: manualGift,
          promotionId: derivedNormalStamp ? null : (it.promotionId ?? null),
          triggerProductId: it.triggerProductId,
          enabledPromotionIds: it.enabledPromotionIds,
        } as OrderItemDto;
      });

    if (dto.skipPromotions || !dto.branchId) {
      return { effectiveItems: baseItems, extraDiscount: 0, logs: [] };
    }

    const choiceKey = (promotionId: number, triggerProductId?: number | null) =>
      `${promotionId}:${triggerProductId ?? ''}`;
    const choiceMap: Record<string, any> = {};
    (dto.appliedPromotions ?? []).forEach((c) => {
      choiceMap[choiceKey(c.promotionId, c.triggerProductId)] = c;
    });
    const appliedIds =
      dto.appliedPromotions && dto.appliedPromotions.length > 0
        ? dto.appliedPromotions.map((c) => c.promotionId)
        : (dto.appliedPromotionIds ?? []);

    // Engine chạy trên dòng thường (không tính discounted_buy vào điều kiện mua-thưởng).
    // Chỉ hàng loại tồn 'normal' mới được hưởng/tính vào ngưỡng KM — hàng bục rách
    // (damaged) và cận date (near_expiry) LOẠI khỏi engine (không tính ngưỡng, không sinh quà).
    const engineItems = baseItems
      .filter(
        (it) =>
          (it.lineType || 'normal') === 'normal' &&
          (it.conditionType || 'normal') === 'normal',
      )
      .map((it) => ({
        productId: it.productId,
        quantity: Number(it.quantity),
        price: Number(it.unitPrice),
        discount: Number(it.discount || 0),
        enabledPromotionIds: it.enabledPromotionIds,
      }));

    const evalResult = await this.promotionsService.evaluateForInvoice({
      branchId: dto.branchId,
      customerId: dto.customerId ?? null,
      userId: dto.soldById ?? null,
      purchaseDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
      items: engineItems,
      appliedPromotionIds: appliedIds,
    });

    const applied = (evalResult as any).applied as any[];
    let extraDiscount = 0;
    const logs: any[] = [];

    // Resolve giftLines hiệu dụng cho từng KM
    const resolvedGifts: Record<string, any[]> = {};
    for (const r of applied) {
      const resultKey = choiceKey(r.promotionId, r.triggerProductId);
      let giftLines = r.giftLines as any[];
      if (
        (r.type === 'BUY_X_GET_Y' || r.type === 'BUY_N_GET_M_SAME') &&
        r.requiresChoice
      ) {
        const choice =
          choiceMap[resultKey] || choiceMap[choiceKey(r.promotionId)];
        const perTime =
          r.rewardTimes && r.rewardTimes > 0
            ? Number(r.rewardQuantity) / Number(r.rewardTimes)
            : Number(r.rewardQuantity);
        giftLines = this.resolveChoiceGiftLines(r, choice, perTime);
      }
      resolvedGifts[resultKey] = giftLines.map((g: any) => ({
        ...g,
        triggerProductId: r.triggerProductId,
      }));
    }

    const giftProductIds = Object.values(resolvedGifts)
      .flat()
      .map((g: any) => g.productId);
    const giftCosts = giftProductIds.length
      ? await tx.inventory.findMany({
          where: { branchId: dto.branchId, productId: { in: giftProductIds } },
          select: { productId: true, cost: true },
        })
      : [];
    const costMap: Record<number, number> = {};
    giftCosts.forEach((c) => (costMap[c.productId] = Number(c.cost)));

    for (const r of applied) {
      const resultKey = choiceKey(r.promotionId, r.triggerProductId);
      // 1) Giảm giá đơn hàng (INVOICE_DISCOUNT)
      // Defense-in-depth: nếu KM không autoApply và user chưa chọn → bỏ qua,
      // dù filter ở promotions.service có lọt thì đây vẫn chặn.
      if (r.type === 'INVOICE_DISCOUNT') {
        if (r.autoApply !== false || appliedIds.includes(r.promotionId)) {
          extraDiscount += Number(r.discountAmount);
        }
      }

      // 2) Giảm giá dòng (PRODUCT/CATEGORY_DISCOUNT)
      for (const dl of r.discountLines) {
        const target = baseItems.find(
          (it) =>
            it.productId === dl.productId &&
            (it.lineType || 'normal') === 'normal' &&
            (it.conditionType || 'normal') === 'normal',
        );
        if (target) {
          target.discount =
            Number(target.discount || 0) + Number(dl.perUnitDiscount);
          target.lineType = 'promo_discount';
          target.promotionId = r.promotionId;
        }
      }

      // 2b) Gắn promotionId lên dòng X (hàng mua điều kiện) để thống kê.
      // GIỮ lineType='normal' — đây là hàng bán giá thường, KHÔNG phải hàng KM.
      const matchedIds: number[] = r.triggerProductId
        ? [r.triggerProductId]
        : r.matchedProductIds || [];
      if (matchedIds.length) {
        for (const it of baseItems) {
          if (
            (it.lineType || 'normal') === 'normal' &&
            (it.conditionType || 'normal') === 'normal' &&
            it.promotionId == null &&
            matchedIds.includes(it.productId)
          ) {
            it.promotionId = r.promotionId;
          }
        }
      }

      // 3) Hàng tặng (BE tự sinh dòng giá 0)
      const giftLines = resolvedGifts[resultKey] || [];
      for (const g of giftLines) {
        baseItems.push({
          productId: g.productId,
          quantity: Number(g.quantity),
          unitPrice: 0,
          discount: 0,
          discountRatio: 0,
          note: undefined,
          serialNumbers: undefined,
          conditionType: 'normal',
          lineType: 'gift',
          isGift: true,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
        } as OrderItemDto);
      }

      // 4) Validate dòng mua kèm giá KM (discounted_buy) do FE gửi
      const allowedBuyIds: number[] =
        r.requiresChoice && r.type === 'BUY_X_BUY_Y_PRICE'
          ? (r.rewardOptions || []).map((o: any) => o.productId)
          : (r.discountedBuyLines || []).map((d: any) => d.productId);
      const baseBuyQty =
        r.rewardQuantity != null
          ? Number(r.rewardQuantity)
          : (r.discountedBuyLines?.[0]?.maxQuantity ?? 0);
      const isCartonBuy = r.unitMode === 'carton';
      for (const feLine of baseItems.filter(
        (it) =>
          (it.lineType || 'normal') === 'discounted_buy' &&
          it.promotionId === r.promotionId &&
          (it.triggerProductId == null ||
            it.triggerProductId === r.triggerProductId),
      )) {
        if (!allowedBuyIds.includes(feLine.productId)) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: sản phẩm mua kèm không thuộc chương trình "${r.name}"`,
          );
        }
        // Cap theo suất còn lại (lifetime) của đúng SP mua kèm được chọn.
        const opt = (r.rewardOptions || []).find(
          (o: any) => o.productId === feLine.productId,
        );
        let maxBuyQty = baseBuyQty; // đơn vị CT (gói/thùng)
        if (opt?.remaining != null) {
          maxBuyQty = Math.min(maxBuyQty, Number(opt.remaining));
        }
        // carton: quy maxBuyQty (thùng) → gói theo conversionValue của SP mua kèm.
        if (isCartonBuy) {
          maxBuyQty = Math.round(maxBuyQty * Number(opt?.conversionValue || 1));
        }
        if (maxBuyQty && Number(feLine.quantity) > maxBuyQty) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: số lượng mua kèm vượt mức cho phép (${maxBuyQty})`,
          );
        }
      }

      const giftValue = giftLines.reduce(
        (s: number, g: any) =>
          s + (costMap[g.productId] || 0) * Number(g.quantity),
        0,
      );
      logs.push({
        promotionId: r.promotionId,
        promotionCode: r.code,
        promotionName: r.name,
        type: r.type,
        discountAmount: Number(r.discountAmount),
        giftValue,
        rewardSnapshot: {
          giftLines,
          discountLines: r.discountLines,
          discountedBuyLines: r.discountedBuyLines,
          rewardOptions: r.rewardOptions,
        },
        status: 'applied',
      });
    }

    // Chèn gift / discounted_buy ngay sau đúng SP X kích hoạt.
    // mirror FE giỏ hàng. Không có reward → thứ tự giữ nguyên.
    const isRewardLine = (it: OrderItemDto) => {
      const lt = it.lineType || 'normal';
      return lt === 'gift' || lt === 'discounted_buy' || !!it.isGift;
    };
    const normals = baseItems.filter((it) => !isRewardLine(it));
    const rewards = baseItems.filter((it) => isRewardLine(it));
    if (rewards.length > 0) {
      const used = new Set<OrderItemDto>();
      const reordered: OrderItemDto[] = [];
      for (const n of normals) {
        reordered.push(n);
        if (n.promotionId != null) {
          for (const r of rewards) {
            if (
              !used.has(r) &&
              r.promotionId === n.promotionId &&
              ((r as any).triggerProductId == null ||
                (r as any).triggerProductId === n.productId)
            ) {
              reordered.push(r);
              used.add(r);
            }
          }
        }
      }
      for (const r of rewards) {
        if (!used.has(r)) reordered.push(r);
      }
      baseItems.length = 0;
      baseItems.push(...reordered);
    }

    return { effectiveItems: baseItems, extraDiscount, logs };
  }

  async create(dto: CreateOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const warnings: string[] = [];
      const orderStatusString = dto.orderStatus || 'pending';
      const orderStatusNumber = convertStatusStringToNumber(orderStatusString);

      if (!dto.branchId) {
        throw new Error('Branch ID is required');
      }
      const branchId = dto.branchId;

      // Re-validate khuyến mãi: BE sinh lại dòng gift / discount (authoritative)
      const promo = await this.processOrderPromotions(tx, dto);

      const itemsData = await Promise.all(
        promo.effectiveItems.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product) throw new Error(`Product ${item.productId} not found`);

          const inventory = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: item.productId,
                branchId: branchId,
              },
            },
          });

          if (!inventory || Number(inventory.onHand) < item.quantity) {
            warnings.push(
              `Sản phẩm ${product.name} không đủ tồn kho (Có: ${inventory?.onHand || 0}, Cần: ${item.quantity})`,
            );
          }

          const isGift = item.isGift || item.lineType === 'gift';
          const itemDiscount = isGift ? 0 : item.discount || 0;
          const itemDiscountRatio = isGift ? 0 : item.discountRatio || 0;
          const unitPrice = isGift ? 0 : item.unitPrice;
          const totalPrice =
            (unitPrice - itemDiscount) * item.quantity -
            (unitPrice * item.quantity * itemDiscountRatio) / 100;
          const appliedPrice =
            unitPrice - itemDiscount - (unitPrice * itemDiscountRatio) / 100;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: unitPrice,
            appliedPrice: appliedPrice,
            discount: itemDiscount,
            discountRatio: itemDiscountRatio,
            totalPrice: totalPrice,
            note: item.note || null,
            serialNumbers: item.serialNumbers || null,
            conditionType: item.conditionType || 'normal',
            soldExpiryDate: item.soldExpiryDate
              ? new Date(item.soldExpiryDate)
              : null,
            lineType: item.lineType || 'normal',
            isGift: isGift,
            promotionId: item.promotionId ?? null,
          };
        }),
      );

      let priceBook: any = null;

      if (dto.priceBookId && dto.priceBookId > 0) {
        // User chọn bảng giá cụ thể từ dropdown
        priceBook = await this.prisma.priceBook.findFirst({
          where: { id: dto.priceBookId, isActive: true },
        });
      } else if (dto.priceBookId === undefined || dto.priceBookId === null) {
        // Frontend cũ không gửi field này → auto-detect (backward compatible)
        const applicablePriceBooks = await this.prisma.priceBook.findMany({
          where: {
            isActive: true,
            OR: [
              { isGlobal: true },
              { priceBookBranches: { some: { branchId: branchId } } },
              ...(dto.customerId
                ? [
                    {
                      priceBookCustomerGroups: {
                        some: {
                          customerGroup: {
                            customerGroupDetails: {
                              some: { customerId: dto.customerId },
                            },
                          },
                        },
                      },
                    },
                    { forAllCusGroup: true },
                  ]
                : []),
            ],
          },
          orderBy: { priority: 'desc' },
          take: 1,
        });
        priceBook = applicablePriceBooks[0] || null;
      }
      // dto.priceBookId === 0 → "Bảng giá chung" → priceBook giữ null → lưu basePrice

      const orderCode = await this.generateCode();

      // Snapshot địa chỉ cũ (3 cấp) + mới (2 cấp) từ customer_addresses để shipper xem cả hai.
      const addrSnapshot = await resolveDeliveryAddress(tx, dto.customerId);

      const order = await tx.order.create({
        data: {
          code: orderCode,
          customerId: dto.customerId,
          branchId: branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          priceBookId: priceBook?.id || null,
          priceBookName: priceBook?.name || null,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          status: orderStatusNumber,
          statusValue: getStatusLabel(orderStatusNumber),
          orderStatus: orderStatusString,
          depositAmount: dto.depositAmount || 0,
          discount: (dto.discountAmount || 0) + promo.extraDiscount,
          discountRatio: dto.discountRatio || 0,
          description: dto.description,
          createdBy: userId,
          items: {
            createMany: {
              data: itemsData,
            },
          },
          delivery: dto.delivery
            ? {
                create: {
                  receiver: dto.delivery.receiver || '',
                  contactNumber: dto.delivery.contactNumber || '',
                  address: dto.delivery.address || '',
                  locationName: dto.delivery.locationName,
                  wardName: dto.delivery.wardName,
                  oldCityName: addrSnapshot.oldCityName,
                  oldDistrictName: addrSnapshot.oldDistrictName,
                  oldWardName: addrSnapshot.oldWardName,
                  newCityName: addrSnapshot.newCityName,
                  newWardName: addrSnapshot.newWardName,
                  weight: dto.delivery.weight,
                  weightUnit: dto.delivery.weightUnit || 'g',
                  length: dto.delivery.length || 10,
                  width: dto.delivery.width || 10,
                  height: dto.delivery.height || 10,
                  noteForDriver: dto.delivery.noteForDriver,
                },
              }
            : undefined,
        },
        include: {
          items: true,
          delivery: true,
        },
      });

      await this.calculateTotals(order.id, tx);

      // Ghi log khuyến mãi đã áp + tăng usageCount (gắn orderId)
      if (promo.logs.length > 0) {
        await tx.invoicePromotionLog.createMany({
          data: promo.logs.map((l) => ({ ...l, orderId: order.id })),
        });
        await tx.promotion.updateMany({
          where: { id: { in: promo.logs.map((l) => l.promotionId) } },
          data: { usageCount: { increment: 1 } },
        });
      }

      const finalOrder = await tx.order.findUnique({
        where: { id: order.id },
        include: {
          customer: true,
          items: { include: { product: true } },
          creator: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          payments: true,
          delivery: true,
          priceBook: true,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_CREATE',
        entityType: 'orders',
        entityId: finalOrder?.id.toString(),
        entityCode: finalOrder?.code,
        category: getCategoryFromActionCode('ORDER_CREATE'),
        severity: getSeverityFromActionCode('ORDER_CREATE'),
        snapshot: this.buildOrderSnapshot(finalOrder),
        message: renderAuditMessage('ORDER_CREATE', {
          orderCode: finalOrder?.code,
          customerName: finalOrder?.customer?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: finalOrder?.branchId || undefined,
      });

      // if (finalOrder) {
      //   this.larkOrderSync.syncSingleAsync(finalOrder.id);
      // }

      return { order: finalOrder, warnings };
    });
  }

  async update(id: number, dto: UpdateOrderDto, user: any) {
    const result = await this.prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findUnique({
        where: { id },
        include: {
          items: { include: { product: true } },
          delivery: true,
          customer: true,
          soldBy: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!existingOrder) {
        throw new Error('Order not found');
      }

      if (
        dto.branchId !== undefined &&
        dto.branchId !== existingOrder.branchId
      ) {
        throw new BadRequestException(
          'Không được phép đổi chi nhánh của đơn đã tạo',
        );
      }

      // extraDiscount KM cấp đơn (chỉ tính lại khi items thay đổi)
      let promoExtraDiscount: number | null = null;

      if (dto.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });

        // Hoàn lại usageCount + xóa log KM cũ của đơn (sẽ tính lại bên dưới)
        const oldLogs = await tx.invoicePromotionLog.findMany({
          where: { orderId: id, status: 'applied' },
          select: { id: true, promotionId: true },
        });
        if (oldLogs.length > 0) {
          for (const lg of oldLogs) {
            await tx.promotion.updateMany({
              where: { id: lg.promotionId },
              data: { usageCount: { decrement: 1 } },
            });
          }
          await tx.invoicePromotionLog.deleteMany({
            where: { orderId: id, status: 'applied' },
          });
        }

        // Re-validate KM trên branch hiện tại của đơn (không cho đổi branch)
        const promo = await this.processOrderPromotions(tx, {
          ...dto,
          items: dto.items,
          branchId: existingOrder.branchId ?? undefined,
          customerId: dto.customerId ?? existingOrder.customerId ?? undefined,
          soldById: dto.soldById ?? existingOrder.soldById ?? undefined,
        });
        promoExtraDiscount = promo.extraDiscount;

        const itemsData = await Promise.all(
          promo.effectiveItems.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new Error(`Product ${item.productId} not found`);

            const isGift = item.isGift || item.lineType === 'gift';
            const itemDiscount = isGift ? 0 : item.discount || 0;
            const itemDiscountRatio = isGift ? 0 : item.discountRatio || 0;
            const unitPrice = isGift ? 0 : item.unitPrice;
            const totalPrice =
              (unitPrice - itemDiscount) * item.quantity -
              (unitPrice * item.quantity * itemDiscountRatio) / 100;
            const appliedPrice =
              unitPrice - itemDiscount - (unitPrice * itemDiscountRatio) / 100;

            return {
              orderId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: unitPrice,
              appliedPrice: appliedPrice,
              discount: itemDiscount,
              discountRatio: itemDiscountRatio,
              totalPrice: totalPrice,
              note: item.note || null,
              serialNumbers: item.serialNumbers || null,
              conditionType: item.conditionType || 'normal',
              soldExpiryDate: item.soldExpiryDate
                ? new Date(item.soldExpiryDate)
                : null,
              lineType: item.lineType || 'normal',
              isGift: isGift,
              promotionId: item.promotionId ?? null,
            };
          }),
        );

        await tx.orderItem.createMany({
          data: itemsData,
        });

        // Ghi log KM mới + tăng usageCount
        if (promo.logs.length > 0) {
          await tx.invoicePromotionLog.createMany({
            data: promo.logs.map((l) => ({ ...l, orderId: id })),
          });
          await tx.promotion.updateMany({
            where: { id: { in: promo.logs.map((l) => l.promotionId) } },
            data: { usageCount: { increment: 1 } },
          });
        }
      }

      const updateData: any = {
        customerId: dto.customerId,
        branchId: dto.branchId,
        soldById: dto.soldById,
        saleChannelId: dto.saleChannelId,
        orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
        paidAmount: dto.paidAmount,
        discount:
          dto.discountAmount != null
            ? (dto.discountAmount || 0) + (promoExtraDiscount ?? 0)
            : promoExtraDiscount != null
              ? promoExtraDiscount
              : undefined,
        discountRatio: dto.discountRatio,
        depositAmount: dto.depositAmount,
        description: dto.description,
      };

      if (dto.orderStatus) {
        const statusNumber = convertStatusStringToNumber(dto.orderStatus);
        updateData.orderStatus = dto.orderStatus;
        updateData.status = statusNumber;
        updateData.statusValue = getStatusLabel(statusNumber);

        if (
          dto.orderStatus === 'cancelled' &&
          existingOrder.orderStatus !== 'cancelled'
        ) {
          updateData.debtAmount = 0;
        }
      }

      // Chỉ động đến priceBook khi DTO chủ động gửi.
      // dto.priceBookId === undefined / null → giữ nguyên giá trị đã chốt
      //   (PUT không kèm priceBookId từ các flow patch nhỏ như đổi trạng thái,
      //    đổi description, đổi delivery... không được phép thay đổi bảng giá).
      // dto.priceBookId > 0 → set theo bảng giá user chọn.
      // dto.priceBookId === 0 → "Bảng giá chung" → null/null.
      if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
        if (dto.priceBookId > 0) {
          const priceBook = await tx.priceBook.findFirst({
            where: { id: dto.priceBookId, isActive: true },
          });
          updateData.priceBookId = priceBook?.id || null;
          updateData.priceBookName = priceBook?.name || null;
        } else {
          // dto.priceBookId === 0 → "Bảng giá chung"
          updateData.priceBookId = null;
          updateData.priceBookName = null;
        }
      }

      await tx.order.update({
        where: { id },
        data: updateData,
      });

      if (dto.delivery) {
        if (existingOrder.delivery) {
          await tx.orderDelivery.update({
            where: { orderId: id },
            data: {
              receiver: dto.delivery.receiver || '',
              contactNumber: dto.delivery.contactNumber || '',
              address: dto.delivery.address || '',
              locationName: dto.delivery.locationName,
              wardName: dto.delivery.wardName,
              weight: dto.delivery.weight,
              weightUnit: dto.delivery.weightUnit || 'g',
              length: dto.delivery.length || 10,
              width: dto.delivery.width || 10,
              height: dto.delivery.height || 10,
              noteForDriver: dto.delivery.noteForDriver,
            },
          });
        } else {
          await tx.orderDelivery.create({
            data: {
              orderId: id,
              receiver: dto.delivery.receiver || '',
              contactNumber: dto.delivery.contactNumber || '',
              address: dto.delivery.address || '',
              locationName: dto.delivery.locationName,
              wardName: dto.delivery.wardName,
              weight: dto.delivery.weight,
              weightUnit: dto.delivery.weightUnit || 'g',
              length: dto.delivery.length || 10,
              width: dto.delivery.width || 10,
              height: dto.delivery.height || 10,
              noteForDriver: dto.delivery.noteForDriver,
            },
          });
        }
      }

      await this.calculateTotals(id, tx);

      const updatedOrderBeforeCalc = await tx.order.findUnique({
        where: { id },
        include: {
          items: { include: { product: true } },
          delivery: true,
          customer: true,
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!updatedOrderBeforeCalc) {
        throw new Error('Updated order not found');
      }

      const changes: string[] = [];

      if (existingOrder.statusValue !== updatedOrderBeforeCalc.statusValue) {
        changes.push(
          `${existingOrder.statusValue} → ${updatedOrderBeforeCalc.statusValue}`,
        );
      }

      const oldItemMap = new Map(
        existingOrder.items.map((i) => [i.productId, i]),
      );
      const newItemMap = new Map(
        updatedOrderBeforeCalc.items.map((i) => [i.productId, i]),
      );

      updatedOrderBeforeCalc.items.forEach((newItem) => {
        const oldItem = oldItemMap.get(newItem.productId);
        if (!oldItem) {
          changes.push(`Thêm ${newItem.product.name}`);
        } else if (Number(oldItem.quantity) !== Number(newItem.quantity)) {
          changes.push(
            `${newItem.product.name}: SL ${oldItem.quantity} → ${newItem.quantity}`,
          );
        }
      });

      existingOrder.items.forEach((oldItem) => {
        if (!newItemMap.has(oldItem.productId)) {
          changes.push(`Xóa ${oldItem.product.name}`);
        }
      });

      const fieldChanges = buildChanges(
        'orders',
        {
          statusValue: existingOrder.statusValue,
          grandTotal: Number(existingOrder.grandTotal),
          discount: Number(existingOrder.discount || 0),
          discountRatio: Number(existingOrder.discountRatio || 0),
          description: existingOrder.description,
          customerName: existingOrder.customer?.name ?? null,
          soldByName: existingOrder.soldBy?.name ?? null,
          branchName: existingOrder.branch?.name ?? null,
        },
        {
          statusValue: updatedOrderBeforeCalc.statusValue,
          grandTotal: Number(updatedOrderBeforeCalc.grandTotal),
          discount: Number(updatedOrderBeforeCalc.discount || 0),
          discountRatio: Number(updatedOrderBeforeCalc.discountRatio || 0),
          description: updatedOrderBeforeCalc.description,
          customerName: updatedOrderBeforeCalc.customer?.name ?? null,
          soldByName: updatedOrderBeforeCalc.soldBy?.name ?? null,
          branchName: updatedOrderBeforeCalc.branch?.name ?? null,
        },
      );

      const itemChanges = buildItemChanges(
        existingOrder.items.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
        updatedOrderBeforeCalc.items.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
      );

      const allChanges = [...fieldChanges, ...itemChanges];

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_UPDATE',
        entityType: 'orders',
        entityId: id.toString(),
        entityCode: updatedOrderBeforeCalc.code,
        category: getCategoryFromActionCode('ORDER_UPDATE'),
        severity: getSeverityFromActionCode('ORDER_UPDATE'),
        snapshot: this.buildOrderSnapshot(updatedOrderBeforeCalc),
        changes: allChanges.length > 0 ? allChanges : null,
        message: renderAuditMessage('ORDER_UPDATE', {
          orderCode: updatedOrderBeforeCalc.code,
          statusValue: updatedOrderBeforeCalc.statusValue || 'Phiếu tạm',
          customerName: updatedOrderBeforeCalc.customer?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_UPDATE',
        userId: user.id,
        userName: user.name || user.email,
        branchId: updatedOrderBeforeCalc.branchId || undefined,
      });

      // this.larkOrderSync.syncSingleAsync(id);

      return tx.order.findUnique({
        where: { id },
        include: {
          customer: true,
          branch: true,
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          delivery: true,
          invoices: true,
          priceBook: true,
        },
      });
    });

    // Gửi card "ĐƠN HÀNG ĐÃ ĐƯỢC CHỐT" vào Lark group HN/SG mỗi khi đơn được
    // lưu ở trạng thái "Đã xác nhận" (status = 5). Chạy ngoài transaction,
    // fire-and-forget để không ảnh hưởng response time.
    if (result?.status === ORDER_STATUS.CONFIRMED) {
      this.larkOrderNotification.notifyOrderConfirmedAsync(id);
    }

    return result;
  }

  /**
   * Tách logic build `where` để dùng chung giữa findAll và getTotals.
   * Mọi filter (status/branch/date/payment...) thay đổi đều áp lên cả 2.
   */
  private async buildOrderListWhere(
    query: OrderQueryDto,
    currentUser?: any,
  ): Promise<any> {
    const {
      search,
      status,
      statuses,
      customerId,
      branchId,
      branchIds,
      fromDate,
      toDate,
      fromCreatedDate,
      toCreatedDate,
      soldById,
      saleChannelId,
      paymentMethod,
      bankAccountIds,
      createdByIds,
      soldByIds,
    } = query;

    const where: any = {};

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    }

    if (search) {
      const matchedIds = await searchCustomerIds(this.prisma, search);
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }
    if (statuses && statuses.length > 0) {
      const statusNumbers = statuses.map((s) => convertStatusStringToNumber(s));
      where.status = { in: statusNumbers };
    } else if (status) {
      const statusNumber = convertStatusStringToNumber(status);
      where.status = statusNumber;
    }
    if (customerId) where.customerId = customerId;
    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }
    if (soldById) where.soldById = soldById;
    if (createdByIds && createdByIds.length > 0 && !where.createdBy) {
      where.createdBy = { in: createdByIds };
    }
    if (soldByIds && soldByIds.length > 0) {
      where.soldById = { in: soldByIds };
    }
    if (saleChannelId) where.saleChannelId = saleChannelId;

    if (fromDate && toDate) {
      where.orderDate = {
        gte: new Date(fromDate),
        lte: new Date(toDate),
      };
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    if (paymentMethod) {
      const paymentWhere: any = { paymentMethod };
      if (bankAccountIds && bankAccountIds.length > 0) {
        paymentWhere.accountId = { in: bankAccountIds };
      }
      where.payments = { some: paymentWhere };
    }

    return where;
  }

  /**
   * Tổng các cột tiền của TOÀN BỘ đơn match filter (không phân trang).
   * Dùng cho hàng "tổng" hiển thị ngay dưới header bảng đặt hàng.
   */
  async getTotals(query: OrderQueryDto, currentUser?: any) {
    const where = await this.buildOrderListWhere(query, currentUser);

    const agg = await this.prisma.order.aggregate({
      where,
      _sum: {
        totalAmount: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
      },
      _count: { _all: true },
    });

    const totalAmount = Number(agg._sum.totalAmount || 0);
    const grandTotal = Number(agg._sum.grandTotal || 0);
    const paidAmount = Number(agg._sum.paidAmount || 0);
    const debtAmount = Number(agg._sum.debtAmount || 0);

    return {
      count: agg._count._all,
      totalAmount,
      grandTotal,
      // "Khách cần trả" trên FE đang hiển thị grandTotal — giữ nhất quán.
      customerDebt: grandTotal,
      paidAmount,
      debtAmount,
    };
  }

  async findAll(query: OrderQueryDto, currentUser?: any) {
    const {
      page = 1,
      limit = 10,
      pageSize,
      currentItem,
      orderBy: rawOrderBy,
      orderDirection: rawOrderDirection,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where = await this.buildOrderListWhere(query, currentUser);

    const VALID_ORDER_BY = new Set([
      'orderDate',
      'createdAt',
      'updatedAt',
      'grandTotal',
      'paidAmount',
      'debtAmount',
      'totalAmount',
      'status',
    ]);
    const sortField =
      rawOrderBy && VALID_ORDER_BY.has(rawOrderBy) ? rawOrderBy : 'orderDate';
    const sortDir = rawOrderDirection === 'asc' ? 'asc' : 'desc';

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip: effectiveSkip,
        take: effectiveLimit,
        include: {
          customer: true,
          soldBy: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
          invoices: true,
          delivery: true,
        },
        orderBy: { [sortField]: sortDir },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Xuất Excel TỔNG QUAN đơn đặt hàng (mỗi đơn = 1 dòng). Bộ lọc dùng chung
   * buildOrderListWhere với danh sách/tổng, đảm bảo file xuất khớp UI. Tôn
   * trọng scope "chỉ xem đơn của mình" (currentUser.canViewOtherStaffData).
   */
  async exportOrders(
    query: OrderQueryDto,
    res: Response,
    currentUser?: any,
  ): Promise<void> {
    const where = await this.buildOrderListWhere(query, currentUser);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Đặt hàng');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã đặt hàng', key: 'code', width: 16 },
      { header: 'Thời gian', key: 'orderDate', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 18 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã khách hàng', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 22 },
      { header: 'Điện thoại', key: 'customerPhone', width: 14 },
      { header: 'Bảng giá', key: 'priceBookName', width: 16 },
      { header: 'Người bán', key: 'soldByName', width: 18 },
      { header: 'Người tạo', key: 'creatorName', width: 18 },
      { header: 'Người nhận', key: 'deliveryReceiver', width: 18 },
      { header: 'ĐT người nhận', key: 'deliveryPhone', width: 14 },
      { header: 'Địa chỉ giao', key: 'deliveryAddress', width: 28 },
      { header: 'Ghi chú giao hàng', key: 'deliveryNote', width: 22 },
      { header: 'Ghi chú', key: 'description', width: 22 },
      { header: 'Tổng số lượng', key: 'totalQuantity', width: 14 },
      { header: 'Số mặt hàng', key: 'totalGoods', width: 12 },
      { header: 'Tổng tiền hàng', key: 'totalAmount', width: 16 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Khách cần trả', key: 'grandTotal', width: 16 },
      { header: 'Khách đã trả', key: 'paidAmount', width: 16 },
      { header: 'Còn nợ', key: 'debtAmount', width: 14 },
      { header: 'Trạng thái', key: 'statusValue', width: 18 },
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
    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.order.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { orderDate: 'desc' },
        select: {
          id: true,
          code: true,
          orderDate: true,
          createdAt: true,
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
          status: true,
          statusValue: true,
          description: true,
          priceBookName: true,
          branch: { select: { name: true } },
          customer: {
            select: {
              code: true,
              name: true,
              contactNumber: true,
              phone: true,
            },
          },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          delivery: {
            select: {
              receiver: true,
              contactNumber: true,
              address: true,
              noteForDriver: true,
            },
          },
          items: { select: { quantity: true } },
        },
      });

      if (batch.length === 0) break;

      for (const o of batch) {
        stt++;
        const totalQuantity = o.items.reduce(
          (s, it) => s + Number(it.quantity),
          0,
        );
        sheet
          .addRow({
            stt,
            code: o.code,
            orderDate: fmtDateTime(o.orderDate),
            createdAt: fmtDateTime(o.createdAt),
            branchName: o.branch?.name ?? '',
            customerCode: o.customer?.code ?? 'Khách vãng lai',
            customerName: o.customer?.name ?? 'Khách vãng lai',
            customerPhone:
              o.customer?.contactNumber ?? (o.customer as any)?.phone ?? '',
            priceBookName: o.priceBookName || 'Bảng giá chung',
            soldByName: o.soldBy?.name ?? '',
            creatorName: o.creator?.name ?? '',
            deliveryReceiver: o.delivery?.receiver ?? '',
            deliveryPhone: o.delivery?.contactNumber ?? '',
            deliveryAddress: o.delivery?.address ?? '',
            deliveryNote: o.delivery?.noteForDriver ?? '',
            description: o.description ?? '',
            totalQuantity,
            totalGoods: o.items.length,
            totalAmount: Number(o.totalAmount) || 0,
            discount: Number(o.discount) || 0,
            grandTotal: Number(o.grandTotal) || 0,
            paidAmount: Number(o.paidAmount) || 0,
            debtAmount: Number(o.debtAmount) || 0,
            statusValue: o.statusValue || getStatusLabel(o.status),
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất Excel CHI TIẾT đơn đặt hàng (mỗi dòng sản phẩm = 1 dòng), kèm thông
   * tin đơn. Bộ lọc dùng chung buildOrderListWhere với export tổng quan.
   */
  async exportOrdersDetail(
    query: OrderQueryDto,
    res: Response,
    currentUser?: any,
  ): Promise<void> {
    const where = await this.buildOrderListWhere(query, currentUser);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết đặt hàng');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã đặt hàng', key: 'code', width: 16 },
      { header: 'Thời gian', key: 'orderDate', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 18 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã khách hàng', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 22 },
      { header: 'Điện thoại', key: 'customerPhone', width: 14 },
      { header: 'Người bán', key: 'soldByName', width: 18 },
      { header: 'Người tạo', key: 'creatorName', width: 18 },
      { header: 'Trạng thái', key: 'statusValue', width: 18 },
      { header: 'Mã hàng', key: 'productCode', width: 14 },
      { header: 'Tên hàng', key: 'productName', width: 28 },
      { header: 'Ghi chú hàng hóa', key: 'productNote', width: 22 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Đơn giá', key: 'unitPrice', width: 14 },
      { header: 'Giảm giá %', key: 'detailDiscountRatio', width: 12 },
      { header: 'Giảm giá', key: 'detailDiscount', width: 14 },
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
    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.order.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { orderDate: 'desc' },
        select: {
          id: true,
          code: true,
          orderDate: true,
          createdAt: true,
          status: true,
          statusValue: true,
          branch: { select: { name: true } },
          customer: {
            select: {
              code: true,
              name: true,
              contactNumber: true,
              phone: true,
            },
          },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          items: {
            orderBy: { lineNumber: 'asc' },
            select: {
              productCode: true,
              productName: true,
              note: true,
              quantity: true,
              price: true,
              discount: true,
              discountRatio: true,
              totalPrice: true,
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const o of batch) {
        const base = {
          code: o.code,
          orderDate: fmtDateTime(o.orderDate),
          createdAt: fmtDateTime(o.createdAt),
          branchName: o.branch?.name ?? '',
          customerCode: o.customer?.code ?? 'Khách vãng lai',
          customerName: o.customer?.name ?? 'Khách vãng lai',
          customerPhone:
            o.customer?.contactNumber ?? (o.customer as any)?.phone ?? '',
          soldByName: o.soldBy?.name ?? '',
          creatorName: o.creator?.name ?? '',
          statusValue: o.statusValue || getStatusLabel(o.status),
        };

        if (!o.items.length) {
          stt++;
          sheet
            .addRow({
              ...base,
              stt,
              productCode: '',
              productName: '',
              productNote: '',
              quantity: 0,
              unitPrice: 0,
              detailDiscountRatio: 0,
              detailDiscount: 0,
              totalPrice: 0,
            })
            .commit();
          continue;
        }

        for (const it of o.items) {
          stt++;
          sheet
            .addRow({
              ...base,
              stt,
              productCode: it.productCode || '',
              productName: it.productName || '',
              productNote: it.note || '',
              quantity: Number(it.quantity) || 0,
              unitPrice: Number(it.price) || 0,
              detailDiscountRatio: Number(it.discountRatio) || 0,
              detailDiscount: Number(it.discount) || 0,
              totalPrice: Number(it.totalPrice) || 0,
            })
            .commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
        branch: true,
        soldBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: {
          include: {
            product: { include: { inventories: true } },
            promotion: { select: { id: true, code: true, name: true } },
          },
        },
        payments: true,
        delivery: true,
        invoices: {
          where: { status: { not: 5 } },
          include: {
            details: true,
          },
        },
      },
    });
  }

  private async calculateTotals(orderId: number, tx: any) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const payments = await tx.orderPayment.findMany({
      where: { orderId, status: { not: 2 } },
    });

    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );

    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    // Giảm giá hiệu dụng: ưu tiên số tiền đã chốt (discount).
    // discountRatio chỉ là metadata; nếu chỉ có ratio (data cũ) thì quy đổi sang tiền.
    const discountAmount =
      Number(order.discount) > 0
        ? Number(order.discount)
        : (totalAmount * (Number(order.discountRatio) || 0)) / 100;
    const grandTotal = totalAmount - discountAmount;

    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const debtAmount = grandTotal - paidAmount;

    let paymentStatus = 'Draft';
    if (paidAmount >= grandTotal) paymentStatus = 'paid';
    else if (paidAmount > 0) paymentStatus = 'partial';

    await tx.order.update({
      where: { id: orderId },
      data: { totalAmount, grandTotal, paidAmount, debtAmount, paymentStatus },
    });
  }

  async updateOrderStatusByInvoices(
    orderId: number,
    tx: any,
    forceComplete = false,
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) return;

    if (order.status === 4) return;

    const invoices = await tx.invoice.findMany({
      where: {
        orderId,
        status: { not: 2 },
      },
      include: { details: true },
    });

    if (invoices.length === 0) {
      return;
    }

    const invoicedQty: Record<number, number> = {};
    invoices.forEach((inv: any) => {
      inv.details.forEach((d: any) => {
        invoicedQty[d.productId] =
          (invoicedQty[d.productId] || 0) + Number(d.quantity);
      });
    });

    let isFullyInvoiced = true;
    for (const item of order.items) {
      const orderedQty = Number(item.quantity);
      const invoiced = invoicedQty[item.productId] || 0;
      if (invoiced < orderedQty) {
        isFullyInvoiced = false;
        break;
      }
    }

    if (isFullyInvoiced) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 3,
          statusValue: getStatusLabel(3),
          orderStatus: 'completed',
        },
      });
    } else if (forceComplete) {
      // Người dùng chọn "Kết thúc đơn hàng" dù còn mã xuất thiếu → ép hoàn thành.
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 3,
          statusValue: getStatusLabel(3),
          orderStatus: 'completed',
        },
      });
    } else {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 6,
          statusValue: getStatusLabel(6),
          orderStatus: 'partially_invoiced',
        },
      });
    }
  }

  private async generateCode(): Promise<string> {
    const lastOrder = await this.prisma.order.findFirst({
      orderBy: { id: 'desc' },
    });

    const nextId = lastOrder ? lastOrder.id + 1 : 1;
    return `DH${nextId.toString().padStart(6, '0')}`;
  }

  async remove(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        include: {
          items: true,
          customer: { select: { id: true, code: true, name: true } },
        },
      });

      if (!order) {
        throw new Error('Order not found');
      }

      // Hoàn lại usageCount của KM trước khi xóa cứng (log sẽ bị cascade-delete)
      const promoLogs = await tx.invoicePromotionLog.findMany({
        where: { orderId: id, status: 'applied' },
        select: { promotionId: true },
      });
      for (const lg of promoLogs) {
        await tx.promotion.updateMany({
          where: { id: lg.promotionId },
          data: { usageCount: { decrement: 1 } },
        });
      }

      await tx.order.delete({ where: { id } });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'ORDER_DELETE',
        entityType: 'orders',
        entityId: id.toString(),
        entityCode: order.code,
        category: getCategoryFromActionCode('ORDER_DELETE'),
        severity: getSeverityFromActionCode('ORDER_DELETE'),
        snapshot: {
          code: order.code,
          status: order.statusValue,
          customerName: order.customer?.name || 'N/A',
          grandTotal: Number(order.grandTotal),
        },
        message: renderAuditMessage('ORDER_DELETE', {
          orderCode: order.code,
        }),
        messageTemplate: 'ORDER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: order.branchId || user?.branchId || undefined,
      });
    });
  }

  async cancelOrder(id: number, dto: CancelOrderDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        include: {
          items: true,
          invoices: { where: { status: { not: INVOICE_STATUS.CANCELLED } } },
          payments: true,
          customer: {
            select: { id: true, code: true, name: true, totalDebt: true },
          },
          creator: { select: { id: true, name: true } },
        },
      });

      if (!order) {
        throw new NotFoundException('Không tìm thấy đơn hàng');
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
        throw new BadRequestException('Đơn hàng đã được hủy trước đó');
      }

      // Kiểm tra có hóa đơn không bị hủy
      const hasActiveInvoices = order.invoices && order.invoices.length > 0;
      if (hasActiveInvoices) {
        throw new BadRequestException(
          'Đơn hàng có hóa đơn. Vui lòng hủy tất cả hóa đơn trước khi hủy đơn hàng',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      if (dto.cancelPayments && order.payments.length > 0) {
        const paymentIds = order.payments.map((p) => p.id);
        const paymentCodes = order.payments
          .map((p) => p.code)
          .filter((c): c is string => !!c);

        // Soft-cancel orderPayment (giữ audit, không hard-delete)
        await tx.orderPayment.updateMany({
          where: { id: { in: paymentIds } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });

        // Soft-cancel cashFlow match theo code (giữ audit + tra cứu được)
        if (paymentCodes.length > 0) {
          await tx.cashFlow.updateMany({
            where: {
              code: { in: paymentCodes },
              status: { not: 2 },
            },
            data: { status: 2, statusValue: 'Đã hủy' },
          });
        }

        // Audit log từng payment (giữ nguyên message ORDER_PAYMENT_DELETE)
        for (const payment of order.payments) {
          await this.auditLogsService.create({
            actionType: 'DELETE',
            actionCode: 'ORDER_PAYMENT_DELETE',
            entityType: 'order_payment',
            entityId: payment.id.toString(),
            entityCode: payment.code,
            category: getCategoryFromActionCode('ORDER_PAYMENT_DELETE'),
            severity: getSeverityFromActionCode('ORDER_PAYMENT_DELETE'),
            snapshot: {
              code: payment.code,
              amount: Number(payment.amount),
              paymentMethod: payment.paymentMethod,
              order: {
                code: order.code,
                customer: order.customer,
              },
            },
            message: renderAuditMessage('ORDER_PAYMENT_DELETE', {
              paymentCode: payment.code,
              orderCode: order.code,
            }),
            messageTemplate: 'ORDER_PAYMENT_DELETE',
            userId,
            userName: user?.name || 'System',
            branchId: order.branchId || undefined,
          });
        }

        if (order.customerId) {
          await this.recalculateCustomerDebt(order.customerId, tx);
        }
      }

      // Hủy đơn hàng
      await tx.order.update({
        where: { id },
        data: {
          status: ORDER_STATUS.CANCELLED,
          statusValue: getStatusLabel(ORDER_STATUS.CANCELLED),
          orderStatus: 'cancelled',
          ...(dto.cancelPayments && order.payments.length > 0
            ? { paidAmount: 0, depositAmount: 0, debtAmount: 0 }
            : {}),
          debtAmount: 0,
        },
      });

      // Hoàn lại usageCount + đảo log KM của đơn (đơn chưa xuất hóa đơn nên log thuộc về order)
      const promoLogs = await tx.invoicePromotionLog.findMany({
        where: { orderId: id, status: 'applied' },
        select: { id: true, promotionId: true },
      });
      if (promoLogs.length > 0) {
        for (const lg of promoLogs) {
          await tx.promotion.updateMany({
            where: { id: lg.promotionId },
            data: { usageCount: { decrement: 1 } },
          });
        }
        await tx.invoicePromotionLog.updateMany({
          where: { orderId: id, status: 'applied' },
          data: { status: 'reverted' },
        });
      }

      // Log audit hủy đơn hàng
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_CANCEL',
        entityType: 'orders',
        entityId: id.toString(),
        entityCode: order.code,
        category: getCategoryFromActionCode('ORDER_CANCEL'),
        severity: getSeverityFromActionCode('ORDER_CANCEL'),
        snapshot: this.buildOrderSnapshot(order),
        message: renderAuditMessage('ORDER_CANCEL', {
          orderCode: order.code,
          customerName: order.customer?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: order.branchId || undefined,
      });

      return { message: 'Hủy đơn hàng thành công' };
    });
  }

  private recalculateCustomerDebt(customerId: number, tx: any) {
    return recalcCustomerDebt(tx, customerId);
  }

  async getProductPriceHistory(
    customerId: number,
    productId: number,
    type?: 'order' | 'invoice',
    branchId?: number,
  ) {
    const results: Array<{
      code: string;
      date: string;
      price: number;
      discount: number;
      quantity: number;
      finalPrice: number;
      type: 'order' | 'invoice';
    }> = [];

    if (!type || type === 'order') {
      const orderHistory = await this.prisma.orderItem.findMany({
        where: {
          productId,
          order: {
            customerId,
            status: { notIn: [ORDER_STATUS.CANCELLED] },
            ...(branchId ? { branchId } : {}),
          },
        },
        select: {
          price: true,
          discount: true,
          quantity: true,
          order: {
            select: {
              id: true,
              code: true,
              orderDate: true,
            },
          },
        },
        orderBy: {
          order: {
            orderDate: 'desc',
          },
        },
        take: 5,
      });

      results.push(
        ...orderHistory.map((item) => ({
          code: item.order.code,
          date: item.order.orderDate.toISOString(),
          price: Number(item.price),
          discount: Number(item.discount),
          quantity: Number(item.quantity),
          finalPrice: Number(item.price) - Number(item.discount),
          type: 'order' as const,
        })),
      );
    }

    if (!type || type === 'invoice') {
      const invoiceHistory = await this.prisma.invoiceDetail.findMany({
        where: {
          productId,
          invoice: {
            customerId,
            status: { notIn: [INVOICE_STATUS.CANCELLED] },
            ...(branchId ? { branchId } : {}),
          },
        },
        select: {
          price: true,
          discount: true,
          quantity: true,
          invoice: {
            select: {
              id: true,
              code: true,
              purchaseDate: true,
            },
          },
        },
        orderBy: {
          invoice: {
            purchaseDate: 'desc',
          },
        },
        take: 5,
      });

      results.push(
        ...invoiceHistory.map((item) => ({
          code: item.invoice.code,
          date: item.invoice.purchaseDate.toISOString(),
          price: Number(item.price),
          discount: Number(item.discount),
          quantity: Number(item.quantity),
          finalPrice: Number(item.price) - Number(item.discount),
          type: 'invoice' as const,
        })),
      );
    }

    results.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return results.slice(0, 5);
  }

  /**
   * Tính tổng số lượng "Khách đặt" cho từng productId.
   * Khách đặt = sum(quantity của OrderItem) trong các Order có status thuộc
   * { Phiếu tạm (1), Đã xác nhận (5) }.
   * Nếu truyền branchId thì chỉ tính đơn thuộc chi nhánh đó — lọc y hệt
   * `getPendingByProduct` để con số tổng khớp tuyệt đối với danh sách trong modal.
   */
  async getPendingSummary(productIds: number[], branchId?: number) {
    if (!productIds || productIds.length === 0) {
      return {} as Record<number, number>;
    }

    const orderWhere: any = {
      status: { in: [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      orderWhere.branchId = branchId;
    }

    const grouped = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        productId: { in: productIds },
        order: orderWhere,
      },
      _sum: { quantity: true },
    });

    const result: Record<number, number> = {};
    for (const id of productIds) result[id] = 0;
    for (const row of grouped) {
      result[row.productId] = Number(row._sum.quantity || 0);
    }
    return result;
  }

  /**
   * Lấy danh sách đơn hàng có chứa productId đang ở trạng thái
   * Phiếu tạm hoặc Đã xác nhận.
   * Nếu truyền branchId thì lọc theo chi nhánh, không truyền thì lấy mọi chi nhánh.
   * Trả về thông tin tối thiểu cho modal: mã đơn, ngày tạo, khách hàng,
   * người tạo, thành tiền, trạng thái, số lượng đặt sản phẩm tương ứng.
   *
   * Lưu ý: 1 sản phẩm có thể xuất hiện trên nhiều dòng (OrderItem) trong
   * cùng 1 đơn → phải gộp về 1 dòng / 1 đơn để tránh trùng key ở FE.
   */
  async getPendingByProduct(productId: number, branchId?: number) {
    if (!productId || Number.isNaN(productId)) return [];

    const orderWhere: any = {
      status: { in: [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      orderWhere.branchId = branchId;
    }

    const items = await this.prisma.orderItem.findMany({
      where: {
        productId,
        order: orderWhere,
      },
      select: {
        quantity: true,
        order: {
          select: {
            id: true,
            code: true,
            orderDate: true,
            createdAt: true,
            grandTotal: true,
            status: true,
            statusValue: true,
            orderStatus: true,
            customer: { select: { id: true, code: true, name: true } },
            creator: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { order: { createdAt: 'desc' } },
    });

    // Gộp các dòng cùng orderId → 1 record / 1 đơn (cộng quantity)
    const map = new Map<
      number,
      {
        orderId: number;
        code: string;
        createdAt: Date;
        orderDate: Date;
        grandTotal: number;
        status: number;
        statusValue: string;
        orderStatus: string;
        customer: { id: number; code: string | null; name: string } | null;
        creator: { id: number; name: string | null } | null;
        branch: { id: number; name: string } | null;
        quantity: number;
      }
    >();

    for (const it of items) {
      const o = it.order;
      const existing = map.get(o.id);
      if (existing) {
        existing.quantity += Number(it.quantity);
      } else {
        map.set(o.id, {
          orderId: o.id,
          code: o.code,
          createdAt: o.createdAt,
          orderDate: o.orderDate,
          grandTotal: Number(o.grandTotal),
          status: o.status,
          // Luôn map từ status (number) → label tiếng Việt; không dùng
          // statusValue thô vì DB lưu không nhất quán (mix Việt/Anh).
          statusValue: getStatusLabel(o.status),
          orderStatus: o.orderStatus,
          customer: o.customer,
          creator: o.creator,
          branch: o.branch,
          quantity: Number(it.quantity),
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  private buildOrderSnapshot(order: any) {
    return {
      code: order.code,
      orderDate: order.orderDate,
      statusValue: order.statusValue,
      grandTotal: Number(order.grandTotal),
      totalAmount: Number(order.totalAmount || 0),
      discount: Number(order.discount || 0),
      discountRatio: Number(order.discountRatio || 0),
      paidAmount: Number(order.paidAmount || 0),
      depositAmount: Number(order.depositAmount || 0),
      debtAmount: Number(order.debtAmount || 0),
      description: order.description,
      priceBookName: order.priceBookName || order.priceBook?.name || null,
      customer: order.customer
        ? { code: order.customer.code, name: order.customer.name }
        : null,
      createdBy: order.creator
        ? {
            name:
              typeof order.creator === 'object'
                ? order.creator.name
                : order.creator,
          }
        : null,
      soldBy: order.soldBy
        ? {
            name:
              typeof order.soldBy === 'object'
                ? order.soldBy.name
                : order.soldBy,
          }
        : null,
      branch: order.branch ? { name: order.branch.name } : null,
      items: (order.items || []).map((i: any) => ({
        productId: i.productId,
        productCode: i.productCode || i.product?.code,
        productName: i.productName || i.product?.name,
        quantity: Number(i.quantity),
        price: Number(i.price),
        discount: Number(i.discount || 0),
      })),
      delivery: order.delivery
        ? {
            receiver: order.delivery.receiver,
            contactNumber: order.delivery.contactNumber,
            address: order.delivery.address,
            wardName: order.delivery.wardName,
            weight: order.delivery.weight,
            length: order.delivery.length,
            width: order.delivery.width,
            height: order.delivery.height,
            noteForDriver: order.delivery.noteForDriver,
            statusValue: order.delivery.statusValue,
          }
        : null,
    };
  }
}
