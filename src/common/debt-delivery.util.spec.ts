import {
  assertCanConfirmOrder,
  assertCanCreateInvoiceForCustomer,
  assertPrepaidPolicySatisfied,
  hasOpenStopDeliveryHold,
} from './debt-delivery.util';

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
  const buildDb = (order: any, hold: any = null) => ({
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    debtTicketCustomer: { findFirst: jest.fn().mockResolvedValue(hold) },
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
    const db = buildDb(
      order({
        payments: [
          { amount: 100000, status: 2 },
          { amount: 30000, status: 1 },
        ],
        customer: {
          totalDebt: 0,
          debtPolicy: { isActive: true, requireFullPaymentForInvoice: true },
        },
      }),
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
