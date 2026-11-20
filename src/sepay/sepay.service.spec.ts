import { SepayService } from './sepay.service';

describe('SepayService handleWebhook → khớp mã trong nội dung chuyển khoản', () => {
  const QR_CONTENT =
    'TKP#QRPSEP1ZZZZ54900790#6324PGBLP2FU8SPB.DH129766.20261120.112809.1313333797999.CTTNHH TM VA TP NGOC OANH.970430';

  const setup = (orders: Record<string, { id: number; soldById: number }>) => {
    const prisma = {
      invoicePayment: { findUnique: jest.fn().mockResolvedValue(null) },
      orderPayment: { findUnique: jest.fn().mockResolvedValue(null) },
      invoice: { findUnique: jest.fn().mockResolvedValue(null) },
      order: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(orders[where.code] ?? null),
        ),
      },
    };
    const orderPaymentsService = {
      create: jest.fn().mockResolvedValue({ payment: { id: 77 } }),
    };
    const service = new SepayService(
      prisma as any,
      { get: jest.fn().mockReturnValue('1') } as any,
      { create: jest.fn() } as any,
      orderPaymentsService as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service as any, 'recordRawTransaction')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'isVpsgAccount').mockResolvedValue(false);
    jest.spyOn(service as any, 'resolveAccountId').mockResolvedValue(5);
    return { service, prisma, orderPaymentsService };
  };

  const payload = (content: string) =>
    ({
      id: 123,
      transferType: 'in',
      transferAmount: 13900000,
      content,
      accountNumber: '0000',
      referenceCode: 'REF',
    }) as any;

  it('tạo phiếu thu cho đơn DH129766 từ nội dung QR có ngày dính sau mã', async () => {
    const { service, prisma, orderPaymentsService } = setup({
      DH129766: { id: 129766, soldById: 4 },
    });

    const result = await service.handleWebhook(payload(QR_CONTENT));

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'DH129766' } }),
    );
    expect(orderPaymentsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 129766,
        amount: 13900000,
        sepayTransactionId: '123',
      }),
      1,
    );
    expect(result.message).toBe('Order payment created');
  });

  it('không tạo phiếu thu khi nội dung không có mã', async () => {
    const { service, orderPaymentsService } = setup({});

    const result = await service.handleWebhook(payload('20024'));

    expect(orderPaymentsService.create).not.toHaveBeenCalled();
    expect(result.message).toBe('No order/invoice code found in content');
  });
});
