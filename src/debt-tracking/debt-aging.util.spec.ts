import {
  allocateDebtFifo,
  computeCustomerAging,
  diffDays,
  evaluatePaymentFrequency,
  hasAnyDebtPolicy,
  resolveInvoiceDueDate,
  resolveInvoiceOverdueDate,
  startOfDay,
  type AgingInvoiceInput,
  type DebtPolicyInput,
} from './debt-aging.util';
import {
  DEBT_GRACE_DAYS,
  DEBT_STATUS,
  MIN_PAYMENT_RATIO_WARN,
} from './debt-tracking.constants';

const d = (s: string) => new Date(`${s}T00:00:00`);

function inv(
  id: number,
  grandTotal: number,
  deliveredAt: string | null = null,
  purchaseDate = '2026-01-01',
): AgingInvoiceInput {
  return {
    id,
    code: `HD${id}`,
    grandTotal,
    deliveredAt: deliveredAt ? d(deliveredAt) : null,
    purchaseDate: d(purchaseDate),
  };
}

/** Chính sách chỉ theo ngày. */
const days = (n: number): DebtPolicyInput => ({
  hasTermDays: true,
  termDays: n,
  hasCreditLimit: false,
});

/** Chính sách chỉ theo hạn mức. */
const limit = (n: number): DebtPolicyInput => ({
  hasTermDays: false,
  hasCreditLimit: true,
  creditLimit: n,
});

/** Chính sách bật cả hai chiều. */
const both = (n: number, l: number): DebtPolicyInput => ({
  hasTermDays: true,
  termDays: n,
  hasCreditLimit: true,
  creditLimit: l,
});

const NONE: DebtPolicyInput = { hasTermDays: false, hasCreditLimit: false };

describe('date helpers', () => {
  it('diffDays bỏ qua phần giờ', () => {
    expect(
      diffDays(new Date('2026-03-01T23:59'), new Date('2026-03-02T00:01')),
    ).toBe(1);
    expect(diffDays(d('2026-03-10'), d('2026-03-01'))).toBe(-9);
  });

  it('startOfDay chuẩn hóa về 00:00', () => {
    expect(startOfDay(new Date('2026-03-01T18:30')).getHours()).toBe(0);
  });
});

describe('hasAnyDebtPolicy', () => {
  it('nhận biết đúng khách không công nợ', () => {
    expect(hasAnyDebtPolicy(NONE)).toBe(false);
    expect(hasAnyDebtPolicy(days(30))).toBe(true);
    expect(hasAnyDebtPolicy(limit(100))).toBe(true);
    expect(hasAnyDebtPolicy(both(30, 100))).toBe(true);
  });
});

describe('resolveInvoiceDueDate', () => {
  it('null khi chưa báo đơn giao hàng', () => {
    expect(resolveInvoiceDueDate({ deliveredAt: null }, days(30))).toBeNull();
  });

  it('null khi khách không áp hạn theo ngày', () => {
    expect(
      resolveInvoiceDueDate({ deliveredAt: d('2026-03-01') }, limit(100)),
    ).toBeNull();
  });

  it('tính ngày bắt đầu phải thanh toán, chưa cộng ân hạn', () => {
    // 01/03 + 30 = 31/03
    expect(
      resolveInvoiceDueDate({ deliveredAt: d('2026-03-01') }, days(30)),
    ).toEqual(d('2026-03-31'));
  });

  it('tính ngày chuyển quá hạn sau ân hạn', () => {
    expect(
      resolveInvoiceOverdueDate({ deliveredAt: d('2026-03-01') }, days(30)),
    ).toEqual(d('2026-04-05'));
  });

  it('hỗ trợ mọi kỳ hạn đang dùng thực tế', () => {
    const base = { deliveredAt: d('2026-03-01') };
    expect(resolveInvoiceDueDate(base, days(1))).toEqual(d('2026-03-02'));
    expect(resolveInvoiceDueDate(base, days(3))).toEqual(d('2026-03-04'));
    expect(resolveInvoiceDueDate(base, days(7))).toEqual(d('2026-03-08'));
    expect(resolveInvoiceDueDate(base, days(15))).toEqual(d('2026-03-16'));
    // 01/03 + 55 = 25/04 (tháng 3 có 31 ngày)
    expect(resolveInvoiceDueDate(base, days(55))).toEqual(d('2026-04-25'));
  });

  it('bật cả hai chiều vẫn tính được hạn ngày', () => {
    expect(
      resolveInvoiceDueDate({ deliveredAt: d('2026-03-01') }, both(30, 100)),
    ).toEqual(d('2026-03-31'));
  });

  it('thiếu termDays → null, không crash', () => {
    expect(
      resolveInvoiceDueDate(
        { deliveredAt: d('2026-03-01') },
        { hasTermDays: true, termDays: null, hasCreditLimit: false },
      ),
    ).toBeNull();
  });
});

describe('allocateDebtFifo', () => {
  it('phân bổ nợ vào hóa đơn MỚI NHẤT trước', () => {
    const { allocated } = allocateDebtFifo(
      [
        inv(1, 100, '2026-01-10'),
        inv(2, 100, '2026-02-10'),
        inv(3, 100, '2026-03-10'),
      ],
      150,
    );
    // Còn nợ 150 → HĐ3 (100) + HĐ2 (50). HĐ1 coi như đã trả xong.
    expect(allocated.map((r) => [r.id, r.outstanding])).toEqual([
      [2, 50],
      [3, 100],
    ]);
  });

  it('tổng phân bổ luôn khớp totalDebt khi đủ hóa đơn', () => {
    const { allocated, unallocated } = allocateDebtFifo(
      [inv(1, 500), inv(2, 300), inv(3, 900)],
      1200,
    );
    expect(allocated.reduce((s, r) => s + r.outstanding, 0)).toBe(1200);
    expect(unallocated).toBe(0);
  });

  it('trả về phần KHÔNG phân bổ được khi thiếu hóa đơn', () => {
    const { allocated, unallocated } = allocateDebtFifo([inv(1, 100)], 500);
    expect(allocated.reduce((s, r) => s + r.outstanding, 0)).toBe(100);
    expect(unallocated).toBe(400);
  });

  it('không có hóa đơn nào thì toàn bộ nợ là unallocated', () => {
    const { allocated, unallocated } = allocateDebtFifo([], 250);
    expect(allocated).toHaveLength(0);
    expect(unallocated).toBe(250);
  });

  it('nợ 0 thì không phân bổ gì', () => {
    const { allocated, unallocated } = allocateDebtFifo([inv(1, 100)], 0);
    expect(allocated).toEqual([]);
    expect(unallocated).toBe(0);
  });
});

describe('computeCustomerAging — chỉ SỐ NGÀY', () => {
  it('quá hạn sau ngày hạn và 5 ngày ân hạn', () => {
    // giao 01/03, ngày hạn = 31/03, hết ân hạn = 05/04.
    // Hôm nay 10/04 → quá 5 ngày.
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      days(30),
      d('2026-04-10'),
    );
    expect(r.overdueAmount).toBe(100);
    expect(r.requiredPaymentAmount).toBe(100);
    expect(r.maxDaysOverdue).toBe(5);
    expect(r.debtStatus).toBe(DEBT_STATUS.OVERDUE);
  });

  it('ĐÚNG ngày hết ân hạn vẫn CHƯA quá hạn', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      days(30),
      d('2026-04-05'),
    );
    expect(r.overdueAmount).toBe(0);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('ĐẾN HẠN ngay khi chạm ngày phải thanh toán', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      days(30),
      d('2026-03-31'),
    );
    expect(r.dueAmount).toBe(100);
    expect(r.requiredPaymentAmount).toBe(100);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('báo đơn hôm qua với hạn 1 ngày thì hôm nay phải cần thu', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      both(1, 1_000),
      d('2026-03-02'),
    );
    expect(r.undeliveredAmount).toBe(0);
    expect(r.dueAmount).toBe(100);
    expect(r.invoiceRequiredAmount).toBe(100);
    expect(r.requiredPaymentAmount).toBe(100);
    expect(r.requiredPaymentSource).toBe('INVOICE');
    expect(r.nearestDueDate).toEqual(d('2026-03-02'));
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('trong 7 ngày trước hạn chỉ cảnh báo sớm, chưa cần thu', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      days(30),
      d('2026-03-25'),
    );
    expect(r.dueAmount).toBe(0);
    expect(r.dueSoonAmount).toBe(100);
    expect(r.requiredPaymentAmount).toBe(0);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('BÌNH THƯỜNG khi còn xa hạn', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, '2026-03-01')],
      days(30),
      d('2026-03-10'),
    );
    expect(r.debtStatus).toBe(DEBT_STATUS.NORMAL);
    expect(r.notDueAmount).toBe(100);
  });

  it('hóa đơn CHƯA báo đơn không bị tính quá hạn', () => {
    const r = computeCustomerAging(
      100,
      [inv(1, 100, null, '2020-01-01')],
      days(30),
      d('2026-04-10'),
    );
    expect(r.overdueAmount).toBe(0);
    expect(r.undeliveredAmount).toBe(100);
    expect(r.debtStatus).toBe(DEBT_STATUS.NORMAL);
  });

  it('tách đúng phần quá hạn và phần chưa tới hạn', () => {
    const r = computeCustomerAging(
      150,
      [inv(1, 100, '2026-01-01'), inv(2, 100, '2026-04-01')],
      days(30),
      d('2026-03-01'),
    );
    // FIFO: HĐ2 nhận 100, HĐ1 nhận 50.
    // HĐ1 ngày hạn 31/01, hết ân hạn 05/02 → quá hạn 50.
    // HĐ2 ngày hạn 01/05 → chưa tới hạn.
    expect(r.overdueAmount).toBe(50);
    expect(r.notDueAmount).toBe(100);
  });
});

describe('computeCustomerAging — chỉ HẠN MỨC', () => {
  it('chạm đúng hạn mức → chỉ cảnh báo, chưa có số tiền phải thu', () => {
    const r = computeCustomerAging(
      100_000_000,
      [inv(1, 100_000_000, '2026-03-01')],
      limit(100_000_000),
      d('2026-03-02'),
    );
    expect(r.limitReached).toBe(true);
    expect(r.overdueAmount).toBe(0);
    expect(r.requiredPaymentAmount).toBe(0);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('chỉ phần VƯỢT hạn mức là khoản cần thu', () => {
    const r = computeCustomerAging(
      1_183_310_468,
      [inv(1, 1_183_310_468, '2026-03-01')],
      limit(500_000_000),
      d('2026-03-02'),
    );
    expect(r.overLimitAmount).toBe(683_310_468);
    expect(r.limitOverdueAmount).toBe(683_310_468);
    expect(r.overdueAmount).toBe(0);
    expect(r.notDueAmount).toBe(1_183_310_468);
    expect(r.requiredPaymentAmount).toBe(683_310_468);
    expect(r.debtStatus).toBe(DEBT_STATUS.OVERDUE);
    expect(Math.round((r.creditUsageRatio as number) * 100)).toBe(237);
  });

  it('chưa cán hạn mức thì không tới hạn, bất kể nợ bao lâu', () => {
    const r = computeCustomerAging(
      50_000_000,
      [inv(1, 50_000_000, '2020-01-01')],
      limit(100_000_000),
      d('2026-03-02'),
    );
    expect(r.limitReached).toBe(false);
    expect(r.overdueAmount).toBe(0);
    expect(r.overLimitAmount).toBe(0);
    expect(r.requiredPaymentAmount).toBe(0);
    expect(r.notDueAmount).toBe(50_000_000);
  });

  it('dùng >= 80% hạn mức → ĐẾN HẠN', () => {
    const r = computeCustomerAging(
      85_000_000,
      [inv(1, 85_000_000, '2026-03-01')],
      limit(100_000_000),
      d('2026-03-02'),
    );
    expect(r.creditUsageRatio).toBeCloseTo(0.85);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });
});

describe('computeCustomerAging — CẢ HAI chiều tính độc lập', () => {
  const p = both(30, 100_000_000);

  it('hóa đơn quá hạn vẫn được tính khi chưa vượt hạn mức', () => {
    const r = computeCustomerAging(
      50_000_000,
      [inv(1, 50_000_000, '2026-01-01')],
      p,
      d('2026-06-01'),
    );
    expect(r.limitReached).toBe(false);
    expect(r.overdueAmount).toBe(50_000_000);
    expect(r.invoiceRequiredAmount).toBe(50_000_000);
    expect(r.requiredPaymentAmount).toBe(50_000_000);
    expect(r.requiredPaymentSource).toBe('INVOICE');
    expect(r.maxDaysOverdue).toBeGreaterThan(0);
  });

  it('chạm hạn mức NHƯNG còn hạn ngày → chỉ cảnh báo ĐẾN HẠN', () => {
    const r = computeCustomerAging(
      100_000_000,
      [inv(1, 100_000_000, '2026-03-01')],
      p,
      d('2026-03-02'),
    );
    expect(r.limitReached).toBe(true);
    expect(r.overdueAmount).toBe(0);
    expect(r.requiredPaymentAmount).toBe(0);
    expect(r.debtStatus).toBe(DEBT_STATUS.DUE);
  });

  it('vượt hạn mức NHƯNG hóa đơn chưa đến hạn → lấy phần vượt', () => {
    const r = computeCustomerAging(
      120_000_000,
      [inv(1, 120_000_000, '2026-03-01')],
      p,
      d('2026-03-02'),
    );
    expect(r.overLimitAmount).toBe(20_000_000);
    expect(r.overdueAmount).toBe(0);
    expect(r.requiredPaymentAmount).toBe(20_000_000);
    expect(r.requiredPaymentSource).toBe('CREDIT_LIMIT');
    expect(r.debtStatus).toBe(DEBT_STATUS.OVERDUE);
  });

  it('cả hai cùng phát sinh → lấy khoản lớn hơn', () => {
    const r = computeCustomerAging(
      120_000_000,
      [inv(1, 120_000_000, '2026-01-01')],
      p,
      d('2026-06-01'),
    );
    expect(r.limitReached).toBe(true);
    expect(r.overdueAmount).toBe(120_000_000);
    expect(r.overLimitAmount).toBe(20_000_000);
    expect(r.invoiceRequiredAmount).toBe(120_000_000);
    expect(r.requiredPaymentAmount).toBe(120_000_000);
    expect(r.requiredPaymentSource).toBe('INVOICE');
    expect(r.maxDaysOverdue).toBeGreaterThan(0);
  });

  it('cả hai cùng phát sinh → hạn mức thắng khi lớn hơn', () => {
    const r = computeCustomerAging(
      300_000_000,
      [inv(1, 150_000_000, '2026-01-01')],
      p,
      d('2026-03-01'),
    );
    expect(r.limitOverdueAmount).toBe(200_000_000);
    expect(r.invoiceRequiredAmount).toBe(150_000_000);
    expect(r.requiredPaymentAmount).toBe(200_000_000);
    expect(r.requiredPaymentSource).toBe('CREDIT_LIMIT');
  });

  it('cả hai cùng phát sinh bằng nhau → giữ nguồn TIE', () => {
    const r = computeCustomerAging(
      200_000_000,
      [inv(1, 100_000_000, '2026-01-01')],
      p,
      d('2026-03-01'),
    );
    expect(r.limitOverdueAmount).toBe(100_000_000);
    expect(r.invoiceRequiredAmount).toBe(100_000_000);
    expect(r.requiredPaymentAmount).toBe(100_000_000);
    expect(r.requiredPaymentSource).toBe('TIE');
  });
});

describe('computeCustomerAging — nợ KHÔNG gắn được hóa đơn', () => {
  it('tách riêng phần unallocated, không tính quá hạn', () => {
    // Nợ 500 nhưng chỉ có hóa đơn 100 (nợ cũ trước khi hệ thống chạy).
    const r = computeCustomerAging(
      500,
      [inv(1, 100, '2026-01-01')],
      days(30),
      d('2026-06-01'),
    );
    expect(r.unallocatedAmount).toBe(400);
    expect(r.overdueAmount).toBe(100);
  });

  it('khách không còn hóa đơn nào', () => {
    const r = computeCustomerAging(212_902_560, [], days(30), d('2026-06-01'));
    expect(r.unallocatedAmount).toBe(212_902_560);
    expect(r.overdueAmount).toBe(0);
    expect(r.outstandingInvoices).toHaveLength(0);
  });

  it('hạn mức vẫn cảnh báo được dù không có hóa đơn', () => {
    const r = computeCustomerAging(
      212_902_560,
      [],
      limit(100_000_000),
      d('2026-06-01'),
    );
    expect(r.limitReached).toBe(true);
    expect(r.debtStatus).toBe(DEBT_STATUS.OVERDUE);
    expect(r.requiredPaymentAmount).toBe(112_902_560);
  });
});

describe('evaluatePaymentFrequency — "1 tháng 2 lần"', () => {
  const now = d('2026-03-20');

  it('null khi khách không cam kết tần suất', () => {
    expect(evaluatePaymentFrequency([], null, now)).toBeNull();
    expect(evaluatePaymentFrequency([], 0, now)).toBeNull();
  });

  it('đếm đúng số lần trả trong THÁNG HIỆN TẠI', () => {
    const r = evaluatePaymentFrequency(
      [d('2026-03-05'), d('2026-03-06'), d('2026-02-28')],
      2,
      now,
    );
    // 2 lần trong tháng 3; lần tháng 2 không tính
    expect(r?.paymentsThisMonth).toBe(2);
    expect(r?.met).toBe(true);
    expect(r?.remaining).toBe(0);
  });

  it('chấp nhận hai lần trả liền nhau', () => {
    // Đúng tình huống thực tế: khách chuyển hôm nay rồi mai chuyển tiếp.
    const r = evaluatePaymentFrequency(
      [d('2026-03-10'), d('2026-03-11')],
      2,
      now,
    );
    expect(r?.met).toBe(true);
  });

  it('báo còn thiếu khi chưa đạt cam kết', () => {
    const r = evaluatePaymentFrequency([d('2026-03-05')], 2, now);
    expect(r?.paymentsThisMonth).toBe(1);
    expect(r?.met).toBe(false);
    expect(r?.remaining).toBe(1);
  });

  it('không sinh hạn thanh toán — chỉ theo dõi tần suất', () => {
    // paymentFrequency KHÔNG được dùng để tính dueDate.
    const due = resolveInvoiceDueDate(
      { deliveredAt: d('2026-03-01') },
      { hasTermDays: false, hasCreditLimit: false, paymentFrequency: 2 },
    );
    expect(due).toBeNull();
  });
});

describe('bất biến quan trọng', () => {
  it('tổng các nhóm luôn bằng totalDebt', () => {
    const invoices = [
      inv(1, 300, '2026-01-01'),
      inv(2, 300, '2026-03-01'),
      inv(3, 300, null, '2026-04-01'),
    ];
    const r = computeCustomerAging(700, invoices, days(30), d('2026-04-10'));
    const sum =
      r.overdueAmount +
      r.dueAmount +
      r.notDueAmount +
      r.undeliveredAmount +
      r.unallocatedAmount;
    expect(sum).toBeCloseTo(700, 2);
  });

  it('bất biến vẫn đúng khi thiếu hóa đơn', () => {
    const r = computeCustomerAging(
      1000,
      [inv(1, 200, '2026-01-01')],
      days(30),
      d('2026-06-01'),
    );
    const sum =
      r.overdueAmount +
      r.dueAmount +
      r.notDueAmount +
      r.undeliveredAmount +
      r.unallocatedAmount;
    expect(sum).toBeCloseTo(1000, 2);
  });

  it('không có nợ thì mọi thứ về 0 và BÌNH THƯỜNG', () => {
    const r = computeCustomerAging(
      0,
      [inv(1, 100, '2020-01-01')],
      days(30),
      d('2026-04-10'),
    );
    expect(r.outstandingInvoices).toHaveLength(0);
    expect(r.overdueAmount).toBe(0);
    expect(r.debtStatus).toBe(DEBT_STATUS.NORMAL);
  });

  it('hằng số cấu hình đúng như quy ước vận hành', () => {
    expect(DEBT_GRACE_DAYS).toBe(5);
    expect(MIN_PAYMENT_RATIO_WARN).toBe(0.3);
  });
});
