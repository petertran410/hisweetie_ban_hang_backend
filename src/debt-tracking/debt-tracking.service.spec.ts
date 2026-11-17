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

describe('DebtTrackingService policy — trạng thái "Chưa thiết lập"', () => {
  const setup = () => {
    const upsert = jest.fn().mockResolvedValue({ id: 10 });
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
      customerDebtPolicy: { upsert },
    };
    const service = new DebtTrackingService(prisma as any, {} as any);
    return { service, upsert };
  };

  it('NONE + cờ false giữ khách ở "Chưa thiết lập" (không bắt trả đủ)', async () => {
    const { service, upsert } = setup();

    await service.upsertPolicy(
      1,
      {
        debtRuleType: 'NONE',
        hasCreditLimit: false,
        hasTermDays: false,
        requireFullPaymentForInvoice: false,
      } as any,
      7,
    );

    const args = upsert.mock.calls[0][0];
    expect(args.create.requireFullPaymentForInvoice).toBe(false);
    expect(args.update.requireFullPaymentForInvoice).toBe(false);
  });

  it('quy tắc cho nợ luôn tắt cờ dù FE gửi true', async () => {
    const { service, upsert } = setup();

    await service.upsertPolicy(
      1,
      {
        debtRuleType: 'CREDIT_LIMIT',
        hasCreditLimit: true,
        hasTermDays: false,
        creditLimit: 1000000,
        requireFullPaymentForInvoice: true,
      } as any,
      7,
    );

    const args = upsert.mock.calls[0][0];
    expect(args.create.requireFullPaymentForInvoice).toBe(false);
    expect(args.update.requireFullPaymentForInvoice).toBe(false);
  });

  it('request cũ không gửi debtRuleType và cờ thì không đổi cờ đã lưu', async () => {
    const { service, upsert } = setup();

    await service.upsertPolicy(
      1,
      { hasCreditLimit: false, hasTermDays: false } as any,
      7,
    );

    const args = upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty('requireFullPaymentForInvoice');
    expect(args.create.requireFullPaymentForInvoice).toBe(false);
  });
});

describe('DebtTrackingService Sale PIC notifications', () => {
  it('sends a summary to the Sale PIC Lark ID and reports missing IDs', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 7, name: 'Sale A', larkUserId: 'ou_sale_a' },
        ]),
      },
    };
    const lark = { notifySaleDebtReminder: jest.fn().mockResolvedValue(undefined) };
    const service = new DebtTrackingService(
      prisma as any,
      {} as any,
      lark as any,
    );
    jest.spyOn(service, 'findAll').mockResolvedValue({
      data: [
        {
          customerId: 1,
          name: 'Khách A',
          code: 'KH001',
          totalDebt: 1000,
          requiredPaymentAmount: 500,
          debtStatus: 'OVERDUE',
          nearestDueDate: null,
          policy: {
            salePicId: 7,
            salePic: { id: 7, name: 'Sale A', canNotify: true },
          },
        },
        {
          customerId: 2,
          name: 'Khách B',
          code: 'KH002',
          totalDebt: 2000,
          requiredPaymentAmount: 0,
          debtStatus: 'DUE',
          nearestDueDate: null,
          policy: { salePicId: null, salePic: null },
        },
      ],
      pagination: { page: 1, pageSize: 5000, total: 2, totalPages: 1 },
    } as any);

    const result = await service.notifySaleDebt([1, 2]);

    expect(lark.notifySaleDebtReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        larkUserId: 'ou_sale_a',
        customerCode: 'KH001',
        totalDebt: 1000,
      }),
    );
    expect(result).toMatchObject({ total: 2, sent: 1, failed: 1 });
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customerId: 1, status: 'SENT' }),
        expect.objectContaining({ customerId: 2, status: 'MISSING_SALE_PIC' }),
      ]),
    );
  });

  it('rejects a batch larger than 50 customers', async () => {
    const service = new DebtTrackingService({} as any, {} as any, {} as any);

    await expect(
      service.notifySaleDebt(Array.from({ length: 51 }, (_, index) => index + 1)),
    ).rejects.toThrow('tối đa 50');
  });
});

describe('DebtTrackingService accountant PIC filtering', () => {
  it('filters customers by MISA employee code and name', async () => {
    const findManyMisa = jest.fn().mockResolvedValue([
      { accountObjectCode: 'KT01', accountObjectName: 'Kế Toán A' },
    ]);
    const findManyCustomers = jest.fn().mockResolvedValue([]);
    const prisma = {
      misaAccountObject: { findMany: findManyMisa },
      customer: { findMany: findManyCustomers },
    };
    const service = new DebtTrackingService(prisma as any, {} as any);

    await service.findAll({
      accountantPics: ['KT01'],
    } as any);

    expect(findManyMisa).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isEmployee: true,
          OR: [
            { accountObjectCode: { in: ['KT01'] } },
            { accountObjectName: { in: ['KT01'] } },
          ],
        }),
      }),
    );

    expect(findManyCustomers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { misaEmployeeCode: { in: expect.arrayContaining(['KT01', 'Kế Toán A']) } },
                { misaEmployeeName: { in: expect.arrayContaining(['KT01', 'Kế Toán A']) } },
              ],
            },
          ]),
        }),
      }),
    );
  });
});
