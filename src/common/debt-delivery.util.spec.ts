import { Prisma } from '@prisma/client';
import {
  assertCanConfirmOrder,
  assertCanCreateInvoiceForCustomer,
  assertPrepaidPolicySatisfied,
  customerDebtForOrderPrepaidCheck,
  hasOpenStopDeliveryHold,
  isDebtRuleUnset,
} from './debt-delivery.util';

const asTx = (db: unknown) => db as Prisma.TransactionClient;

type MockPayment = { code: string; orderId: number; amount: number };

/**
 * Mock các truy vấn của customerDebtForOrderPrepaidCheck: HĐ còn hiệu lực của
 * đơn (aggregate), lần thanh toán đang gắn đơn, phiếu thu theo mã, HĐ của các
 * đơn khác. Phiếu thu sinh từ chính danh sách thanh toán (cùng mã, cùng tiền).
 * Hành vi đầy đủ trên sổ cái giả: prepaid-rule.ledger.spec.ts.
 */
const debtQueries = (
  opts: {
    thisOrderInvoices?: number;
    payments?: MockPayment[];
    otherInvoices?: Array<{ orderId: number; grandTotal: number }>;
  } = {},
) => {
  const payments = opts.payments ?? [];
  return {
    invoice: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { grandTotal: opts.thisOrderInvoices ?? 0 },
      }),
      findMany: jest.fn().mockResolvedValue(opts.otherInvoices ?? []),
    },
    orderPayment: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          payments.map(({ code, orderId }) => ({ code, orderId })),
        ),
    },
    cashFlow: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          payments.map(({ code, amount }) => ({ code, amount })),
        ),
    },
  };
};

describe('customerDebtForOrderPrepaidCheck', () => {
  it('bỏ phần của chính đơn + tiền đơn khác đang xử lý, đúng điều kiện truy vấn', async () => {
    const db = debtQueries({
      payments: [
        { code: 'TTDH1-1', orderId: 1, amount: 500000 },
        { code: 'TTDH2-1', orderId: 2, amount: 1000000 },
      ],
    });

    // Công nợ −1,5M = 500k trả trên đơn này + 1M trả trên đơn B chưa ra HĐ.
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: -1500000,
      }),
    ).resolves.toBe(0);

    expect(db.invoice.aggregate).toHaveBeenCalledWith({
      where: { orderId: 1, customerId: 3, status: { not: 2 } },
      _sum: { grandTotal: true },
    });
    expect(db.orderPayment.findMany).toHaveBeenCalledWith({
      where: {
        status: { not: 2 },
        OR: [
          { orderId: 1 },
          { order: { customerId: 3, status: { in: [1, 5, 6] } } },
        ],
      },
      select: { code: true, orderId: true },
    });
    expect(db.cashFlow.findMany).toHaveBeenCalledWith({
      where: {
        code: { in: ['TTDH1-1', 'TTDH2-1'] },
        partnerType: 'C',
        partnerId: 3,
        isReceipt: true,
        status: { not: 2 },
      },
      select: { code: true, amount: true },
    });
    expect(db.invoice.findMany).toHaveBeenCalledWith({
      where: { orderId: { in: [2] }, customerId: 3, status: { not: 2 } },
      select: { orderId: true, grandTotal: true },
    });
  });

  it('giữ tiền trả trước tự do (không gắn đơn nào)', async () => {
    const db = debtQueries({
      payments: [{ code: 'TTDH1-1', orderId: 1, amount: 500000 }],
    });
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: -1100000,
      }),
    ).resolves.toBe(-600000);
  });

  it('đơn đã có HĐ: bỏ cả HĐ của đơn lẫn phiếu thu của đơn', async () => {
    // Đơn 1M đã trả đủ, HĐ 1 là 600k → công nợ = 600k − 1M = −400k.
    const db = debtQueries({
      thisOrderInvoices: 600000,
      payments: [{ code: 'TTDH1-1', orderId: 1, amount: 1000000 }],
    });
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: -400000,
      }),
    ).resolves.toBe(0);
  });

  it('đơn khác đã ra 1 phần: chỉ phần trả vượt số đã ra HĐ là tiền đơn đó giữ', async () => {
    // Đơn B trả 1M, mới ra HĐ 600k → công nợ −400k, cả 400k là của đơn B.
    const db = debtQueries({
      payments: [{ code: 'TTDH2-1', orderId: 2, amount: 1000000 }],
      otherInvoices: [{ orderId: 2, grandTotal: 600000 }],
    });
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: -400000,
      }),
    ).resolves.toBe(0);
  });

  it('đơn khác còn nợ (HĐ > tiền trả): không được xóa nợ đó để tăng tiền tự do', async () => {
    const db = debtQueries({
      payments: [{ code: 'TTDH2-1', orderId: 2, amount: 200000 }],
      otherInvoices: [{ orderId: 2, grandTotal: 600000 }],
    });
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: 100000,
      }),
    ).resolves.toBe(100000);
  });

  it('không có lần thanh toán nào đang gắn đơn → không truy vấn phiếu thu', async () => {
    const db = debtQueries();
    await expect(
      customerDebtForOrderPrepaidCheck(asTx(db), {
        orderId: 1,
        customerId: 3,
        totalDebt: -200000,
      }),
    ).resolves.toBe(-200000);
    expect(db.cashFlow.findMany).not.toHaveBeenCalled();
    expect(db.invoice.findMany).not.toHaveBeenCalled();
  });
});

describe('debt delivery lifecycle guard', () => {
  it('keeps every active stop hold blocked regardless of provisional amount', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
  });

  it('does not release an active hold for a qualifying payment', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
  });

  it('keeps a multi-customer transaction blocked until accounting allocates it', async () => {
    const db = {
      debtTicketCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
          requiredPaymentAmount: 100,
          provisionalPaymentAmount: null,
          provisionalSepayTxId: null,
        }),
      },
    };

    await expect(hasOpenStopDeliveryHold(db, 3)).resolves.toBe(true);
    await expect(assertCanCreateInvoiceForCustomer(db, 3)).rejects.toThrow(
      'phiếu ngừng đi hàng chưa kết thúc',
    );
  });
});

describe('assertPrepaidPolicySatisfied', () => {
  const prepaid = { isActive: true, requireFullPaymentForInvoice: true };
  const base = {
    policy: prepaid,
    paidAmount: 0,
    grandTotal: 100000,
    currentCustomerDebt: 0,
    message: 'Không cho nợ.',
  };

  it('chặn khách không công nợ chưa trả đủ', () => {
    expect(() => assertPrepaidPolicySatisfied(base)).toThrow('Không cho nợ.');
  });

  it('cho qua khi trả đủ (trong sai số 1đ)', () => {
    expect(() =>
      assertPrepaidPolicySatisfied({ ...base, paidAmount: 99999.5 }),
    ).not.toThrow();
  });

  it('cho qua khi tiền trả trước chưa phân bổ bù đủ', () => {
    expect(() =>
      assertPrepaidPolicySatisfied({
        ...base,
        paidAmount: 40000,
        currentCustomerDebt: -60000,
      }),
    ).not.toThrow();
  });

  it('cho qua khi thu tiền mặt', () => {
    expect(() =>
      assertPrepaidPolicySatisfied({ ...base, paymentMethod: 'cash' }),
    ).not.toThrow();
  });

  it('cho qua khi chính sách tắt hoặc không bắt trả đủ', () => {
    expect(() =>
      assertPrepaidPolicySatisfied({
        ...base,
        policy: { ...prepaid, isActive: false },
      }),
    ).not.toThrow();
    expect(() =>
      assertPrepaidPolicySatisfied({
        ...base,
        policy: { isActive: true, requireFullPaymentForInvoice: false },
      }),
    ).not.toThrow();
    expect(() =>
      assertPrepaidPolicySatisfied({ ...base, policy: null }),
    ).not.toThrow();
  });
});

describe('assertCanConfirmOrder', () => {
  const buildDb = (
    order: any,
    hold: any = null,
    debt: Parameters<typeof debtQueries>[0] = {},
  ) => ({
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    debtTicketCustomer: { findFirst: jest.fn().mockResolvedValue(hold) },
    ...debtQueries(debt),
  });
  const prepaidCustomer = (totalDebt: number) => ({
    totalDebt,
    debtPolicy: { isActive: true, requireFullPaymentForInvoice: true },
  });
  const order = (overrides: any = {}) => ({
    customerId: 3,
    grandTotal: 100000,
    payments: [],
    paymentNotes: [],
    customer: {
      totalDebt: 0,
      debtPolicy: { isActive: true, requireFullPaymentForInvoice: false },
    },
    ...overrides,
  });

  it('chặn khi khách có phiếu ngừng đi hàng đang mở', async () => {
    const db = buildDb(order(), { id: 10 });
    await expect(assertCanConfirmOrder(db, 1)).rejects.toThrow(
      'không thể xác nhận đơn hàng',
    );
  });

  it('chặn khách không công nợ khi đơn chưa trả đủ (bỏ qua thanh toán đã hủy)', async () => {
    // 30k trả trên đơn là phiếu thu → công nợ −30k (dữ liệu khớp thực tế).
    const db = buildDb(
      order({
        payments: [
          { amount: 100000, status: 2 },
          { amount: 30000, status: 1 },
        ],
        customer: prepaidCustomer(-30000),
      }),
      null,
      { payments: [{ code: 'TTDH1-2', orderId: 1, amount: 30000 }] },
    );
    await expect(assertCanConfirmOrder(db, 1)).rejects.toThrow(
      'chưa được thanh toán đủ nên không thể xác nhận',
    );
  });

  it('không tính 2 lần tiền đã trả trên đơn (đơn 1M, trả 500k)', async () => {
    // Trước khi sửa: 500k (đơn) + 500k (công nợ âm do chính phiếu thu đó) = đủ.
    const db = buildDb(
      order({
        grandTotal: 1000000,
        payments: [{ amount: 500000, status: 1 }],
        customer: prepaidCustomer(-500000),
      }),
      null,
      { payments: [{ code: 'TTDH1-1', orderId: 1, amount: 500000 }] },
    );
    await expect(assertCanConfirmOrder(db, 1)).rejects.toThrow(
      'chưa được thanh toán đủ nên không thể xác nhận',
    );
  });

  it('cho qua khi tiền trả trước tự do bù đủ phần còn thiếu', async () => {
    const db = buildDb(
      order({
        grandTotal: 1000000,
        payments: [{ amount: 500000, status: 1 }],
        customer: prepaidCustomer(-1100000),
      }),
      null,
      { payments: [{ code: 'TTDH1-1', orderId: 1, amount: 500000 }] },
    );
    await expect(assertCanConfirmOrder(db, 1)).resolves.toBeUndefined();
  });

  it('không dùng tiền đã trả trên đơn khác chưa ra hóa đơn', async () => {
    const db = buildDb(
      order({
        grandTotal: 1000000,
        payments: [{ amount: 500000, status: 1 }],
        customer: prepaidCustomer(-1500000),
      }),
      null,
      {
        payments: [
          { code: 'TTDH1-1', orderId: 1, amount: 500000 },
          { code: 'TTDH2-1', orderId: 2, amount: 1000000 },
        ],
      },
    );
    await expect(assertCanConfirmOrder(db, 1)).rejects.toThrow(
      'chưa được thanh toán đủ nên không thể xác nhận',
    );
  });

  it('cho qua khách không công nợ khi phiếu thu gần nhất là tiền mặt', async () => {
    const db = buildDb(
      order({
        paymentNotes: [{ paymentType: 'cash' }],
        customer: {
          totalDebt: 0,
          debtPolicy: { isActive: true, requireFullPaymentForInvoice: true },
        },
      }),
    );
    await expect(assertCanConfirmOrder(db, 1)).resolves.toBeUndefined();
    // Được miễn kiểm tra → không tốn truy vấn tính công nợ điều chỉnh.
    expect(db.orderPayment.findMany).not.toHaveBeenCalled();
  });

  it('cho qua khách có công nợ, không có phiếu ngừng đi hàng', async () => {
    const db = buildDb(order());
    await expect(assertCanConfirmOrder(db, 1)).resolves.toBeUndefined();
  });

  it('không kiểm tra với đơn khách vãng lai', async () => {
    const db = buildDb(order({ customerId: null, customer: null }));
    await expect(assertCanConfirmOrder(db, 1)).resolves.toBeUndefined();
    expect(db.debtTicketCustomer.findFirst).not.toHaveBeenCalled();
  });
});

describe('isDebtRuleUnset', () => {
  it('khách chưa có policy hoặc NONE không bắt trả đủ là "Chưa thiết lập"', () => {
    expect(isDebtRuleUnset(null)).toBe(true);
    expect(
      isDebtRuleUnset({
        debtRuleType: 'NONE',
        requireFullPaymentForInvoice: false,
      }),
    ).toBe(true);
  });

  it('"Không công nợ" và các quy tắc cho nợ là đã thiết lập', () => {
    expect(
      isDebtRuleUnset({
        debtRuleType: 'NONE',
        requireFullPaymentForInvoice: true,
      }),
    ).toBe(false);
    expect(
      isDebtRuleUnset({
        debtRuleType: 'TERM_DAYS',
        requireFullPaymentForInvoice: false,
      }),
    ).toBe(false);
  });
});
