import { OrdersService } from './orders.service';
import { INVOICE_STATUS } from '../invoices/dto';

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
              debtPolicy: { select: { debtRuleType: true } },
            }),
          }),
        }),
      }),
    );
    expect(result.data[0].customer?.debtPolicy?.debtRuleType).toBe(
      'CREDIT_LIMIT',
    );
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
