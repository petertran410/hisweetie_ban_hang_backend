import { InvoicesService } from './invoices.service';
import { INVOICE_STATUS } from './dto';

describe('InvoicesService delivery reporting', () => {
  const createInvoice = (deliveredAt: Date | null) => ({
    id: 1,
    code: 'HDTEST001',
    status: INVOICE_STATUS.PROCESSING,
    statusValue: 'Đang xử lý',
    deliveredAt,
    createdBy: 7,
    customerId: null,
    branchId: 1,
    orderId: null,
    details: [],
    customer: null,
    payments: [],
    delivery: null,
    branch: null,
    soldBy: null,
    purchaseDate: new Date('2026-08-27T09:00:00.000Z'),
    grandTotal: 100_000,
    totalAmount: 100_000,
    discount: 0,
    discountRatio: 0,
    shippingFee: 0,
    paidAmount: 0,
    debtAmount: 100_000,
    description: null,
    usingCod: false,
    priceBookName: null,
  });

  const createService = (
    currentInvoice: ReturnType<typeof createInvoice>,
    firstPackingSlipAt: Date | null = null,
  ) => {
    const tx = {
      invoice: {
        findUnique: jest.fn().mockResolvedValue(currentInvoice),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...currentInvoice,
            ...data,
            creator: { id: currentInvoice.createdBy, name: 'Người tạo' },
            priceBook: null,
          }),
        ),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Người báo đơn' }),
      },
      packingSlipInvoice: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            firstPackingSlipAt
              ? { packingSlip: { createdAt: firstPackingSlipAt } }
              : null,
          ),
      },
    };
    const prisma = {
      invoice: { findUnique: jest.fn().mockResolvedValue(currentInvoice) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    (tx as any).$queryRaw = jest.fn().mockResolvedValue([{ id: 1 }]);
    const auditLogs = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new InvoicesService(
      prisma as any,
      {} as any,
      {} as any,
      auditLogs as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(currentInvoice as any);

    return { service, tx };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ghi mốc báo đơn khi chuyển trực tiếp sang Giao thành công', async () => {
    const reportedAt = new Date('2026-08-27T09:30:00.000Z');
    jest.useFakeTimers().setSystemTime(reportedAt);
    const { service, tx } = createService(createInvoice(null));

    await service.update(1, { status: INVOICE_STATUS.DELIVERED } as any, 9);

    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          status: INVOICE_STATUS.DELIVERED,
          deliveredAt: reportedAt,
        }),
      }),
    );
  });

  it('giữ nguyên mốc giao sớm nhất khi hóa đơn đã có deliveredAt', async () => {
    const firstDeliveredAt = new Date('2026-08-26T09:30:00.000Z');
    const { service, tx } = createService(createInvoice(firstDeliveredAt));

    await service.update(1, { status: INVOICE_STATUS.DELIVERED } as any, 9);

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toBeUndefined();
  });

  it('ưu tiên mốc phiếu giao sớm nhất khi dữ liệu cũ chưa có deliveredAt', async () => {
    const firstPackingSlipAt = new Date('2026-08-26T08:00:00.000Z');
    const { service, tx } = createService(
      createInvoice(null),
      firstPackingSlipAt,
    );

    await service.update(1, { status: INVOICE_STATUS.DELIVERED } as any, 9);

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toEqual(firstPackingSlipAt);
  });

  it('không xem thao tác Hoàn thành là một lần báo đơn', async () => {
    const { service, tx } = createService(createInvoice(null));

    await service.update(1, { status: INVOICE_STATUS.COMPLETED } as any, 9);

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toBeUndefined();
    expect(tx.packingSlipInvoice.findFirst).not.toHaveBeenCalled();
  });

  it('tính lại tổng và công nợ khi cập nhật phí giao hàng', async () => {
    const { service, tx } = createService(createInvoice(null));

    await service.update(1, { shippingFee: 15_000 } as any, 9);

    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shippingFee: 15_000,
          grandTotal: 115_000,
          debtAmount: 115_000,
        }),
      }),
    );
  });

  it('giữ nguyên phí giao hàng khi patch không gửi field', async () => {
    const invoice = { ...createInvoice(null), shippingFee: 15_000 };
    const { service, tx } = createService(invoice);

    await service.update(1, { description: 'Ghi chú mới' } as any, 9);

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.shippingFee).toBeUndefined();
    expect(updateInput.data.grandTotal).toBeUndefined();
  });

  it('khóa invoice trước khi đọc trong update transaction', async () => {
    const { service, tx } = createService(createInvoice(null));
    const calls: string[] = [];
    (tx as any).$queryRaw.mockImplementation(() => {
      calls.push('lock');
      return Promise.resolve([{ id: 1 }]);
    });
    tx.invoice.findUnique.mockImplementation(() => {
      calls.push('read');
      return Promise.resolve(createInvoice(null));
    });

    await service.update(1, { description: 'Ghi chú mới' } as any, 9);

    expect(calls.slice(0, 2)).toEqual(['lock', 'read']);
  });
});

describe('InvoicesService customer invoice debt guard', () => {
  const createService = () =>
    new InvoicesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  const policy = (requireFullPaymentForInvoice: boolean) => ({
    debtForm: 'TRUST',
    hasCreditLimit: false,
    hasTermDays: false,
    isActive: true,
    requireFullPaymentForInvoice,
  });

  it('chặn thanh toán thiếu khi chính sách yêu cầu trả đủ', () => {
    const service = createService() as any;

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(true),
        paidAmount: 98,
        grandTotal: 100,
        mode: 'invoice',
      }),
    ).toThrow('Khách hàng không được phép phát sinh công nợ');
  });

  it('chặn thanh toán thiếu khi chính sách yêu cầu trả đủ và phương thức là chuyển khoản', () => {
    const service = createService() as any;

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(true),
        paidAmount: 50,
        grandTotal: 100,
        mode: 'order',
        paymentMethod: 'transfer',
      }),
    ).toThrow('Khách hàng không được phép phát sinh công nợ');
  });

  it('cho phép tạo hóa đơn khi chính sách yêu cầu trả đủ nhưng phương thức là tiền mặt', () => {
    const service = createService() as any;

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(true),
        paidAmount: 0,
        grandTotal: 100,
        mode: 'invoice',
        paymentMethod: 'cash',
      }),
    ).not.toThrow();

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(true),
        paidAmount: 0,
        grandTotal: 100,
        mode: 'order',
        paymentMethod: 'cash',
      }),
    ).not.toThrow();
  });

  it('cho phép thanh toán thiếu khi cờ cũ đang tắt', () => {
    const service = createService() as any;

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(false),
        paidAmount: 0,
        grandTotal: 100,
        mode: 'invoice',
      }),
    ).not.toThrow();
  });

  it('cho phép đúng đủ tiền khi chính sách yêu cầu trả đủ', () => {
    const service = createService() as any;

    expect(() =>
      service.assertCustomerInvoiceCanBeCreated({
        policy: policy(true),
        paidAmount: 100,
        grandTotal: 100,
        mode: 'order',
        paymentMethod: 'transfer',
      }),
    ).not.toThrow();
  });
});

describe('InvoicesService optimized list contracts', () => {
  const createService = (prisma: any) =>
    new InvoicesService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('getTotals chỉ tải invoice có return order để điều chỉnh totals', async () => {
    const prisma = {
      invoice: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: {
            totalAmount: 1000,
            grandTotal: 1000,
            paidAmount: 100,
            debtAmount: 900,
          },
          _count: { _all: 2 },
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 2,
            grandTotal: 500,
            paidAmount: 0,
          },
        ]),
      },
      returnOrder: {
        groupBy: jest.fn().mockResolvedValue([
          {
            invoiceId: 2,
            status: 4,
            refundType: 'cash_refund',
            _sum: {
              refundAmount: 100,
              refundedAmount: 100,
            },
          },
        ]),
      },
    };
    const service = createService(prisma);
    jest
      .spyOn(service as any, 'buildInvoiceListWhere')
      .mockResolvedValue({ branchId: 1 });

    const totals = await service.getTotals({} as any);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [2] } },
      }),
    );
    expect(totals.returnOrderAmount).toBe(100);
    expect(totals.cashRefundAmount).toBe(100);
    expect(totals.remainingAmount).toBe(900);
  });

  it('findPickupDetails chỉ select dữ liệu cần cho phiếu pick-up', async () => {
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = createService(prisma);

    await service.findPickupDetails([3, 5]);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [3, 5] } },
        select: expect.objectContaining({
          id: true,
          code: true,
          customer: expect.any(Object),
          details: expect.objectContaining({
            select: expect.objectContaining({
              productCode: true,
              productName: true,
              quantity: true,
              conditionType: true,
            }),
          }),
        }),
      }),
    );
  });
});

describe('InvoicesService source shipping fee allocation', () => {
  const service = new InvoicesService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  ) as any;

  it('phân bổ toàn bộ phần phí còn lại khi DTO không gửi shippingFee', () => {
    expect(
      service.allocateSourceShippingFee(
        30_000,
        [{ shippingFee: 10_000, status: INVOICE_STATUS.PROCESSING }],
        undefined,
      ),
    ).toBe(20_000);
  });

  it('từ chối override vượt phần phí còn lại và cho phép explicit 0', () => {
    const priorInvoices = [
      { shippingFee: 20_000, status: INVOICE_STATUS.DELIVERED },
    ];

    expect(() =>
      service.allocateSourceShippingFee(30_000, priorInvoices, 50_000),
    ).toThrow('Phí giao hàng phân bổ không được vượt quá 10000');
    expect(service.allocateSourceShippingFee(30_000, priorInvoices, 0)).toBe(0);
  });

  it('chấp nhận sai số nhỏ khi override sát phần phí còn lại', () => {
    expect(service.allocateSourceShippingFee(30_000, [], 30_000.5)).toBe(
      30_000,
    );
  });

  it('không tính phí của invoice đã hủy/superseded', () => {
    expect(
      service.allocateSourceShippingFee(
        30_000,
        [
          { shippingFee: 30_000, status: INVOICE_STATUS.CANCELLED },
          { shippingFee: 5_000, status: INVOICE_STATUS.PROCESSING },
        ],
        undefined,
      ),
    ).toBe(25_000);
  });
});
