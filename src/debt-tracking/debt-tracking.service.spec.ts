import { DebtTrackingService } from './debt-tracking.service';

describe('DebtTrackingService policy normalization', () => {
  const setup = () => {
    const upsert = jest.fn().mockResolvedValue({ id: 10 });
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
      customerDebtPolicy: { upsert },
    };
    const service = new DebtTrackingService(prisma as any, {} as any);
    return { service, upsert };
  };

  it('bật yêu cầu trả đủ khi lưu quy tắc NONE', async () => {
    const { service, upsert } = setup();

    await service.upsertPolicy(
      1,
      {
        debtRuleType: 'NONE',
        hasCreditLimit: false,
        hasTermDays: false,
        debtForm: 'PREPAID',
      } as any,
      7,
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          debtRuleType: 'NONE',
          requireFullPaymentForInvoice: true,
        }),
        update: expect.objectContaining({
          debtRuleType: 'NONE',
          requireFullPaymentForInvoice: true,
        }),
      }),
    );
  });

  it('tắt yêu cầu trả đủ khi lưu quy tắc công nợ', async () => {
    const { service, upsert } = setup();

    await service.upsertPolicy(
      1,
      {
        debtRuleType: 'TERM_DAYS',
        hasCreditLimit: false,
        hasTermDays: true,
        termDays: 15,
      } as any,
      7,
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          debtRuleType: 'TERM_DAYS',
          requireFullPaymentForInvoice: false,
        }),
        update: expect.objectContaining({
          debtRuleType: 'TERM_DAYS',
          requireFullPaymentForInvoice: false,
        }),
      }),
    );
  });
});
