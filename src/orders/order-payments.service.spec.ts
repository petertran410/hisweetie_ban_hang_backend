import { OrderPaymentsService } from './order-payments.service';

describe('OrderPaymentsService create', () => {
  const setup = (opts: { failInTx?: boolean } = {}) => {
    const tx: any = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          code: 'DH000001',
          branchId: 2,
          customerId: 3,
          grandTotal: 300000,
          customer: { id: 3, code: 'KH1', name: 'Khách', addresses: [] },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      orderPayment: {
        findMany: jest
          .fn()
          // lần 1: đếm số phiếu đã có (sinh mã); lần 2: phiếu còn hiệu lực.
          .mockResolvedValueOnce([{ id: 7 }])
          .mockResolvedValueOnce([{ amount: 100000 }, { amount: 200000 }]),
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 11, paymentDate: new Date(), ...data }),
        ),
      },
      cashFlow: {
        create: jest.fn(({ data }: any) => {
          if (opts.failInTx) return Promise.reject(new Error('lỗi sổ quỹ'));
          return Promise.resolve({ id: 21, ...data });
        }),
        update: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      invoice: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotal: 0 } }),
      },
      returnOrder: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { refundAmount: 0 } }),
      },
      customer: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ totalDebt: -200000 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Nhân viên A' }),
      },
    };
    const prisma = { $transaction: jest.fn(async (cb: any) => cb(tx)) };
    const auditLogsService = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new OrderPaymentsService(
      prisma as any,
      auditLogsService as any,
    );
    return { service, tx, auditLogsService };
  };

  it('tạo phiếu + phiếu thu, trả { payment, cashFlow } và ghi log sau commit', async () => {
    const { service, tx, auditLogsService } = setup();

    const result = await service.create(
      { orderId: 1, amount: 200000, paymentMethod: 'cash' } as any,
      9,
    );

    expect(Object.keys(result).sort()).toEqual(['cashFlow', 'payment']);
    expect(result.payment.code).toBe('TTDH000001-2');
    expect(result.cashFlow.code).toBe('TTDH000001-2');
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { paidAmount: 300000, depositAmount: 300000, debtAmount: 0 },
    });
    expect(tx.cashFlow.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { customerDebtSnapshot: -200000 },
    });
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: 'ORDER_PAYMENT_CREATE',
        entityCode: 'TTDH000001-2',
        userName: 'Nhân viên A',
      }),
    );
  });

  it('transaction lỗi → không ghi log', async () => {
    const { service, auditLogsService } = setup({ failInTx: true });

    await expect(
      service.create({ orderId: 1, amount: 200000 } as any, 9),
    ).rejects.toThrow('lỗi sổ quỹ');
    expect(auditLogsService.create).not.toHaveBeenCalled();
  });
});

describe('OrderPaymentsService remove → hủy kèm bản sao trên hóa đơn', () => {
  const AT = new Date('2026-11-20T09:32:58.277Z');
  const payment = {
    id: 10,
    code: 'TTDH130121-1',
    orderId: 130121,
    amount: 3099000,
    paymentDate: AT,
    status: 1,
    order: { code: 'DH130121', customer: { code: 'KH052214', name: 'Khách' } },
    creator: null,
  };

  const setup = (mirrors: Record<string, unknown>[]) => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      orderPayment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        // Tìm bản sao: phiếu khác của đơn (orderId.in); sau hủy: phiếu còn lại.
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(where.orderId?.in ? [payment] : []),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      invoicePayment: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(where.code ? mirrors : []),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cashFlow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          grandTotal: 1315000,
          status: 1,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      returnOrder: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          grandTotal: 1315000,
          customerId: 5,
          branchId: 1,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Kế toán' }) },
    };
    const prisma = { $transaction: jest.fn(async (cb: any) => cb(tx)) };
    const auditLogsService = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new OrderPaymentsService(
      prisma as any,
      auditLogsService as any,
    );
    jest
      .spyOn(service as any, 'recalculateCustomerDebt')
      .mockResolvedValue(undefined);
    return { service, tx };
  };

  it('hủy TTTUHD137790-1 + phiếu thu của nó và tính lại HD137790', async () => {
    const { service, tx } = setup([
      {
        id: 1,
        invoiceId: 116,
        cashFlowId: 901,
        code: 'TTTUHD137790-1',
        amount: 3099000,
        paymentDate: AT,
        invoice: { orderId: 130121 },
      },
    ]);

    await service.remove(10, 9);

    expect(tx.invoicePayment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      data: { status: 2, statusValue: 'Đã hủy' },
    });
    expect(tx.cashFlow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [901] }, status: { not: 2 } },
      data: { status: 2, statusValue: 'Đã hủy' },
    });
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 116 },
      data: {
        paidAmount: 0,
        debtAmount: 1315000,
        status: 7,
        statusValue: 'Giao thành công',
      },
    });
    // Phiếu gốc vẫn bị hủy như trước.
    expect(tx.cashFlow.updateMany).toHaveBeenCalledWith({
      where: { code: 'TTDH130121-1', status: { not: 2 } },
      data: { status: 2, statusValue: 'Đã hủy' },
    });
  });

  it('đơn chưa có hóa đơn thì không đụng tới hóa đơn', async () => {
    const { service, tx } = setup([]);

    await service.remove(10, 9);

    expect(tx.invoicePayment.updateMany).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.orderPayment.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: 2, statusValue: 'Đã hủy' },
    });
  });
});
