import { recalcCustomerDebt } from './customer-debt.util';
import { assertCanConfirmOrder } from './debt-delivery.util';
import { InvoicesService } from '../invoices/invoices.service';
import { ORDER_STATUS } from '../orders/dto/order-status.constants';

/**
 * Quy tắc của chủ hệ thống (2026-11-20): khách "không công nợ", đơn 1.000.000
 * chỉ được XÁC NHẬN và RA HÓA ĐƠN khi khách đã thanh toán đủ (>= 1.000.000).
 * - "Đã thanh toán" = tiền trả trên chính đơn + tiền dư của khách (phần âm
 *   của công nợ sau khi bỏ HĐ và phiếu thu của chính đơn).
 * - 2026-11-25: kiểm tra ở cấp khách — tiền đã trả trên ĐƠN KHÁC chưa ra hết
 *   hóa đơn cũng là tiền dư, dùng được cho đơn này (không giữ riêng cho đơn
 *   kia). Nợ cũ dương không chặn đơn đã trả đủ trên chính nó.
 * - Ngoại lệ giữ nguyên: đơn ghi Tiền mặt (TM, thu tiền khi giao) được miễn.
 *
 * Công nợ khách không gõ tay: mọi nghiệp vụ ghi vào sổ cái giả bên dưới, rồi
 * tính bằng recalcCustomerDebt THẬT. Mọi truy vấn đi qua bộ lọc `where` giả
 * lập Prisma (gặp điều kiện chưa hỗ trợ thì báo lỗi, không bỏ qua), nên lọc
 * sai trong code sẽ làm sai kết quả và test fail.
 */

interface CustomerRow {
  id: number;
  totalDebt: number;
  debtPolicy: { isActive: boolean; requireFullPaymentForInvoice: boolean };
}
interface OrderRow {
  id: number;
  code: string;
  customerId: number;
  grandTotal: number;
  status: number;
  branchId: number;
}
interface PaymentRow {
  id: number;
  code: string;
  orderId: number;
  amount: number;
  status: number;
}
interface NoteRow {
  orderId: number;
  paymentType: 'cash' | 'transfer';
  createdAt: number;
}
interface InvoiceRow {
  id: number;
  code: string;
  orderId: number | null;
  customerId: number;
  grandTotal: number;
  status: number;
}
interface CashFlowRow {
  code: string;
  partnerType: string;
  partnerId: number;
  isReceipt: boolean;
  status: number;
  amount: number;
}

type Where = Record<string, unknown>;
type Select = Record<string, boolean>;
type Relations = Record<string, (row: object, cond: unknown) => boolean>;
interface QueryArgs {
  where?: Where;
  select?: Select;
}

const field = (row: object, key: string): unknown =>
  (row as Record<string, unknown>)[key];

const unsupported = (cond: unknown) =>
  new Error(`Điều kiện chưa hỗ trợ: ${JSON.stringify(cond)}`);

const matchValue = (actual: unknown, cond: unknown): boolean => {
  if (cond === null || typeof cond !== 'object') return actual === cond;
  const c = cond as {
    not?: unknown;
    notIn?: unknown[];
    in?: unknown[];
    startsWith?: string;
  };
  if (Object.keys(c).length !== 1) throw unsupported(cond);
  if ('not' in c) return actual !== c.not;
  if (c.notIn) return !c.notIn.includes(actual);
  if (c.in) return c.in.includes(actual);
  if (c.startsWith !== undefined) {
    return typeof actual === 'string' && actual.startsWith(c.startsWith);
  }
  throw unsupported(cond);
};

const matches = (
  row: object,
  where: Where = {},
  relations: Relations = {},
): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') {
      return (cond as Where[]).some((w) => matches(row, w, relations));
    }
    if (key === 'NOT') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Where[];
      return !list.some((w) => matches(row, w, relations));
    }
    const relation = relations[key];
    if (relation) return relation(row, cond);
    return matchValue(field(row, key), cond);
  });

const sum = (rows: object[], key: string) =>
  rows.reduce((total: number, row) => total + Number(field(row, key) || 0), 0);

/** Chỉ trả các field được `select`, như Prisma. */
const pick = (row: object, select?: Select) => {
  if (!select) throw new Error('Thiếu select');
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, field(row, key)]),
  );
};

class Ledger {
  customers: CustomerRow[] = [];
  orders: OrderRow[] = [];
  orderPayments: PaymentRow[] = [];
  paymentNotes: NoteRow[] = [];
  invoices: InvoiceRow[] = [];
  cashFlows: CashFlowRow[] = [];
  private seq = 0;

  customerById = (id: number) => this.customers.find((c) => c.id === id)!;
  orderById = (id: number) => this.orders.find((o) => o.id === id)!;

  /** Khách mặc định "không công nợ" (bắt trả đủ trước khi ra hóa đơn). */
  customer(prepaid = true) {
    const id = ++this.seq;
    this.customers.push({
      id,
      totalDebt: 0,
      debtPolicy: { isActive: true, requireFullPaymentForInvoice: prepaid },
    });
    return id;
  }

  order(customerId: number, grandTotal = 1000000) {
    const id = ++this.seq;
    this.orders.push({
      id,
      code: `DH${String(id).padStart(6, '0')}`,
      customerId,
      grandTotal,
      status: ORDER_STATUS.PENDING,
      branchId: 1,
    });
    this.note(id, 'transfer');
    return id;
  }

  note(orderId: number, paymentType: 'cash' | 'transfer') {
    this.paymentNotes.push({ orderId, paymentType, createdAt: ++this.seq });
  }

  /** Thanh toán trên đơn: phiếu thanh toán + phiếu thu `TT<mã đơn>-n`. */
  async pay(orderId: number, amount: number) {
    const order = this.orderById(orderId);
    const n = this.orderPayments.filter((p) => p.orderId === orderId).length;
    const code = `TT${order.code}-${n + 1}`;
    this.orderPayments.push({
      id: ++this.seq,
      code,
      orderId,
      amount,
      status: 1,
    });
    this.cashFlows.push({
      code,
      partnerType: 'C',
      partnerId: order.customerId,
      isReceipt: true,
      status: 0,
      amount,
    });
    await this.recalc(order.customerId);
  }

  /** Hủy phiếu thanh toán: phiếu thanh toán + phiếu thu cùng mã → status 2. */
  async cancelPayments(orderId: number) {
    const order = this.orderById(orderId);
    for (const payment of this.orderPayments.filter(
      (p) => p.orderId === orderId,
    )) {
      payment.status = 2;
      this.cashFlows
        .filter((cf) => cf.code === payment.code)
        .forEach((cf) => (cf.status = 2));
    }
    await this.recalc(order.customerId);
  }

  /** Nộp tiền trước, không gắn đơn nào (phiếu thu sổ quỹ). */
  async deposit(customerId: number, amount: number) {
    this.cashFlows.push({
      code: `TTM${++this.seq}`,
      partnerType: 'C',
      partnerId: customerId,
      isReceipt: true,
      status: 0,
      amount,
    });
    await this.recalc(customerId);
  }

  /** Hóa đơn chưa thanh toán (nợ cũ), không gắn đơn. */
  async oldDebt(customerId: number, amount: number) {
    this.invoices.push({
      id: ++this.seq,
      code: `HD${this.seq}`,
      orderId: null,
      customerId,
      grandTotal: amount,
      status: 1,
    });
    await this.recalc(customerId);
  }

  /**
   * Ra hóa đơn từ đơn như createFromOrder: HĐ đầu tiên chuyển tiền đơn sang
   * bằng phiếu `TTTU<mã HĐ>-n` (bị loại khỏi công nợ).
   */
  async invoiceFromOrder(orderId: number, grandTotal: number) {
    const order = this.orderById(orderId);
    const isFirst = !this.invoices.some(
      (i) => i.orderId === orderId && i.status !== 2,
    );
    const code = `HD${String(++this.seq).padStart(6, '0')}`;
    this.invoices.push({
      id: this.seq,
      code,
      orderId,
      customerId: order.customerId,
      grandTotal,
      status: 1,
    });
    if (isFirst) {
      this.orderPayments
        .filter((p) => p.orderId === orderId && p.status !== 2)
        .forEach((p, i) =>
          this.cashFlows.push({
            code: `TTTU${code}-${i + 1}`,
            partnerType: 'C',
            partnerId: order.customerId,
            isReceipt: true,
            status: 0,
            amount: p.amount,
          }),
        );
    }
    // Như updateOrderStatusByInvoices: ra đủ tổng đơn → Hoàn thành.
    const invoiced = sum(
      this.invoices.filter((i) => i.orderId === orderId && i.status !== 2),
      'grandTotal',
    );
    order.status =
      invoiced >= order.grandTotal
        ? ORDER_STATUS.COMPLETED
        : ORDER_STATUS.PARTIALLY_INVOICED;
    await this.recalc(order.customerId);
  }

  /** Hủy đơn nhưng KHÔNG hủy thanh toán (tiền ở lại làm tiền trả trước). */
  cancelOrderKeepPayments(orderId: number) {
    this.orderById(orderId).status = ORDER_STATUS.CANCELLED;
  }

  async changeCustomer(orderId: number, customerId: number) {
    const order = this.orderById(orderId);
    const previous = order.customerId;
    order.customerId = customerId;
    await this.recalc(previous);
    await this.recalc(customerId);
  }

  recalc(customerId: number) {
    return recalcCustomerDebt(this.db, customerId);
  }

  /** Đơn như Prisma trả về cho assertCanConfirmOrder / createFromOrder. */
  private orderView(id: number) {
    const order = this.orderById(id);
    if (!order) return null;
    const customer = this.customerById(order.customerId);
    return {
      ...order,
      items: [],
      delivery: null,
      payments: this.orderPayments.filter((p) => p.orderId === id),
      paymentNotes: this.paymentNotes
        .filter((n) => n.orderId === id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 1)
        .map(({ paymentType }) => ({ paymentType })),
      invoices: this.invoices
        .filter((i) => i.orderId === id && i.status !== 2)
        .map((i) => ({ ...i, details: [] })),
      customer: customer ? { ...customer, addresses: [] } : null,
    };
  }

  get db() {
    const orderRelations: Relations = {
      invoices: (order, cond) => {
        const none = (cond as { none?: Where } | null)?.none;
        if (!none || Object.keys(cond as object).length !== 1) {
          throw unsupported(cond);
        }
        const orderId = (order as OrderRow).id;
        return !this.invoices.some(
          (i) => i.orderId === orderId && matches(i, none),
        );
      },
    };
    const paymentRelations: Relations = {
      order: (payment, cond) =>
        matches(
          this.orderById((payment as PaymentRow).orderId),
          cond as Where,
          orderRelations,
        ),
    };
    return {
      $queryRaw: () => Promise.resolve([]),
      order: {
        findUnique: ({ where }: { where: { id: number } }) =>
          Promise.resolve(this.orderView(where.id)),
      },
      orderPayment: {
        findMany: ({ where, select }: QueryArgs) =>
          Promise.resolve(
            this.orderPayments
              .filter((p) => matches(p, where, paymentRelations))
              .map((p) => pick(p, select)),
          ),
      },
      invoice: {
        aggregate: ({ where }: QueryArgs) =>
          Promise.resolve({
            _sum: {
              grandTotal: sum(
                this.invoices.filter((i) => matches(i, where)),
                'grandTotal',
              ),
            },
          }),
        findMany: ({ where, select }: QueryArgs) =>
          Promise.resolve(
            this.invoices
              .filter((i) => matches(i, where))
              .map((i) => pick(i, select)),
          ),
      },
      cashFlow: {
        aggregate: ({ where }: QueryArgs) =>
          Promise.resolve({
            _sum: {
              amount: sum(
                this.cashFlows.filter((cf) => matches(cf, where)),
                'amount',
              ),
            },
          }),
        findMany: ({ where, select }: QueryArgs) =>
          Promise.resolve(
            this.cashFlows
              .filter((cf) => matches(cf, where))
              .map((cf) => pick(cf, select)),
          ),
      },
      returnOrder: {
        aggregate: () => Promise.resolve({ _sum: { refundAmount: 0 } }),
      },
      customer: {
        update: ({
          where,
          data,
        }: {
          where: { id: number };
          data: Partial<CustomerRow>;
        }) => Promise.resolve(Object.assign(this.customerById(where.id), data)),
      },
      debtTicketCustomer: { findFirst: () => Promise.resolve(null) },
    };
  }
}

const CONFIRM_BLOCKED = 'chưa được thanh toán đủ nên không thể xác nhận';
const INVOICE_BLOCKED = 'chưa được thanh toán đủ nên không thể tạo hóa đơn';
// createFromOrder qua được kiểm tra công nợ thì dừng ở bước sau vì đơn giả
// không có dòng hàng (giống invoices.service.spec.ts).
const INVOICE_PASSED_CHECK =
  'Tất cả sản phẩm trong đơn hàng đã được xuất hóa đơn';

const createInvoice = (ledger: Ledger, orderId: number) => {
  const prisma = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(ledger.db),
  };
  const unused = {} as never;
  const service = new InvoicesService(
    prisma as never,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );
  return service.createFromOrder(
    orderId,
    { paymentNoteType: 'transfer', paymentType: 'transfer' } as never,
    1,
    true,
  );
};

/** Kiểm cả 2 cửa: xác nhận đơn, rồi (đơn đã xác nhận) ra hóa đơn từ đơn. */
const expectRule = async (
  ledger: Ledger,
  orderId: number,
  allowed: boolean,
) => {
  const confirm = assertCanConfirmOrder(ledger.db, orderId);
  if (allowed) await expect(confirm).resolves.toBeUndefined();
  else await expect(confirm).rejects.toThrow(CONFIRM_BLOCKED);

  ledger.orderById(orderId).status = ORDER_STATUS.CONFIRMED;
  await expect(createInvoice(ledger, orderId)).rejects.toThrow(
    allowed ? INVOICE_PASSED_CHECK : INVOICE_BLOCKED,
  );
};

describe('Quy tắc khách không công nợ — đơn 1.000.000 (sổ cái giả)', () => {
  let ledger: Ledger;
  let khach: number;
  let don: number;

  beforeEach(() => {
    ledger = new Ledger();
    khach = ledger.customer();
    don = ledger.order(khach, 1000000);
  });

  describe('chỉ tiền trả trên đơn', () => {
    it('chưa trả đồng nào → không xác nhận, không ra HĐ', async () => {
      await expectRule(ledger, don, false);
    });

    it('trả 500.000 → chặn (trước đây bị tính 2 lần thành đủ)', async () => {
      await ledger.pay(don, 500000);
      // Công nợ do recalcCustomerDebt thật tính ra, không gõ tay.
      expect(ledger.customerById(khach).totalDebt).toBe(-500000);
      await expectRule(ledger, don, false);
    });

    it('thiếu 1.000đ (trả 999.000) → chặn', async () => {
      await ledger.pay(don, 999000);
      await expectRule(ledger, don, false);
    });

    it('trả đủ 1.000.000 → xác nhận và ra HĐ được', async () => {
      await ledger.pay(don, 1000000);
      await expectRule(ledger, don, true);
    });

    it('trả dư 1.200.000 → được', async () => {
      await ledger.pay(don, 1200000);
      await expectRule(ledger, don, true);
    });

    it('trả 2 lần 600.000 + 400.000 → được', async () => {
      await ledger.pay(don, 600000);
      await ledger.pay(don, 400000);
      await expectRule(ledger, don, true);
    });

    it('trả đủ rồi hủy phiếu thanh toán → bị chặn lại', async () => {
      await ledger.pay(don, 1000000);
      await ledger.cancelPayments(don);
      await expectRule(ledger, don, false);
    });
  });

  describe('ngoại lệ Tiền mặt (thu tiền khi giao)', () => {
    it('ghi TM, chưa trả đồng nào → được', async () => {
      ledger.note(don, 'cash');
      await expectRule(ledger, don, true);
    });

    it('ghi TM rồi đổi lại CK → bị chặn', async () => {
      ledger.note(don, 'cash');
      ledger.note(don, 'transfer');
      await expectRule(ledger, don, false);
    });
  });

  describe('tiền trả trước tự do (không gắn đơn nào)', () => {
    it('trả 500.000 trên đơn + nộp trước 500.000 → được', async () => {
      await ledger.pay(don, 500000);
      await ledger.deposit(khach, 500000);
      await expectRule(ledger, don, true);
    });

    it('trả 500.000 trên đơn + nộp trước 400.000 → chặn', async () => {
      await ledger.pay(don, 500000);
      await ledger.deposit(khach, 400000);
      await expectRule(ledger, don, false);
    });

    it('chưa trả trên đơn nhưng nộp trước 1.000.000 → được', async () => {
      await ledger.deposit(khach, 1000000);
      await expectRule(ledger, don, true);
    });

    it('còn nợ cũ 300.000 nhưng trả đủ 1.000.000 trên đơn → được', async () => {
      await ledger.oldDebt(khach, 300000);
      await ledger.pay(don, 1000000);
      await expectRule(ledger, don, true);
    });

    it('nộp trước 1.000.000 nhưng còn nợ cũ 300.000 → chỉ 700.000 là tự do → chặn', async () => {
      await ledger.oldDebt(khach, 300000);
      await ledger.deposit(khach, 1000000);
      await expectRule(ledger, don, false);
    });
  });

  describe('tiền nằm trên đơn khác', () => {
    it('trả 500.000, còn 1.000.000 nằm trên đơn B chưa ra HĐ → tiền B là tiền dư → được', async () => {
      const donB = ledger.order(khach, 1000000);
      await ledger.pay(don, 500000);
      await ledger.pay(donB, 1000000);
      await expectRule(ledger, don, true);
    });

    it('đơn B bị hủy nhưng giữ thanh toán → tiền B thành tiền trả trước → được', async () => {
      const donB = ledger.order(khach, 1000000);
      await ledger.pay(donB, 1000000);
      ledger.cancelOrderKeepPayments(donB);
      await expectRule(ledger, don, true);
    });

    it('đơn B đã ra HĐ đủ 1.000.000 → tiền B đã dùng cho HĐ B → chặn', async () => {
      const donB = ledger.order(khach, 1000000);
      await ledger.pay(donB, 1000000);
      await ledger.invoiceFromOrder(donB, 1000000);
      await expectRule(ledger, don, false);
    });

    it('đơn B đã ra HĐ đủ, khách còn nộp trước 1.000.000 tự do → đơn A được', async () => {
      const donB = ledger.order(khach, 1000000);
      await ledger.pay(donB, 1000000);
      await ledger.invoiceFromOrder(donB, 1000000);
      await ledger.deposit(khach, 1000000);
      await expectRule(ledger, don, true);
    });

    it('đơn B trả đủ 1.000.000 nhưng mới ra HĐ 600.000 (như KH000579) → 400.000 còn lại là tiền dư → đơn A (400.000) được', async () => {
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 400000);
      await ledger.pay(donB, 1000000);
      await ledger.invoiceFromOrder(donB, 600000);
      await expectRule(ledger, donA, true);
    });

    it('đơn B trả 600.000 = đúng HĐ 1 600.000 (còn hàng chưa trả) + nộp trước 500.000 → đơn A 500.000 được', async () => {
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 500000);
      await ledger.pay(donB, 600000);
      await ledger.invoiceFromOrder(donB, 600000);
      await ledger.deposit(khach, 500000);
      await expectRule(ledger, donA, true);
    });

    it('đơn B còn nợ 400.000 (HĐ 600.000 ra khi ghi TM, mới trả 200.000) → nợ đó ăn hết 300.000 nộp trước → đơn A bị chặn', async () => {
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 300000);
      await ledger.pay(donB, 200000);
      ledger.note(donB, 'cash');
      await ledger.invoiceFromOrder(donB, 600000);
      await ledger.deposit(khach, 300000);
      // Công nợ = 600.000 − 200.000 − 300.000 = +100.000: khách đang nợ, không
      // còn đồng trả trước tự do nào.
      expect(ledger.customerById(khach).totalDebt).toBe(100000);
      await expectRule(ledger, donA, false);
    });

    it('đơn B đã hoàn thành nhưng trả dư 200.000 → phần dư là tiền trả trước tự do → đơn A 200.000 được', async () => {
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 200000);
      await ledger.pay(donB, 1200000);
      await ledger.invoiceFromOrder(donB, 1000000);
      expect(ledger.orderById(donB).status).toBe(ORDER_STATUS.COMPLETED);
      await expectRule(ledger, donA, true);
    });

    it('đánh đổi đã chấp nhận: đơn A dùng tiền dư của B rồi B ra nốt HĐ 2 → khách nợ 400.000', async () => {
      // B 1M trả đủ, HĐ 1 600k → 400k dư. A 400k chưa trả dùng 400k đó.
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 400000);
      await ledger.pay(donB, 1000000);
      await ledger.invoiceFromOrder(donB, 600000);
      await expectRule(ledger, donA, true);
      await ledger.invoiceFromOrder(donA, 400000);
      // B đã trả đủ trên chính đơn nên HĐ 2 vẫn qua kiểm tra (kiểm tra ở cấp
      // khách, không giữ tiền theo đơn) → cùng 400k bị dùng 2 lần.
      await expect(createInvoice(ledger, donB)).rejects.toThrow(
        INVOICE_PASSED_CHECK,
      );
      await ledger.invoiceFromOrder(donB, 400000);
      expect(ledger.customerById(khach).totalDebt).toBe(400000);
    });

    it('khi đó đơn C mới chưa trả thì bị chặn (khách đang nợ, không còn tiền dư)', async () => {
      const donB = ledger.order(khach, 1000000);
      const donA = ledger.order(khach, 400000);
      const donC = ledger.order(khach, 100000);
      await ledger.pay(donB, 1000000);
      await ledger.invoiceFromOrder(donB, 600000);
      await ledger.invoiceFromOrder(donA, 400000);
      await ledger.invoiceFromOrder(donB, 400000);
      await expectRule(ledger, donC, false);
    });
  });

  describe('đơn đổi khách', () => {
    it('khách cũ trả 500.000 rồi đơn chuyển sang khách mới → khách mới vẫn bị chặn', async () => {
      const khachMoi = ledger.customer();
      await ledger.pay(don, 500000);
      await ledger.changeCustomer(don, khachMoi);
      await expectRule(ledger, don, false);
    });

    // LỖ HỔNG CHƯA SỬA (2026-11-20): tiền đã trả lấy từ orderPayment (đi theo
    // đơn) nhưng phiếu thu vẫn nằm ở công nợ khách CŨ. Khách mới chỉ có 500.000
    // thật mà vẫn qua → ra HĐ 1.000.000 thì khách mới nợ 500.000.
    // it.failing: test pass khi code còn lỗi; khi sửa xong Jest sẽ báo để đổi
    // thành it(...).
    it.failing(
      'khách cũ trả 500.000, đơn chuyển sang khách mới chỉ có 500.000 trả trước → phải chặn',
      async () => {
        const khachMoi = ledger.customer();
        await ledger.pay(don, 500000);
        await ledger.changeCustomer(don, khachMoi);
        await ledger.deposit(khachMoi, 500000);
        await expectRule(ledger, don, false);
      },
    );
  });

  describe('ra hóa đơn lần 2 (đơn đã ra 1 phần)', () => {
    it('đơn trả đủ 1.000.000, HĐ 1 là 600.000 → HĐ 2 được', async () => {
      await ledger.pay(don, 1000000);
      await ledger.invoiceFromOrder(don, 600000);
      await expect(createInvoice(ledger, don)).rejects.toThrow(
        INVOICE_PASSED_CHECK,
      );
    });

    it('đơn trả 500.000, HĐ 1 ra khi ghi TM, sau đổi sang CK → HĐ 2 bị chặn', async () => {
      await ledger.pay(don, 500000);
      ledger.note(don, 'cash');
      await ledger.invoiceFromOrder(don, 600000);
      ledger.note(don, 'transfer');
      await expect(createInvoice(ledger, don)).rejects.toThrow(INVOICE_BLOCKED);
    });

    it('như trên nhưng khách nộp thêm 500.000 tự do → 500.000 + 500.000 đủ → HĐ 2 được', async () => {
      await ledger.pay(don, 500000);
      ledger.note(don, 'cash');
      await ledger.invoiceFromOrder(don, 600000);
      ledger.note(don, 'transfer');
      await ledger.deposit(khach, 500000);
      // Công nợ = HĐ 600.000 − 500.000 (đơn) − 500.000 (nộp) = −400.000. Phải bỏ
      // cả HĐ 1 lẫn phiếu thu của đơn mới thấy đúng 500.000 tự do.
      expect(ledger.customerById(khach).totalDebt).toBe(-400000);
      await expect(createInvoice(ledger, don)).rejects.toThrow(
        INVOICE_PASSED_CHECK,
      );
    });
  });

  describe('khách không bị ràng buộc', () => {
    it('khách có công nợ (không bắt trả đủ), chưa trả → không chặn', async () => {
      const khachCoNo = ledger.customer(false);
      const donCoNo = ledger.order(khachCoNo, 1000000);
      await expectRule(ledger, donCoNo, true);
    });
  });
});
