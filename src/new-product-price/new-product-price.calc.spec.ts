import {
  goodsPriceVnd,
  leadtimeDays,
  priceAnalysis,
} from './new-product-price.calc';

describe('goodsPriceVnd', () => {
  it('= Giá hàng × Tỉ giá; thiếu tỉ giá coi như 1', () => {
    expect(goodsPriceVnd({ goodsPrice: 12.5, exchangeRate: 3500 })).toBe(43750);
    expect(goodsPriceVnd({ goodsPrice: 100000 })).toBe(100000);
    expect(goodsPriceVnd({})).toBeNull();
  });
});

describe('priceAnalysis', () => {
  const rows = priceAnalysis({
    cogsHn: 108000,
    cogsSg: 97200,
    cogsDt: 100000,
    priceHnRetail: 162000,
    priceSgWholesale: 129600,
    priceShopee: 150000,
    priceDlcl: 0,
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  it('HN Lẻ: trước VAT, lãi, tỷ suất theo giá vốn HN', () => {
    expect(byKey.HN_RETAIL.priceExVat).toBeCloseTo(150000);
    expect(byKey.HN_RETAIL.cogs).toBeCloseTo(100000);
    expect(byKey.HN_RETAIL.profit).toBeCloseTo(50000);
    expect(byKey.HN_RETAIL.margin).toBeCloseTo(0.5);
  });

  it('SG Buôn theo giá vốn SG', () => {
    expect(byKey.SG_WHOLESALE.cogs).toBeCloseTo(90000);
    expect(byKey.SG_WHOLESALE.profit).toBeCloseTo(30000);
    expect(byKey.SG_WHOLESALE.margin).toBeCloseTo(1 / 3);
  });

  it('Shopee không chia 1.08, so với giá vốn CH Diệp Trà', () => {
    expect(byKey.SHOPEE.priceExVat).toBe(150000);
    expect(byKey.SHOPEE.profit).toBe(50000);
    expect(byKey.SHOPEE.margin).toBe(0.5);
  });

  it('giá = 0 hoặc trống thì để trống như Lark', () => {
    expect(byKey.HN_DLCL.price).toBeNull();
    expect(byKey.HN_DLCL.profit).toBeNull();
    expect(byKey.OEM.margin).toBeNull();
  });
});

describe('leadtimeDays', () => {
  const createdAt = new Date('2026-11-01T08:00:00Z');
  it('tính tới khi hoàn thành', () => {
    expect(
      leadtimeDays({ createdAt, doneAt: new Date('2026-11-11T07:00:00Z') }),
    ).toBe(9);
  });
  it('chưa xong thì tính tới hiện tại', () => {
    expect(leadtimeDays({ createdAt }, new Date('2026-11-04T09:00:00Z'))).toBe(
      3,
    );
  });
});
