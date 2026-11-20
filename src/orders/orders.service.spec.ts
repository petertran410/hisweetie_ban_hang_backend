import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { INVOICE_STATUS } from '../invoices/dto';
import * as orderPayments from './order-payments.service';
import * as paymentNotes from '../payment-notes/payment-notes.service';

describe('OrdersService findOne', () => {
  it('chỉ loại invoice đã hủy khỏi relation', async () => {
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    };
    const service = new OrdersService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.findOne(1);

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          invoices: expect.objectContaining({
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
          }),
        }),
      }),
    );
  });
});

describe('OrdersService findAll', () => {
  it('trả loại công nợ hiện tại cùng khách hàng trong danh sách', async () => {
    const order = {
      id: 1,
      customer: { id: 2, debtPolicy: { debtRuleType: 'CREDIT_LIMIT' } },
    };
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([order]),
        count: jest.fn().mockResolvedValue(1),
      },
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new OrdersService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.findAll({ page: 1, limit: 15 } as any);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          customer: expect.objectContaining({
            select: expect.objectContaining({
              debtPolicy: {
                select: {
                  debtRuleType: true,
                  requireFullPaymentForInvoice: true,
                },
              },
            }),
          }),
        }),
      }),
    );
    expect(result.data[0].customer?.debtPolicy?.debtRuleType).toBe(
      'CREDIT_LIMIT',
    );
    expect(result.data[0]).toMatchObject({ hasPriceBookWarning: false, warnings: null });
  });

  it('gắn cảnh báo lệch giá bảng giá, phí ship, hàng lạnh theo từng đơn', async () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, shippingFee: new Prisma.Decimal(0) },
          { id: 2, shippingFee: new Prisma.Decimal(30000) },
        ]),
        count: jest.fn().mockResolvedValue(2),
      },
      orderItem: { findMany: jest.fn().mockResolvedValue([{ orderId: 1 }]) },
      $queryRaw: jest.fn().mockResolvedValue([
        { id: 2, productCode: 'SP1', productName: 'Mứt Mận', price: new Prisma.Decimal(135000), listPrice: new Prisma.Decimal(140000) },
      ]),
    };
    const service = new OrdersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.findAll({ page: 1, limit: 15 } as any);

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: { in: [1, 2] }, product: { cargoType: 'COLD' } },
      }),
    );
    expect(result.data[0]).toMatchObject({
      hasPriceBookWarning: false,
      hasShippingFee: false,
      hasColdItems: true,
      warnings: null,
    });
    expect(result.data[1]).toMatchObject({
      hasPriceBookWarning: true,
      hasShippingFee: true,
      hasColdItems: false,
      warnings: {
        price: [{ productCode: 'SP1', productName: 'Mứt Mận', price: 135000, listPrice: 140000 }],
        quantity: [],
      },
    });
  });
});

describe('OrdersService bộ lọc Cảnh báo đơn hàng', () => {
  const make = () => {
    const prisma = {
      order: { findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 2 }]),
    };
    const service = new OrdersService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { prisma, service };
  };

  it('không chọn ô nào: không thêm điều kiện, không truy vấn', async () => {
    const { prisma, service } = make();
    const where = await (service as any).buildOrderListWhere({});
    expect(where.AND).toBeUndefined();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('nhiều ô: OR giữa lệch giá / phí ship / hàng lạnh, giữ bộ lọc khác', async () => {
    const { prisma, service } = make();
    const where = await (service as any).buildOrderListWhere({
      branchIds: [1],
      priceWarning: true,
      hasShippingFee: true,
      hasColdItems: true,
    });
    expect(where.branchId).toEqual({ in: [1] });
    // Lệch giá chỉ xét đơn đã khớp bộ lọc khác, cùng điều kiện với icon
    expect(prisma.order.findMany.mock.calls[0][0].where.branchId).toEqual({ in: [1] });
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('(oi.price - oi.discount) < pbd.price');
    expect(sql.values).toEqual([1, 2, 3]);
    expect(where.AND).toEqual([
      {
        OR: [
          { shippingFee: { gt: 0 } },
          { items: { some: { product: { cargoType: 'COLD' } } } },
          { id: { in: [2] } },
        ],
      },
    ]);
  });

  it('lệch giá không có đơn nào → không ra đơn (id -1)', async () => {
    const { prisma, service } = make();
    prisma.$queryRaw.mockResolvedValue([]);
    const where = await (service as any).buildOrderListWhere({ priceWarning: true });
    expect(where.AND).toEqual([{ OR: [{ id: { in: [-1] } }] }]);
  });
});

const buildService = (prisma: any, auditLogs: any = { create: jest.fn() }) =>
  new OrdersService(
    prisma,
    {} as any,
    auditLogs,
    {} as any,
    {} as any,
    {} as any,
  );

describe('OrdersService updateOrderStatusByInvoices', () => {
  const run = async (
    invoiced: Array<{ productId: number; qty: number }>,
    opts: { invoiceCount?: number; forceComplete?: boolean } = {},
  ) => {
    const tx = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          status: 5,
          items: [
            { productId: 10, quantity: 5 },
            { productId: 11, quantity: 2 },
          ],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      invoice: { count: jest.fn().mockResolvedValue(opts.invoiceCount ?? 1) },
      invoiceDetail: {
        groupBy: jest.fn().mockResolvedValue(
          invoiced.map((i) => ({
            productId: i.productId,
            _sum: { quantity: i.qty },
          })),
        ),
      },
    };
    await buildService({}).updateOrderStatusByInvoices(
      1,
      tx,
      opts.forceComplete,
    );
    return tx;
  };

  it('xuất đủ → hoàn thành', async () => {
    const tx = await run([
      { productId: 10, qty: 5 },
      { productId: 11, qty: 3 },
    ]);
    expect(tx.order.update.mock.calls[0][0].data.status).toBe(3);
    expect(tx.invoiceDetail.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoice: { orderId: 1, status: { not: 2 } } },
      }),
    );
  });

  it('xuất thiếu → xuất một phần', async () => {
    const tx = await run([{ productId: 10, qty: 5 }]);
    expect(tx.order.update.mock.calls[0][0].data.status).toBe(6);
  });

  it('xuất thiếu nhưng ép kết thúc → hoàn thành', async () => {
    const tx = await run([{ productId: 10, qty: 1 }], { forceComplete: true });
    expect(tx.order.update.mock.calls[0][0].data.status).toBe(3);
  });

  it('không có hóa đơn còn hiệu lực → giữ nguyên', async () => {
    const tx = await run([], { invoiceCount: 0 });
    expect(tx.invoiceDetail.groupBy).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe('OrdersService create', () => {
  it('tra sản phẩm/tồn kho 1 lần, sinh mã trong transaction, ghi audit sau commit', async () => {
    const order = { id: 7, code: 'DH000007', branchId: 1, customer: null };
    const tx: any = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 10, code: 'A', name: 'Bánh A', conversionValue: 1 },
          { id: 11, code: 'B', name: 'Bánh B', conversionValue: 1 },
        ]),
      },
      inventory: {
        findMany: jest.fn().mockResolvedValue([{ productId: 10, onHand: 1 }]),
      },
      priceBook: { findFirst: jest.fn().mockResolvedValue(null) },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 6 }),
        create: jest.fn().mockResolvedValue(order),
        findUnique: jest.fn().mockResolvedValue(order),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'NV' }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const order$: string[] = [];
    const auditLogs = {
      create: jest.fn().mockImplementation(() => {
        order$.push('audit');
      }),
    };
    const prisma = {
      $transaction: jest.fn(async (cb: any, _opts?: any) => {
        const r = await cb(tx);
        order$.push('commit');
        return r;
      }),
    };
    const service = buildService(prisma, auditLogs);
    jest.spyOn(service as any, 'processOrderPromotions').mockResolvedValue({
      effectiveItems: [
        { productId: 10, quantity: 3, unitPrice: 100 },
        { productId: 11, quantity: 1, unitPrice: 50 },
        { productId: 10, quantity: 1, unitPrice: 100 },
      ],
      extraDiscount: 0,
      logs: [],
    });
    jest.spyOn(service as any, 'calculateTotals').mockResolvedValue(undefined);

    const result = await service.create(
      { branchId: 1, priceBookId: 0, items: [] } as any,
      9,
    );

    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(tx.inventory.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.order.create.mock.calls[0][0].data.code).toBe('DH000007');
    expect(result.warnings).toEqual([
      'Sản phẩm Bánh A không đủ tồn kho (Có: 1, Cần: 3)',
      'Sản phẩm Bánh B không đủ tồn kho (Có: 0, Cần: 1)',
    ]);
    expect(order$).toEqual(['commit', 'audit']);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      timeout: 30000,
      maxWait: 10000,
    });
  });
});

describe('OrdersService cancelOrder', () => {
  const setup = (orderUpdate: jest.Mock) => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          code: 'DH000001',
          status: 1,
          branchId: 1,
          customerId: null,
          customer: null,
          items: [],
          invoices: [],
          payments: [
            { id: 5, code: 'TT1', amount: 100, paymentMethod: 'cash' },
          ],
        }),
        update: orderUpdate,
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'NV' }) },
      orderPayment: { updateMany: jest.fn().mockResolvedValue({}) },
      cashFlow: { updateMany: jest.fn().mockResolvedValue({}) },
      invoicePromotionLog: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, promotionId: 3 },
          { id: 2, promotionId: 3 },
          { id: 3, promotionId: 4 },
        ]),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      promotion: { updateMany: jest.fn().mockResolvedValue({}) },
    };
    const auditLogs = { create: jest.fn() };
    const prisma = { $transaction: jest.fn((cb) => cb(tx)) };
    return { tx, auditLogs, service: buildService(prisma, auditLogs) };
  };

  it('khóa đơn, gom hoàn lượt dùng KM và ghi audit sau khi xong', async () => {
    const { tx, auditLogs, service } = setup(jest.fn().mockResolvedValue({}));

    await service.cancelOrder(1, { cancelPayments: true } as any, 9);
    await new Promise((resolve) => setImmediate(resolve)); // audit ghi nền

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.promotion.updateMany.mock.calls.map((c: any) => c[0])).toEqual([
      { where: { id: 3 }, data: { usageCount: { decrement: 2 } } },
      { where: { id: 4 }, data: { usageCount: { decrement: 1 } } },
    ]);
    expect(
      auditLogs.create.mock.calls.map((c: any) => c[0].actionCode),
    ).toEqual(['ORDER_PAYMENT_DELETE', 'ORDER_CANCEL']);
  });

  it('không ghi audit khi transaction lỗi', async () => {
    const { auditLogs, service } = setup(
      jest.fn().mockRejectedValue(new Error('db')),
    );

    await expect(
      service.cancelOrder(1, { cancelPayments: true } as any, 9),
    ).rejects.toThrow('db');
    expect(auditLogs.create).not.toHaveBeenCalled();
  });
});

describe('OrdersService update — chặn xác nhận đơn theo công nợ', () => {
  const PENDING = 1;
  const CONFIRMED = 5;

  const setup = (opts: {
    currentStatus: number;
    savedStatus: number;
    requireFullPayment?: boolean;
    stopDeliveryHold?: boolean;
    items?: any[];
    savedGrandTotal?: number;
  }) => {
    const baseOrder = {
      id: 1,
      code: 'DH000001',
      branchId: 1,
      customerId: 3,
      statusValue: 'x',
      grandTotal: 100000,
      items: opts.items ?? [],
      customer: { id: 3, code: 'KH1', name: 'Khách' },
    };
    // Phiếu thanh toán / ghi chú TM-CK tạo trong lần lưu (qua helper bên dưới)
    // → assertCanConfirmOrder đọc lại được, như khi chạy cùng transaction thật.
    const created = {
      payments: [] as Array<{ amount: number; status: number; code: string }>,
      notes: [] as Array<{ paymentType: string }>,
    };
    const createdPaid = () =>
      created.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      order: {
        // assertCanConfirmOrder đọc bằng `select`, các lần khác bằng `include`.
        findUnique: jest.fn().mockImplementation((args: any) => {
          if (args.select) {
            return Promise.resolve({
              customerId: 3,
              grandTotal: 100000,
              payments: created.payments,
              paymentNotes: [...created.notes].reverse(),
              customer: {
                // Phiếu thu của lần thanh toán đơn làm công nợ khách giảm.
                totalDebt: -createdPaid(),
                debtPolicy: {
                  isActive: true,
                  requireFullPaymentForInvoice: !!opts.requireFullPayment,
                },
              },
            });
          }
          const isFirstRead = tx.order.findUnique.mock.calls.length === 1;
          return Promise.resolve({
            ...baseOrder,
            status: isFirstRead ? opts.currentStatus : opts.savedStatus,
            grandTotal: isFirstRead
              ? baseOrder.grandTotal
              : (opts.savedGrandTotal ?? baseOrder.grandTotal),
          });
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      debtTicketCustomer: {
        findFirst: jest
          .fn()
          .mockResolvedValue(opts.stopDeliveryHold ? { id: 10 } : null),
      },
      // customerDebtForOrderPrepaidCheck: đơn chưa có HĐ, phiếu thu gắn đơn
      // chính là các lần thanh toán tạo trong lần lưu.
      invoice: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotal: 0 } }),
      },
      orderPayment: {
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve(created.payments.map(({ code }) => ({ code }))),
        ),
      },
      cashFlow: {
        aggregate: jest.fn().mockImplementation(() =>
          Promise.resolve({ _sum: { amount: createdPaid() } }),
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const larkOrderNotification = { notifyOrderConfirmedAsync: jest.fn() };
    const auditLogsService = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(
      prisma as any,
      {} as any,
      auditLogsService as any,
      {} as any,
      larkOrderNotification as any,
      {} as any,
    );
    const calculateTotals = jest
      .spyOn(service as any, 'calculateTotals')
      .mockResolvedValue(undefined);
    const createPayment = jest
      .spyOn(orderPayments, 'createOrderPaymentInTx')
      .mockImplementation(((_tx: any, dto: any) => {
        created.payments.push({
          amount: dto.amount,
          status: 0,
          code: `TTDH000001-${created.payments.length + 1}`,
        });
        return Promise.resolve({
          payment: {},
          cashFlow: {},
          auditLog: { actionCode: 'ORDER_PAYMENT_CREATE' },
        });
      }) as any);
    const createNote = jest
      .spyOn(paymentNotes, 'createOrderPaymentNoteInTx')
      .mockImplementation(((_tx: any, _id: number, dto: any) => {
        created.notes.push({ paymentType: dto.paymentType });
        return Promise.resolve({
          note: {},
          auditLog: { actionCode: 'ORDER_PAYMENT_NOTE_CHANGE' },
        });
      }) as any);
    return {
      service,
      tx,
      larkOrderNotification,
      auditLogsService,
      calculateTotals,
      createPayment,
      createNote,
    };
  };

  afterEach(() => jest.restoreAllMocks());

  it('chặn khách không công nợ chưa trả đủ, không gửi card Lark', async () => {
    const { service, tx, larkOrderNotification } = setup({
      currentStatus: PENDING,
      savedStatus: CONFIRMED,
      requireFullPayment: true,
    });

    await expect(
      service.update(1, { orderStatus: 'confirmed' } as any, { id: 9 }),
    ).rejects.toThrow('chưa được thanh toán đủ nên không thể xác nhận');
    expect(tx.order.update).toHaveBeenCalled();
    expect(
      larkOrderNotification.notifyOrderConfirmedAsync,
    ).not.toHaveBeenCalled();
  });

  it('chặn khách có phiếu ngừng đi hàng đang mở', async () => {
    const { service } = setup({
      currentStatus: PENDING,
      savedStatus: CONFIRMED,
      stopDeliveryHold: true,
    });

    await expect(
      service.update(1, { orderStatus: 'confirmed' } as any, { id: 9 }),
    ).rejects.toThrow('phiếu ngừng đi hàng');
  });

  it('cho xác nhận khi khách đủ điều kiện', async () => {
    const { service, tx, larkOrderNotification } = setup({
      currentStatus: PENDING,
      savedStatus: CONFIRMED,
    });

    await service.update(1, { orderStatus: 'confirmed' } as any, { id: 9 });

    expect(tx.debtTicketCustomer.findFirst).toHaveBeenCalled();
    // (orderId, confirmedById): người xác nhận là user id 9
    expect(
      larkOrderNotification.notifyOrderConfirmedAsync,
    ).toHaveBeenCalledWith(1, 9);
  });

  it('không kiểm tra khi chỉ sửa ghi chú hoặc đơn đã xác nhận sẵn', async () => {
    const pending = setup({
      currentStatus: PENDING,
      savedStatus: PENDING,
      requireFullPayment: true,
    });
    await pending.service.update(1, { description: 'ghi chú' } as any, {
      id: 9,
    });
    expect(pending.tx.debtTicketCustomer.findFirst).not.toHaveBeenCalled();

    const confirmed = setup({
      currentStatus: CONFIRMED,
      savedStatus: CONFIRMED,
      requireFullPayment: true,
    });
    await confirmed.service.update(
      1,
      { orderStatus: 'confirmed', description: 'ghi chú' } as any,
      { id: 9 },
    );
    expect(confirmed.tx.debtTicketCustomer.findFirst).not.toHaveBeenCalled();
  });

  it('kiểm tra lại khi đơn đã xác nhận bị tăng tổng tiền', async () => {
    const { service } = setup({
      currentStatus: CONFIRMED,
      savedStatus: CONFIRMED,
      requireFullPayment: true,
      savedGrandTotal: 150000,
    });

    await expect(
      service.update(1, { shippingFee: 50000 } as any, { id: 9 }),
    ).rejects.toThrow('chưa được thanh toán đủ nên không thể xác nhận');
  });

  describe('khóa sản phẩm khi đơn không còn Phiếu tạm', () => {
    const savedItems = [
      {
        productId: 1,
        quantity: 10,
        price: 50000,
        lineType: 'normal',
        product: { name: 'SP 1' },
      },
    ];

    it('chặn thêm sản phẩm vào đơn đã xác nhận, không xóa dòng cũ', async () => {
      const { service, tx } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        items: savedItems,
      });
      tx.orderItem = { deleteMany: jest.fn() };

      await expect(
        service.update(
          1,
          {
            items: [
              { productId: 1, quantity: 10, unitPrice: 50000 },
              { productId: 2, quantity: 1, unitPrice: 20000 },
            ],
          } as any,
          { id: 9 },
        ),
      ).rejects.toThrow('không thể thêm hoặc sửa sản phẩm');
      expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    });

    it('cho lưu đơn đã xác nhận khi dòng hàng gửi lại y nguyên', async () => {
      const { service, tx } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        items: savedItems,
      });
      // Dòng hàng không đổi → dừng ở bước xử lý dòng hàng như cũ, không bị chặn.
      tx.orderItem = {
        deleteMany: jest.fn().mockRejectedValue(new Error('qua kiểm tra')),
      };

      await expect(
        service.update(
          1,
          { items: [{ productId: 1, quantity: 10, unitPrice: 50000 }] } as any,
          { id: 9 },
        ),
      ).rejects.toThrow('qua kiểm tra');
    });

    it('cho sửa sản phẩm khi đơn đang Phiếu tạm', async () => {
      const { service, tx } = setup({
        currentStatus: PENDING,
        savedStatus: PENDING,
        items: savedItems,
      });
      tx.orderItem = {
        deleteMany: jest.fn().mockRejectedValue(new Error('qua kiểm tra')),
      };

      await expect(
        service.update(
          1,
          { items: [{ productId: 1, quantity: 12, unitPrice: 50000 }] } as any,
          { id: 9 },
        ),
      ).rejects.toThrow('qua kiểm tra');
    });
  });

  describe('lưu tiền khách trả + TM/CK cùng 1 lần với đơn', () => {
    it('TM chọn ở lần lưu này được miễn kiểm tra trả đủ ngay lần đó', async () => {
      const { service, createNote, calculateTotals } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        requireFullPayment: true,
        savedGrandTotal: 150000,
      });

      await service.update(
        1,
        {
          shippingFee: 50000,
          paymentNote: { paymentType: 'cash', amount: 150000 },
        } as any,
        { id: 9, name: 'Nhân viên A' },
      );

      expect(createNote).toHaveBeenCalledWith(
        expect.anything(),
        1,
        { paymentType: 'cash', amount: 150000 },
        9,
        'Nhân viên A',
      );
      // Ghi chú phải có TRƯỚC khi tính tổng + kiểm tra công nợ.
      expect(createNote.mock.invocationCallOrder[0]).toBeLessThan(
        calculateTotals.mock.invocationCallOrder[0],
      );
    });

    it('tiền khách trả ở lần lưu này được tính khi kiểm tra trả đủ', async () => {
      const { service, createPayment } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        requireFullPayment: true,
        savedGrandTotal: 150000,
      });

      await service.update(
        1,
        {
          shippingFee: 50000,
          payments: [{ amount: 100000, paymentMethod: 'transfer' }],
          paymentNote: { paymentType: 'transfer' },
        } as any,
        { id: 9 },
      );

      expect(createPayment).toHaveBeenCalledWith(
        expect.anything(),
        {
          orderId: 1,
          amount: 100000,
          paymentMethod: 'transfer',
          accountId: undefined,
        },
        9,
      );
    });

    it('lưu bị chặn ở bước kiểm tra → không ghi log phiếu thu (transaction rollback)', async () => {
      const { service, auditLogsService } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        requireFullPayment: true,
        savedGrandTotal: 150000,
      });

      await expect(
        service.update(
          1,
          {
            shippingFee: 50000,
            payments: [{ amount: 10000 }],
            paymentNote: { paymentType: 'transfer' },
          } as any,
          { id: 9 },
        ),
      ).rejects.toThrow('chưa được thanh toán đủ nên không thể xác nhận');
      expect(auditLogsService.create).not.toHaveBeenCalled();
    });

    it('dòng hàng bị chặn → chưa tạo phiếu thu, chưa ghi chú', async () => {
      const { service, tx, createPayment, createNote } = setup({
        currentStatus: CONFIRMED,
        savedStatus: CONFIRMED,
        items: [
          {
            productId: 1,
            quantity: 10,
            price: 50000,
            lineType: 'normal',
            product: { name: 'SP 1' },
          },
        ],
      });
      tx.orderItem = { deleteMany: jest.fn() };

      await expect(
        service.update(
          1,
          {
            items: [{ productId: 1, quantity: 11, unitPrice: 50000 }],
            payments: [{ amount: 500000 }],
            paymentNote: { paymentType: 'cash', amount: 500000 },
          } as any,
          { id: 9 },
        ),
      ).rejects.toThrow('không thể thêm hoặc sửa sản phẩm');
      expect(createPayment).not.toHaveBeenCalled();
      expect(createNote).not.toHaveBeenCalled();
    });

    it('lưu thành công → ghi log phiếu thu + đổi TM/CK sau commit', async () => {
      const { service, auditLogsService } = setup({
        currentStatus: PENDING,
        savedStatus: PENDING,
      });

      await service.update(
        1,
        {
          payments: [{ amount: 200000, paymentMethod: 'cash' }],
          paymentNote: { paymentType: 'cash', amount: 200000 },
        } as any,
        { id: 9 },
      );
      await new Promise((resolve) => setImmediate(resolve));

      const codes = auditLogsService.create.mock.calls.map(
        ([log]: any[]) => log.actionCode,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          'ORDER_PAYMENT_CREATE',
          'ORDER_PAYMENT_NOTE_CHANGE',
          'ORDER_UPDATE',
        ]),
      );
    });
  });
});

describe('OrdersService create → nhắc thiết lập công nợ', () => {
  const run = async (policy: any, customerId: number | null = 3) => {
    const order = { id: 7, code: 'DH000007', branchId: 1, customer: null };
    const tx: any = {
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 10, code: 'A', name: 'Bánh A', conversionValue: 1 },
          ]),
      },
      inventory: {
        findMany: jest.fn().mockResolvedValue([{ productId: 10, onHand: 9 }]),
      },
      customerAddress: { findMany: jest.fn().mockResolvedValue([]) },
      customerDebtPolicy: { findUnique: jest.fn().mockResolvedValue(policy) },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 6 }),
        create: jest.fn().mockResolvedValue(order),
        findUnique: jest.fn().mockResolvedValue(order),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'NV' }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = { $transaction: jest.fn(async (cb: any) => cb(tx)) };
    const service = buildService(prisma);
    jest.spyOn(service as any, 'processOrderPromotions').mockResolvedValue({
      effectiveItems: [{ productId: 10, quantity: 1, unitPrice: 100 }],
      extraDiscount: 0,
      logs: [],
    });
    jest.spyOn(service as any, 'calculateTotals').mockResolvedValue(undefined);
    const result = await service.create(
      { branchId: 1, priceBookId: 0, customerId, items: [] } as any,
      9,
    );
    return { result, tx };
  };

  it('khách cũ chưa có policy → debtPolicyUnset = true', async () => {
    const { result } = await run(null);
    expect(result.debtPolicyUnset).toBe(true);
  });

  it('khách "Không công nợ" → không nhắc', async () => {
    const { result } = await run({
      debtRuleType: 'NONE',
      requireFullPaymentForInvoice: true,
    });
    expect(result.debtPolicyUnset).toBe(false);
  });

  it('khách vãng lai → không tra policy, không nhắc', async () => {
    const { result, tx } = await run(null, null);
    expect(result.debtPolicyUnset).toBe(false);
    expect(tx.customerDebtPolicy.findUnique).not.toHaveBeenCalled();
  });
});
