import { buildColdCargoWarning } from './cold-cargo.util';

describe('cold cargo warning', () => {
  it('does not warn when invoices have no cold products', () => {
    expect(
      buildColdCargoWarning([
        {
          invoice: {
            id: 1,
            code: 'HD001',
            details: [
              {
                productId: 10,
                productCode: 'NORMAL-01',
                productName: 'Hàng thường',
                product: { id: 10, cargoType: 'NORMAL' },
              },
            ],
          },
        },
      ]),
    ).toEqual({
      hasColdItems: false,
      coldItemCount: 0,
      coldItems: [],
    });
  });

  it('warns for one cold product and keeps invoice/product context', () => {
    expect(
      buildColdCargoWarning([
        {
          invoice: {
            id: 2,
            code: 'HD002',
            details: [
              {
                productId: 20,
                productCode: 'COLD-01',
                productName: 'Hàng lạnh',
                product: { id: 20, cargoType: 'COLD' },
              },
            ],
          },
        },
      ]),
    ).toEqual({
      hasColdItems: true,
      coldItemCount: 1,
      coldItems: [
        {
          invoiceId: 2,
          invoiceCode: 'HD002',
          productId: 20,
          productCode: 'COLD-01',
          productName: 'Hàng lạnh',
        },
      ],
    });
  });

  it('deduplicates repeated cold lines and ignores missing product relations', () => {
    const result = buildColdCargoWarning([
      {
        invoice: {
          id: 3,
          code: 'HD003',
          details: [
            {
              productId: 30,
              productCode: 'COLD-02',
              productName: 'Kem lạnh',
              product: { id: 30, cargoType: 'COLD' },
            },
            {
              productId: 30,
              productCode: 'COLD-02',
              productName: 'Kem lạnh',
              product: { id: 30, cargoType: 'COLD' },
            },
            {
              productId: 31,
              productCode: 'MISSING',
              productName: 'Không còn sản phẩm',
              product: null,
            },
          ],
        },
      },
    ]);

    expect(result.hasColdItems).toBe(true);
    expect(result.coldItemCount).toBe(1);
    expect(result.coldItems[0].productCode).toBe('COLD-02');
  });

  it('aggregates cold products across multiple invoices', () => {
    const result = buildColdCargoWarning([
      {
        invoice: {
          id: 4,
          code: 'HD004',
          details: [
            {
              productId: 40,
              productCode: 'COLD-03',
              productName: 'Sữa lạnh',
              product: { id: 40, cargoType: 'COLD' },
            },
          ],
        },
      },
      {
        invoice: {
          id: 5,
          code: 'HD005',
          details: [
            {
              productId: 50,
              productCode: 'COLD-04',
              productName: 'Trái cây lạnh',
              product: { id: 50, cargoType: 'COLD' },
            },
          ],
        },
      },
    ]);

    expect(result.hasColdItems).toBe(true);
    expect(result.coldItemCount).toBe(2);
    expect(result.coldItems.map((item) => item.invoiceCode)).toEqual([
      'HD004',
      'HD005',
    ]);
  });
});
