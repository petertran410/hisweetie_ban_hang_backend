import { Prisma } from '@prisma/client';
import { CashAdvancesService } from './cash-advances.service';
import { CashAdvanceRefundsService } from './cash-advance-refunds.service';

const day = (key: string) => new Date(`${key}T00:00:00Z`);

function setup() {
  const advance: any = {
    id: 1,
    code: 'TCNB-TU-HN-20261019-000001',
    branchId: 6,
    recipientId: 20,
    createdBy: 7,
    amount: new Prisma.Decimal(50_000_000),
    advanceDate: day('2026-10-19'),
    periodMode: 'WEEK',
    periodYear: 2026,
    periodWeek: 43,
    periodFrom: day('2026-10-19'),
    periodTo: day('2026-10-25'),
    refundDueDate: day('2026-10-30'),
    description: 'Ứng chi phí giao hàng',
    status: 'DRAFT',
    confirmedAt: null,
    createdAt: new Date('2026-10-19T02:00:00Z'),
    branch: { id: 6, name: 'Kho HN' },
    recipient: { id: 20, name: 'Tài xế A' },
    creator: { id: 7, name: 'Kế toán' },
    attachments: [],
    refunds: [] as any[],
  };
  // Tạm ứng cũ của người nhận dùng để kiểm tra chặn quá hạn.
  const overdue: any[] = [];
  let allocationCount = 0;
  const prisma: any = {
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 20,
        name: 'Tài xế A',
        isActive: true,
      }),
    },
    internalFinanceCodeCounter: {
      upsert: jest.fn().mockResolvedValue({ nextNumber: 2 }),
    },
    cashAdvance: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === advance.id ? advance : null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        where.recipientId
          ? overdue.filter((row) => where.status.in.includes(row.status))
          : [...overdue, advance].filter(
              (row) =>
                row.branchId === where.branchId &&
                where.status.in.includes(row.status),
            ),
      ),
      create: jest.fn(async ({ data }: any) => {
        Object.assign(advance, data, { id: 1 });
        return advance;
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(advance, data)),
    },
    cashAdvanceRefund: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    cashAdvanceAllocation: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn(async () => allocationCount),
    },
    cashAdvanceAttachment: { createMany: jest.fn() },
    internalFinanceEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: null },
        _count: { _all: 0 },
      }),
    },
    internalFundTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const access: any = {
    can: jest.fn().mockResolvedValue(true),
    assert: jest.fn(),
    branchesFor: jest.fn().mockResolvedValue([6, 1]),
    isSuperAdmin: jest.fn().mockResolvedValue(false),
  };
  const ledger: any = {
    lock: jest.fn(),
    assertOpen: jest.fn(),
    postSystemTransaction: jest.fn(),
    cancelBySource: jest.fn(),
  };
  const codes: any = { nextCode: jest.fn().mockResolvedValue('TCNB-TU-HN-1') };
  const service = new CashAdvancesService(prisma, access, ledger, codes);
  return {
    service,
    prisma,
    access,
    ledger,
    advance,
    overdue,
    setAllocations: (count: number) => (allocationCount = count),
  };
}

const creator = { id: 7, roles: [], branchIds: [6] };
const createDto = {
  branchId: 6,
  recipientId: 20,
  amount: 50_000_000,
  advanceDate: '2026-10-19',
  periodMode: 'WEEK',
  periodYear: 2026,
  periodWeek: 43,
  description: 'Ứng chi phí giao hàng',
};

describe('CashAdvancesService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-20T03:00:00Z') });
  });
  afterEach(() => jest.useRealTimers());

  it('creates a draft with the server-derived ISO week and refund due date', async () => {
    const { service, prisma, ledger } = setup();
    await service.create(createDto as any, creator);
    expect(prisma.cashAdvance.create.mock.calls[0][0].data).toMatchObject({
      code: 'TCNB-TU-HN-1',
      status: 'DRAFT',
      periodFrom: day('2026-10-19'),
      periodTo: day('2026-10-25'),
      refundDueDate: day('2026-10-30'),
      createdBy: 7,
    });
    // Phiếu tạm chưa đụng tới quỹ.
    expect(ledger.postSystemTransaction).not.toHaveBeenCalled();
  });

  it('blocks a new advance after the 5 grace days when the old one has money left', async () => {
    const { service, overdue } = setup();
    overdue.push({
      id: 2,
      code: 'TU-CU',
      branchId: 6,
      status: 'COMPLETED',
      amount: new Prisma.Decimal(10_000_000),
      periodFrom: day('2026-10-05'),
      periodTo: day('2026-10-11'),
      refundDueDate: day('2026-10-16'),
      confirmedAt: new Date('2026-10-05T02:00:00Z'),
      createdAt: new Date('2026-10-05T01:00:00Z'),
    });
    await expect(service.create(createDto as any, creator)).rejects.toThrow(
      'TU-CU',
    );
  });

  it('allows a new advance while the old one is still in grace or fully used', async () => {
    const { service, overdue, prisma } = setup();
    // Còn trong 5 ngày ân hạn (hạn 21/10, hôm nay 20/10): truy vấn chặn trả rỗng.
    prisma.cashAdvance.findMany.mockImplementationOnce(async () => []);
    await expect(
      service.create(createDto as any, creator),
    ).resolves.toBeTruthy();
    // Quá hạn nhưng đã dùng hết tiền: không chặn.
    overdue.push({
      id: 3,
      code: 'TU-HET',
      branchId: 6,
      status: 'COMPLETED',
      amount: new Prisma.Decimal(1_000_000),
      periodFrom: day('2026-10-05'),
      periodTo: day('2026-10-11'),
      refundDueDate: day('2026-10-16'),
      confirmedAt: new Date('2026-10-05T02:00:00Z'),
      createdAt: new Date('2026-10-05T01:00:00Z'),
    });
    prisma.cashAdvanceAllocation.groupBy.mockResolvedValue([
      { advanceId: 3, _sum: { amount: new Prisma.Decimal(1_000_000) } },
    ]);
    await expect(
      service.create(createDto as any, creator),
    ).resolves.toBeTruthy();
  });

  it('confirms the hand-over by posting a fund expense once', async () => {
    const { service, ledger, advance } = setup();
    await service.confirm(1, creator);
    expect(ledger.postSystemTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        branchId: 6,
        transactionType: 'EXPENSE',
        sourceType: 'CASH_ADVANCE',
        sourceKey: 'CASH_ADVANCE:1',
        assertOpen: true,
      }),
    );
    expect(advance.status).toBe('CONFIRMING');
    await expect(service.confirm(1, creator)).rejects.toThrow('đã giao tiền');
  });

  it('lets only the recipient or the creator upload the signed voucher', async () => {
    const { service, advance } = setup();
    advance.status = 'CONFIRMING';
    const files = { attachments: [{ fileUrl: 'https://x/ky.jpg' }] };
    await expect(
      service.uploadSigned(1, files, { id: 99, roles: [], branchIds: [6] }),
    ).rejects.toThrow('Chỉ người nhận');
    await service.uploadSigned(1, files, { id: 20, roles: [], branchIds: [6] });
    expect(advance.status).toBe('COMPLETED');
  });

  it('refuses to cancel an advance that already paid warehouse expenses', async () => {
    const { service, advance, setAllocations, ledger } = setup();
    advance.status = 'COMPLETED';
    setAllocations(2);
    await expect(
      service.cancel(1, { reason: 'Nhầm' }, creator),
    ).rejects.toThrow('bỏ Đã chi');
    setAllocations(0);
    await service.cancel(1, { reason: 'Nhầm' }, creator);
    expect(advance.status).toBe('CANCELLED');
    // Không có dòng quỹ đã ghi (mock) thì không gọi hủy dòng quỹ.
    expect(ledger.cancelBySource).not.toHaveBeenCalled();
  });
});

describe('CashAdvanceRefundsService', () => {
  it('refuses a refund above amount − other refunds − locked expenses', async () => {
    const { prisma, access, ledger, service: advances } = setup();
    prisma.cashAdvance.findUnique = jest.fn().mockResolvedValue({
      id: 1,
      branchId: 6,
      recipientId: 20,
      amount: new Prisma.Decimal(50_000_000),
      status: 'CONFIRMING',
      code: 'TU-1',
    });
    prisma.cashAdvanceRefund.aggregate = jest.fn().mockResolvedValue({
      _sum: { amount: new Prisma.Decimal(5_000_000) },
    });
    prisma.cashAdvanceAllocation.aggregate = jest.fn().mockResolvedValue({
      _sum: { amount: new Prisma.Decimal(40_000_000) },
    });
    prisma.cashAdvanceRefund.create = jest.fn();
    const codes: any = { nextCode: jest.fn().mockResolvedValue('HU-1') };
    const refunds = new CashAdvanceRefundsService(
      prisma,
      access,
      ledger,
      codes,
      advances,
    );
    await expect(
      refunds.create(
        { advanceId: 1, amount: 6_000_000, refundDate: '2026-10-26' },
        creator,
      ),
    ).rejects.toThrow('vượt');
    expect(prisma.cashAdvanceRefund.create).not.toHaveBeenCalled();
  });
});
