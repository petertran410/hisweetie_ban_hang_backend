import {
  EngineContext,
  EnginePromotion,
  computeReward,
  evaluatePromotions,
} from './promotion-engine';

/**
 * Test cho cơ chế trần quà tặng 2 tầng (lifetime):
 *  - Trần riêng từng SP quà (rewardItems[].rewardLimit)
 *  - Trần tổng toàn chương trình (maxRewardQuantity)
 *
 * Kịch bản gốc của người dùng:
 *   Mua 15 ABC → tặng (chọn 1): ABC (trần 30) | BCF (trần 30) | CFD (trần 40)
 *   Trần tổng chương trình: 100
 */

const ABC = 1;
const BCF = 2;
const CFD = 3;

function makePromotion(
  overrides: Partial<EnginePromotion> = {},
): EnginePromotion {
  return {
    id: 100,
    code: 'KM',
    name: 'Mua 15 ABC tặng',
    type: 'BUY_X_GET_Y',
    priority: 0,
    stackable: false,
    autoApply: false,
    applyWeekdays: [],
    minOrderValue: 0,
    minQuantity: 0,
    maxDiscountAmount: null,
    maxRewardQuantity: 100,
    usageLimit: null,
    usageCount: 0,
    rewards: [
      {
        buyProductId: null,
        buyCategoryName: null,
        buyQuantity: 15,
        rewardType: 'gift',
        rewardProductId: null,
        rewardQuantity: 1,
        rewardValue: 0,
        buyItems: [{ productId: ABC }],
        rewardItems: [
          { productId: ABC, rewardLimit: 30 },
          { productId: BCF, rewardLimit: 30 },
          { productId: CFD, rewardLimit: 40 },
        ],
      },
    ],
    ...overrides,
  };
}

function makeContext(
  boughtAbc: number,
  issued: { byProduct: Record<number, number>; total: number },
): EngineContext {
  return {
    branchId: 1,
    now: new Date(),
    items: [{ productId: ABC, quantity: boughtAbc, price: 10000 }],
    stockMap: { [ABC]: 999, [BCF]: 999, [CFD]: 999 },
    productNameMap: { [ABC]: 'ABC', [BCF]: 'BCF', [CFD]: 'CFD' },
    productCodeMap: { [ABC]: 'ABC', [BCF]: 'BCF', [CFD]: 'CFD' },
    categoryProductMap: {},
    rewardIssuedMap: { 100: issued },
  };
}

describe('promotion-engine — trần quà 2 tầng lifetime', () => {
  it('trả về remaining đúng cho từng option khi chưa tặng gì', () => {
    const p = makePromotion();
    // Mua 30 ABC → times = 2 → muốn tặng 2
    const ctx = makeContext(30, { byProduct: {}, total: 0 });
    const r = computeReward(p, ctx, 300000)!;
    expect(r).not.toBeNull();
    expect(r.requiresChoice).toBe(true);
    const byId = Object.fromEntries(
      (r.rewardOptions || []).map((o) => [o.productId, o.remaining]),
    );
    expect(byId[ABC]).toBe(30);
    expect(byId[BCF]).toBe(30);
    expect(byId[CFD]).toBe(40);
  });

  it('trần riêng SP chặn: BCF đã tặng 30 → BCF bị loại khỏi options', () => {
    const p = makePromotion();
    const ctx = makeContext(30, {
      byProduct: { [BCF]: 30 },
      total: 30,
    });
    const r = computeReward(p, ctx, 300000)!;
    const ids = (r.rewardOptions || []).map((o) => o.productId);
    expect(ids).not.toContain(BCF);
    expect(ids).toContain(ABC);
    expect(ids).toContain(CFD);
    const byId = Object.fromEntries(
      (r.rewardOptions || []).map((o) => [o.productId, o.remaining]),
    );
    // Tổng đã tặng 30 → overall remaining = 70; ABC riêng 30 → min = 30
    expect(byId[ABC]).toBe(30);
    // CFD riêng 40, overall 70 → min = 40
    expect(byId[CFD]).toBe(40);
  });

  it('trần tổng chặn: đã tặng tổng 80 → mọi option bị cap còn 20', () => {
    const p = makePromotion();
    const ctx = makeContext(30, {
      byProduct: { [ABC]: 10, [BCF]: 10, [CFD]: 60 },
      total: 80,
    });
    const r = computeReward(p, ctx, 300000)!;
    const byId = Object.fromEntries(
      (r.rewardOptions || []).map((o) => [o.productId, o.remaining]),
    );
    // overall remaining = 100 - 80 = 20
    // ABC: min(30-10, 20) = 20
    expect(byId[ABC]).toBe(20);
    // BCF: min(30-10, 20) = 20
    expect(byId[BCF]).toBe(20);
    // CFD: min(40-60=0 -> 0, 20) = 0 → bị loại
    expect(byId[CFD]).toBeUndefined();
  });

  it('option đơn (1 SP) tự sinh giftLine cap theo remaining', () => {
    const p = makePromotion({
      rewards: [
        {
          buyProductId: null,
          buyCategoryName: null,
          buyQuantity: 15,
          rewardType: 'gift',
          rewardProductId: null,
          rewardQuantity: 1,
          rewardValue: 0,
          buyItems: [{ productId: ABC }],
          rewardItems: [{ productId: BCF, rewardLimit: 30 }],
        },
      ],
    });
    // Mua 15*40 = 600 → times = 40 → muốn tặng 40, nhưng BCF trần 30, đã tặng 28 → còn 2
    const ctx = makeContext(600, { byProduct: { [BCF]: 28 }, total: 28 });
    const r = computeReward(p, ctx, 6000000)!;
    expect(r.requiresChoice).toBe(false);
    expect(r.giftLines).toHaveLength(1);
    expect(r.giftLines[0].productId).toBe(BCF);
    expect(r.giftLines[0].quantity).toBe(2);
    expect(r.rewardQuantity).toBe(2);
  });

  it('hết suất hoàn toàn (tổng đạt 100) → không còn option, trả null', () => {
    const p = makePromotion();
    const ctx = makeContext(30, {
      byProduct: { [ABC]: 30, [BCF]: 30, [CFD]: 40 },
      total: 100,
    });
    const r = computeReward(p, ctx, 300000);
    expect(r).toBeNull();
  });

  it('không cấu hình trần → remaining = null (không giới hạn)', () => {
    const p = makePromotion({
      maxRewardQuantity: null,
      rewards: [
        {
          buyProductId: null,
          buyCategoryName: null,
          buyQuantity: 15,
          rewardType: 'gift',
          rewardProductId: null,
          rewardQuantity: 1,
          rewardValue: 0,
          buyItems: [{ productId: ABC }],
          rewardItems: [
            { productId: ABC, rewardLimit: null },
            { productId: BCF, rewardLimit: null },
          ],
        },
      ],
    });
    const ctx = makeContext(30, { byProduct: {}, total: 0 });
    const r = computeReward(p, ctx, 300000)!;
    (r.rewardOptions || []).forEach((o) => expect(o.remaining).toBeNull());
  });

  it('nhiều mã X: không cộng chéo SL giữa các mã', () => {
    const SECOND_X = 4;
    const p = makePromotion({
      rewards: [
        {
          buyProductId: null,
          buyCategoryName: null,
          buyQuantity: 15,
          rewardType: 'gift',
          rewardProductId: null,
          rewardQuantity: 1,
          rewardValue: 0,
          buyItems: [{ productId: ABC }, { productId: SECOND_X }],
          rewardItems: [{ productId: BCF, rewardLimit: 30 }],
        },
      ],
    });
    const ctx: EngineContext = {
      ...makeContext(15, { byProduct: {}, total: 0 }),
      items: [
        { productId: ABC, quantity: 15, price: 10000 },
        { productId: SECOND_X, quantity: 1, price: 10000 },
      ],
      stockMap: { [ABC]: 999, [BCF]: 999, [SECOND_X]: 999 },
      productNameMap: {
        [ABC]: 'ABC',
        [BCF]: 'BCF',
        [SECOND_X]: 'SECOND_X',
      },
      productCodeMap: {
        [ABC]: 'ABC',
        [BCF]: 'BCF',
        [SECOND_X]: 'SECOND_X',
      },
    };

    const result = evaluatePromotions([p], ctx);
    expect(result.eligiblePromotions).toHaveLength(1);
    expect(result.eligiblePromotions[0].triggerProductId).toBe(ABC);
    expect(result.eligiblePromotions[0].rewardQuantity).toBe(1);
  });

  it('nhiều mã X: mỗi mã đủ ngưỡng sinh một kết quả riêng', () => {
    const SECOND_X = 4;
    const p = makePromotion({
      rewards: [
        {
          buyProductId: null,
          buyCategoryName: null,
          buyQuantity: 15,
          rewardType: 'gift',
          rewardProductId: null,
          rewardQuantity: 1,
          rewardValue: 0,
          buyItems: [{ productId: ABC }, { productId: SECOND_X }],
          rewardItems: [{ productId: BCF, rewardLimit: 30 }],
        },
      ],
    });
    const ctx: EngineContext = {
      ...makeContext(15, { byProduct: {}, total: 0 }),
      items: [
        { productId: ABC, quantity: 15, price: 10000 },
        { productId: SECOND_X, quantity: 15, price: 10000 },
      ],
      stockMap: { [ABC]: 999, [BCF]: 999, [SECOND_X]: 999 },
      productNameMap: {
        [ABC]: 'ABC',
        [BCF]: 'BCF',
        [SECOND_X]: 'SECOND_X',
      },
      productCodeMap: {
        [ABC]: 'ABC',
        [BCF]: 'BCF',
        [SECOND_X]: 'SECOND_X',
      },
    };

    const result = evaluatePromotions([p], ctx);
    expect(result.eligiblePromotions).toHaveLength(2);
    expect(
      result.eligiblePromotions.map((r) => r.triggerProductId).sort(),
    ).toEqual([ABC, SECOND_X]);
    expect(result.eligiblePromotions.every((r) => r.rewardQuantity === 1)).toBe(
      true,
    );
  });
});
