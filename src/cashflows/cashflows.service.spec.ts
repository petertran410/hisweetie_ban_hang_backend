import { CashFlowsService } from './cashflows.service';

describe('CashFlowsService.findAll', () => {
  const prisma = {
    invoice: {
      findUnique: jest.fn(),
    },
    cashFlow: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    returnOrder: {
      groupBy: jest.fn(),
    },
    customer: {
      findMany: jest.fn(),
    },
    supplier: {
      findMany: jest.fn(),
    },
  };

  let service: CashFlowsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CashFlowsService(prisma as any, {} as any);
    prisma.cashFlow.findMany.mockResolvedValue([]);
    prisma.cashFlow.count.mockResolvedValue(0);
    prisma.invoice.findUnique.mockResolvedValue(null);
    prisma.cashFlow.groupBy.mockResolvedValue([]);
    prisma.returnOrder.groupBy.mockResolvedValue([]);
    prisma.customer.findMany.mockResolvedValue([]);
    prisma.supplier.findMany.mockResolvedValue([]);
  });

  it('searches by cashflow code, Sepay reference code, and partner name', async () => {
    await service.findAll({
      search: 'REF-123',
      pageSize: 15,
      currentItem: 0,
    });

    const findManyArgs = prisma.cashFlow.findMany.mock.calls[0][0];
    const searchOr = findManyArgs.where.AND[2].OR;

    expect(searchOr).toEqual(
      expect.arrayContaining([
        { code: { contains: 'REF-123', mode: 'insensitive' } },
        {
          sepayReferenceCode: {
            contains: 'REF-123',
            mode: 'insensitive',
          },
        },
        { partnerName: { contains: 'REF-123', mode: 'insensitive' } },
      ]),
    );
    expect(findManyArgs.include).toBeUndefined();
    expect(findManyArgs.select).toBeDefined();
  });

  it('returns summary and keeps it aligned with the requested period', async () => {
    prisma.cashFlow.findMany.mockResolvedValue([
      {
        id: 10,
        code: 'TT000010',
        branchId: 1,
        cashFlowGroupId: null,
        isReceipt: true,
        amount: 100,
        currency: 'VND',
        exchangeRate: 1,
        foreignAmount: null,
        transDate: new Date('2026-09-10T00:00:00.000Z'),
        method: 'cash',
        accountId: null,
        partnerType: null,
        partnerId: null,
        partnerName: null,
        contactNumber: null,
        address: null,
        wardName: null,
        description: null,
        sepayReferenceCode: 'REF-123',
        status: 0,
        statusValue: 'Đã thanh toán',
        usedForFinancialReporting: 1,
        createdBy: 1,
        collectorUserId: 1,
        createdAt: new Date('2026-09-10T00:00:00.000Z'),
        updatedAt: new Date('2026-09-10T00:00:00.000Z'),
        branch: { id: 1, name: 'Main' },
        cashFlowGroup: null,
        account: null,
        creator: { id: 1, name: 'User' },
        collector: null,
        collectionBranch: null,
      },
    ]);
    prisma.cashFlow.count.mockResolvedValue(1);
    prisma.cashFlow.groupBy.mockImplementation(({ where }: any) => {
      if (where.transDate?.lt) {
        return Promise.resolve([
          { isReceipt: true, _sum: { amount: 100 } },
          { isReceipt: false, _sum: { amount: 40 } },
        ]);
      }
      return Promise.resolve([
        { isReceipt: true, _sum: { amount: 300 } },
        { isReceipt: false, _sum: { amount: 120 } },
      ]);
    });

    const result = await service.findAll(
      {
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-30T23:59:59.999Z',
        includeSummary: true,
        pageSize: 15,
        currentItem: 0,
      },
      { canViewOtherStaffData: true },
    );

    expect(result.summary).toEqual({
      openingBalance: 60,
      totalReceipt: 300,
      totalPayment: 120,
      closingBalance: 240,
    });
    expect(result.data[0].debtOffsetTotal).toBe(0);
  });

  it('preserves an explicit status filter in the list summary', async () => {
    await service.findAll({
      status: 2,
      includeSummary: true,
      pageSize: 15,
      currentItem: 0,
    });

    const summaryWhere = prisma.cashFlow.groupBy.mock.calls[0][0].where;
    expect(summaryWhere.status).toBe(2);
  });

  it('applies invoice relation filters to both list and summary', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ code: 'HD001' });

    await service.findAll({
      invoiceId: 9,
      includeSummary: true,
      pageSize: 15,
      currentItem: 0,
    });

    const listWhere = prisma.cashFlow.findMany.mock.calls[0][0].where;
    const summaryWhere = prisma.cashFlow.groupBy.mock.calls[0][0].where;
    const expectedInvoiceFilter = {
      some: { invoiceId: 9 },
    };

    expect(listWhere.invoicePayments).toEqual(expectedInvoiceFilter);
    expect(summaryWhere.invoicePayments).toEqual(expectedInvoiceFilter);
    expect(listWhere.code).toEqual({ contains: 'HD001' });
    expect(summaryWhere.code).toEqual({ contains: 'HD001' });
  });
});

describe('CashFlowsService approval cashflows', () => {
  it('preserves transfer method for an internal receipt transfer', async () => {
    const created: any[] = [];
    const tx = {
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 41,
          status: 'APPROVED',
          cashFlowId: null,
          detailSnapshot: {},
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      cashFlow: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) => {
          const cashFlow = { id: created.length + 1, ...data };
          created.push(cashFlow);
          return Promise.resolve(cashFlow);
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = new CashFlowsService(prisma as any, {} as any);

    const result = await service.createApprovalTransferCashFlows(
      {
        approvalRequestId: 41,
        sourceBranchId: 6,
        destinationBranchId: 1,
        amount: 500000,
        transDate: '2026-09-26',
        method: 'transfer',
      },
      7,
    );

    expect(result.cashFlows).toHaveLength(2);
    expect(created.map((cashFlow) => cashFlow.method)).toEqual([
      'transfer',
      'transfer',
    ]);
    expect(tx.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cashFlowId: 1,
          detailSnapshot: expect.objectContaining({
            transferCashFlowIds: [1, 2],
          }),
        }),
      }),
    );
  });
});

describe('CashFlowsService.createCustomerPayment', () => {
  const setup = () => {
    type CreatedCashFlow = {
      id: number;
      code: string;
      partnerId: number;
      amount: number;
    };
    const createdCashFlows: CreatedCashFlow[] = [];
    const customers: Record<number, any> = {
      1: { id: 1, name: 'Khách cha', contactNumber: null, addresses: [] },
      2: { id: 2, name: 'Khách con', contactNumber: null, addresses: [] },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      customer: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(customers[where.id] ?? null),
          ),
        findMany: jest.fn().mockResolvedValue([{ id: 2 }]),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, name: 'Thu ngân' }),
      },
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          id: 10,
          code: 'HD000010',
          customerId: 2,
          debtAmount: 700000,
          paidAmount: 0,
          status: 3,
          payments: [],
        }),
        update: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotal: 0 } }),
      },
      invoicePayment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: 100, ...data }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cashFlow: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: { partnerId: number; amount: number } }) => {
              const cashFlow: CreatedCashFlow = {
                id: createdCashFlows.length + 1,
                code: `TT00000${createdCashFlows.length + 1}`,
                partnerId: data.partnerId,
                amount: data.amount,
              };
              createdCashFlows.push(cashFlow);
              return Promise.resolve(cashFlow);
            },
          ),
        update: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      returnOrder: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { refundAmount: 0 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = new CashFlowsService(prisma as any, {} as any);
    return { service, tx, createdCashFlows };
  };

  it('ghi phần tiền không gắn hóa đơn vào phiếu thu của khách cha khi trả hóa đơn của khách con', async () => {
    const { service, createdCashFlows } = setup();

    await service.createCustomerPayment(
      {
        customerId: 1,
        totalAmount: 1000000,
        branchId: 1,
        method: 'cash',
        allocateToInvoices: true,
        invoices: [{ invoiceId: 10, amount: 700000 }],
      },
      7,
    );

    expect(createdCashFlows.map((cf) => [cf.partnerId, cf.amount])).toEqual([
      [2, 700000],
      [1, 300000],
    ]);
  });

  it('không có phần dư thì chỉ lập phiếu thu cho khách con', async () => {
    const { service, createdCashFlows } = setup();

    await service.createCustomerPayment(
      {
        customerId: 1,
        totalAmount: 700000,
        branchId: 1,
        method: 'cash',
        allocateToInvoices: true,
        invoices: [{ invoiceId: 10, amount: 700000 }],
      },
      7,
    );

    expect(createdCashFlows.map((cf) => [cf.partnerId, cf.amount])).toEqual([
      [2, 700000],
    ]);
  });

  it('từ chối khi tiền gắn hóa đơn vượt số tiền thu', async () => {
    const { service, tx, createdCashFlows } = setup();

    await expect(
      service.createCustomerPayment(
        {
          customerId: 1,
          totalAmount: 500000,
          branchId: 1,
          method: 'cash',
          allocateToInvoices: true,
          invoices: [{ invoiceId: 10, amount: 700000 }],
        },
        7,
      ),
    ).rejects.toThrow('vượt số tiền thu');
    expect(tx.invoicePayment.create).not.toHaveBeenCalled();
    expect(createdCashFlows).toHaveLength(0);
  });
});
