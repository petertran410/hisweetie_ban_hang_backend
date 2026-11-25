import {
  findInvoiceMirrorsOfOrderPayments,
  findOrphanOrderPaymentMirrors,
  matchOrderPaymentMirrors,
} from './order-payment-mirror.util';

const AT = new Date('2026-11-20T09:32:58.277Z');
const mirror = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  invoiceId: 116,
  orderId: 130121,
  cashFlowId: 900 + id,
  code: `TTTUHD137790-${id}`,
  amount: 3099000,
  paymentDate: AT,
  ...over,
});

describe('matchOrderPaymentMirrors', () => {
  it('ghép phiếu đơn với bản sao cùng đơn, số tiền và paymentDate', () => {
    const [match] = matchOrderPaymentMirrors(
      [{ orderId: 130121, amount: '3099000.00', paymentDate: AT }],
      [
        mirror(1, { amount: 261000 }),
        mirror(2, { paymentDate: new Date(AT.getTime() + 1) }),
        mirror(3, { orderId: 130583 }),
        mirror(4),
      ],
    );
    expect(match?.id).toBe(4);
  });

  it('2 phiếu giống nhau ghép 2 bản sao khác nhau, thiếu bản sao thì null', () => {
    const source = { orderId: 130121, amount: 3099000, paymentDate: AT };
    const matches = matchOrderPaymentMirrors(
      [source, source, source],
      [mirror(1), mirror(2)],
    );
    expect(matches.map((m) => m?.id ?? null)).toEqual([1, 2, null]);
  });
});

describe('findOrphanOrderPaymentMirrors', () => {
  it('chỉ trả bản sao của phiếu đã hủy; phiếu còn hiệu lực giữ bản sao trước', () => {
    const cancelled = {
      id: 1,
      orderId: 130121,
      amount: 3099000,
      paymentDate: AT,
      status: 2,
    };
    const active = { ...cancelled, id: 2, status: 1 };

    // Hủy đứng trước trong danh sách nhưng phiếu còn hiệu lực vẫn được ghép trước.
    expect(
      findOrphanOrderPaymentMirrors([cancelled, active], [mirror(1)]),
    ).toEqual([]);

    expect(
      findOrphanOrderPaymentMirrors(
        [cancelled, active],
        [mirror(1), mirror(2)],
      ),
    ).toEqual([{ mirror: mirror(2), source: cancelled }]);
  });
});

describe('findInvoiceMirrorsOfOrderPayments', () => {
  const setup = (
    candidates: ReturnType<typeof mirror>[],
    others: Record<string, unknown>[] = [],
  ) => {
    const db = {
      invoicePayment: {
        findMany: jest.fn().mockResolvedValue(
          candidates.map(({ orderId, ...row }) => ({
            ...row,
            invoice: { orderId },
          })),
        ),
      },
      orderPayment: { findMany: jest.fn().mockResolvedValue(others) },
    };
    return db;
  };

  it('trả bản sao TTTUHD137790-1 khi hủy TTDH130121-1', async () => {
    const payment = {
      id: 10,
      orderId: 130121,
      amount: 3099000,
      paymentDate: AT,
    };
    // Phiếu sắp hủy vẫn còn status 1 lúc tìm → không được coi là "giữ bản sao".
    const db = setup([mirror(1)], [payment]);

    const result = await findInvoiceMirrorsOfOrderPayments(db, [payment]);

    expect(result).toEqual([mirror(1)]);
    expect(db.invoicePayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          code: { startsWith: 'TTTU' },
          status: { not: 2 },
          invoice: { orderId: { in: [130121] }, status: { not: 2 } },
        },
      }),
    );
  });

  it('không trả bản sao đang thuộc một phiếu khác còn hiệu lực', async () => {
    const payment = {
      id: 10,
      orderId: 130121,
      amount: 3099000,
      paymentDate: AT,
    };
    const db = setup([mirror(1)], [payment, { ...payment, id: 11 }]);

    expect(await findInvoiceMirrorsOfOrderPayments(db, [payment])).toEqual([]);
  });

  it('không có hóa đơn từ đơn thì không đọc phiếu đơn', async () => {
    const db = setup([]);

    expect(
      await findInvoiceMirrorsOfOrderPayments(db, [
        { id: 10, orderId: 1, amount: 1, paymentDate: AT },
      ]),
    ).toEqual([]);
    expect(db.orderPayment.findMany).not.toHaveBeenCalled();
  });
});
