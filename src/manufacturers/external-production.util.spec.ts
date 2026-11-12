import { externalCosts, materialAmount, ownConversion } from './external-production.util';

describe('external production cost and unit rules', () => {
  it('700 owned + 300 manufacturer, no machining: only 300 is payable', () => {
    const result = externalCosts([{ description: '', pricingMode: 'UNIT_PRICE', quantity: 300, unit: 'kg', unitPrice: 100 }], 0, 'VND', 1, 700 * 50);
    expect(result).toMatchObject({ manufacturerMaterialCost: 30000, processingFee: 0, totalPayable: 30000, totalCost: 65000 });
  });

  it('80 A sent and 160 A received preserves the value of the original 80', () => {
    const { totalCost, totalPayable } = externalCosts([{ pricingMode: 'UNIT_PRICE', quantity: 80, unit: 'kg', unitPrice: 200 }], 3000, 'VND', 1, 80 * 100);
    expect(totalPayable).toBe(19000);
    expect(totalCost / 160).toBe(168.75);
  });

  it('a confidential component only needs a lump sum', () => {
    expect(materialAmount({ pricingMode: 'TOTAL', amount: 12345.67 })).toBe(12345.67);
    expect(() => materialAmount({ pricingMode: 'UNIT_PRICE', unitPrice: 100 })).toThrow();
  });

  it('allows a free manufacturer component and zero machining', () => {
    expect(externalCosts([{ pricingMode: 'TOTAL', amount: 0 }], 0, 'VND', 1, 500)).toMatchObject({ totalPayable: 0, totalCost: 500 });
  });

  it('uses decimal arithmetic and keeps CNY/VND component totals consistent', () => {
    expect(materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 3, unit: 'kg', unitPrice: 0.1 })).toBe(0.3);
    const result = externalCosts([{ pricingMode: 'TOTAL', amount: 1.23 }], 0.25, 'CNY', 3500.55, 100);
    expect(result.totalForeignPayable).toBe(1.48);
    expect(result.totalPayable).toBe(5181);
    expect(result.manufacturerMaterialCost + result.processingFee).toBe(result.totalPayable);
    expect(result.totalCost).toBe(5281);
    expect(() => externalCosts([{ pricingMode: 'TOTAL', amount: 1 }], 0, 'CNY', 0)).toThrow();
  });

  it('converts weight to stock units, including pieces with no weight', () => {
    expect(ownConversion({ unit: 'túi', weight: 0.5, weightUnit: 'kg' }, 'kg')).toBe(2);
    expect(ownConversion({ unit: 'túi', weight: 500 }, 'g')).toBe(0.002);
    expect(ownConversion({ unit: 'chiếc' }, 'chiếc')).toBe(1);
    expect(() => ownConversion({ unit: 'chiếc' }, 'kg')).toThrow();
  });
  it('converts g ↔ kg when the price unit differs, legacy lines keep qty × price', () => {
    expect(materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 300, unit: 'g', unitPrice: 250000, priceUnit: 'kg' })).toBe(75000);
    expect(materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 2, unit: 'kg', unitPrice: 300, priceUnit: 'g' })).toBe(600000);
    expect(materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 300, unit: 'g', unitPrice: 250000, priceUnit: null })).toBe(75000000);
    expect(materialAmount({ pricingMode: 'TOTAL', amount: 10, priceUnit: 'kg' })).toBe(10);
    expect(() => materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 3, unit: 'gói', unitPrice: 1, priceUnit: 'kg' })).toThrow();
  });

  it('rounds slip quantity to 4 decimals before pricing', () => {
    expect(materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 0.12345, unit: 'kg', unitPrice: 10000, priceUnit: 'kg' })).toBe(1235);
    expect(() => materialAmount({ pricingMode: 'UNIT_PRICE', quantity: 0.00001, unit: 'kg', unitPrice: 1, priceUnit: 'kg' })).toThrow();
  });

  it('CNY totals include converted-unit lines', () => {
    const result = externalCosts([{ pricingMode: 'UNIT_PRICE', quantity: 500, unit: 'g', unitPrice: 20, priceUnit: 'kg' }], 5, 'CNY', 3500, 0);
    expect(result).toMatchObject({ totalForeignPayable: 15, totalPayable: 52500, processingFee: 17500, manufacturerMaterialCost: 35000 });
  });
});
