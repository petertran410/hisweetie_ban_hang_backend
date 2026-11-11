import { filterInventoryLogPrices } from './product-inventory-log-visibility.util';

describe('filterInventoryLogPrices', () => {
  const sources = [
    ['invoice', false],
    ['return_order', false],
    ['consignment', false],
    ['consignment_return', false],
    ['purchase_order', true],
    ['supplier_return', true],
  ] as const;

  describe.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('cost=%s sale=%s', (canViewCost, canViewSale) => {
    it.each(sources)(
      'filters %s without changing inventory data',
      (refType, costBased) => {
        const log = {
          refType,
          costPrice: 750,
          transactionPrice: 1200,
          quantity: 3,
          tonCuoi: 20,
          refCode: 'TEST-1',
        };
        const filtered = filterInventoryLogPrices(
          log,
          canViewCost,
          canViewSale,
        );
        expect('costPrice' in filtered).toBe(canViewCost);
        expect('transactionPrice' in filtered).toBe(
          costBased ? canViewCost : canViewSale,
        );
        expect(filtered).toMatchObject({
          quantity: 3,
          tonCuoi: 20,
          refCode: 'TEST-1',
        });
        expect(log.costPrice).toBe(750);
        expect(log.transactionPrice).toBe(1200);
      },
    );

    it.each([undefined, 'transfer', 'unknown'])(
      'requires both price permissions for unclassified source %s',
      (refType) => {
        const filtered = filterInventoryLogPrices(
          { refType, costPrice: 750, transactionPrice: 1200 },
          canViewCost,
          canViewSale,
        );
        expect('transactionPrice' in filtered).toBe(canViewCost && canViewSale);
      },
    );
  });

  it('preserves zero and null prices when permitted', () => {
    expect(
      filterInventoryLogPrices(
        { refType: 'invoice', costPrice: 0, transactionPrice: null },
        true,
        true,
      ),
    ).toEqual({ refType: 'invoice', costPrice: 0, transactionPrice: null });
  });
});
