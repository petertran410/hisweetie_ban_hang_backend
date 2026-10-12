import { Prisma } from '@prisma/client';
import { InternalFundHistorySyncService } from './internal-fund-history-sync.service';

describe('InternalFundHistorySyncService', () => {
  const day = (value: string) => new Date(`${value}T00:00:00+07:00`).getTime();
  const record = (recordId: string, fields: Record<string, unknown>) => ({
    recordId,
    fields: { 'Ngày Giao Dịch': day('2026-10-05'), ...fields },
  });

  function setup(records: any[], existing: any[] = [], issued: any[] = []) {
    const stored: any[] = [...existing];
    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      internalFinanceEntry: { findMany: jest.fn().mockResolvedValue(issued) },
      internalFundTransaction: {
        findMany: jest.fn(async ({ where }: any) =>
          stored.filter((row) => where.sourceKey.in.includes(row.sourceKey)),
        ),
        createMany: jest.fn(async ({ data }: any) => {
          stored.push(...data.map((row: any, i: number) => ({ id: 100 + i, ...row })));
          return { count: data.length };
        }),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            stored.find((row) => row.id === where.id),
            data,
          ),
        ),
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        ({
          LARK_EXPENSE_BASE_TOKEN: 'base',
          LARK_EXPENSE_TABLE_HN: 'tblHN',
          LARK_EXPENSE_TABLE_SG: 'tblSG',
        })[key],
      ),
    };
    const lark = {
      getToken: jest.fn().mockResolvedValue('token'),
      forEachRecordPage: jest.fn(async (_b, _t, _k, onPage: any) => {
        await onPage(records);
        return records.length;
      }),
    };
    const ledger = {
      lock: jest.fn(),
      invalidateClosings: jest.fn(),
      code: jest.fn(() => 'QF-SQ-generated'),
    };
    const service = new InternalFundHistorySyncService(
      prisma,
      config as any,
      lark as any,
      ledger as any,
    );
    const run = async () => {
      service.start(7);
      for (let i = 0; i < 50 && service.getStatus().running; i++)
        await new Promise((resolve) => setImmediate(resolve));
      return service.getStatus();
    };
    return { run, stored, prisma, ledger };
  }

  it('maps receipts, expenses and internal transfers to the right fund and skips funds POS does not keep', async () => {
    const f = setup([
      record('recA1234', { 'Chi Nhánh': 'Kho Hà Nội', Thu: 15000000, 'Loại Thu Chi': 'Thu Tiền Khách Hàng', 'Nội Dung': 'Thu tiền của khách', STT: '101' }),
      record('recB1234', { 'Chi Nhánh': 'Kho Sài Gòn', Chi: 60000, 'Loại Thu Chi': 'Phiếu Chi Kho SG', 'Nội Dung': 'Dầu xe', STT: '102' }),
      record('recC1234', { 'Chi Nhánh': 'Văn Phòng Hà Nội', Thu: 270000000, 'Loại Thu Chi': 'Chuyển Tiền Nội Bộ', STT: '103' }),
      record('recD1234', { 'Chi Nhánh': 'Cửa Hàng Diệp Trà', Chi: 500000, STT: '104' }),
      record('recE1234', { 'Chi Nhánh': 'Kho Hà Nội', STT: '105' }),
    ]);
    const status = await f.run();
    expect(status).toMatchObject({ fetched: 5, created: 3, skipped: 2, error: null });
    expect(f.stored.map((row) => [row.code, row.branchId, row.transactionType])).toEqual([
      ['SQ-101', 6, 'RECEIPT'],
      ['SQ-102', 1, 'EXPENSE'],
      ['SQ-103', 4, 'TRANSFER_IN'],
    ]);
    expect(f.stored.every((row) => row.sourceType === 'LEDGER_HISTORY')).toBe(true);
    expect(f.ledger.invalidateClosings).toHaveBeenCalledTimes(3);
  });

  it('is idempotent and applies later changes such as a cancellation', async () => {
    const existing = [
      {
        id: 1,
        sourceKey: 'LARK_LEDGER:recA1234',
        branchId: 6,
        transactionType: 'EXPENSE',
        amount: new Prisma.Decimal(40000),
        occurredAt: new Date(day('2026-10-05')),
        description: 'Phí gửi bến',
        status: 'POSTED',
      },
      {
        id: 2,
        sourceKey: 'LARK_LEDGER:recB1234',
        branchId: 1,
        transactionType: 'EXPENSE',
        amount: new Prisma.Decimal(70000),
        occurredAt: new Date(day('2026-10-05')),
        description: 'Phí gửi bến',
        status: 'POSTED',
      },
    ];
    const f = setup(
      [
        record('recA1234', { 'Chi Nhánh': 'Kho Hà Nội', Chi: 40000, 'Nội Dung': 'Phí gửi bến' }),
        record('recB1234', { 'Chi Nhánh': 'Kho Sài Gòn', Chi: 70000, 'Nội Dung': 'Phí gửi bến', 'Trạng Thái': 'Hủy' }),
      ],
      existing,
    );
    const status = await f.run();
    expect(status).toMatchObject({ created: 0, updated: 1 });
    expect(f.prisma.internalFundTransaction.createMany).not.toHaveBeenCalled();
    expect(f.stored[1].status).toBe('CANCELLED');
  });

  it('does not post a warehouse expense that was already issued when its voucher was imported', async () => {
    const f = setup(
      [
        record('recA1234', {
          'Chi Nhánh': 'Kho Hà Nội',
          Chi: 40000,
          'Phiếu Chi HN': { link_record_ids: ['recVoucher1'] },
        }),
      ],
      [],
      [{ sourceKey: 'LARK:base:tblHN:recVoucher1' }],
    );
    const status = await f.run();
    expect(status).toMatchObject({ created: 0, skipped: 1 });
  });
});
