import { PaymentNotesService } from './payment-notes.service';

describe('PaymentNotesService createOrderNote → log phương thức thanh toán', () => {
  const setup = (previous?: { paymentType: string; amount: unknown }) => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          code: 'DH000001',
          branchId: 2,
          paymentNotes: previous ? [previous] : [],
        }),
      },
      orderPaymentNote: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 10, ...data }),
        ),
      },
    };
    const auditLogsService = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new PaymentNotesService(
      prisma as any,
      auditLogsService as any,
    );
    return { service, auditLogsService };
  };

  it('ghi log khi đổi CK → TM', async () => {
    const { service, auditLogsService } = setup({
      paymentType: 'transfer',
      amount: null,
    });

    await service.createOrderNote(
      1,
      { paymentType: 'cash', amount: 500000 } as any,
      9,
      'Nhân viên A',
    );

    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: 'ORDER_PAYMENT_NOTE_CHANGE',
        entityType: 'orders',
        entityCode: 'DH000001',
        userName: 'Nhân viên A',
        message: expect.stringContaining('CK → TM (500.000 đ)'),
      }),
    );
  });

  it('ghi log lần chọn đầu tiên', async () => {
    const { service, auditLogsService } = setup();

    await service.createOrderNote(1, { paymentType: 'transfer' } as any, 9);

    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Chưa chọn → CK'),
      }),
    );
  });

  it('không ghi log khi lưu lại y nguyên', async () => {
    const { service, auditLogsService } = setup({
      paymentType: 'cash',
      amount: '500000.00',
    });

    await service.createOrderNote(
      1,
      { paymentType: 'cash', amount: 500000 } as any,
      9,
    );

    expect(auditLogsService.create).not.toHaveBeenCalled();
  });
});
