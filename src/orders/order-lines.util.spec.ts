import { isSameOrderLines } from './order-lines.util';

describe('isSameOrderLines', () => {
  const saved = [
    { productId: 1, quantity: '10', price: '50000', lineType: 'normal' },
    {
      productId: 2,
      quantity: '5',
      price: '30000',
      lineType: 'promo_discount',
      conditionType: 'normal',
    },
    {
      productId: 9,
      quantity: '1',
      price: '0',
      lineType: 'gift',
      promotionId: 4,
    },
  ];

  it('coi là giống khi FE gửi lại y nguyên (bỏ qua quà KM, dòng promo_discount gửi dạng thường)', () => {
    expect(
      isSameOrderLines(saved, [
        { productId: 2, quantity: 5, unitPrice: 30000 },
        { productId: 1, quantity: 10, unitPrice: 50000 },
      ]),
    ).toBe(true);
  });

  it('coi là giống khi dòng bị tách nhưng tổng số lượng không đổi', () => {
    expect(
      isSameOrderLines(
        [
          {
            productId: 1,
            quantity: 6,
            price: 50000,
            lineType: 'promo_discount',
          },
          { productId: 1, quantity: 4, price: 50000, lineType: 'normal' },
        ],
        [{ productId: 1, quantity: 10, unitPrice: 50000 }],
      ),
    ).toBe(true);
  });

  it('phát hiện thêm sản phẩm, đổi số lượng, đổi giá, xóa dòng', () => {
    const base = [
      { productId: 1, quantity: 10, unitPrice: 50000 },
      { productId: 2, quantity: 5, unitPrice: 30000 },
    ];
    expect(
      isSameOrderLines(saved, [
        ...base,
        { productId: 3, quantity: 1, unitPrice: 1 },
      ]),
    ).toBe(false);
    expect(
      isSameOrderLines(saved, [{ ...base[0], quantity: 11 }, base[1]]),
    ).toBe(false);
    expect(
      isSameOrderLines(saved, [{ ...base[0], unitPrice: 49000 }, base[1]]),
    ).toBe(false);
    expect(isSameOrderLines(saved, [base[0]])).toBe(false);
  });

  it('tính quà thủ công nhưng bỏ qua dòng mua kèm giá KM', () => {
    expect(
      isSameOrderLines(saved, [
        { productId: 1, quantity: 10, unitPrice: 50000 },
        { productId: 2, quantity: 5, unitPrice: 30000 },
        { productId: 7, quantity: 2, unitPrice: 0, lineType: 'gift' },
      ]),
    ).toBe(false);
    expect(
      isSameOrderLines(saved, [
        { productId: 1, quantity: 10, unitPrice: 50000 },
        { productId: 2, quantity: 5, unitPrice: 30000 },
        {
          productId: 8,
          quantity: 1,
          unitPrice: 20000,
          lineType: 'discounted_buy',
          promotionId: 4,
        },
      ]),
    ).toBe(true);
  });
});
