import { ConflictException } from '@nestjs/common';
import { SepayMatchService } from './sepay-match.service';
import { ORDER_STATUS } from '../orders/dto/order-status.constants';

describe('SepayMatchService order candidates', () => {
  const tx = { id: 8, sepayId: 'tx-8', suggestedOrderId: null };
  const createService = (order: any = null) => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(order ? [order] : []),
        count: jest.fn().mockResolvedValue(order ? 1 : 0),
        findUnique: jest.fn().mockResolvedValue(order),
      },
      sepayAllocation: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      cashFlow: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const service = new SepayMatchService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service as any, 'getTxWithMatch')
      .mockResolvedValue({ tx, match: { status: 'processing' } });
    return { service, prisma };
  };

  it('lọc cùng tập đơn NONE và trạng thái 1/5 cho danh sách lẫn tổng', async () => {
    const { service, prisma } = createService();

    await service.getOrderCandidates(8, {
      page: '1',
      limit: '20',
      search: 'DH',
    });

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: { in: [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED] },
      customer: { is: { debtPolicy: { is: { debtRuleType: 'NONE' } } } },
      OR: [
        { code: { contains: 'DH', mode: 'insensitive' } },
        { customer: { code: { contains: 'DH', mode: 'insensitive' } } },
        { customer: { name: { contains: 'DH', mode: 'insensitive' } } },
      ],
    });
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
  });

  it.each([null, 'TERM_DAYS', 'CREDIT_LIMIT'])(
    'không cho gắn đơn khi chính sách là %s',
    async (debtRuleType) => {
      const order = {
        id: 12,
        status: ORDER_STATUS.PENDING,
        customer: {
          id: 5,
          name: 'Khách A',
          debtPolicy: debtRuleType ? { debtRuleType } : null,
        },
      };
      const { service, prisma } = createService(order);

      await expect(service.selectOrder(8, { orderId: 12 }, 3)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('gắn được đơn NONE và lấy khách hàng từ đơn', async () => {
    const order = {
      id: 12,
      code: 'DH0012',
      orderDate: new Date('2026-09-01'),
      grandTotal: 450_000,
      paidAmount: 0,
      debtAmount: 450_000,
      status: ORDER_STATUS.PENDING,
      customer: {
        id: 5,
        code: 'KH005',
        name: 'Khách A',
        debtPolicy: { debtRuleType: 'NONE' },
      },
      branch: null,
    };
    const { service, prisma } = createService(order);
    const deleteMany = jest.fn();
    const create = jest.fn();
    const update = jest.fn();
    prisma.$transaction.mockImplementation((callback) =>
      callback({
        sepayAllocation: { deleteMany, create },
        sepayTransaction: { update },
      }),
    );
    const onAssigned = jest.fn();
    (service as any).debtTicketAutoClose.onSepayCustomersAssigned = onAssigned;

    const result = await service.selectOrder(8, { orderId: 12 }, 3);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: 5,
        customerName: 'Khách A',
      }),
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: expect.objectContaining({
        suggestedOrderId: 12,
        assignedCustomerId: 5,
      }),
    });
    expect(onAssigned).toHaveBeenCalledWith(8, [5]);
    expect(result.order.customer?.id).toBe(5);
  });

  it('không lập phiếu khi chính sách đã đổi sau lúc gắn đơn', async () => {
    const { service, prisma } = createService({
      id: 12,
      code: 'DH0012',
      status: ORDER_STATUS.CONFIRMED,
      customerId: 5,
      customer: { debtPolicy: { debtRuleType: 'TERM_DAYS' } },
    });
    jest.spyOn(service as any, 'getTxWithMatch').mockResolvedValue({
      tx: { ...tx, amountIn: 120_000, suggestedOrderId: 12 },
      match: { status: 'assigned' },
    });
    prisma.sepayAllocation.findMany.mockResolvedValue([]);

    await expect(
      service.confirmReceipt(
        8,
        {
          branchId: 1,
          allocations: [
            { customerId: 5, orderId: 12, amount: 120_000, invoices: [] },
          ],
        },
        3,
      ),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('SepayMatchService warehouse fund deposit', () => {
  const setup = (status = 'processing', amountIn = 5_000_000) => {
    const tx: any = {
      id: 8,
      sepayId: 'tx-8',
      amountIn,
      transactionDate: new Date('2026-10-05T03:00:00Z'),
      transactionContent: 'KHO HN NOP TIEN',
      fundDepositBranchId: null,
    };
    const prisma: any = {
      sepayTransaction: {
        findUnique: jest.fn(async () => tx),
        update: jest.fn(async ({ data }: any) => Object.assign(tx, data)),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const internalFund = { assertPermission: jest.fn() };
    const fundLedger = {
      postSystemTransaction: jest.fn().mockResolvedValue({ id: 77 }),
      cancelBySource: jest.fn(),
      lock: jest.fn(),
      assertOpen: jest.fn(),
    };
    const service = new SepayMatchService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      internalFund as any,
      fundLedger as any,
    );
    jest
      .spyOn(service as any, 'getTxWithMatch')
      .mockResolvedValue({ tx, match: { status } });
    return { service, prisma, tx, internalFund, fundLedger };
  };

  it('posts one fund expense for the warehouse and links it to the bank transaction', async () => {
    const f = setup();
    await f.service.markFundDeposit(8, 6, 3);
    expect(f.internalFund.assertPermission).toHaveBeenCalledWith(
      3,
      6,
      'create_expense',
    );
    expect(f.fundLedger.postSystemTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        branchId: 6,
        transactionType: 'EXPENSE',
        sourceType: 'SEPAY_FUND_DEPOSIT',
        sourceKey: 'SEPAY_DEPOSIT:8',
        assertOpen: true,
      }),
    );
    expect(f.tx).toMatchObject({ fundDepositBranchId: 6, fundTransactionId: 77 });
  });

  it('rejects non-warehouse branches and transactions already handled', async () => {
    await expect(setup().service.markFundDeposit(8, 4, 3)).rejects.toThrow(
      'Hà Nội hoặc Sài Gòn',
    );
    const f = setup('completed');
    await expect(f.service.markFundDeposit(8, 6, 3)).rejects.toThrow(
      ConflictException,
    );
    expect(f.fundLedger.postSystemTransaction).not.toHaveBeenCalled();
  });

  it('cancels the fund row and clears the mark when undone', async () => {
    const f = setup();
    f.tx.fundDepositBranchId = 1;
    f.tx.fundTransactionId = 77;
    await f.service.unmarkFundDeposit(8, 3);
    expect(f.internalFund.assertPermission).toHaveBeenCalledWith(3, 1, 'cancel');
    expect(f.fundLedger.cancelBySource).toHaveBeenCalledWith(
      expect.anything(),
      'SEPAY_DEPOSIT:8',
      3,
      expect.any(String),
    );
    expect(f.tx).toMatchObject({
      fundDepositBranchId: null,
      fundTransactionId: null,
    });
  });
});
