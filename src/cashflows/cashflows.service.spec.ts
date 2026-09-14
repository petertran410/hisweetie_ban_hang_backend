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
