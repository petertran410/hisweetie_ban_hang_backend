/**
 * Promotion rule engine — pure function, không truy cập DB.
 * Service load promotion candidates + stock map rồi gọi engine để tính kết quả.
 * Tách riêng để dễ unit test (xem test cases trong tài liệu thiết kế).
 */

export interface EngineItem {
  productId: number;
  quantity: number;
  price: number;
  discount?: number;
  // category resolve sẵn ở service (Product lưu category dạng string)
  parentName?: string | null;
  middleName?: string | null;
  childName?: string | null;
  // Opt-in per-line: danh sách promotionId mà thu ngân bật KM cho dòng này.
  // undefined => không lọc (giữ hành vi cũ cho auto-apply / luồng ngoài POS).
  // [] hoặc mảng => chỉ tính dòng này cho promotion nằm trong mảng.
  enabledPromotionIds?: number[];
}

export interface EngineProductRef {
  productId?: number | null;
  categoryName?: string | null;
}

export interface EngineReward {
  buyProductId?: number | null;
  buyCategoryName?: string | null;
  buyQuantity: number;
  rewardType: string; // discount_percent | discount_amount | gift | discounted_buy
  rewardProductId?: number | null;
  rewardQuantity: number;
  rewardValue: number;
  // multi X/Y: danh sách SP/nhóm hàng làm điều kiện mua (buy) và phần thưởng (reward)
  buyItems?: EngineProductRef[];
  rewardItems?: EngineProductRef[];
}

export interface EnginePromotion {
  id: number;
  code: string;
  name: string;
  type: string;
  priority: number;
  stackable: boolean;
  autoApply: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  applyTimeFrom?: string | null;
  applyTimeTo?: string | null;
  applyWeekdays: number[];
  minOrderValue: number;
  minQuantity: number;
  maxDiscountAmount?: number | null;
  maxRewardQuantity?: number | null;
  usageLimit?: number | null;
  usageCount: number;
  rewards: EngineReward[];
}

export interface GiftLine {
  productId: number;
  productName?: string;
  productCode?: string;
  quantity: number;
  price: number;
  lineType: 'gift';
  isGift: true;
  promotionId: number;
  availableStock: number;
  stockEnough: boolean;
}

export interface DiscountedBuyLine {
  productId: number;
  productName?: string;
  productCode?: string;
  maxQuantity: number;
  promoPrice: number;
  lineType: 'discounted_buy';
  promotionId: number;
  availableStock: number;
}

export interface DiscountLine {
  productId: number;
  perUnitDiscount: number;
  quantity: number;
  promotionId: number;
}

/** Một lựa chọn SP để tặng / mua kèm (khi nhóm Y có nhiều SP). */
export interface RewardOption {
  productId: number;
  productName?: string;
  productCode?: string;
  availableStock: number;
}

export interface PromotionResult {
  promotionId: number;
  code: string;
  name: string;
  type: string;
  autoApply: boolean;
  selected: boolean; // auto => true, suggest => false
  scope: string; // INVOICE | product:<id> | category:<name>
  priority: number;
  stackable: boolean;
  discountAmount: number;
  giftLines: GiftLine[];
  discountedBuyLines: DiscountedBuyLine[];
  discountLines: DiscountLine[];
  // multi Y: số lượng được tặng / được mua kèm và danh sách SP để thu ngân chọn
  rewardQuantity?: number;
  rewardOptions?: RewardOption[];
  promoPrice?: number; // dùng cho discounted_buy
  requiresChoice?: boolean; // true khi rewardOptions > 1 → cần thu ngân chọn
  matchedProductIds?: number[]; // các productId trong giỏ khớp điều kiện mua X
}

export interface EngineContext {
  branchId: number;
  customerId?: number | null;
  userId?: number | null;
  now: Date;
  items: EngineItem[];
  // map productId -> onHand tại branch (để check tồn hàng tặng)
  stockMap: Record<number, number>;
  // tên SP để hiển thị
  productNameMap: Record<number, string>;
  // mã SP (productCode)
  productCodeMap: Record<number, string>;
  // resolve danh sách SP thuộc 1 category (parent/middle/child name) -> [productId]
  categoryProductMap: Record<string, number[]>;
}

export interface EvaluateOutput {
  subtotal: number;
  totalQuantity: number;
  eligiblePromotions: PromotionResult[];
  conflicts: { promotionIds: number[]; reason: string }[];
  estimatedDiscount: number;
  estimatedTotalAfter: number;
}

const round = (n: number) => Math.round(n);

function calcSubtotal(items: EngineItem[]): number {
  return items.reduce(
    (sum, it) => sum + (it.price - (it.discount || 0)) * it.quantity,
    0,
  );
}

function inTimeWindow(now: Date, from?: string | null, to?: string | null) {
  if (!from || !to) return true;
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const cur = `${hh}:${mm}`;
  return cur >= from && cur <= to;
}

function matchItemToReward(it: EngineItem, rw: EngineReward): boolean {
  if (rw.buyProductId) return it.productId === rw.buyProductId;
  if (rw.buyCategoryName) {
    return (
      it.parentName === rw.buyCategoryName ||
      it.middleName === rw.buyCategoryName ||
      it.childName === rw.buyCategoryName
    );
  }
  return false;
}

/** Item có khớp 1 product-ref (SP cụ thể hoặc nhóm hàng) không. */
function itemMatchesRef(it: EngineItem, ref: EngineProductRef): boolean {
  if (ref.productId) return it.productId === ref.productId;
  if (ref.categoryName) {
    return (
      it.parentName === ref.categoryName ||
      it.middleName === ref.categoryName ||
      it.childName === ref.categoryName
    );
  }
  return false;
}

/** Danh sách buyItems hiệu dụng: ưu tiên buyItems[], fallback field đơn cũ. */
function getBuyItems(rw: EngineReward): EngineProductRef[] {
  if (rw.buyItems && rw.buyItems.length > 0) return rw.buyItems;
  if (rw.buyProductId) return [{ productId: rw.buyProductId }];
  if (rw.buyCategoryName) return [{ categoryName: rw.buyCategoryName }];
  return [];
}

function getRewardItems(rw: EngineReward): EngineProductRef[] {
  if (rw.rewardItems && rw.rewardItems.length > 0) return rw.rewardItems;
  if (rw.rewardProductId) return [{ productId: rw.rewardProductId }];
  return [];
}

/** Dòng này có được thu ngân bật KM cho promotion đang xét không.
 * undefined => không lọc (giữ hành vi cũ). */
function itemEnabledForPromo(it: EngineItem, promotionId: number): boolean {
  if (it.enabledPromotionIds === undefined) return true;
  return it.enabledPromotionIds.includes(promotionId);
}

/** Tổng SL trong giỏ khớp BẤT KỲ buyItem (gộp nhóm X), chỉ tính dòng opt-in. */
function sumBoughtQty(
  ctx: EngineContext,
  buyItems: EngineProductRef[],
  promotionId: number,
): number {
  return ctx.items
    .filter(
      (it) =>
        itemEnabledForPromo(it, promotionId) &&
        buyItems.some((ref) => itemMatchesRef(it, ref)),
    )
    .reduce((s, it) => s + it.quantity, 0);
}

/** Các productId trong giỏ khớp điều kiện mua X, chỉ tính dòng opt-in. */
function matchedProductIds(
  ctx: EngineContext,
  buyItems: EngineProductRef[],
  promotionId: number,
): number[] {
  return [
    ...new Set(
      ctx.items
        .filter(
          (it) =>
            itemEnabledForPromo(it, promotionId) &&
            buyItems.some((ref) => itemMatchesRef(it, ref)),
        )
        .map((it) => it.productId),
    ),
  ];
}

/** Resolve danh sách SP cụ thể từ rewardItems (expand category) kèm tồn kho. */
function resolveRewardOptions(
  ctx: EngineContext,
  rewardItems: EngineProductRef[],
): RewardOption[] {
  const ids = new Set<number>();
  for (const ref of rewardItems) {
    if (ref.productId) ids.add(ref.productId);
    else if (ref.categoryName) {
      (ctx.categoryProductMap[ref.categoryName] || []).forEach((id) =>
        ids.add(id),
      );
    }
  }
  return [...ids].map((productId) => ({
    productId,
    productName: ctx.productNameMap[productId] ?? '',
    productCode: ctx.productCodeMap[productId] ?? '',
    availableStock: ctx.stockMap[productId] ?? 0,
  }));
}

/** Lọc điều kiện áp dụng theo thời điểm + ngưỡng (B2). DB đã lọc B1. */
export function isTimeAndThresholdEligible(
  p: EnginePromotion,
  ctx: EngineContext,
  subtotal: number,
  totalQty: number,
): boolean {
  const now = ctx.now;
  if (p.startDate && now < new Date(p.startDate)) return false;
  if (p.endDate && now > new Date(p.endDate)) return false;
  if (p.applyWeekdays && p.applyWeekdays.length > 0) {
    // JS getDay: 0=CN..6=T7 -> chuyển sang 1=T2..7=CN
    const wd = now.getDay() === 0 ? 7 : now.getDay();
    if (!p.applyWeekdays.includes(wd)) return false;
  }
  if (!inTimeWindow(now, p.applyTimeFrom, p.applyTimeTo)) return false;
  if (subtotal < Number(p.minOrderValue || 0)) return false;
  if (totalQty < Number(p.minQuantity || 0)) return false;
  if (p.usageLimit != null && p.usageCount >= p.usageLimit) return false;
  return true;
}

/** Tính phần thưởng cho 1 promotion (B3). Trả null nếu không áp dụng được. */
export function computeReward(
  p: EnginePromotion,
  ctx: EngineContext,
  subtotal: number,
): PromotionResult | null {
  const rw = p.rewards[0];
  const base: Omit<
    PromotionResult,
    | 'discountAmount'
    | 'giftLines'
    | 'discountedBuyLines'
    | 'discountLines'
    | 'scope'
  > = {
    promotionId: p.id,
    code: p.code,
    name: p.name,
    type: p.type,
    autoApply: p.autoApply,
    selected: p.autoApply,
    priority: p.priority,
    stackable: p.stackable,
  };

  const stockOf = (pid: number) => ctx.stockMap[pid] ?? 0;
  const nameOf = (pid: number) => ctx.productNameMap[pid] ?? '';
  const codeOf = (pid: number) => ctx.productCodeMap[pid] ?? '';

  switch (p.type) {
    case 'INVOICE_DISCOUNT':
    case 'GIFT_BY_INVOICE': {
      if (p.type === 'INVOICE_DISCOUNT') {
        let disc =
          rw.rewardType === 'discount_percent'
            ? (subtotal * Number(rw.rewardValue)) / 100
            : Number(rw.rewardValue);
        if (p.maxDiscountAmount != null)
          disc = Math.min(disc, Number(p.maxDiscountAmount));
        disc = Math.min(disc, subtotal);
        if (disc <= 0) return null;
        return {
          ...base,
          scope: 'INVOICE',
          discountAmount: round(disc),
          giftLines: [],
          discountedBuyLines: [],
          discountLines: [],
        };
      }
      // GIFT_BY_INVOICE: HĐ >= ngưỡng tặng quà
      if (!rw.rewardProductId) return null;
      const giftQty = Number(rw.rewardQuantity);
      const stock = stockOf(rw.rewardProductId);
      return {
        ...base,
        scope: 'INVOICE',
        discountAmount: 0,
        giftLines: [
          {
            productId: rw.rewardProductId,
            productName: nameOf(rw.rewardProductId),
            productCode: codeOf(rw.rewardProductId),
            quantity: giftQty,
            price: 0,
            lineType: 'gift',
            isGift: true,
            promotionId: p.id,
            availableStock: stock,
            stockEnough: stock >= giftQty,
          },
        ],
        discountedBuyLines: [],
        discountLines: [],
      };
    }

    case 'PRODUCT_DISCOUNT':
    case 'CATEGORY_DISCOUNT': {
      const lines: DiscountLine[] = [];
      let total = 0;
      for (const it of ctx.items) {
        if (!matchItemToReward(it, rw)) continue;
        const d =
          rw.rewardType === 'discount_percent'
            ? (it.price * Number(rw.rewardValue)) / 100
            : Number(rw.rewardValue);
        const perUnit = Math.min(round(d), it.price);
        if (perUnit <= 0) continue;
        lines.push({
          productId: it.productId,
          perUnitDiscount: perUnit,
          quantity: it.quantity,
          promotionId: p.id,
        });
        total += perUnit * it.quantity;
      }
      if (lines.length === 0) return null;
      if (p.maxDiscountAmount != null)
        total = Math.min(total, Number(p.maxDiscountAmount));
      const scope =
        p.type === 'CATEGORY_DISCOUNT'
          ? `category:${rw.buyCategoryName}`
          : `product:${rw.buyProductId}`;
      return {
        ...base,
        scope,
        discountAmount: round(total),
        giftLines: [],
        discountedBuyLines: [],
        discountLines: lines,
      };
    }

    case 'BUY_X_GET_Y':
    case 'BUY_N_GET_M_SAME': {
      const buyItems = getBuyItems(rw);
      if (buyItems.length === 0 || rw.buyQuantity <= 0) return null;
      const boughtQty = sumBoughtQty(ctx, buyItems, p.id);
      const times = Math.floor(boughtQty / Number(rw.buyQuantity));
      if (times === 0) return null;
      let giftQty = times * Number(rw.rewardQuantity);
      if (p.maxRewardQuantity != null)
        giftQty = Math.min(giftQty, Number(p.maxRewardQuantity));
      if (giftQty <= 0) return null;

      // BUY_N_GET_M_SAME: tặng chính SP đã mua (các SP trong giỏ khớp X).
      // BUY_X_GET_Y: tặng SP thuộc nhóm Y (rewardItems).
      let options: RewardOption[];
      if (p.type === 'BUY_N_GET_M_SAME') {
        const boughtIds = matchedProductIds(ctx, buyItems, p.id);
        options = boughtIds.map((productId) => ({
          productId,
          productName: nameOf(productId),
          productCode: codeOf(productId),
          availableStock: stockOf(productId),
        }));
      } else {
        options = resolveRewardOptions(ctx, getRewardItems(rw));
      }
      if (options.length === 0) return null;

      const scope = `buy:${p.id}`;
      const requiresChoice = options.length > 1;
      // Nếu chỉ 1 option → tự sinh giftLine luôn. Nếu nhiều → chờ thu ngân chọn.
      const giftLines: GiftLine[] = requiresChoice
        ? []
        : [
            {
              productId: options[0].productId,
              productName: options[0].productName,
              productCode: options[0].productCode,
              quantity: giftQty,
              price: 0,
              lineType: 'gift',
              isGift: true,
              promotionId: p.id,
              availableStock: options[0].availableStock,
              stockEnough: options[0].availableStock >= giftQty,
            },
          ];
      return {
        ...base,
        scope,
        discountAmount: 0,
        giftLines,
        discountedBuyLines: [],
        discountLines: [],
        rewardQuantity: giftQty,
        rewardOptions: options,
        requiresChoice,
        matchedProductIds: matchedProductIds(ctx, buyItems, p.id),
      };
    }

    case 'BUY_X_BUY_Y_PRICE': {
      const buyItems = getBuyItems(rw);
      const rewardItems = getRewardItems(rw);
      if (
        buyItems.length === 0 ||
        rw.buyQuantity <= 0 ||
        rewardItems.length === 0
      )
        return null;
      const boughtQty = sumBoughtQty(ctx, buyItems, p.id);
      const times = Math.floor(boughtQty / Number(rw.buyQuantity));
      if (times === 0) return null;
      let buyableQty = times * Number(rw.rewardQuantity);
      if (p.maxRewardQuantity != null)
        buyableQty = Math.min(buyableQty, Number(p.maxRewardQuantity));
      if (buyableQty <= 0) return null;
      const promoPrice = round(Number(rw.rewardValue));
      const options = resolveRewardOptions(ctx, rewardItems);
      if (options.length === 0) return null;

      const scope = `buy:${p.id}`;
      const requiresChoice = options.length > 1;
      const discountedBuyLines: DiscountedBuyLine[] = requiresChoice
        ? []
        : [
            {
              productId: options[0].productId,
              productName: options[0].productName,
              productCode: options[0].productCode,
              maxQuantity: buyableQty,
              promoPrice,
              lineType: 'discounted_buy',
              promotionId: p.id,
              availableStock: options[0].availableStock,
            },
          ];
      return {
        ...base,
        scope,
        discountAmount: 0,
        giftLines: [],
        discountedBuyLines,
        discountLines: [],
        rewardQuantity: buyableQty,
        rewardOptions: options,
        promoPrice,
        requiresChoice,
        matchedProductIds: matchedProductIds(ctx, buyItems, p.id),
      };
    }

    default:
      return null;
  }
}

/**
 * Giải xung đột + ưu tiên (B4).
 * MVP: KHÔNG cộng dồn. Mỗi scope giữ 1 KM tốt nhất.
 * KM giảm hóa đơn (scope=INVOICE) được phép kèm thêm 1 KM scope khác.
 */
export function resolveConflicts(results: PromotionResult[]): {
  eligible: PromotionResult[];
  conflicts: { promotionIds: number[]; reason: string }[];
} {
  const conflicts: { promotionIds: number[]; reason: string }[] = [];
  const byScope = new Map<string, PromotionResult[]>();
  for (const r of results) {
    const arr = byScope.get(r.scope) || [];
    arr.push(r);
    byScope.set(r.scope, arr);
  }

  const winners: PromotionResult[] = [];
  for (const [scope, arr] of byScope.entries()) {
    if (arr.length === 1) {
      winners.push(arr[0]);
      continue;
    }
    // Ưu tiên: priority desc -> giá trị (discount + giftValueProxy) desc -> id nhỏ hơn
    const sorted = [...arr].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const va =
        a.discountAmount + a.giftLines.reduce((s, g) => s + g.quantity, 0);
      const vb =
        b.discountAmount + b.giftLines.reduce((s, g) => s + g.quantity, 0);
      if (vb !== va) return vb - va;
      return a.promotionId - b.promotionId;
    });
    winners.push(sorted[0]);
    conflicts.push({
      promotionIds: sorted.map((r) => r.promotionId),
      reason: `Trùng phạm vi "${scope}", không cộng dồn — chọn CT ưu tiên cao nhất (${sorted[0].code})`,
    });
  }

  return { eligible: winners, conflicts };
}

/** Entry point chính. */
export function evaluatePromotions(
  promotions: EnginePromotion[],
  ctx: EngineContext,
): EvaluateOutput {
  const subtotal = calcSubtotal(ctx.items);
  const totalQty = ctx.items.reduce((s, it) => s + it.quantity, 0);

  const results: PromotionResult[] = [];
  for (const p of promotions) {
    if (!isTimeAndThresholdEligible(p, ctx, subtotal, totalQty)) continue;
    const r = computeReward(p, ctx, subtotal);
    if (r) results.push(r);
  }

  const { eligible, conflicts } = resolveConflicts(results);

  // Sắp xếp: KM đã chọn (auto) lên trước, rồi priority
  eligible.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return b.priority - a.priority;
  });

  const estimatedDiscount = eligible
    .filter((r) => r.selected)
    .reduce((s, r) => s + r.discountAmount, 0);

  return {
    subtotal,
    totalQuantity: totalQty,
    eligiblePromotions: eligible,
    conflicts,
    estimatedDiscount,
    estimatedTotalAfter: subtotal - estimatedDiscount,
  };
}
