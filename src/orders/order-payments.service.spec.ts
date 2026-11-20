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
