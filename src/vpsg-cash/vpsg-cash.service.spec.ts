import { Prisma } from '@prisma/client';
import { FinanceAccessService } from '../auth/finance-access.service';
import { VPSG_FUND_START } from '../approval-lifecycle/approval-lifecycle.constants';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import {
  isVpsgTransaction,
  nonVpsgAccountClause,
  vpsgAccountClause,
} from './vpsg-cash.accounts';
import { VpsgCashService } from './vpsg-cash.service';

const ACCOUNT = '96460247777';
const afterStart = new Date(VPSG_FUND_START.getTime() + 86400000);

describe('VPSG cash accounts', () => {
  it('matches virtual accounts by subAccount and plain accounts by accountNumber', () => {
    const numbers = [ACCOUNT];
    expect(
      isVpsgTransaction(
        { accountNumber: '8601539888', subAccount: ACCOUNT },
        numbers,
      ),
    ).toBe(true);
    expect(
      isVpsgTransaction({ accountNumber: ACCOUNT, subAccount: null }, numbers),
    ).toBe(true);
    // TK chính trùng số nhưng tiền vào TK ảo khác: không phải VPSG.
    expect(
      isVpsgTransaction(
        { accountNumber: ACCOUNT, subAccount: '96460248888' },
        numbers,
      ),
    ).toBe(false);
    expect(
      isVpsgTransaction({ accountNumber: ACCOUNT, subAccount: null }, []),
    ).toBe(false);
  });

  it('builds null-safe include and exclude clauses', () => {
    expect(vpsgAccountClause([ACCOUNT])).toEqual({
      OR: [
        { subAccount: { in: [ACCOUNT] } },
        { accountNumber: { in: [ACCOUNT] }, subAccount: null },
      ],
    });
    expect(nonVpsgAccountClause([ACCOUNT])).toEqual({
      AND: [
        { OR: [{ subAccount: null }, { subAccount: { notIn: [ACCOUNT] } }] },
        {
          OR: [
            { subAccount: { not: null } },
            { accountNumber: null },
            { accountNumber: { notIn: [ACCOUNT] } },
          ],
        },
      ],
    });
  });
});

describe('VpsgCashService', () => {
  function setup(permissions: string[] = []) {
    const fundRows: any[] = [];
    const sepay: any = {
      id: 31,
      accountNumber: '8601539888',
      subAccount: ACCOUNT,
      amountIn: new Prisma.Decimal(5000000),
      transactionDate: afterStart,
      createdAt: afterStart,
      transactionContent: ' Nop tien mat VPSG ',
      referenceNumber: 'FT123',
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          branchId: null,
          userBranches: [{ branchId: 7 }],
          userRoles: [],
        }),
      },
      bankAccount: {
        findMany: jest.fn().mockResolvedValue([{ accountNumber: ACCOUNT }]),
      },
      sepayTransaction: { findUnique: jest.fn(async () => sepay) },
      internalFundTransaction: {
        findUnique: jest.fn(
          async ({ where }: any) =>
            fundRows.find((row) => row.sourceKey === where.sourceKey) || null,
        ),
        findMany: jest.fn(async () =>
          fundRows.filter((row) => row.status === 'POSTED'),
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: fundRows.length + 1, ...data };
          fundRows.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            fundRows.find((row) => row.id === where.id),
            data,
          ),
        ),
      },
      internalFundDailyClosing: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const auth: any = {
      getPermissionsForBranch: jest.fn(async (_: number, branchId: number) =>
        branchId === 7 ? permissions : [],
      ),
    };
    const service = new VpsgCashService(
      prisma,
      new FinanceAccessService(prisma, auth),
      new InternalFundLedgerService(),
    );
    return { service, prisma, auth, sepay, fundRows };
  }
  const user = { id: 9, roles: [] };
  const all = ['vpsg_cash:view', 'vpsg_cash:record', 'vpsg_cash:cancel'];

  it('shows the VPSG accounts only to users who may view the fund', async () => {
    const none = setup();
    expect(await none.service.accounts(user)).toMatchObject({
      accountNumbers: [],
      canView: false,
      canRecord: false,
    });
    const viewer = setup(['vpsg_cash:view']);
    expect(await viewer.service.accounts(user)).toMatchObject({
      accountNumbers: [ACCOUNT],
      canView: true,
      canRecord: false,
      canCancel: false,
    });
  });

  it('records an incoming VPSG transaction once as a fund receipt', async () => {
    const f = setup(all);
    await f.service.record(31, user);
    await f.service.record(31, user);
    expect(f.fundRows).toHaveLength(1);
    expect(f.fundRows[0]).toMatchObject({
      branchId: 7,
      transactionType: 'RECEIPT',
      sourceType: 'SEPAY_VPSG',
      sourceKey: 'SEPAY_VPSG:31',
      sourceId: '31',
      occurredAt: afterStart,
      description: 'Nop tien mat VPSG',
      createdBy: 9,
      status: 'POSTED',
    });
    expect(String(f.fundRows[0].amount)).toBe('5000000');
    expect(await f.service.records([31, 32], user)).toEqual([
      expect.objectContaining({ transactionId: 31, fundTransactionId: 1 }),
    ]);
  });

  it('refuses other accounts, outgoing money, dates before the fund start and missing permission', async () => {
    const f = setup(all);
    f.sepay.subAccount = '96460248888';
    await expect(f.service.record(31, user)).rejects.toThrow(
      'không thuộc tài khoản quỹ tiền mặt VPSG',
    );
    f.sepay.subAccount = ACCOUNT;
    f.sepay.amountIn = new Prisma.Decimal(0);
    await expect(f.service.record(31, user)).rejects.toThrow('tiền vào');
    f.sepay.amountIn = new Prisma.Decimal(100);
    f.sepay.transactionDate = new Date(VPSG_FUND_START.getTime() - 1000);
    await expect(f.service.record(31, user)).rejects.toThrow(
      'trước ngày quỹ VPSG lên POS',
    );
    expect(f.fundRows).toHaveLength(0);

    const viewer = setup(['vpsg_cash:view']);
    await expect(viewer.service.record(31, user)).rejects.toThrow(
      'vpsg_cash:record',
    );
  });

  it('cancels a recorded receipt with a reason so it can be recorded again', async () => {
    const f = setup(all);
    await f.service.record(31, user);
    await expect(f.service.cancel(31, '  ', user)).rejects.toThrow('lý do');
    await f.service.cancel(31, 'Ghi nhầm', user);
    expect(f.fundRows[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Ghi nhầm',
      sourceKey: 'SEPAY_VPSG:31:CANCELLED:1',
    });
    await expect(f.service.cancel(31, 'Lần nữa', user)).rejects.toThrow(
      'chưa ghi vào quỹ VPSG',
    );
    await f.service.record(31, user);
    expect(f.fundRows).toHaveLength(2);
    expect(f.fundRows[1].status).toBe('POSTED');
  });

  it('blocks recording into a closed day without adjust', async () => {
    const f = setup(all);
    f.prisma.internalFundDailyClosing.findFirst.mockResolvedValue({
      id: 3,
      closedAt: new Date(),
    });
    await expect(f.service.record(31, user)).rejects.toThrow('chốt sổ');
    f.auth.getPermissionsForBranch.mockResolvedValue([
      ...all,
      'internal_fund:adjust',
    ]);
    await f.service.record(31, user);
    expect(f.fundRows).toHaveLength(1);
  });
});
