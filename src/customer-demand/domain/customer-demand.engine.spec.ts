import { resolveCustomerDemand } from './customer-demand.engine';

describe('resolveCustomerDemand', () => {
  const month = (
    demandMonth: string,
    status: string,
    productId: number,
    quantityBase: number,
    customerId = 1,
  ) => ({
    id: 10,
    demandMonth,
    status,
    customerId,
    customerName: 'Khách OEM',
    lines: [{ productId, quantityBase }],
  });

  it('chỉ cộng tháng confirmed trong horizon và tự loại tháng đã qua', () => {
    const result = resolveCustomerDemand(
      [
        month('2026-08-01', 'CONFIRMED', 1, 20),
        month('2026-09-01', 'DRAFT', 1, 30),
        month('2026-10-01', 'CONFIRMED', 1, 40),
        month('2026-12-01', 'CONFIRMED', 1, 50),
      ],
      '2026-09-09',
      60,
    );

    expect(result.totalByProduct.get(1)).toBe(40);
    expect(result.includedMonths).toEqual(['2026-10']);
  });

  it('cộng nhiều tháng và nhiều khách hàng theo từng SKU', () => {
    const result = resolveCustomerDemand(
      [
        month('2026-09-01', 'CONFIRMED', 1, 20, 1),
        month('2026-10-01', 'CONFIRMED', 1, 30, 2),
        month('2026-09-01', 'CONFIRMED', 2, 15, 3),
      ],
      '2026-09-09',
      90,
    );

    expect(result.totalByProduct.get(1)).toBe(50);
    expect(result.totalByProduct.get(2)).toBe(15);
    expect(result.detailsByProduct.get(1)).toHaveLength(2);
  });

  it('không cộng Draft hoặc Cancelled', () => {
    const result = resolveCustomerDemand(
      [
        month('2026-09-01', 'DRAFT', 1, 40),
        month('2026-09-01', 'CANCELLED', 1, 50, 2),
        month('2026-09-01', 'CONFIRMED', 1, 15, 3),
      ],
      '2026-09-09',
      90,
    );
    expect(result.totalByProduct.get(1)).toBe(15);
  });

  it('cộng tháng hiện tại đã Confirmed', () => {
    const result = resolveCustomerDemand(
      [month('2026-09-01', 'CONFIRMED', 1, 25)],
      '2026-09-09',
      30,
    );
    expect(result.totalByProduct.get(1)).toBe(25);
    expect(result.includedMonths).toEqual(['2026-09']);
  });

  it('không cộng tháng nằm ngoài planning horizon', () => {
    const result = resolveCustomerDemand(
      [month('2026-12-01', 'CONFIRMED', 1, 80)],
      '2026-09-09',
      30,
    );
    expect(result.totalByProduct.get(1)).toBeUndefined();
    expect(result.includedMonths).toEqual([]);
  });
});
