import { LarkDebtNotificationService } from './lark-debt-notification.service';

describe('LarkDebtNotificationService debt reminder', () => {
  it('sends a direct text message using the Sale PIC open_id', async () => {
    const create = jest.fn().mockResolvedValue({ code: 0 });
    const service = new LarkDebtNotificationService(
      { im: { message: { create } } } as any,
      {} as any,
      {} as any,
    );

    await service.notifySaleDebtReminder({
      larkUserId: 'ou_sale_a',
      customerName: 'Khách A',
      customerCode: 'KH001',
      totalDebt: 1000000,
      requiredPaymentAmount: 500000,
      debtStatus: 'OVERDUE',
      nearestDueDate: '07/09/2026',
      policyDescription: 'Công nợ 55 ngày',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({ receive_id: 'ou_sale_a', msg_type: 'text' }),
      }),
    );
    const content = JSON.parse(create.mock.calls[0][0].data.content).text;
    expect(content).toContain('KH001');
    expect(content).toContain('1.000.000');
    expect(content).toContain('Quá Hạn');
  });
});
