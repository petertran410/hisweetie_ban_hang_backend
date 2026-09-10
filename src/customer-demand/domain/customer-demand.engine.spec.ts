import {
  InboundOrderEvent,
  resolveCustomerDemand,
  resolvePastCustomerDemand,
} from './customer-demand.engine';

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

describe('resolvePastCustomerDemand', () => {
  const month = (
    demandMonth: string,
    status: string,
    productId: number,
    quantityBase: number,
    customerId = 1,
  ) => ({
    id: Number(demandMonth.slice(5, 7)),
    demandMonth,
    status,
    customerId,
    customerName: 'Khách OEM',
    lines: [{ productId, quantityBase }],
  });

  it('cộng 3 tháng lịch đã kết thúc và bỏ tháng hiện tại', () => {
    const result = resolvePastCustomerDemand(
      [
        month('2026-05-01', 'CONFIRMED', 1, 10),
        month('2026-06-01', 'CONFIRMED', 1, 20),
        month('2026-07-01', 'CONFIRMED', 1, 30),
        month('2026-08-01', 'CONFIRMED', 1, 40),
        month('2026-09-01', 'CONFIRMED', 1, 50),
      ],
      '2026-09-10',
    );
    expect(result.totalByProduct.get(1)).toBe(90);
    expect(result.includedMonths).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('không cộng Draft/Cancelled trong cửa sổ 3 tháng trước', () => {
    const result = resolvePastCustomerDemand(
      [
        month('2026-07-01', 'DRAFT', 1, 80),
        month('2026-08-01', 'CANCELLED', 1, 90),
        month('2026-08-01', 'CONFIRMED', 1, 15),
      ],
      '2026-09-10',
    );
    expect(result.totalByProduct.get(1)).toBe(15);
  });

  it('cộng nhiều khách hàng cùng SKU', () => {
    const result = resolvePastCustomerDemand(
      [
        month('2026-07-01', 'CONFIRMED', 1, 12, 1),
        month('2026-08-01', 'CONFIRMED', 1, 8, 2),
      ],
      '2026-09-10',
    );
    expect(result.totalByProduct.get(1)).toBe(20);
    expect(result.detailsByProduct.get(1)).toHaveLength(2);
  });
});

describe('collapse overlapping OEM demand by inbound orders', () => {
  const pearJam = 11;
  const demand = (
    id: number,
    createdAt: string,
    quantityBase: number,
    extras?: {
      customerId?: number;
      productId?: number;
      demandMonth?: string;
      status?: string;
    },
  ) => ({
    id,
    demandMonth: extras?.demandMonth ?? '2026-10-01',
    status: extras?.status ?? 'CONFIRMED',
    customerId: extras?.customerId ?? 1,
    customerName: 'Khách OEM',
    createdAt,
    lines: [
      {
        productId: extras?.productId ?? pearJam,
        quantityBase,
        createdAt,
      },
    ],
  });
  const inbound = (
    orderDate: string,
    status = 1,
    productId = pearJam,
  ): InboundOrderEvent => ({
    productId,
    orderDate,
    status,
  });

  it('chỉ tính Demand 2/9 khi có PĐN xen giữa 31/8 và 2/9', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 100),
        demand(2, '2026-09-02T08:00:00.000Z', 80),
      ],
      '2026-09-09',
      90,
      [inbound('2026-09-01T00:00:00.000Z')],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(80);
    const details = result.detailsByProduct.get(pearJam) ?? [];
    expect(details.filter((row) => !row.skipped)).toHaveLength(1);
    expect(details.find((row) => row.skipped)?.quantityBase).toBe(100);
    expect(details.find((row) => row.skipped)?.skipReason).toBe(
      'INBOUND_BETWEEN',
    );
  });

  it('cộng cả hai Demand khi PĐN chỉ xuất hiện sau Demand mới nhất', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 100),
        demand(2, '2026-09-02T08:00:00.000Z', 80),
      ],
      '2026-09-09',
      90,
      [inbound('2026-09-03T00:00:00.000Z')],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(180);
    expect(
      (result.detailsByProduct.get(pearJam) ?? []).every((row) => !row.skipped),
    ).toBe(true);
  });

  it('chỉ tính Demand 2/9 khi có PĐN xen giữa và thêm PĐN sau 2/9', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 100),
        demand(2, '2026-09-02T08:00:00.000Z', 80),
      ],
      '2026-09-09',
      90,
      [
        inbound('2026-09-01T00:00:00.000Z'),
        inbound('2026-09-03T00:00:00.000Z'),
      ],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(80);
  });

  it('cộng D2+D3 khi PĐN chỉ nằm giữa D1 và D2', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 10),
        demand(2, '2026-09-02T08:00:00.000Z', 20),
        demand(3, '2026-09-05T08:00:00.000Z', 30),
      ],
      '2026-09-09',
      90,
      [inbound('2026-09-01T00:00:00.000Z')],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(50);
  });

  it('chỉ giữ Demand cuối khi mọi khoảng đều có PĐN xen giữa', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 10),
        demand(2, '2026-09-02T08:00:00.000Z', 20),
        demand(3, '2026-09-05T08:00:00.000Z', 30),
      ],
      '2026-09-09',
      90,
      [
        inbound('2026-09-01T00:00:00.000Z'),
        inbound('2026-09-04T00:00:00.000Z'),
      ],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(30);
  });

  it('không gộp Demand của khách khác, SKU khác hoặc tháng khác', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 100),
        demand(2, '2026-09-02T08:00:00.000Z', 80, { customerId: 2 }),
        demand(3, '2026-09-02T08:00:00.000Z', 50, { productId: 99 }),
        demand(4, '2026-09-02T08:00:00.000Z', 40, {
          demandMonth: '2026-11-01',
        }),
      ],
      '2026-09-09',
      90,
      [inbound('2026-09-01T00:00:00.000Z')],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(220);
    expect(result.totalByProduct.get(99)).toBe(50);
  });

  it('bỏ qua Draft/Cancelled Demand và PĐN phiếu tạm hoặc đã hủy', () => {
    const result = resolveCustomerDemand(
      [
        demand(1, '2026-08-31T08:00:00.000Z', 100, { status: 'DRAFT' }),
        demand(2, '2026-08-31T09:00:00.000Z', 70, { status: 'CANCELLED' }),
        demand(3, '2026-08-31T10:00:00.000Z', 40),
        demand(4, '2026-09-02T08:00:00.000Z', 80),
      ],
      '2026-09-09',
      90,
      [
        inbound('2026-09-01T00:00:00.000Z', 0),
        inbound('2026-09-01T01:00:00.000Z', 4),
      ],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(120);
  });

  it('cộng dồn khi không có PĐN và luôn giữ Demand đơn lẻ', () => {
    expect(
      resolveCustomerDemand(
        [
          demand(1, '2026-08-31T08:00:00.000Z', 100),
          demand(2, '2026-09-02T08:00:00.000Z', 80),
        ],
        '2026-09-09',
        90,
        [],
      ).totalByProduct.get(pearJam),
    ).toBe(180);
    expect(
      resolveCustomerDemand(
        [demand(1, '2026-08-31T08:00:00.000Z', 100)],
        '2026-09-09',
        90,
        [inbound('2026-09-01T00:00:00.000Z')],
      ).totalByProduct.get(pearJam),
    ).toBe(100);
  });

  it('áp cùng rule collapse trước khi trừ Demand 3 tháng trước', () => {
    const result = resolvePastCustomerDemand(
      [
        demand(1, '2026-06-01T08:00:00.000Z', 100, {
          demandMonth: '2026-08-01',
        }),
        demand(2, '2026-06-10T08:00:00.000Z', 40, {
          demandMonth: '2026-08-01',
        }),
      ],
      '2026-09-10',
      3,
      [inbound('2026-06-05T00:00:00.000Z')],
    );
    expect(result.totalByProduct.get(pearJam)).toBe(40);
    expect(
      (result.detailsByProduct.get(pearJam) ?? []).filter((row) => row.skipped),
    ).toHaveLength(1);
  });
});
