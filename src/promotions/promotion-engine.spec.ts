import {
  EngineContext,
  EnginePromotion,
  evaluatePromotions,
} from './promotion-engine';
import { PromotionsService } from './promotions.service';

const context = (items: EngineContext['items']): EngineContext => ({
  branchId: 1,
  now: new Date('2026-10-07T10:00:00.000Z'),
  items,
  stockMap: { 999: 100 },
  productNameMap: { 101: 'SP A', 102: 'SP B', 999: 'Quà' },
  productCodeMap: { 101: 'A', 102: 'B', 999: 'GIFT' },
  categoryProductMap: {},
});

const promotion: EnginePromotion = {
  id: 7,
  code: 'KM-7',
  name: 'Mua 2 tặng 1',
  type: 'BUY_X_GET_Y',
  priority: 1,
  stackable: true,
  autoApply: false,
  applyWeekdays: [],
  minOrderValue: 0,
  minQuantity: 0,
  usageCount: 0,
  rewards: [
    {
      buyQuantity: 2,
      rewardType: 'gift',
      rewardProductId: 999,
      rewardQuantity: 1,
      rewardValue: 0,
      buyItems: [{ productId: 101 }, { productId: 102 }],
      rewardItems: [{ productId: 999 }],
    },
  ],
};

describe('promotion engine per-line opt-in', () => {
  it('only counts lines that explicitly enable a promotion', () => {
    const result = evaluatePromotions(
      [promotion],
      context([
        {
          productId: 101,
          quantity: 2,
          price: 100,
          enabledPromotionIds: [7],
        },
        {
          productId: 102,
          quantity: 2,
          price: 100,
          enabledPromotionIds: [],
        },
      ]),
    );

    expect(result.progress[0]).toEqual(
      expect.objectContaining({
        promotionId: 7,
        currentQuantity: 2,
        matchedProductIds: [101],
      }),
    );
    expect(result.eligiblePromotions[0]).toEqual(
      expect.objectContaining({
        promotionId: 7,
        matchedProductIds: [101],
      }),
    );
  });

  it('keeps legacy behavior when enabledPromotionIds is omitted', () => {
    const result = evaluatePromotions(
      [promotion],
      context([
        { productId: 101, quantity: 1, price: 100 },
        { productId: 102, quantity: 1, price: 100 },
      ]),
    );

    expect(result.progress[0]).toEqual(
      expect.objectContaining({
        currentQuantity: 2,
        matchedProductIds: [101, 102],
      }),
    );
  });

  it('does not re-enable excluded lines during invoice re-validation', async () => {
    const service = new PromotionsService({} as any);
    jest
      .spyOn(service as any, 'loadCandidates')
      .mockResolvedValue([promotion]);
    const buildContext = jest
      .spyOn(service as any, 'buildContext')
      .mockImplementation(
        async (
          _branchId: number,
          _customerId: number | null,
          _userId: number | null,
          _now: Date,
          items: EngineContext['items'],
        ) => context(items),
      );

    const result = await service.evaluateForInvoice({
      branchId: 1,
      items: [
        {
          productId: 101,
          quantity: 2,
          price: 100,
          enabledPromotionIds: [7],
        },
        {
          productId: 102,
          quantity: 2,
          price: 100,
          enabledPromotionIds: [],
        },
      ],
      appliedPromotionIds: [7],
    });

    expect(buildContext).toHaveBeenCalledWith(
      1,
      null,
      null,
      expect.any(Date),
      expect.arrayContaining([
        expect.objectContaining({
          productId: 102,
          enabledPromotionIds: [],
        }),
      ]),
      [promotion],
    );
    expect((result as any).applied[0]).toEqual(
      expect.objectContaining({
        promotionId: 7,
        matchedProductIds: [101],
      }),
    );
  });
});
